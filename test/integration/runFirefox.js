#!/usr/bin/env node
"use strict";

/**
 * Launches Firefox with the built extension and reports what the harness saw.
 *
 * This is the harness's startup validation: it answers, empirically, the
 * questions the design depends on -
 *
 *   1. does Firefox Developer Edition load this unsigned, sideloaded build?
 *   2. does it spawn the native host at all, i.e. did OUR user-level manifest
 *      win over the root-owned system manifest of the same name?
 *   3. do both connections (discovery and, later, session) show up as separate
 *      OS processes?
 *   4. do extension console logs reach our stdout (devtools.console.stdout.*)?
 *   5. does the discovery process find the fake Roku over real SSDP and start
 *      polling it over real ECP?
 *
 * Everything it observes comes from the wrapper's traces, never from a
 * simulation: the extension, the host and the relay are the real ones.
 *
 * Usage:
 *   node test/integration/runFirefox.js [--seconds 20] [--keep-profile] [--show]
 *
 * Exit code 0 means the extension loaded AND at least one host connection was
 * spawned through the wrapper.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const {
    defaultName,
    install,
    snapshot: snapshotUserManifest,
    restore: restoreUserManifest
} = require("./installManifest");

const FIREFOX_CANDIDATES = [
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox"
];

function parseArgs(argv) {
    const args = {
        seconds: 20,
        settle: 8,
        keepProfile: false,
        show: false,
        // Test-only: throw once Firefox and the fake Roku are up, to verify the
        // exit-time cleanup instead of trusting it (see --simulate-early-failure).
        simulateEarlyFailure: false,
        // Its OWN host name: this harness installs a user-level manifest, and it
        // must not shadow a real bridge install (see sessionHarness.js).
        name: `${defaultName}_harness`
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--seconds") args.seconds = Number(argv[++i]);
        else if (arg === "--settle") args.settle = Number(argv[++i]);
        else if (arg === "--keep-profile") args.keepProfile = true;
        else if (arg === "--simulate-early-failure")
            args.simulateEarlyFailure = true;
        else if (arg === "--show") args.show = true;
        else if (arg === "--name") args.name = argv[++i];
        else throw new Error(`runFirefox: unknown argument ${arg}`);
    }
    return args;
}

/** Preferences this harness needs, and why. */
function harnessPrefs() {
    return {
        // Unsigned sideloaded builds (Firefox Developer Edition/Nightly honour
        // this; Release ignores it, which is why the default binary is DE).
        "xpinstall.signatures.required": false,
        // Without these a sideloaded add-on is treated as not-from-the-store
        // and can be silently disabled.
        "extensions.autoDisableScopes": 0,
        "extensions.enabledScopes": 15,
        // The extension's own logs (logger.info/error) go to the Browser
        // Console; these two prefs mirror it to stdout so a headless run is
        // observable. Without them the harness would be blind to the relay.
        "devtools.console.stdout.chrome": true,
        "devtools.console.stdout.content": true,
        "browser.dom.window.dump.enabled": true,
        // Keep first-run noise out of the traces.
        "app.update.auto": false,
        "datareporting.policy.dataSubmissionEnabled": false,
        "toolkit.telemetry.enabled": false,
        "browser.shell.checkDefaultBrowser": false,
        "browser.startup.homepage_override.mstone": "ignore",
        "browser.startup.page": 0,
        "signon.rememberSignons": false,
        "extensions.getAddons.showPane": false
    };
}

function pickFirefox() {
    for (const candidate of FIREFOX_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
        "runFirefox: no Firefox found in " + FIREFOX_CANDIDATES.join(", ")
    );
}

/**
 * Builds the harness its OWN extension copy and zips it into an unsigned XPI.
 *
 * Never dist/: that directory belongs to the developer's build and packaging
 * (a package run replaces it with an artifact), and this harness must not
 * depend on it - nor shadow the real bridge, so the copy requests a host name
 * of its own (see sessionHarness.js for the same reasoning).
 */
