#!/usr/bin/env node
"use strict";

/**
 * The hop that was missing.
 *
 * The page sender posts `main:bilibiliPlaybackProgress` with
 * `browser.runtime.sendMessage`, but the coordinator's consumer was reachable
 * only from the NATIVE bridge port (`deviceManager.onBridgeMessage`) - so the
 * message was never delivered, a page-route command could never reach
 * `receiverPhase: "requested"`, and it died on the 12s page-dispatch watchdog.
 *
 * Both neighbouring tests were green while that was true:
 *   `test/senders/pageTransition.js` - the SENDER emits the progress;
 *   `test/playback/coordinatorObservation.js` - the coordinator ACCEPTS it.
 * Neither covered the routing between them, which is exactly where the defect
 * lived. This test drives the real registration function with a stub runtime and
 * a spy target, so "the listener is on the wrong channel" can never pass again.
 *
 * Usage:
 *   node test/playback/runtimeRelay.js
 *   node test/playback/runtimeRelay.js --pre-fix [<git-rev>]   # the reverse control
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const relaySource = path.join(
    repoRoot,
    "extension/src/background/pageProgressRelay.ts"
);
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

const argv = process.argv.slice(2);
const preFixIndex = argv.indexOf("--pre-fix");
const preFix = preFixIndex !== -1;
const preFixRev = preFix ? argv[preFixIndex + 1] : undefined;

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
    if (cond) {
        pass++;
        console.log("  ok  ", name);
    } else {
        fail++;
        failures.push({ name, detail });
        console.log("  FAIL", name, detail === undefined ? "" : detail);
    }
};

async function bundle(outfile, workDir) {
    const esbuild = require(esbuildPath);
    const entry = path.join(workDir, "entry.js");
    fs.writeFileSync(
        entry,
        `export { registerPagePlaybackProgressRuntimeRelay } from ${JSON.stringify(
            relaySource
        )};\n`
    );
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        define: {
            BRIDGE_NAME: '"fx_cast_bilibili_bridge"',
            BRIDGE_VERSION: '"0.0.0-test"',
            MIRRORING_APP_ID: '"TESTMIRROR"'
        }
    });
}

/** A `browser` good enough for the module to load and register listeners. */
function installBrowserStub() {
    const runtimeListeners = [];
    global.browser = {
        runtime: {
            onMessage: {
                addListener: fn => runtimeListeners.push(fn)
            },
            sendMessage: () => Promise.resolve(undefined),
            getManifest: () => ({ version: "0.0.0-test" }),
            lastError: undefined
        },
        storage: {
            local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
            onChanged: { addListener: () => {} }
        },
        scripting: { executeScript: () => Promise.resolve([]) },
        menus: {
            create: () => {},
            removeAll: () => Promise.resolve(),
            onClicked: { addListener: () => {} }
        },
        action: { setIcon: () => Promise.resolve() },
        tabs: { query: () => Promise.resolve([]) },
        windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
        permissions: { contains: () => Promise.resolve(true) }
    };
    global.window = undefined;
    return runtimeListeners;
}

/** Everything else the background module touches at import time. */
function installDomStub() {
    const noop = () => {};
    global.document = {
        addEventListener: noop,
        removeEventListener: noop,
        querySelector: () => null,
        createElement: () => ({ style: {}, appendChild: noop, remove: noop }),
        body: { appendChild: noop, removeChild: noop },
        documentElement: { style: {} }
    };
    global.self = global;
}

async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-relay-"));
    if (preFix) {
        // The reverse control: the pre-fix background has no exported relay at
        // all, which is the point - the runtime hop did not exist.
        const rev = preFixRev || "HEAD";
        const show = spawnSync(
            "git",
            [
                "show",
                `${rev}:extension/src/background/pageProgressRelay.ts`
            ],
            { cwd: repoRoot, encoding: "utf8" }
        );
        // Pre-fix there is no relay module at all - and no registration in the
        // background either, which is the whole point of the control.
        const background = spawnSync(
            "git",
            ["show", `${rev}:extension/src/background/background.ts`],
            { cwd: repoRoot, encoding: "utf8" }
        );
        const hasRelay =
            show.status === 0 ||
            /registerPagePlaybackProgressRuntimeRelay/.test(
                background.stdout || ""
            );
        check(
            `reverse control: the pre-fix source (${rev}) has NO runtime relay (module absent, nothing registered)`,
            hasRelay === false,
            JSON.stringify({ rev, moduleStatus: show.status, hasRelay })
        );
        console.log(`\n${pass}/${pass + fail} checks passed`);
        if (fail) process.exit(1);
        return;
    }

    installDomStub();
    const listeners = installBrowserStub();
    const bundlePath = path.join(workDir, "relay.cjs");
    console.log("bundling pageProgressRelay.ts");
    await bundle(bundlePath, workDir);
    const mod = require(bundlePath);
    check(
        "the relay registration is exported (so the hop can be tested at all)",
        typeof mod.registerPagePlaybackProgressRuntimeRelay === "function",
        JSON.stringify(Object.keys(mod))
    );

    const calls = [];
    mod.registerPagePlaybackProgressRuntimeRelay({
        handlePagePlaybackProgress: detail => calls.push(detail)
    });
    check(
        "registering the relay installs exactly one runtime listener",
        listeners.length === 1,
        JSON.stringify({ listeners: listeners.length })
    );

    const listener = listeners[0];
    listener({ subject: "popup:debugLog", data: { message: "unrelated" } });
    listener({ subject: "main:rokuSessionMedia", data: { deviceId: "x" } });
    check(
        "an unrelated runtime message does NOT reach the coordinator entry",
        calls.length === 0,
        JSON.stringify({ calls })
    );

    const progress = {
        commandId: 1,
        mediaIdentity: {
            deviceId: "roku-HARNESS0001",
            loadGeneration: 1
        },
        receiverPhase: "requested",
        receiverDispatchStartedAt: 1000
    };
    listener({ subject: "main:bilibiliPlaybackProgress", data: progress });
    check(
        "the runtime progress message reaches the coordinator entry EXACTLY once, with the same payload",
        calls.length === 1 && calls[0] === progress,
        JSON.stringify({ calls })
    );

    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`\n${pass}/${pass + fail} checks passed`);
    if (fail) {
        console.log("\nfailures:");
        for (const f of failures) console.log("  -", f.name, f.detail || "");
        process.exit(1);
    }
}

main().catch(err => {
    console.error("runtimeRelay ERROR", err);
    process.exit(1);
});
