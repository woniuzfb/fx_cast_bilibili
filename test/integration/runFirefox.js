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
const { defaultName, install } = require("./installManifest");

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
        name: defaultName
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--seconds") args.seconds = Number(argv[++i]);
        else if (arg === "--settle") args.settle = Number(argv[++i]);
        else if (arg === "--keep-profile") args.keepProfile = true;
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

/** Zips the built extension into an unsigned XPI next to the profile. */
function buildXpi(harnessDir) {
    const source = path.join(repoRoot, "dist/extension");
    if (!fs.existsSync(path.join(source, "manifest.json"))) {
        throw new Error(
            "runFirefox: dist/extension has no manifest.json - run `npm run build:extension` first"
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
        `${require(path.join(repoRoot, "dist/bridge/config.json")).extensionId}.xpi`
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-harness-run-"));
    console.log("harness dir:", harnessDir);

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
    const roku = spawn(
        process.execPath,
        [
            path.join(__dirname, "fakeRoku.js"),
            "--harness-dir",
            rokuHarnessDir
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
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
    const { profileDir, target } = makeProfile(harnessDir);
    console.log("firefox:", firefoxPath);
    console.log("profile:", profileDir);
    console.log("sideloaded:", target);

    const stdoutLog = fs.createWriteStream(path.join(harnessDir, "firefox-stdout.log"));
    const firefox = spawn(
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
    );
    firefox.stdout.pipe(stdoutLog);
    firefox.stderr.pipe(stdoutLog);

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

    firefox.kill("SIGTERM");
    await sleep(1200);
    if (!firefox.killed) firefox.kill("SIGKILL");
    roku.kill("SIGTERM");
    if (!args.keepProfile) {
        fs.rmSync(profileDir, { recursive: true, force: true });
    } else {
        console.log("profile kept at:", profileDir);
    }

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
    process.exit(ok ? 0 : 1);
}

main().catch(err => {
    console.error("runFirefox ERROR", err);
    process.exit(1);
});