function buildXpi(harnessDir) {
    const config = require(path.join(repoRoot, "bridge/config.json"));
    const hostName = `${config.applicationName}_harness`;
    const source = path.join(harnessDir, "build/extension");
    const built = spawnSync(
        process.execPath,
        [
            path.join(repoRoot, "extension/bin/build.js"),
            "--out-dir",
            source,
            "--bridge-name",
            hostName
        ],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
    );
    if (built.status !== 0) {
        throw new Error(
            "runFirefox: extension build failed: " +
                String(built.stderr || built.stdout).slice(-600)
        );
    }
    const xpiPath = path.join(harnessDir, `${defaultName}-extension.xpi`);
    fs.rmSync(xpiPath, { force: true });
    // `zip -r -X` from inside the directory keeps manifest.json at the root,
    // which is what an XPI requires.
    const result = spawnSync("zip", ["-r", "-X", "-q", xpiPath, "."], {
        cwd: source
    });
    if (result.status !== 0) {
        throw new Error("runFirefox: zip failed: " + result.stderr);
    }
    return xpiPath;
}

function makeProfile(harnessDir) {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-harness-prof-"));
    fs.mkdirSync(path.join(profileDir, "extensions"), { recursive: true });

    const prefs = harnessPrefs();
    fs.writeFileSync(
        path.join(profileDir, "user.js"),
        Object.entries(prefs)
            .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
            .join("\n") + "\n"
    );

    const xpiPath = buildXpi(harnessDir);
    // Sideloading by id is what makes a fixed-id extension load from a profile
    // directory without any UI interaction.
    const target = path.join(
        profileDir,
        "extensions",
        `${require(path.join(repoRoot, "bridge/config.json")).extensionId}.xpi`
    );
    fs.copyFileSync(xpiPath, target);
    return { profileDir, xpiPath, target };
}

function readNdjson(file) {
    if (!fs.existsSync(file)) return [];
    return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return { unparsable: line };
            }
        });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Every child this script starts, killed on exit.
 *
 * Registering the children is what makes an EARLY throw safe: without it, a
 * failure after the fake Roku and Firefox are up (waiting for the wrapper trace,
 * reading a log, an assertion) left both running - the fake Roku holding port
 * 8060 and a browser holding a temporary profile. The graceful stop at the end
 * of main() only covers the path that reaches it.
 */
const ownedChildren = new Set();
function own(child) {
    ownedChildren.add(child);
    child.once("exit", () => ownedChildren.delete(child));
    return child;
}
function killOwnedChildren(signal = "SIGKILL") {
    for (const child of ownedChildren) {
        try {
            child.kill(signal);
        } catch {
            // Already gone.
        }
    }
}

