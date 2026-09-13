"use strict";

/**
 * Plumbing self-test: no browser involved.
 *
 * Spawns the wrapper exactly the way Firefox would (executable, stdin/stdout
 * pipes) and drives the real bridge entry over the real native-messaging
 * protocol. This exists because the harness's own instrument must be proven
 * before anything is concluded from it - the previous differential harness in
 * this repo reported "equivalence" for two traces that were both empty, and an
 * isolation control cannot catch that.
 *
 * What it establishes:
 *   1. the wrapper forwards bytes verbatim (a reply arrives at all),
 *   2. both directions are traced (a request AND a reply are recorded),
 *   3. the trace records a real subject, not an empty message list,
 *   4. two wrapper instances are two OS processes with different PIDs.
 *
 * Usage: node test/integration/selfTest.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { encode, FrameReader } = require("./nativeProtocol");

const wrapperPath = path.join(__dirname, "hostWrapper.js");
const repoRoot = path.resolve(__dirname, "../..");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) {
        pass++;
        console.log("  ok   " + name);
    } else {
        fail++;
        console.log(
            "  FAIL " + name + (detail === undefined ? "" : " :: " + detail)
        );
    }
}

function readNdjson(file) {
    if (!fs.existsSync(file)) return [];
    return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Starts a wrapper and returns a handle that can send and collect replies. */
function startConnection(harnessDir) {
    const child = spawn(process.execPath, [wrapperPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FX_HARNESS_DIR: harnessDir, FX_LABEL: "selftest" }
    });
    const replies = [];
    const reader = new FrameReader((message, parseError) => {
        replies.push({ message, parseError });
    });
    child.stdout.on("data", chunk => reader.push(chunk));
    let stderr = "";
    child.stderr.on("data", chunk => {
        stderr += chunk.toString();
    });
    return {
        child,
        replies,
        get stderr() {
            return stderr;
        },
        send(message) {
            child.stdin.write(encode(message));
        },
        stop() {
            child.stdin.end();
            child.kill("SIGTERM");
        }
    };
}

async function waitFor(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(25);
    }
    throw new Error(`timed out waiting for ${what}`);
}

(async () => {
    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-harness-self-"));
    console.log("harness dir:", harnessDir);

    const first = startConnection(harnessDir);
    await sleep(400);
    first.send({ subject: "bridge:getInfo", data: {} });
    await waitFor(() => first.replies.length > 0, 5000, "a getInfo reply");
    const reply = first.replies[0];

    check(
        "the wrapper relayed a reply (bytes are forwarded verbatim)",
        typeof reply.message === "string" && reply.message.length > 0,
        JSON.stringify(reply)
    );
    check(
        "the reply is the application version",
        typeof reply.message === "string" && /^\d+\.\d+\.\d+/.test(reply.message),
        JSON.stringify(reply.message)
    );

    // A second connection at the same time: this is the shape the real test
    // needs (discovery + session), and the PID check below is the whole point.
    const second = startConnection(harnessDir);
    await sleep(400);
    second.send({ subject: "bridge:getInfo", data: {} });
    await waitFor(() => second.replies.length > 0, 5000, "a second reply");

    const spawns = readNdjson(path.join(harnessDir, "spawns.ndjson")).filter(
        entry => entry.event === undefined
    );
    const pids = spawns.map(entry => entry.pid);
    check(
        "two connections were spawned by the wrapper",
        spawns.length === 2,
        JSON.stringify(spawns)
    );
    check(
        "and they are two different OS processes",
        pids.length === 2 && pids[0] !== pids[1],
        JSON.stringify(pids)
    );
    check(
        "each wrapper reports a distinct child host process too",
        readNdjson(path.join(harnessDir, "spawns.ndjson")).filter(
            entry => entry.event === "child"
        ).length === 2
    );

    const firstPid = pids[0];
    const inboundTrace = readNdjson(
        path.join(harnessDir, `conn-${firstPid}-in.ndjson`)
    );
    const outboundTrace = readNdjson(
        path.join(harnessDir, `conn-${firstPid}-out.ndjson`)
    );
    check(
        "the firefox->host trace is non-empty and holds the request",
        inboundTrace.length > 0 &&
            inboundTrace[0].subject === "bridge:getInfo",
        JSON.stringify(inboundTrace)
    );
    check(
        "the host->firefox trace is non-empty and holds the reply",
        outboundTrace.length > 0 &&
            typeof outboundTrace[0].message === "string",
        JSON.stringify(outboundTrace)
    );
    check(
        "no frame failed to parse in either direction",
        [...inboundTrace, ...outboundTrace].every(entry => !entry.parseError),
        JSON.stringify(
            [...inboundTrace, ...outboundTrace]
                .filter(entry => entry.parseError)
                .map(entry => entry.parseError)
        )
    );

    const childPids = readNdjson(path.join(harnessDir, "spawns.ndjson"))
        .filter(entry => entry.event === "child")
        .map(entry => entry.childPid);

    first.stop();
    second.stop();
    await sleep(800);

    const alive = pid => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };
    check(
        "no host child is left orphaned after teardown",
        childPids.every(pid => !alive(pid)),
        JSON.stringify(childPids.map(pid => [pid, alive(pid)]))
    );

    // The child must not outlive the wrapper: a stray host would keep polling
    // ECP and sabotage later assertions.
    const exits = readNdjson(path.join(harnessDir, "spawns.ndjson")).filter(
        entry => entry.event === "child-exit"
    );
    check(
        "closing a connection ends its host child",
        exits.length >= 1,
        JSON.stringify(exits)
    );

    console.log("");
    console.log(pass + "/" + (pass + fail) + " checks passed");
    if (fail) {
        console.log("first connection stderr:\n" + first.stderr.slice(-2000));
        process.exit(1);
    }
})().catch(err => {
    console.error("SELF-TEST ERROR", err);
    process.exit(1);
});
