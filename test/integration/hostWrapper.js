#!/usr/bin/env node
"use strict";

/**
 * Transparent native-messaging host wrapper.
 *
 * Firefox can only be pointed at one executable per manifest, and what this
 * harness needs is to see BOTH connections (discovery and session), which are
 * two independent spawns of the same host. So the manifest points here, and this
 * wrapper execs the real bridge entry while:
 *
 *   - recording its own PID (that is how the harness proves the two connections
 *     really are two OS processes, not one process holding two ports),
 *   - forwarding stdin/stdout byte-for-byte and parsing only a COPY, so the
 *     protocol is never re-encoded by the harness,
 *   - teeing the host's stderr, which is where it logs (stdout is the protocol),
 *   - surviving being killed: traces are appended synchronously, because
 *     "kill the discovery host" is how the harness forces a reconnect.
 *
 * Environment:
 *   FX_HARNESS_DIR  directory for spawns.ndjson and conn-<pid>-*.ndjson
 *   FX_HOST_ENTRY   path to the bridge entry to exec (default: the dev build's
 *                   launcher script, dist/bridge/fx_cast_bilibili_bridge.sh,
 *                   which is what the repo's own `npm run build:bridge` emits
 *                   and which sets NODE_PATH for the real entry itself)
 *   FX_HOST_NODE_PATH  NODE_PATH for the child, when the entry needs one
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { FrameReader } = require("./nativeProtocol");

// Firefox passes its own environment to native hosts, so runFirefox.js exports
// this before launching the browser. The fixed fallback keeps a manually
// launched browser tracing somewhere predictable instead of failing silently.
const harnessDir =
    process.env.FX_HARNESS_DIR ||
    path.join(require("os").tmpdir(), "fx-cast-harness");
fs.mkdirSync(harnessDir, { recursive: true });

const repoRoot = path.resolve(__dirname, "../..");
const entry =
    process.env.FX_HOST_ENTRY ||
    path.join(repoRoot, "dist/bridge/fx_cast_bilibili_bridge.sh");
const nodePath =
    process.env.FX_HOST_NODE_PATH || path.join(repoRoot, "bridge/node_modules");

const pid = process.pid;
const at = Date.now();

/** Append one NDJSON record, synchronously: a killed host must not lose it. */
function record(file, value) {
    try {
        fs.appendFileSync(
            path.join(harnessDir, file),
            JSON.stringify(value) + "\n"
        );
    } catch {
        // Tracing must never take the host down.
    }
}

record("spawns.ndjson", {
    pid,
    ppid: process.ppid,
    at,
    entry,
    // Firefox passes the manifest path and the extension id as arguments;
    // keeping them makes a failed spawn diagnosable, and proves which manifest
    // the browser actually read (harness one vs the system one).
    argv: process.argv.slice(2),
    // The host is a launcher script that calls `node`, and a browser is not
    // obliged to hand its native hosts the shell PATH the developer has. Both
    // are recorded, because "host spawned but silent" was exactly this.
    path: process.env.PATH,
    nodeDir: path.dirname(process.execPath),
    label: process.env.FX_LABEL || undefined
});

// Executed directly, not through `node`: the entry may be a launcher script
// (a shebang executable is exactly what a native messaging manifest points at,
// so this is also the shape Firefox uses).
const childEnv = {
    ...process.env,
    // The wrapper IS node, so it always knows where node is. Prepending that
    // directory makes the launcher script's `node` resolve even when the
    // browser's own PATH does not contain it.
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    NODE_PATH: nodePath
};
const child = spawn(entry, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv
});

record("spawns.ndjson", { pid, at: Date.now(), event: "child", childPid: child.pid });

child.on("error", err => {
    record("wrapper-errors.ndjson", {
        pid,
        at: Date.now(),
        error: err.message
    });
});

child.on("exit", (code, signal) => {
    record("spawns.ndjson", {
        pid,
        at: Date.now(),
        event: "child-exit",
        childPid: child.pid,
        code,
        signal
    });
    // The wrapper's own stdin is Firefox's; when the child is gone there is
    // nothing left to relay, and exiting lets Firefox see the port close.
    process.exit(code === null ? 1 : code);
});

// --- byte-transparent forwarding ------------------------------------------
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });

// --- tracing (a copy of the same chunks) ----------------------------------
const inbound = new FrameReader((message, parseError) => {
    record(`conn-${pid}-in.ndjson`, {
        pid,
        at: Date.now(),
        direction: "firefox->host",
        subject: message && message.subject,
        message: message ?? null,
        parseError
    });
});
const outbound = new FrameReader((message, parseError) => {
    record(`conn-${pid}-out.ndjson`, {
        pid,
        at: Date.now(),
        direction: "host->firefox",
        subject:
            message === undefined
                ? undefined
                : typeof message === "string"
                ? `raw:${message}`
                : message.subject,
        message: message ?? null,
        parseError
    });
});

process.stdin.on("data", chunk => inbound.push(chunk));
child.stdout.on("data", chunk => outbound.push(chunk));

// stderr tee: the child's own diagnostics, per connection.
const errStream = fs.createWriteStream(
    path.join(harnessDir, `conn-${pid}-err.log`),
    { flags: "a" }
);
child.stderr.on("data", chunk => errStream.write(chunk));

// Firefox closing our stdin means the port is gone: mirror that onto the child
// exactly as the real host would see it (its own stdin ending), then let it
// shut down. The host stops its ECP polling loop on stdin end, so this is also
// what guarantees no orphaned poller is left behind to contaminate the next
// assertion.
process.stdin.on("end", () => {
    child.stdin.end();
});
process.stdin.on("close", () => {
    child.stdin.end();
});

/**
 * Being killed is a first-class case here: "kill the discovery host" is how the
 * harness forces the extension to reconnect and replay. So the child is reaped
 * deliberately rather than orphaned - a surviving host would keep polling ECP
 * and its messages would be attributed to the new connection.
 */
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    record("spawns.ndjson", {
        pid,
        at: Date.now(),
        event: "wrapper-signal",
        signal,
        childPid: child.pid
    });
    try {
        child.stdin.end();
    } catch {
        // Already closed.
    }
    const grace = Number(process.env.FX_KILL_GRACE_MS || 3000);
    const force = setTimeout(() => {
        record("spawns.ndjson", {
            pid,
            at: Date.now(),
            event: "child-sigkill",
            childPid: child.pid
        });
        child.kill("SIGKILL");
        process.exit(1);
    }, grace);
    child.once("exit", () => {
        clearTimeout(force);
        process.exit(0);
    });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