/** Graceful stop + profile handling, shared by the happy path and any throw. */
async function stopChildren({ args, firefox, roku, profileDir }) {
    if (!firefox && !roku) return;
    try {
        firefox?.kill("SIGTERM");
        await sleep(1200);
        if (firefox && !firefox.killed) firefox.kill("SIGKILL");
        roku?.kill("SIGTERM");
    } catch {
        // Fall through to the exit handler, which SIGKILLs whatever is left.
    }
    if (args.keepProfile) {
        console.log("profile kept at:", profileDir);
    } else if (profileDir) {
        fs.rmSync(profileDir, { recursive: true, force: true });
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-harness-run-"));
    console.log("harness dir:", harnessDir);

    let profileDir;
    let firefox;

    // Private builds outside dist/ (never read/written by this harness) and an
    // isolated device-discovery port, so a developer's own bridge - searching on
    // 1900 - can never see this harness's fake Roku.
    const buildDir = path.join(harnessDir, "build");
    const built = spawnSync(
        process.execPath,
        [
            path.join(repoRoot, "bridge/bin/build.js"),
            "--out-dir",
            path.join(buildDir, "bridge")
        ],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
    );
    if (built.status !== 0) {
        throw new Error(
            "runFirefox: bridge build failed: " +
                String(built.stderr || built.stdout).slice(-600)
        );
    }
    const ssdpPort = 19008;
    {
        const browser = path.join(
            buildDir,
            "bridge/src/bridge/components/roku/deviceBrowser.js"
        );
        const text = fs.readFileSync(browser, "utf8");
        const marker = "const SSDP_PORT = 1900;";
        if (!text.includes(marker)) {
            throw new Error(
                `runFirefox: cannot isolate SSDP in ${browser} (marker not found)`
            );
        }
        fs.writeFileSync(
            browser,
            text.replace(marker, `const SSDP_PORT = ${ssdpPort};`)
        );
    }
    process.env.FX_HOST_ENTRY = path.join(
        buildDir,
        "bridge/fx_cast_bilibili_bridge.sh"
    );

    const manifestState = snapshotUserManifest({ name: args.name });
    let manifestRestored = false;
    const restoreManifest = reason => {
        // Idempotent: the signal handlers and the exit handler can both fire,
        // and a future restore step must not run twice either.
        if (manifestRestored) return;
        manifestRestored = true;
        try {
            for (const line of restoreUserManifest(manifestState))
                console.log(`native manifest (${reason}):`, line);
        } catch (err) {
            console.error("native manifest restore FAILED:", String(err));
        }
    };
    process.on("exit", () => {
        // Bail-out safety net for every path that does not reach the graceful
        // stop: an exception between the spawns and that stop left a browser
        // (holding a temporary profile) and the fake Roku (holding port 8060)
        // running. Same ownership model as sessionHarness.js.
        killOwnedChildren();
        if (!args.keepProfile && profileDir) {
            try {
                fs.rmSync(profileDir, { recursive: true, force: true });
            } catch {
                // A profile that cannot be removed must not mask the real error.
            }
        }
        restoreManifest("exit");
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => {
            restoreManifest(signal);
            process.exit(1);
        });
    }
    const { conflict } = install({ name: args.name });
    if (conflict) {
        console.log(
            "note: a system manifest of the same name exists (target " +
                conflict.target +
                "); the run below shows which one Firefox used."
        );
    }

    // The fake device first: the discovery process may poll it within a second
    // of startDiscovery, and a device that appears late would be indistinguishable
    // from one that was never found.
    const rokuHarnessDir = path.join(harnessDir, "fake-roku");
    fs.mkdirSync(rokuHarnessDir, { recursive: true });
    // `let`, and declared in main()'s scope, so the exit handler below can clean
    // up whatever exists at the moment the process ends - including when an
    // exception lands between the spawns and the graceful stop.
    let roku;
    roku = own(
        spawn(
        process.execPath,
        [
            path.join(__dirname, "fakeRoku.js"),
            "--harness-dir",
            rokuHarnessDir,
            // Not 1900: the developer's own bridge searches there, and this
            // fake device must not appear in their browser.
            "--ssdp-port",
            String(19008)
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
        )
    );
    let rokuControlPort;
    let rokuStdout = "";
    roku.stdout.on("data", chunk => {
        rokuStdout += chunk.toString();
        const line = rokuStdout
            .split("\n")
            .find(candidate => candidate.includes('"ready":true'));
        if (line && !rokuControlPort) {
            rokuControlPort = JSON.parse(line).controlPort;
        }
    });
    roku.stderr.on("data", chunk => {
        process.stderr.write("[fake-roku] " + chunk);
    });
    const rokuReadyDeadline = Date.now() + 5000;
    while (!rokuControlPort && Date.now() < rokuReadyDeadline) {
        await sleep(100);
    }
    if (!rokuControlPort) {
        roku.kill("SIGKILL");
        throw new Error(
            "runFirefox: the fake Roku did not start (port 8060 in use, or SSDP/ECP blocked). " +
                "A run without it is not deterministic: the bridge will happily discover and " +
                "poll a REAL Roku on the LAN instead, and every assertion below would be about " +
                "a device this harness does not control."
        );
    }
    console.log("fake roku control port:", rokuControlPort);

    const firefoxPath = pickFirefox();
    const madeProfile = makeProfile(harnessDir);
    profileDir = madeProfile.profileDir;
    const target = madeProfile.target;
    console.log("firefox:", firefoxPath);
    console.log("profile:", profileDir);
    console.log("sideloaded:", target);

    const stdoutLog = fs.createWriteStream(path.join(harnessDir, "firefox-stdout.log"));
    firefox = own(
        spawn(
        firefoxPath,
        // `-headless` keeps the run out of the way; native messaging and
        // extension background pages work headless.
        ["-headless", "-no-remote", "-profile", profileDir, "about:blank"],
        {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                // Inherited by the native hosts Firefox spawns, which is how the
                // wrapper learns where to trace.
                FX_HARNESS_DIR: harnessDir,
                ...(args.show ? {} : {})
            }
        }
        )
    );
    firefox.stdout.pipe(stdoutLog);
    firefox.stderr.pipe(stdoutLog);

    if (args.simulateEarlyFailure) {
        // Test-only fault injection: the exact shape of the gap this covers -
        // both children are up, nothing has cleaned up yet, and the code throws
        // before reaching the graceful stop. `--simulate-early-failure` must
        // still leave no browser, no fake Roku on 8060 and no temporary profile.
        throw new Error(
            "runFirefox: simulated early failure after both children started (test-only)"
        );
    }

    // Wait for the wrapper traces, polling rather than sleeping a fixed time:
    // the point is to observe WHEN the host appears, not to assume it did.
    const spawnsFile = path.join(harnessDir, "spawns.ndjson");
    const began = Date.now();
    while (Date.now() - began < args.seconds * 1000) {
        if (readNdjson(spawnsFile).length > 0) break;
        await sleep(250);
    }
    // Settle window: the first spawn is the version probe, and the persistent
    // discovery connection follows it. Reporting at the first spawn would show
    // exactly half of the wiring.
    await sleep(args.settle * 1000);
    const spawns = readNdjson(spawnsFile);

    const bridged = spawns.filter(entry => entry.event === undefined);
    const extLog = fs.readFileSync(path.join(harnessDir, "firefox-stdout.log"), "utf8");

    console.log("\n--- what the harness observed ---");
    console.log(
        "host connections spawned through the wrapper:",
        bridged.length,
        JSON.stringify(bridged.map(entry => ({ pid: entry.pid, entry: path.basename(entry.entry) })))
    );
    console.log(
        "distinct PIDs:",
        new Set(bridged.map(entry => entry.pid)).size
    );
    for (const entry of bridged) {
        const inbound = readNdjson(path.join(harnessDir, `conn-${entry.pid}-in.ndjson`));
        const outbound = readNdjson(path.join(harnessDir, `conn-${entry.pid}-out.ndjson`));
        console.log(
            `  pid ${entry.pid}: ${inbound.length} firefox->host, ${outbound.length} host->firefox`,
            "subjects:",
            JSON.stringify([
                ...new Set([...inbound, ...outbound].map(m => m.subject).filter(Boolean))
            ].slice(0, 12))
        );
    }
    const rokuRequests = readNdjson(
        path.join(rokuHarnessDir, "fake-roku-requests.ndjson")
    );
    const byPath = {};
    for (const entry of rokuRequests) {
        byPath[entry.path] = (byPath[entry.path] ?? 0) + 1;
    }
    console.log(
        "fake roku: " +
            readNdjson(path.join(rokuHarnessDir, "fake-roku-msearch.ndjson")).length +
            " M-SEARCH seen, ECP requests by path:",
        JSON.stringify(byPath)
    );

    const extensionMentions = extLog
        .split("\n")
        .filter(line => /fx_cast|bridge|native|Roku/i.test(line));
    console.log(
        "extension/browser console lines captured:",
        extensionMentions.length
    );
    for (const line of extensionMentions.slice(0, 10)) {
        console.log("   |", line.slice(0, 200));
    }

    await stopChildren({ args, firefox, roku, profileDir });

    // "Found and polled" is the assertion that matters here: it is the proof
    // that the discovery process ran real SSDP and real ECP through the real
    // connection, not that a socket happened to open.
    const devicesFound = [];
    for (const entry of bridged) {
        for (const message of readNdjson(
            path.join(harnessDir, `conn-${entry.pid}-out.ndjson`)
        )) {
            if (message.subject === "main:deviceUp") {
                devicesFound.push(message.message?.data?.deviceId);
            }
        }
    }
    const fakeDeviceId = "roku-HARNESS0001";
    const foundFake = devicesFound.includes(fakeDeviceId);
    const polledRoku = rokuRequests.some(
        entry => entry.path === "/query/media-player"
    );
    console.log("devices discovered:", JSON.stringify(devicesFound));
    console.log(
        "the fake device was discovered and polled:",
        foundFake && polledRoku
    );
    if (!foundFake && devicesFound.length) {
        console.log(
            "note: other devices were found (a real Roku on the LAN?). They do not"
        );
        console.log(
            "      count as success here - the harness must control the device."
        );
    }
    const ok = bridged.length > 0 && foundFake && polledRoku;
    console.log(
        "\n" +
            (ok
                ? "PASS: extension loaded, host spawned through the wrapper, fake Roku discovered and polled"
                : `FAIL: connections=${bridged.length}, fake device discovered=${foundFake}, polled=${polledRoku}` +
                  " (see firefox-stdout.log in the harness dir)")
    );
    // Explicit, not only via the exit handler: if some unrelated handle keeps
    // the process alive, the user-level directory must already be clean. The
    // exit handler stays as the safety net for early throws.
    restoreManifest("run finished");
    process.exit(ok ? 0 : 1);
}

main().catch(err => {
    console.error("runFirefox ERROR", err);
    process.exit(1);
});
