#!/usr/bin/env node
"use strict";

/**
 * Stage 1 of the session half: can the REAL page half create a session?
 *
 * Red/green target (no state-machine assertions yet):
 *
 *   test page -> Cast SDK intercepted by the extension -> requestSession()
 *   -> the extension's receiver-selector page -> the harness clicks the fake
 *   Roku's row -> castManager.startSession -> session native host
 *   -> a session-specific message on that connection
 *
 * Assertions: the session connection's PID differs from the discovery PID, the
 * deviceId acted on is the fake one (never a LAN Roku), both traces are
 * non-empty, the page's own success callback ran, and the fake device saw ECP.
 *
 * Surface deviations, deliberate and both forced by the platform:
 *
 *   1. The selector is the extension's toolbar popup (`action.default_popup`),
 *      which WebDriver can neither open nor click. The harness opens the SAME
 *      page (`ui/popup/index.html`) in a background tab, so the selector's
 *      logic, its port protocol and its DOM handlers are all real; only the
 *      surface differs.
 *   2. That page decides which tab it belongs to from the ACTIVE tab of its own
 *      window, so the harness arranges: popup tab created inactive, sender tab
 *      active, popup tab navigated afterwards (delayed, because activating the
 *      console tab to run the script would make IT the active tab instead).
 *
 * Facts learned the hard way, all encoded below:
 *   - WebDriver refuses privileged navigations unless Firefox starts with
 *     system access (MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, what geckodriver's
 *     --allow-system-access sets);
 *   - `contentInitial.js`, the content script that rewrites the Cast SDK src so
 *     the extension can intercept it, is registered from the stored whitelist
 *     AT STARTUP, so the whitelist must be written and the browser restarted;
 *   - `executeScript` serializes a returned promise as null, so anything that
 *     awaits a browser API must go through `executeAsyncScript`.
 *
 * Usage:
 *   node test/integration/sessionHarness.js [--keep-profile]
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const { defaultName, install } = require("./installManifest");

const webdriver = require(path.join(repoRoot, "node_modules/selenium-webdriver"));
const firefox = require(path.join(
    repoRoot,
    "node_modules/selenium-webdriver/firefox"
));

/**
 * Selenium Manager's download directory, shared across runs on purpose: it is
 * cached tooling, not run state, and a per-run directory meant the harness
 * re-downloaded geckodriver (or looked for it in an empty directory).
 */
/** Servers the harness started itself; `driver.quit()` does not stop them. */
const ownedGeckodrivers = [];
/** Children the harness spawned (the fake Roku), reaped on any exit path. */
const ownedChildren = [];

const SELENIUM_CACHE = path.join(
    os.tmpdir(),
    "fx-harness-selenium-cache"
);

const FAKE_DEVICE_ID = "roku-HARNESS0001";
const FAKE_DEVICE_NAME = "Harness Roku";
const EXTENSION_ID = require(path.join(repoRoot, "dist/bridge/config.json"))
    .extensionId;
/** Pinned so the harness can address the extension's own pages before launch. */
const EXTENSION_UUID = "8a1f3c2e-9d4b-4c7a-9f21-2b6c5d8e0a13";

const popupUrl = `moz-extension://${EXTENSION_UUID}/ui/popup/index.html`;
const optionsUrl = `moz-extension://${EXTENSION_UUID}/ui/options/index.html`;

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function parseArgs(argv) {
    const args = {
        keepProfile: false,
        extensionDir: path.join(repoRoot, "dist/extension"),
        phaseAOnly: false,
        startupSynthesis: false,
        mediaBeforeGeneration: false,
        generationAdvance: false,
        instrument: false
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--keep-profile") args.keepProfile = true;
        else if (argv[i] === "--phase-a-only") args.phaseAOnly = true;
        else if (argv[i] === "--startup-synthesis") args.startupSynthesis = true;
        else if (argv[i] === "--media-before-generation")
            args.mediaBeforeGeneration = true;
        else if (argv[i] === "--generation-advance")
            args.generationAdvance = true;
        else if (argv[i] === "--extension-dir") args.extensionDir = argv[++i];
        else if (argv[i] === "--instrument-content-initial")
            args.instrument = true;
        else throw new Error(`sessionHarness: unknown argument ${argv[i]}`);
    }
    return args;
}

/** Serves the sender page: file:// is never a whitelisted SDK origin. */
function startSenderServer() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, "http://x").pathname;
        const name = path.basename(pathname);
        const file = path.join(__dirname, "pages", name);
        if (!fs.existsSync(file)) {
            // The LOAD's contentId points here. Serving a minimal playlist keeps
            // the URL legitimate for the session (which validates the scheme)
            // without a 404 disturbing whatever later uses it.
            if (pathname === "/harness-stage2.m3u8") {
                res.writeHead(200, {
                    "content-type": "application/vnd.apple.mpegurl"
                });
                res.end(
                    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n" +
                        "#EXTINF:6.0,\nsegment0.ts\n#EXT-X-ENDLIST\n"
                );
                return;
            }
            res.writeHead(404).end("not found");
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(file));
    });
    return new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => {
            resolve({
                server,
                origin: `http://127.0.0.1:${server.address().port}`
            });
        });
    });
}

function makeProfile(harnessDir, extensionDir) {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-harness-sess-"));
    fs.mkdirSync(path.join(profileDir, "extensions"), { recursive: true });

    const prefs = {
        "xpinstall.signatures.required": false,
        "extensions.autoDisableScopes": 0,
        "extensions.enabledScopes": 15,
        "extensions.webextensions.uuids": JSON.stringify({
            [EXTENSION_ID]: EXTENSION_UUID
        }),
        "devtools.console.stdout.chrome": true,
        "devtools.console.stdout.content": true,
        "browser.dom.window.dump.enabled": true,
        "app.update.auto": false,
        "datareporting.policy.dataSubmissionEnabled": false,
        "toolkit.telemetry.enabled": false,
        "browser.shell.checkDefaultBrowser": false,
        "browser.startup.homepage_override.mstone": "ignore",
        "browser.startup.page": 0,
        "signon.rememberSignons": false
    };
    fs.writeFileSync(
        path.join(profileDir, "user.js"),
        Object.entries(prefs)
            .map(
                ([k, v]) =>
                    `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`
            )
            .join("\n") + "\n"
    );

    const xpiPath = path.join(harnessDir, "extension.xpi");
    const zipped = spawnSync("zip", ["-r", "-X", "-q", xpiPath, "."], {
        cwd: extensionDir
    });
    if (zipped.status !== 0) throw new Error("zip failed: " + zipped.stderr);
    fs.copyFileSync(
        xpiPath,
        path.join(profileDir, "extensions", `${EXTENSION_ID}.xpi`)
    );
    return profileDir;
}

/**
 * Runs geckodriver ourselves instead of letting the builder spawn it.
 *
 * Why: the extension's own console (where `registerContentScripts` failures and
 * every `logger.error` land) reaches the browser process's stdout, which
 * geckodriver owns. Selenium's builder gives us no handle on that process, and
 * `driver.manage().logs()` is not supported for Firefox ("HTTP method
 * allowed" / no log types), which left the harness blind exactly when it needed
 * the extension's error message. Owning geckodriver's stdio fixes that, and
 * `usingServer` keeps every other Selenium call identical.
 */
async function startFirefox(options, label, harnessDir) {
    console.log(`starting Firefox (${label})...`);
    const geckodriverPath = findGeckodriver(harnessDir);
    if (!geckodriverPath) {
        // Degrade instead of failing: the run is still useful, only the
        // extension console is missing. (The download normally happens on the
        // first WebDriver start into SELENIUM_CACHE.)
        console.log(
            `[${label}] geckodriver not found; letting Selenium spawn it (no console capture)`
        );
        const fallback = await new webdriver.Builder()
            .forBrowser("firefox")
            .setFirefoxOptions(options)
            .build();
        await fallback.manage().setTimeouts({ script: 45000 });
        return { driver: fallback, consoleLog: undefined };
    }
    const port = 20000 + Math.floor(Math.random() * 20000);
    const logFile = path.join(
        harnessDir,
        `geckodriver-${label.replace(/\W+/g, "-")}.log`
    );
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    const gecko = spawn(geckodriverPath, [`--port=${port}`, "-v"], {
        stdio: ["ignore", "pipe", "pipe"]
    });
    ownedGeckodrivers.push(gecko);
    gecko.stdout.pipe(logStream);
    gecko.stderr.pipe(logStream);
    process.env[`GECKO_${label}`] = String(gecko.pid);
    console.log(`[${label}] geckodriver pid ${gecko.pid}, log ${logFile}`);

    // Wait for the server to accept connections.
    const net = require("net");
    const deadline = Date.now() + 15000;
    for (;;) {
        const reachable = await new Promise(resolve => {
            const socket = net.connect(port, "127.0.0.1");
            socket.on("connect", () => {
                socket.destroy();
                resolve(true);
            });
            socket.on("error", () => resolve(false));
        });
        if (reachable) break;
        if (Date.now() > deadline) throw new Error("geckodriver did not listen");
        await sleep(200);
    }

    const driver = await new webdriver.Builder()
        .usingServer(`http://127.0.0.1:${port}`)
        .forBrowser("firefox")
        .setFirefoxOptions(options)
        .build();
    // The default 30s script timeout is shorter than the selector waits below.
    await driver.manage().setTimeouts({ script: 45000 });
    // Best effort: not every Firefox/geckodriver combination exposes the
    // browser console, so this is reported rather than relied upon.
    try {
        const types = await driver.manage().logs().getAvailableLogTypes();
        console.log(`[${label}] available log types:`, JSON.stringify(types));
    } catch (err) {
        console.log(`[${label}] log types unavailable: ${err.message}`);
    }
    return { driver, consoleLog: logFile };
}

/** The geckodriver Selenium Manager downloaded, wherever it put it. */
function findGeckodriver(harnessDir) {
    const roots = [SELENIUM_CACHE, harnessDir];
    // Earlier runs used a per-run cache; reuse those rather than re-download.
    try {
        for (const entry of fs.readdirSync(os.tmpdir())) {
            if (entry.startsWith("fx-harness-s1-")) {
                roots.push(path.join(os.tmpdir(), entry));
            }
        }
    } catch {
        // Not fatal: the stable cache is checked first.
    }

    for (const root of roots) {
        const stack = [root];
        while (stack.length) {
            const dir = stack.pop();
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) stack.push(full);
                else if (entry.name === "geckodriver") return full;
            }
        }
    }
    return undefined;
}

/** Waits for a window handle whose URL contains `fragment`. */
async function findHandleByUrl(driver, fragment, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const handle of await driver.getAllWindowHandles()) {
            try {
                await driver.switchTo().window(handle);
                const url = await driver.getCurrentUrl();
                if (url.includes(fragment)) return handle;
            } catch {
                // The handle may have gone away between listing and switching.
            }
        }
        await sleep(300);
    }
    return undefined;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-harness-s1-"));
    console.log("harness dir:", harnessDir);
    install({ name: defaultName });
    // Firefox passes its environment to native hosts, so the wrappers trace
    // here. Forgetting this does not fail loudly - the wrappers fall back to a
    // shared temp directory, every trace assertion then reads an empty
    // directory, and the failure looks like "no connections at all".
    process.env.FX_HARNESS_DIR = harnessDir;

    // --- fake device -------------------------------------------------------
    const rokuDir = path.join(harnessDir, "fake-roku");
    fs.mkdirSync(rokuDir, { recursive: true });
    const roku = spawn(
        process.execPath,
        [path.join(__dirname, "fakeRoku.js"), "--harness-dir", rokuDir],
        { stdio: ["ignore", "pipe", "pipe"] }
    );
    ownedChildren.push(roku);
    let rokuReady = false;
    let rokuControlPort;
    let rokuOut = "";
    roku.stdout.on("data", chunk => {
        rokuOut += chunk.toString();
        const line = rokuOut
            .split("\n")
            .find(candidate => candidate.includes('"ready":true'));
        if (line) {
            rokuReady = true;
            rokuControlPort = JSON.parse(line).controlPort;
        }
    });
    roku.stderr.on("data", chunk => process.stderr.write("[fake-roku] " + chunk));
    for (let i = 0; i < 60 && !rokuReady; i++) await sleep(100);
    if (!rokuReady) {
        roku.kill("SIGKILL");
        throw new Error(
            "sessionHarness: the fake Roku did not start (port 8060 busy?). " +
                "A real Roku on the LAN is not a valid substitute."
        );
    }

    const { server, origin } = await startSenderServer();
    console.log("sender origin:", origin);

    // --- Stage 0: the artifact must be the code under review --------------
    //
    // Reading current source while the browser runs a stale bundle produces
    // conclusions about neither, so the markers the current source is supposed
    // to emit are asserted BEFORE anything is launched. `--extension-dir`
    // controls are labelled as such rather than silently accepted.
    const backgroundBundle = path.join(
        args.extensionDir,
        "background/background.js"
    );
    if (!fs.existsSync(backgroundBundle)) {
        throw new Error(
            `sessionHarness: no background bundle at ${backgroundBundle} - run npm run build:extension`
        );
    }
    const requiredBundleMarkers = [
        "bridge:rokuSetLoadGeneration",
        "bridge:rokuSetSessionMedia",
        "load-generation-began"
    ];
    const bundleText = fs.readFileSync(backgroundBundle, "utf8");
    const missingMarkers = requiredBundleMarkers.filter(
        marker => !bundleText.includes(marker)
    );
    if (missingMarkers.length) {
        throw new Error(
            `sessionHarness: the extension bundle is stale - missing ${missingMarkers.join(", ")}`
        );
    }
    const bundleHash = require("crypto")
        .createHash("sha256")
        .update(bundleText)
        .digest("hex");
    console.log(
        "stage 0: bundle fresh",
        JSON.stringify({
            extensionDir: args.extensionDir,
            backgroundSha256: bundleHash.slice(0, 16),
            gitHead: (() => {
                try {
                    return require("child_process")
                        .execSync("git rev-parse --short HEAD", {
                            cwd: repoRoot
                        })
                        .toString()
                        .trim();
                } catch {
                    return "unknown";
                }
            })()
        })
    );

    // --- ungated instrumentation of the TEST COPY only --------------------
    //
    // `logRokuDebug` is gated by a debug option whose timing made an earlier
    // "the log line is absent" conclusion unreliable, so these markers use
    // console.log, which is not gated, and read state at the call site instead
    // of inferring it. The copy lives in the harness directory; dist/ is never
    // touched and this is not production behaviour.
    let extensionDir = args.extensionDir;
    {
        extensionDir = path.join(harnessDir, "extension-instrumented");
        fs.cpSync(args.extensionDir, extensionDir, { recursive: true });
        const patch = (relPath, marker, build) => {
            const file = path.join(extensionDir, relPath);
            const original = fs.readFileSync(file, "utf8");
            const index = original.indexOf(marker);
            if (index === -1) {
                throw new Error(
                    `sessionHarness: cannot instrument ${relPath} (marker not found): ${marker}`
                );
            }
            const at = index + marker.length;
            fs.writeFileSync(
                file,
                original.slice(0, at) + build() + original.slice(at)
            );
        };
        // Did the LOAD generation hook run at all, and was the bridge port
        // available at that instant?
        patch(
            "background/background.js",
            "beginRokuMediaLoad(deviceId) {",
            () =>
                "\nconsole.info('[harness] beginRokuMediaLoad', JSON.stringify({deviceId, hasBridgePort: Boolean(this.bridgePort)}));"
        );
        if (args.mediaBeforeGeneration) {
            // Deterministic reordering, no sleeps. The hold decision is made
            // synchronously at the method's entry - it cannot read storage to
            // find out whether it is in hold mode, because the production post
            // would already have escaped by the time an async read resolved, so
            // the mode is baked in at instrumentation time instead.
            //
            // ONE controller per device+generation: refresh replays call this
            // same function for the same generation, and a timer per call would
            // let several of them race to send, making "which release sent what"
            // undecidable. Later calls refresh the port the release will use.
            // A released key falls through to the production path, so same-
            // generation replays keep their production semantics afterwards.
            patch(
                "background/background.js",
                "setRokuLoadGenerationOnBridge(deviceId, loadGeneration) {",
                () => "\n" + `if (deviceId === 'roku-HARNESS0001') { const self = this; self.__fxHarnessHolds = self.__fxHarnessHolds || {}; self.__fxHarnessReleased = self.__fxHarnessReleased || {}; const key = deviceId + ':' + loadGeneration; if (!self.__fxHarnessReleased[key]) { let entry = self.__fxHarnessHolds[key]; if (!entry) { entry = { deviceId: deviceId, loadGeneration: loadGeneration }; self.__fxHarnessHolds[key] = entry; entry.timer = setInterval(() => { browser.storage.local.get(['__fxHarnessReleaseHeldGeneration', '__fxHarnessDiagnosticRunId']).then(r => { const rel = r && r.__fxHarnessReleaseHeldGeneration; const runId = r && r.__fxHarnessDiagnosticRunId; if (!rel || rel.deviceId !== entry.deviceId || rel.loadGeneration !== entry.loadGeneration || rel.runId !== runId) return; const port = entry.latestBridgePort || self.bridgePort; try { port.postMessage({ subject: 'bridge:rokuSetLoadGeneration', data: { deviceId: entry.deviceId, loadGeneration: entry.loadGeneration } }); clearInterval(entry.timer); self.__fxHarnessReleased[key] = true; delete self.__fxHarnessHolds[key]; void browser.storage.local.set({ __fxHarnessGenerationReleased: { runId: runId, deviceId: entry.deviceId, loadGeneration: entry.loadGeneration, at: Date.now() } }); } catch (e) { void browser.storage.local.set({ __fxHarnessReleaseFailed: { runId: runId, deviceId: entry.deviceId, loadGeneration: entry.loadGeneration, error: String(e) } }); } }).catch(() => {}); }, 200); } entry.latestBridgePort = this.bridgePort; void browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => browser.storage.local.set({ __fxHarnessHeldGeneration: { runId: r && r.__fxHarnessDiagnosticRunId, deviceId: deviceId, loadGeneration: loadGeneration, at: Date.now() } })).catch(() => {}); return; } }`
            );
        }
        patch(
            "background/background.js",
            "setRokuLoadGenerationOnBridge(deviceId, loadGeneration) {",
            () =>
                "\nconsole.info('[harness] setRokuLoadGenerationOnBridge', JSON.stringify({deviceId, loadGeneration, hasBridgePort: Boolean(this.bridgePort)}));"
        );
        // POSITIVE CONTROL for the background console channel: this method is
        // known to have run (the wire trace shows session-media-input), so if
        // its marker appears the channel works and the silence of the other
        // background markers becomes meaningful. Absent, no negative conclusion
        // about production flow may be drawn at all.
        // Background markers CANNOT use browser.runtime.sendMessage: Firefox
        // does not deliver a message back to the context that sent it, which is
        // why the control marker on a call site proven to run never appeared.
        // storage.local is an independent channel: the background writes, the
        // options page reads it back, and nothing depends on the console, on a
        // logger switch, or on the popup being alive.
        //
        // Every marker carries this run's id and only matching ids are read, so
        // a stale value from an earlier run cannot pass as evidence; the keys are
        // written one each rather than as a shared array, so concurrent markers
        // cannot overwrite one another.
        // The background picks the run id up from a value the harness sets in
        // the shared profile storage before the run; the keys are cleared then
        // too, so a marker from an earlier run cannot be read as this one's.
        const storageMarker = (key, fields) =>
            "\ntry { browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => browser.storage.local.set({ " +
            `${key}: { runId: r && r.__fxHarnessDiagnosticRunId, ${fields}, at: Date.now() } })).catch(() => {}); } catch (e) {}`;
        patch(
            "background/background.js",
            "this.bridgePort = await bridge_default.connect();",
            () =>
                "\ntry { this.__fxHarnessBridgeGeneration = (this.__fxHarnessBridgeGeneration || 0) + 1; } catch (e) {}" +
                storageMarker(
                    "__fxHarnessBridgeConnected",
                    "bridgeGeneration: this.__fxHarnessBridgeGeneration ?? null"
                )
        );
        patch(
            "background/background.js",
            "onBridgeDisconnect = () => {",
            () =>
                storageMarker(
                    "__fxHarnessBridgeDisconnected",
                    "bridgeGeneration: this.__fxHarnessBridgeGeneration ?? null, bridgePortStillSet: Boolean(this.bridgePort), portError: this.bridgePort && this.bridgePort.error ? String(this.bridgePort.error.message || this.bridgePort.error) : null"
                )
        );
        patch(
            "background/background.js",
            "async refresh() {",
            () =>
                storageMarker(
                    "__fxHarnessBridgeRefresh",
                    "bridgeGeneration: this.__fxHarnessBridgeGeneration ?? null"
                )
        );
        patch(
            "background/background.js",
            "replayRokuLoadGenerations() {",
            () =>
                storageMarker(
                    "__fxHarnessBridgeReplay",
                    "bridgeGeneration: this.__fxHarnessBridgeGeneration ?? null, identityCount: currentRokuMediaIdentities().length"
                )
        );
        // The click-time state snapshot goes through popupLog's runtime channel,
        // the only one proven to reach the captured output (the popup's own
        // console is not mirrored, and a background runtime message is not
        // delivered back to the sender).
        patch("ui/popup/index.js", "onReceiverCast(device) {", () => {
            const fields = [
                "hasSelectorContext",
                "selectionRequiresRefresh",
                "mediaType",
                "availableMediaTypes",
                "isAppMediaTypeAvailable"
            ].join(", ");
            return (
                "\ntry { browser.runtime.sendMessage({ subject: 'popup:debugLog'," +
                " data: { level: 'info', message: '[harness] onReceiverCast-state'," +
                ` data: { ${fields}, deviceId: device && device.id, deviceType: device && device.deviceType } } }); } catch (e) {}` +
                // Run-bound proof that this run's extension storage is writable and
                // readable: the background's control marker cannot serve that role
                // when no session media is ever synced.
                "\ntry { void browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => browser.storage.local.set({ __fxHarnessClickStorageControl: { runId: r && r.__fxHarnessDiagnosticRunId, deviceId: device && device.id, deviceType: device && device.deviceType, at: Date.now() } })).catch(() => {}); } catch (e) {}"
            );
        });
        // Gate B: was a load generation actually created for this device?
        patch(
            "background/background.js",
            "nextRokuLoadGeneration(deviceId);",
            () =>
                storageMarker(
                    "__fxHarnessLoadGenerationBegan",
                    "deviceId, loadGeneration"
                )
        );
        {
            // A ONE-TIME storage.onChanged listener, installed on the first bridge
            // message and guarded by a flag. The previous version polled
            // storage.local on EVERY bridge message, which (a) does async work for
            // a request that usually is not there - a pause this harness has no
            // business injecting before selector binding, where the popup's own
            // watchdog is 6s, (b) can let two messages read the same request
            // before the remove lands and advance the generation twice, and
            // (c) only works if another bridge message happens to arrive. The
            // listener does nothing at all until a request is written.
            patch("background/background.js", "onBridgeMessage = (message) => {", () => {
                const code =
                    "\nif (!this.__fxHarnessControlInstalled) { this.__fxHarnessControlInstalled = true; this.__fxHarnessHandledRequests = this.__fxHarnessHandledRequests || {};" +
                    " try { browser.storage.onChanged.addListener((changes, area) => { if (area !== 'local') return; const self = this;" +
                    " browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => { const runId = r && r.__fxHarnessDiagnosticRunId;" +
                    " const adv = changes.__fxHarnessAdvanceGenerationRequest && changes.__fxHarnessAdvanceGenerationRequest.newValue;" +
                    " if (adv && adv.runId === runId && adv.deviceId && !self.__fxHarnessHandledRequests[adv.requestId]) {" +
                    " self.__fxHarnessHandledRequests[adv.requestId] = true;" +
                    " const readGen = () => { try { const id = (typeof currentRokuMediaIdentity === 'function') ? currentRokuMediaIdentity(adv.deviceId) : null; return id ? id.loadGeneration : null; } catch (e) { return null; } };" +
                    " const beforeGeneration = readGen();" +
                    " if (beforeGeneration !== adv.expectedCurrentGeneration) {" +
                    " void browser.storage.local.set({ __fxHarnessAdvanceFailed: { runId: runId, requestId: adv.requestId, deviceId: adv.deviceId, expected: adv.expectedCurrentGeneration, actual: beforeGeneration, at: Date.now() } }); }" +
                    " else {" +
                    " try { self.beginRokuMediaLoad(adv.deviceId); } catch (e) {}" +
                    " void browser.storage.local.set({ __fxHarnessGenerationAdvanced: { runId: runId, requestId: adv.requestId, deviceId: adv.deviceId, previousGeneration: beforeGeneration, newGeneration: readGen(), at: Date.now() } }); } }" +
                    " const rep = changes.__fxHarnessReplayMediaRequest && changes.__fxHarnessReplayMediaRequest.newValue;" +
                    " if (rep && rep.runId === runId && rep.deviceId && !self.__fxHarnessHandledRequests[rep.requestId]) {" +
                    " self.__fxHarnessHandledRequests[rep.requestId] = true;" +
                    " try { self.bridgePort.postMessage({ subject: 'bridge:rokuSetSessionMedia', data: { deviceId: rep.deviceId, loadGeneration: rep.loadGeneration, ownerId: rep.ownerId, media: rep.media } });" +
                    " void browser.storage.local.set({ __fxHarnessMediaPosted: { runId: runId, requestId: rep.requestId, deviceId: rep.deviceId, loadGeneration: rep.loadGeneration, marker: rep.media && rep.media.customData && rep.media.customData.harnessMarker, at: Date.now() } }); }" +
                    " catch (e) { void browser.storage.local.set({ __fxHarnessMediaPostFailed: { runId: runId, requestId: rep.requestId, loadGeneration: rep.loadGeneration, error: String(e) } }); } }" +
                    " }).catch(() => {}); }); } catch (e) {} }" +
                    // Harness-triggered probe: the harness sends this AFTER it has
                    // written the run id, so the ack cannot be attributed to an
                    // early lifecycle event, and the ack carries the run id and
                    // probe id straight from the message. It proves, in this run,
                    // that the background executed and could write storage - the
                    // piece the popup-side control cannot prove.
                    "\nif (!this.__fxHarnessProbeInstalled) { this.__fxHarnessProbeInstalled = true;" +
                    " try { browser.runtime.onMessage.addListener((msg) => {" +
                    " if (!msg || msg.subject !== 'harness:backgroundStorageProbe') return;" +
                    " void browser.storage.local.set({ __fxHarnessBackgroundStorageControl: { runId: msg.data && msg.data.runId, probeId: msg.data && msg.data.probeId, at: Date.now() } }).catch(() => {});" +
                    " }); } catch (e) {} }";
                return code;
            });
        }
        {
            // Shared by EVERY mode: it is the Gate B diagnostic, not
            // generation-advance instrumentation. Recorded immediately BEFORE the
            // production Roku condition, so an anomalous run distinguishes "the
            // hook ran and did nothing" from "the hook was legally skipped because
            // the selection object does not carry deviceType === 'roku'". The
            // anchor is the condition itself and the marker goes before it, never
            // inside.
            patch(
                "background/background.js",
                'if (selection.device.deviceType === "roku") {',
                () =>
                    "\ntry { void browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => browser.storage.local.set({ __fxHarnessSelectionAtRokuBranch: { runId: r && r.__fxHarnessDiagnosticRunId, deviceId: selection.device.id, deviceType: selection.device.deviceType, mediaType: selection.mediaType, at: Date.now() } })).catch(() => {}); } catch (e) {}\n"
            );
        }
        patch(
            "background/background.js",
            "setRokuSessionMedia(deviceId, ownerId, media) {",
            () =>
                storageMarker(
                    "__fxHarnessBgControl",
                    "deviceId: String(deviceId), isClear: media === null"
                )
        );
        patch(
            "background/background.js",
            "syncRokuSessionMediaToBridge(deviceId, ownerId, media) {",
            () =>
                storageMarker(
                    "__fxHarnessSyncMediaEnter",
                    "deviceId, ownerId, isClear: media === null, hasBridgePort: Boolean(this.bridgePort), mediaPresent: media !== null"
                )
        );
        // After the identity is read, report whether one was found. Anchored on
        // the assignment statement, which is bundle text that survives minifying
        // (the call itself appears twice, the assignment once).
        patch(
            "background/background.js",
            "const identity = currentRokuMediaIdentity(deviceId);",
            () =>
                storageMarker(
                    "__fxHarnessSyncMediaIdentity",
                    "deviceId, hasIdentity: Boolean(identity), loadGeneration: identity ? identity.loadGeneration : null"
                )
        );
        for (const relPath of [
            "background/background.js",
            "ui/popup/index.js"
        ]) {
            const file = path.join(extensionDir, relPath);
            const parsed = spawnSync(process.execPath, ["--check", file]);
            if (parsed.status !== 0) {
                throw new Error(
                    `sessionHarness: instrumentation produced unparsable ${relPath}: ` +
                        String(parsed.stderr).slice(0, 300)
                );
            }
        }
        console.log("instrumented test copy:", extensionDir);
    }
    const profileDir = makeProfile(harnessDir, extensionDir);
    const firefoxPath = [
        "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
        "/Applications/Firefox.app/Contents/MacOS/firefox"
    ].find(candidate => fs.existsSync(candidate));
    if (!firefoxPath) throw new Error("sessionHarness: no Firefox found");

    const options = new firefox.Options()
        .setBinary(firefoxPath)
        .setProfile(profileDir);
    fs.mkdirSync(SELENIUM_CACHE, { recursive: true });
    process.env.SE_CACHE_PATH = SELENIUM_CACHE;
    // Privileged navigations (the extension's own pages) are refused unless
    // Firefox starts with system access allowed.
    process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

    let driver;
    let phaseAOnlyDone = false;
    try {
        // --- phase A: whitelist, then restart ---------------------------------
        let started = await startFirefox(options, "phase A: whitelist", harnessDir);
        driver = started.driver;
        const phaseAConsole = started.consoleLog;
        await driver.get(optionsUrl);
        await sleep(1500);
        check(
            "the harness can reach the extension's own pages",
            (await driver.getCurrentUrl()).startsWith("moz-extension://"),
            await driver.getCurrentUrl()
        );
        const whitelisted = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             (async () => {
                try {
                    const stored = await browser.storage.sync.get("options");
                    const options = stored.options || {};
                    // Baseline BEFORE any write: if this is already empty, the
                    // extension never registers content scripts here and our
                    // whitelist is not the cause. If it is non-empty and the
                    // read after the write is empty, our write broke it (most
                    // likely by replacing the whole options object).
                    const before = await browser.scripting.getRegisteredContentScripts();
                    const storedKeys = Object.keys(options);
                    const list = Array.isArray(options.siteWhitelist)
                        ? options.siteWhitelist.slice()
                        : [];
                    // Two shapes on purpose: match patterns are not supposed
                    // to carry ports, so the portless host/* form is the one
                    // that plausibly registers. Both are written and the
                    // REGISTERED result is reported below, without guessing.
                    // ONLY the portless form. Firefox match patterns reject
                    // ports ("Error: Invalid match pattern" from the extension
                    // background), and the extension unregisters its whitelist
                    // content script before re-registering, so one invalid
                    // pattern leaves it with NO content script at all - which is
                    // exactly what made arm A fail while arm B worked.
                    // 判定1: a WIDE pattern, in the integration profile only.
                    // If arm A starts working with it while the narrow portless
                    // pattern did not, the problem is host-pattern coverage for
                    // a non-default port, not contentInitial or its setter.
                    const candidates = [
                        "http://127.0.0.1/*",
                        "http://localhost/*",
                        "http://*/*"
                    ];
                    for (const pattern of candidates) {
                        if (!list.some(entry => entry.pattern === pattern)) {
                            list.push({ pattern, isEnabled: true });
                        }
                    }
                    options.siteWhitelist = list;
                    options.siteWhitelistEnabled = true;
                    await browser.storage.sync.set({ options });
                    // Poll the registry: the extension re-registers from the
                    // storage change, and a single read after a fixed wait made
                    // this check flake (the only unrelated red in a case-2 run).
                    let registered = [];
                    const deadline = Date.now() + 15000;
                    while (Date.now() < deadline) {
                        registered = await browser.scripting.getRegisteredContentScripts();
                        if (
                            registered.some(script =>
                                /whitelist-content/.test(script.id)
                            )
                        ) {
                            break;
                        }
                        await new Promise(r => setTimeout(r, 250));
                    }
                    done({
                        ok: true,
                        count: list.length,
                        storedKeys,
                        before: before.map(script => ({
                            id: script.id,
                            matches: script.matches
                        })),
                        after: registered.map(script => ({
                            id: script.id,
                            matches: script.matches,
                            js: script.js
                        }))
                    });
                } catch (err) {
                    done({ ok: false, error: String(err) });
                }
             })();`
        );
        check(
            "the sender origin was added to the extension's site whitelist",
            whitelisted && whitelisted.ok,
            JSON.stringify(whitelisted)
        );
        console.log(
            "stored option keys BEFORE the write:",
            JSON.stringify(whitelisted && whitelisted.storedKeys)
        );
        console.log(
            "registered content scripts BEFORE:",
            JSON.stringify(whitelisted && whitelisted.before)
        );
        console.log(
            "registered content scripts AFTER:",
            JSON.stringify(whitelisted && whitelisted.after)
        );
        // The registration must actually cover the test origin, or the SDK src
        // rewrite (and therefore the whole session flow) cannot happen.
        // The id alternates between -a and -b by design (that is what makes the
        // replacement atomic), so match the family rather than one id.
        const whitelistEntry = (whitelisted && whitelisted.after
            ? whitelisted.after
            : []
        ).find(script => /^whitelist-content(-[ab])?$/.test(script.id));
        check(
            "the extension re-registered its whitelist content script",
            Boolean(whitelistEntry && whitelistEntry.matches.length > 0),
            JSON.stringify(whitelisted && whitelisted.after)
        );

        // A user pattern that Firefox rejects must not take the whole
        // registration down. The old code unregistered the live script and then
        // handed the entire list to one register call, so a single invalid
        // pattern (a port is the easy way to write one) left the extension with
        // NO content script at all - for every site, including the defaults.
        const withBad = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             (async () => {
                try {
                    const stored = await browser.storage.sync.get("options");
                    const options = stored.options || {};
                    const list = Array.isArray(options.siteWhitelist)
                        ? options.siteWhitelist.slice()
                        : [];
                    // An invalid pattern: match patterns do not carry ports.
                    const bad = "http://127.0.0.1:1234/*";
                    if (!list.some(entry => entry.pattern === bad)) {
                        list.push({ pattern: bad, isEnabled: true });
                    }
                    options.siteWhitelist = list;
                    await browser.storage.sync.set({ options });
                    await new Promise(r => setTimeout(r, 2000));
                    const scripts = await browser.scripting.getRegisteredContentScripts();
                    done(
                        scripts
                            .filter(script => /whitelist-content/.test(script.id))
                            .map(script => ({ id: script.id, matches: script.matches }))
                    );
                } catch (err) {
                    done({ error: String(err) });
                }
             })();`
        );
        console.log(
            "whitelist scripts after adding an INVALID pattern:",
            JSON.stringify(withBad)
        );
        const surviving = Array.isArray(withBad)
            ? withBad.flatMap(script => script.matches || [])
            : [];
        check(
            "an invalid user pattern does not empty the whitelist registration",
            Array.isArray(withBad) &&
                withBad.length > 0 &&
                surviving.length > 0,
            JSON.stringify(withBad)
        );
        check(
            "the legal patterns survived the invalid one",
            surviving.includes("https://www.netflix.com/*") &&
                surviving.includes("http://127.0.0.1/*"),
            JSON.stringify(surviving)
        );
        check(
            "the invalid pattern itself was not registered",
            !surviving.includes("http://127.0.0.1:1234/*"),
            JSON.stringify(surviving)
        );

        if (args.phaseAOnly) {
            console.log("(--phase-a-only: stopping after the whitelist checks)");
            phaseAOnlyDone = true;
        }
        await driver.quit();
        driver = undefined;
        console.log(
            "restarted: the SDK-rewriting content script is registered at startup"
        );
        await sleep(1500);

        // --- phase B: the real run -------------------------------------------
        if (args.phaseAOnly) {
            console.log("(--phase-a-only: skipping phase B)");
            throw { phaseAOnly: true };
        }
        started = await startFirefox(options, "phase B: session", harnessDir);
        driver = started.driver;
        const phaseBConsole = started.consoleLog;

        // S: the sender page (must stay the active tab). Arm A is the
        // production entry; B and C are diagnostics/controls, run only if A
        // fails, so the pass path measures nothing but the real chain.
        // This FIRST load is snapshot T0 and is diagnostic only: it happens
        // before this session's dynamic registration has been confirmed, which
        // is exactly the ordering the timing question is about.
        const epoch = () => Math.random().toString(36).slice(2, 10);
        await driver.get(`${origin}/sender.html?arm=A&epoch=${epoch()}`);
        const senderTab = await driver.getWindowHandle();
        const t0 = await driver.executeScript(
            "return window.__HARNESS_SNAPSHOT__();"
        );
        console.log(
            "T0 (first load, before the registration is confirmed):",
            JSON.stringify({
                contentInitialRan: t0.contentInitialRan,
                assignedSrc: t0.assignedSrc,
                effectiveSrc: t0.effectiveSrc,
                scriptLoaded: t0.sdkScriptLoaded
            })
        );

        // O: an extension page, used only as the extension-side console (the
        // one place `browser.tabs.*` can be called from).
        await driver.switchTo().newWindow("tab");
        const consoleTab = await driver.getWindowHandle();
        await driver.get(optionsUrl);
        await sleep(1500);

        // The whitelist must be written in THIS session. Writing it in phase A
        // and restarting did NOT persist: phase B came up with the three
        // defaults only, so every page measured until now was never whitelisted
        // at all - which quietly invalidated the earlier "not injected" and
        // "host pattern is not the cause" readings. The storage change
        // re-registers the content script live, so nothing needs restarting.
        const writtenInB = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             (async () => {
                try {
                    const stored = await browser.storage.sync.get("options");
                    const options = stored.options || {};
                    const list = Array.isArray(options.siteWhitelist)
                        ? options.siteWhitelist.slice()
                        : [];
                    for (const pattern of [
                        "http://127.0.0.1/*",
                        "http://localhost/*",
                        "http://*/*"
                    ]) {
                        if (!list.some(entry => entry.pattern === pattern)) {
                            list.push({ pattern, isEnabled: true });
                        }
                    }
                    options.siteWhitelist = list;
                    options.siteWhitelistEnabled = true;
                    // The popup logs "popup:init received ->
                    // hasSelectorContext=true" only with this debug option on.
                    // That line is the extension's OWN statement that the
                    // requestSession-bound selector claimed the popup's port -
                    // the signal the click must wait for, instead of inferring
                    // readiness from device rows (which a generic popup renders
                    // too) or, worse, retrying clicks until one happens to work.
                    options.bilibiliDebugEnabled = true;
                    await browser.storage.sync.set({ options });
                    // Read back from storage, so "was it stored?" is answered
                    // rather than assumed.
                    const verify = await browser.storage.sync.get("options");
                    done({
                        ok: true,
                        stored: (verify.options?.siteWhitelist || []).map(e => e.pattern)
                    });
                } catch (err) {
                    done({ ok: false, error: String(err) });
                }
             })();`
        );
        check(
            "the whitelist write is stored in this session",
            Boolean(
                writtenInB &&
                    writtenInB.ok &&
                    writtenInB.stored.includes("http://*/*")
            ),
            JSON.stringify(writtenInB)
        );

        // P: the selector page, created inactive and navigated AFTER S is
        // active again.
        const popupTabId = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             (async () => {
                try {
                    const tab = await browser.tabs.create({
                        url: "about:blank",
                        active: false
                    });
                    setTimeout(() => {
                        browser.tabs.update(tab.id, {
                            url: ${JSON.stringify(popupUrl)}
                        });
                    }, 2500);
                    done(tab.id);
                } catch (err) {
                    done(null);
                }
             })();`
        );
        check(
            "the selector tab was created",
            typeof popupTabId === "number",
            String(popupTabId)
        );

        // Registration must be confirmed in THIS session: whether a dynamic
        // registration comes back after a browser restart is one of the facts
        // under test, so phase A's reading cannot be reused as evidence.
        const registration = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             const deadline = Date.now() + 20000;
             const tick = async () => {
                try {
                    const scripts = await browser.scripting.getRegisteredContentScripts();
                    const family = scripts.filter(s => /whitelist-content/.test(s.id));
                    const wide = family.some(s => (s.matches || []).includes("http://*/*"));
                    if (family.length && wide) {
                        done({ ok: true, family: family.map(s => ({ id: s.id, matches: s.matches })) });
                        return;
                    }
                    if (Date.now() > deadline) {
                        done({ ok: false, family: family.map(s => ({ id: s.id, matches: s.matches })) });
                        return;
                    }
                } catch (err) {
                    done({ ok: false, error: String(err) });
                    return;
                }
                setTimeout(tick, 250);
             };
             tick();`
        );
        check(
            "this session registered the whitelist script (http://*/* present)",
            Boolean(registration && registration.ok),
            JSON.stringify(registration)
        );

        // T1: a NEW document, navigated only after the registration above is
        // confirmed, so a difference between T0 and T1 is attributable to
        // ordering rather than to state left in a stale document.
        await driver.switchTo().window(senderTab);
        await driver.get(`${origin}/sender.html?arm=A&epoch=${epoch()}`);
        const waitForSdk = async ms =>
            driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 window.__HARNESS_WAIT_FOR_SDK__(${ms}).then(
                    () => done(true),
                    err => { window.__HARNESS_COLLECT_RESOURCES__(); done(String(err)); }
                 );`
            );
        const sdk = await waitForSdk(20000);
        // The evidence that separates the two remaining suspects, printed
        // whether or not the arm passes.
        const armASnapshot = await driver.executeScript(
            "return window.__HARNESS_SNAPSHOT__();"
        );
        const t1 = armASnapshot;
        const injected = state =>
            Boolean(state && state.contentInitialRan &&
                (state.contentInitialRan.head || state.contentInitialRan.tail));
        console.log(
            "timing verdict:",
            injected(t0)
                ? "T0 was already injected -> ordering is NOT the explanation"
                : injected(t1)
                ? "T0 not injected, T1 injected -> PAGE BEAT THE REGISTRATION"
                : t1.contentInitialRan && t1.contentInitialRan.head && !t1.contentInitialRan.tail
                ? "T1 injected and threw partway -> contentInitial itself throws"
                : t1.contentInitialRan && t1.contentInitialRan.head && t1.contentInitialRan.tail
                ? "T1 fully executed -> the src patch is what does not take"
                : "T1 still not injected -> ordering excluded; run the executeScript positive control"
        );
        console.log(
            "arm A evidence:",
            JSON.stringify({
                contentInitialRan: armASnapshot.contentInitialRan,
                assignedSrc: armASnapshot.assignedSrc,
                effectiveSrc: armASnapshot.effectiveSrc,
                scriptLoaded: armASnapshot.sdkScriptLoaded,
                resources: armASnapshot.resources,
                errors: armASnapshot.errors
            })
        );
        check(
            "arm A: the page got chrome.cast through the production chain",
            sdk === true,
            String(sdk)
        );
        if (sdk !== true) {
            // Separate the two halves of the chain instead of guessing: B skips
            // contentInitial (the src rewrite) and only needs the background
            // redirect, C must never work at all.
            const results = {};
            for (const arm of ["B", "C"]) {
                await driver.get(`${origin}/sender.html?arm=${arm}`);
                results[arm] = await waitForSdk(8000);
                const defined = await driver.executeScript(
                    "return Boolean(window.chrome && window.chrome.cast);"
                );
                results[arm + "_chromeCastPresent"] = defined;
            }
            console.log(
                "arm diagnostics:",
                JSON.stringify(results),
                "(A=full chain, B=background redirect only, C=unsupported URL control)"
            );
            check(
                "arm B: the background redirect alone works (so the break is contentInitial)",
                results.B === true,
                JSON.stringify(results)
            );
            check(
                "arm C: an unsupported SDK URL does not produce chrome.cast",
                results.C_chromeCastPresent === false,
                JSON.stringify(results)
            );
            // Back to the production arm's page for the rest of the flow.
            await driver.get(`${origin}/sender.html?arm=A`);
        }
        const initialized = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             window.__HARNESS_INITIALIZE__().then(() => done(true), err => done(String(err)));`
        );
        check(
            "chrome.cast.initialize() succeeded",
            initialized === true,
            String(initialized)
        );

        // --- requestSession, then drive the selector --------------------------
        const markCount = () => {
            if (!phaseBConsole || !fs.existsSync(phaseBConsole)) return 0;
            const text = fs.readFileSync(phaseBConsole, "utf8");
            return (
                text.split("popup:init received -> hasSelectorContext=true")
                    .length - 1
            );
        };

        // Baseline is taken BEFORE the call. Taken after, a fast binding would
        // already be inside `marksBefore` and the wait below would hang on a
        // mark that never arrives - a false timeout on the fast path.
        // --- diagnostic run id + clean slate, via the options page ----------
        const diagnosticRunId = `${Date.now()}-${process.pid}`;
        const diagnosticKeys = [
            "__fxHarnessBgControl",
            "__fxHarnessSyncMediaEnter",
            "__fxHarnessSyncMediaIdentity"
        ];
        await driver.switchTo().window(consoleTab);
        const prepared = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             (async () => {
                try {
                    await browser.storage.local.remove(${JSON.stringify(
                        diagnosticKeys
                    ).replace('"]', '", "__fxHarnessHeldGeneration", "__fxHarnessReleaseHeldGeneration", "__fxHarnessGenerationReleased", "__fxHarnessReleaseFailed", "__fxHarnessBackgroundStorageControl"]')});
                    await browser.storage.local.set({
                        __fxHarnessDiagnosticRunId: ${JSON.stringify(
                            diagnosticRunId
                        )}
                    });
                    done(true);
                } catch (err) {
                    done(String(err));
                }
             })();`
        );
        check(
            "the diagnostic run id is set and old markers cleared",
            prepared === true,
            String(prepared)
        );
        // Prove the background's own storage write path for THIS run before any
        // negative reading is allowed anywhere else.
        const backgroundProbeId = `bg-probe-${Date.now()}-${process.pid}`;
        await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             browser.runtime
                .sendMessage({
                    subject: "harness:backgroundStorageProbe",
                    data: {
                        runId: ${JSON.stringify(diagnosticRunId)},
                        probeId: ${JSON.stringify(backgroundProbeId)}
                    }
                })
                .then(() => done(true), err => done(String(err)));`
        );
        let backgroundControl;
        const probeDeadline = Date.now() + 15000;
        while (Date.now() < probeDeadline) {
            backgroundControl = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .get("__fxHarnessBackgroundStorageControl")
                    .then(v => done(v.__fxHarnessBackgroundStorageControl || null), err => done(null));`
            );
            if (
                backgroundControl &&
                backgroundControl.runId === diagnosticRunId &&
                backgroundControl.probeId === backgroundProbeId
            )
                break;
            backgroundControl = undefined;
            await sleep(250);
        }
        check(
            "Background storage control: this run's probe was answered by the background",
            Boolean(
                backgroundControl &&
                    backgroundControl.runId === diagnosticRunId &&
                    backgroundControl.probeId === backgroundProbeId
            ),
            JSON.stringify({
                got: backgroundControl || null,
                expectedRunId: diagnosticRunId,
                expectedProbeId: backgroundProbeId
            })
        );

        await driver.switchTo().window(senderTab);

        const marksBeforeSession = markCount();
        const requestAtSession = Date.now();
        await driver.executeScript(
            "window.__HARNESS_REQUEST_SESSION__().catch(() => {});"
        );

        // --- ordering: wait for the extension to say the selector is bound ----
        // (markCount is defined above, next to where the baseline is taken.)
        const marksBefore = marksBeforeSession;
        const requestAt = requestAtSession;
        let boundAt;
        const boundDeadline = Date.now() + 25000;
        while (Date.now() < boundDeadline) {
            if (markCount() > marksBefore) {
                boundAt = Date.now();
                break;
            }
            await sleep(250);
        }
        check(
            "the selector bound to this tab before the click (popup:init received)",
            Boolean(boundAt),
            `popup:init marks before=${marksBefore} now=${markCount()}`
        );

        const popupHandle = await findHandleByUrl(driver, "/ui/popup/", 20000);
        let clickAt;
        let clicked;
        // Guard against a vacuous pass: the popup page renders every device as
        // soon as it mounts, so finding and clicking a row proves nothing about
        // requestSession. The page must have asked first.
        // Read the page's own record from the SENDER tab: after the search above
        // the current context can be the popup or the console tab, where this
        // object does not exist - which reported "false" for a page that had in
        // fact already called requestSession.
        await driver.switchTo().window(senderTab);
        const askedForSession = await driver.executeScript(
            "return !!(window.__HARNESS_RESULT__ && window.__HARNESS_RESULT__.requestSessionCalled);"
        );
        check(
            "the page called requestSession before any selector interaction",
            askedForSession === true,
            String(askedForSession)
        );
        if (!askedForSession) {
            check(
                "the selector was driven (skipped: no requestSession)",
                false,
                "clicking here would have proved nothing"
            );
        } else if (popupHandle) {
            // Switch back to the selector BEFORE querying its DOM. The guard
            // above deliberately switched to the sender tab, and forgetting to
            // return left the click script running in the sender document -
            // which reported `rows: 0` and read like "the selector has no
            // devices" rather than "the harness is looking at the wrong page".
            let selectorUrl = "(switch failed)";
            try {
                await driver.switchTo().window(popupHandle);
                selectorUrl = await driver.getCurrentUrl();
            } catch (err) {
                selectorUrl = `(popup handle gone: ${err.message})`;
            }
            check(
                "the click runs in the selector page",
                selectorUrl.includes("/ui/popup/"),
                selectorUrl
            );
            clickAt = Date.now();
            clicked = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 const wanted = ${JSON.stringify(FAKE_DEVICE_NAME)};
                 const deadline = Date.now() + 30000;
                 const tick = () => {
                    const rows = Array.from(document.querySelectorAll("li.receiver"));
                    const row = rows.find(r => (r.textContent || "").includes(wanted));
                    if (row) {
                        const button = row.querySelector(".receiver__cast-button")
                            || row.querySelector("button");
                        (button || row).click();
                        done({
                            ok: true,
                            rows: rows.length,
                            clicked: button ? "cast-button" : "row",
                            // The assertion about WHICH device was clicked reads
                            // this; the script used to omit it, so the check
                            // could only ever fail.
                            text: (row.textContent || "").trim(),
                            wanted
                        });
                        return;
                    }
                    if (Date.now() > deadline) {
                        done({
                            ok: false,
                            rows: rows.length,
                            texts: rows.map(r => (r.textContent || "").trim().slice(0, 60)),
                            body: document.body.innerText.slice(0, 300)
                        });
                        return;
                    }
                    setTimeout(tick, 250);
                 };
                 tick();`
            );
            check(
                "the selector rendered the fake device and it was clicked",
                clicked && clicked.ok,
                JSON.stringify(clicked)
            );
        } else {
            check(
                "the selector page is addressable by WebDriver",
                false,
                "no popup handle"
            );
        }

        // --- Gate A: did the click go through the BOUND selector? ----------
        //
        // Without this, a click into the generic popup takes the
        // castCurrentTab/loadSender path, which creates the session (so Stage 1
        // still passes) but never calls beginRokuMediaLoad - and the missing
        // generation then looks exactly like a relay failure in Stage 2. That is
        // the flakiness this gate exists to name at its source.
        // The marker travels popup -> runtime message -> background logger ->
        // browser stdout -> log file, so it is not there the instant the click
        // returns; reading once made Gate A report "(no click-state marker)" for
        // a click that had in fact happened. Bounded polling, not a sleep.
        let clickStateRaw;
        const clickStateDeadline = Date.now() + 8000;
        while (Date.now() < clickStateDeadline) {
            if (phaseBConsole && fs.existsSync(phaseBConsole)) {
                const lines = fs
                    .readFileSync(phaseBConsole, "utf8")
                    .split("\n")
                    .filter(line => line.includes("onReceiverCast-state"));
                if (lines.length) {
                    clickStateRaw = lines[lines.length - 1];
                    break;
                }
            }
            await sleep(250);
        }
        const field = name => {
            if (!clickStateRaw) return undefined;
            const match = new RegExp(`${name}\\s*:\\s*(\\{[^}]*\\}|[^,)}]+)`).exec(
                clickStateRaw
            );
            return match ? match[1].trim() : undefined;
        };
        const pathA =
            field("hasSelectorContext") === "true" &&
            field("selectionRequiresRefresh") === "false" &&
            field("mediaType") === "1" &&
            String(field("deviceId") || "").includes(FAKE_DEVICE_ID);
        check(
            "Gate A: the click used the bound selector (path A, not the generic popup)",
            pathA,
            JSON.stringify({
                raw: clickStateRaw ? clickStateRaw.slice(-220) : "(no click-state marker)",
                hasSelectorContext: field("hasSelectorContext"),
                selectionRequiresRefresh: field("selectionRequiresRefresh"),
                mediaType: field("mediaType"),
                deviceId: field("deviceId")
            })
        );

        await driver.switchTo().window(senderTab);
        const pageResult = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             const deadline = Date.now() + 30000;
             const tick = () => {
                const r = window.__HARNESS_RESULT__;
                if (r && r.requestSessionSucceeded) { done(r); return; }
                if (Date.now() > deadline) { done(r); return; }
                setTimeout(tick, 250);
             };
             tick();`
        );
        check(
            "the page's requestSession success callback ran",
            pageResult && pageResult.requestSessionSucceeded === true,
            JSON.stringify(pageResult)
        );
        check(
            "the page has a non-empty session id",
            Boolean(pageResult && pageResult.sessionId),
            JSON.stringify(pageResult && pageResult.sessionId)
        );
        console.log(
            "ordering (ms):",
            JSON.stringify({
                requestSession: 0,
                selectorBound: boundAt ? boundAt - requestAt : null,
                click: clickAt ? clickAt - requestAt : null,
                pageCallback: Date.now() - requestAt
            })
        );
        check(
            "the clicked selector row was the fake device",
            Boolean(clicked && clicked.ok && /Harness Roku/.test(clicked.text || "")),
            JSON.stringify(clicked && clicked.text)
        );

        await sleep(4000);

        // The extension's own console: this is where a failed
        // `registerContentScripts`, a rejected match pattern or a cast error
        // would show up, and it is the only place that can explain a silently
        // empty content-script registry.
        for (const [label, file] of [
            ["phase A", phaseAConsole],
            ["phase B", phaseBConsole]
        ]) {
            if (!file || !fs.existsSync(file)) continue;
            const lines = fs
                .readFileSync(file, "utf8")
                .split("\n")
                .filter(line => /fx_cast|whitelist|registerContentScripts|Error|error/i.test(line));
            console.log(`--- ${label} console (${lines.length} interesting lines) ---`);
            for (const line of lines.slice(-25)) {
                console.log("   |", line.slice(0, 220));
            }
        }

        // --- what the real relay did -----------------------------------------
        const connections = readNdjson(path.join(harnessDir, "spawns.ndjson"))
            .filter(entry => entry.event === undefined)
            .map(entry => ({
                pid: entry.pid,
                inbound: readNdjson(
                    path.join(harnessDir, `conn-${entry.pid}-in.ndjson`)
                ),
                outbound: readNdjson(
                    path.join(harnessDir, `conn-${entry.pid}-out.ndjson`)
                )
            }));
        console.log(
            "connections:",
            JSON.stringify(
                connections.map(c => ({
                    pid: c.pid,
                    in: [...new Set(c.inbound.map(m => m.subject))].slice(0, 8),
                    outCount: c.outbound.length
                }))
            )
        );
        // ALL connections that asked for discovery, not just the first: a
        // bridge refresh creates a NEW native process, and `.find()` returned
        // whichever came first - so messages posted to the replacement would
        // look like messages that were never sent.
        const discoveryConnections = connections.filter(c =>
            c.inbound.some(m => m.subject === "bridge:startDiscovery")
        );
        for (const conn of discoveryConnections) {
            console.log(
                `discovery connection ${conn.pid}:`,
                JSON.stringify({
                    startedAt: (conn.inbound.find(
                        m => m.subject === "bridge:startDiscovery"
                    ) || {}).at,
                    lastInboundAt: (conn.inbound.slice(-1)[0] || {}).at,
                    subjects: [...new Set(conn.inbound.map(m => m.subject))].slice(0, 14)
                })
            );
        }
        const discovery = discoveryConnections[0];
        const discoveryPids = new Set(discoveryConnections.map(c => c.pid));
        const session = connections.find(
            c =>
                !discoveryPids.has(c.pid) &&
                c.inbound.some(m =>
                    [
                        "bridge:createCastSession",
                        "bridge:sendCastSessionMessage",
                        "bridge:sendCastReceiverMessage",
                        "bridge:stopCastSession"
                    ].includes(String(m.subject))
                )
        );
        check("a discovery connection exists", Boolean(discovery));
        check(
            "a session connection exists",
            Boolean(session),
            JSON.stringify(connections.map(c => c.pid))
        );
        check(
            "the session PID is none of the discovery PIDs",
            Boolean(
                session && !discoveryPids.has(session.pid)
            ),
            JSON.stringify({
                session: session && session.pid,
                discovery: [...discoveryPids]
            })
        );
        check(
            "the session connection is used in both directions",
            Boolean(
                session &&
                    session.inbound.length > 0 &&
                    session.outbound.length > 0
            ),
            JSON.stringify(
                session && [session.inbound.length, session.outbound.length]
            )
        );

        const discovered = [];
        const actedOn = [];
        // Only real commands count. `bridge:sendMediaMessage` carrying
        // GET_STATUS is a read the popup performs for every listed device, so
        // treating it as "commanding a device" flagged the user's own Roku for
        // something harmless.
        const ACTION_SUBJECTS = new Set([
            "bridge:sendReceiverMessage",
            "bridge:createCastSession",
            "bridge:stopCastSession"
        ]);
        // Sampling requests are tracked separately: asking the discovery
        // process for a dense poll does not submit anything to a device, so
        // counting it as a command would make the check mean two things.
        const polledDevices = [];
        // The real protocol types (see the sender message union): there is no
        // generic "VOLUME", and listing one would have let a SET_VOLUME aimed
        // at a non-fake device pass unnoticed - a new false green.
        const COMMAND_MEDIA_TYPES = new Set([
            "PLAY",
            "PAUSE",
            "STOP",
            "SEEK",
            "LOAD",
            "SET_VOLUME",
            "VOLUME_UP",
            "VOLUME_DOWN"
        ]);
        for (const conn of connections) {
            for (const message of [...conn.inbound, ...conn.outbound]) {
                const data = (message.message && message.message.data) || {};
                if (data.deviceId) {
                    discovered.push(data.deviceId);
                    const mediaType =
                        (data.message && data.message.type) || undefined;
                    if (
                        ACTION_SUBJECTS.has(String(message.subject)) ||
                        (String(message.subject) === "bridge:sendMediaMessage" &&
                            COMMAND_MEDIA_TYPES.has(String(mediaType)))
                    ) {
                        actedOn.push(`${data.deviceId}:${mediaType ?? ""}`);
                    }
                    if (
                        String(message.subject) ===
                        "bridge:rokuRequestConfirmationPoll"
                    ) {
                        polledDevices.push(data.deviceId);
                    }
                }
                if (data.deviceInfo && data.deviceInfo.id) {
                    discovered.push(data.deviceInfo.id);
                }
            }
        }
        const deviceIds = discovered;
        console.log(
            "deviceIds on the wire:",
            JSON.stringify([...new Set(deviceIds)])
        );
        console.log("deviceIds acted on:", JSON.stringify([...new Set(actedOn)]));
        console.log(
            "confirmation polls targeted:",
            JSON.stringify([...new Set(polledDevices)])
        );
        check(
            "no confirmation poll targeted a non-fake device",
            !polledDevices.some(id => id && id !== FAKE_DEVICE_ID),
            JSON.stringify([...new Set(polledDevices)])
        );
        check(
            "no command was sent to a non-fake device",
            !actedOn.some(entry => !entry.startsWith(FAKE_DEVICE_ID)),
            JSON.stringify([...new Set(actedOn)])
        );
        check(
            "the fake Roku received ECP traffic",
            readNdjson(path.join(rokuDir, "fake-roku-requests.ndjson")).length >
                0
        );
        // ================= Stage 2, round 1 =========================
        //
        // One core chain only: a real HLS DVR LOAD through the session the
        // selector just created, then every hop asserted separately, because the
        // point is the extension's relay - the boundary that until now was only
        // supported by reading code.
        // --- Gate B: was a load generation established for this device? -----
        // Every one of these markers is written through an async
        // storage.get(runId) -> storage.set(...) chain in a different extension
        // context, so a single read can land in the window where the production
        // call has happened but the write has not settled - which would fabricate
        // a "generation was never created". Poll, and require the runId on each.
        await driver.switchTo().window(consoleTab);
        const readGateMarkers = () =>
            driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .get(["__fxHarnessDiagnosticRunId", "__fxHarnessLoadGenerationBegan", "__fxHarnessSelectionAtRokuBranch", "__fxHarnessClickStorageControl"])
                    .then(v => done(v), err => done({ error: String(err) }));`
            );
        const markerFor = (markers, key) => {
            const marker = markers && markers[key];
            return marker && marker.runId === diagnosticRunId ? marker : undefined;
        };
        let gateMarkers;
        const gateDeadline = Date.now() + 15000;
        for (;;) {
            gateMarkers = await readGateMarkers();
            const control = markerFor(gateMarkers, "__fxHarnessClickStorageControl");
            const selection = markerFor(
                gateMarkers,
                "__fxHarnessSelectionAtRokuBranch"
            );
            const beganMarker = markerFor(
                gateMarkers,
                "__fxHarnessLoadGenerationBegan"
            );
            if (control && selection && beganMarker) break;
            if (Date.now() > gateDeadline) break;
            await sleep(250);
        }
        const clickControl = markerFor(
            gateMarkers,
            "__fxHarnessClickStorageControl"
        );
        const selectionMarker = markerFor(
            gateMarkers,
            "__fxHarnessSelectionAtRokuBranch"
        );
        // The channel is only self-proven when BOTH run-bound markers are there;
        // without that, a missing Gate B marker explains nothing.
        check(
            "Gate B channel self-proof: the click and selection markers are present for this run",
            Boolean(clickControl && selectionMarker),
            JSON.stringify({
                clickControl: clickControl || null,
                selectionMarker: selectionMarker || null
            })
        );
        console.log(
            "deviceType matrix (popup / background):",
            JSON.stringify({
                popup: clickControl && clickControl.deviceType,
                background: selectionMarker && selectionMarker.deviceType,
                backgroundMediaType: selectionMarker && selectionMarker.mediaType
            })
        );
        const began = markerFor(gateMarkers, "__fxHarnessLoadGenerationBegan");
        // One predicate, used by both the assertion and the skip decision: a
        // marker with the wrong runId or device would otherwise assert red while
        // Stage 2 carried on.
        const gateBOk = Boolean(
            began &&
                began.runId === diagnosticRunId &&
                began.deviceId === FAKE_DEVICE_ID &&
                Number.isFinite(began.loadGeneration)
        );
        const pathBWasTaken = !pathA || !gateBOk;
        check(
            "Gate B: a load generation was created for the fake device",
            gateBOk,
            // The detail must name WHICH way it failed: a missing marker and a
            // marker from another run look the same as a boolean, and
            // JSON.stringify(undefined) prints nothing at all.
            JSON.stringify({
                selectionAtRokuBranch:
                    gateMarkers && gateMarkers.__fxHarnessSelectionAtRokuBranch,
                clickStorageControl:
                    gateMarkers && gateMarkers.__fxHarnessClickStorageControl,
                markerPresent: Boolean(began),
                marker: began ?? null,
                expectedRunId: diagnosticRunId,
                runIdMatches: Boolean(
                    began && began.runId === diagnosticRunId
                )
            })
        );
        if (pathBWasTaken) {
            console.log(
                "selector click used the path that does not create a load generation; " +
                    "Stage 2 assertions would be meaningless, so they are skipped " +
                    "(Gate A ok:", pathA, "Gate B ok:", gateBOk, ")"
            );
        }
        await driver.switchTo().window(senderTab);

        const post = async (path, body) => {
            const response = await fetch(
                `http://127.0.0.1:${rokuControlPort}${path}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body)
                }
            );
            return response.json();
        };
        if (!pathBWasTaken) {
        // The startup synthesis only exists while ECP still reports idle, so the
        // device is pinned there: a device that flips to buffer/play on its own
        // would quietly bypass the boundary under test.
        await post("/state", { playerState: "idle", position: undefined, duration: undefined });
        console.log("fake roku pinned to idle for the LOAD");

        await driver.switchTo().window(senderTab);
        // Everything below is this LOAD's: the discovery connection has been
        // polling since Stage 1, so an unfiltered `.find()` would happily return
        // an observation from before the media ever arrived - a real message
        // from the wrong lifecycle, which is its own kind of false green.
        const loadStartedAt = Date.now();
        const HARNESS_MARKER = args.mediaBeforeGeneration
            ? "stage3-media-first"
            : args.generationAdvance
            ? "stage3-generation-N"
            : "stage2";
        const NEXT_MARKER = "stage3-generation-N-plus-1";

        // Helpers first: they are pure predicates over the trace entries, and
        // their bodies only read the vars above once called, so defining them
        // here removes any chance of a use-before-declaration (which has now
        // bitten this file three times).
        const afterLoad = entry => entry.at >= loadStartedAt;
        const afterSessionRequest = entry => entry.at >= requestAtSession;
        const markerOf = media =>
            media && media.customData && media.customData.harnessMarker;

        /** The Stage 2 hops assume the generation was relayed with the media,
         *  which the reordering and advance modes deliberately prevent. */
        const assertStage2Hops =
            !args.mediaBeforeGeneration && !args.generationAdvance;
        
        
        // A LOAD whose callbacks never settle is itself a finding, not a reason
        // to abort the run: the relay hops below are read from the traces either
        // way, so a timeout here is reported and the evidence is still collected.
        let loaded;
        try {
            loaded = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 const timer = setTimeout(() => done("timeout: no load callback"), 20000);
                 window.__HARNESS_LOAD__({ harnessMarker: ${JSON.stringify(
                 args.mediaBeforeGeneration
                     ? "stage3-media-first"
                     : args.generationAdvance
                     ? "stage3-generation-N"
                     : "stage2"
             )} }).then(
                    () => { clearTimeout(timer); done(true); },
                    err => { clearTimeout(timer); done(String(err)); }
                 );`
            );
        } catch (err) {
            loaded = `webdriver: ${err.message}`;
        }
        // Not an assertion: an HLS DVR LOAD is deferred until the consume signal
        // or the 60s fallback, so "no callback yet" is the expected state here.
        // The assertion is the post-publication check below.
        console.log(
            "loadMedia before the fallback:",
            loaded === true ? "settled early (unexpected)" : String(loaded)
        );
        if (loaded !== true) {
            const pageState = await driver.executeScript(
                "return window.__HARNESS_RESULT__;"
            );
            console.log("load did not settle; page state:", JSON.stringify(pageState));
        }
        // HLS DVR LOADs deliberately do not publish session media at launch:
        // handleLoad() takes the deferred-consume path (deferUntilFreshPlayer)
        // and registers/publishes only when a consume signal arrives OR the
        // 60s fallback fires (DEFERRED_CONSUME_FALLBACK_MS). This device is
        // pinned at IDLE and never requests the relay, so neither of the two
        // evidence paths can fire - the fallback is what must release it.
        // The 60s wait only exists because the device is held at IDLE: an HLS DVR
        // LOAD registers its media only when a consume signal arrives, and a
        // device that never moves can only be released by
        // DEFERRED_CONSUME_FALLBACK_MS. For everything except the startup
        // synthesis itself, the device can simply start - the post-launch ECP
        // evidence releases the gate within a poll, so a run takes seconds
        // instead of minutes. `--startup-synthesis` keeps the slow path for the
        // assertion that genuinely needs the device to stay idle.
        const readConnPre = pid => ({
            outbound: readNdjson(path.join(harnessDir, `conn-${pid}-out.ndjson`))
        });
        if (!args.startupSynthesis) {
            await sleep(2500);
            await post("/state", { playerState: "buffer", position: 1 });
            console.log("fake roku advanced to buffer to release the consume gate");
            const mediaDeadline = Date.now() + 25000;
            let released = false;
            while (Date.now() < mediaDeadline) {
                const out = session
                    ? readNdjson(path.join(harnessDir, `conn-${session.pid}-out.ndjson`))
                    : [];
                if (
                    out.some(
                        m =>
                            m.subject === "main:rokuSessionMedia" &&
                            markerOf(m.message.data.media) === HARNESS_MARKER
                    )
                ) {
                    released = true;
                    break;
                }
                await sleep(250);
            }
            check(
                "the consume gate released from ECP evidence (no fallback wait)",
                released,
                "main:rokuSessionMedia did not appear within 25s of the device starting"
            );
            console.log("session media released after", ((Date.now() - loadStartedAt) / 1000).toFixed(1) + "s");
            await sleep(1500);
        }
        await sleep(args.startupSynthesis ? 25000 : 0);
        const midSession = session ? readConnPre(session.pid) : { outbound: [] };
        if (args.startupSynthesis) {
        check(
            "before the fallback: no session media was published",
            !midSession.outbound.some(
                m =>
                    m.subject === "main:rokuSessionMedia" &&
                    afterLoad(m) &&
                    markerOf(m.message.data.media) === HARNESS_MARKER
            ),
            JSON.stringify(midSession.outbound.map(m => m.subject).slice(0, 8))
        );
        }
        if (args.startupSynthesis) {
            console.log(
                "waiting out the 60s deferred-consume fallback (device pinned at IDLE)"
            );
        }
        await sleep(args.startupSynthesis ? 60000 : 0);

        const readConn = pid => ({
            inbound: readNdjson(path.join(harnessDir, `conn-${pid}-in.ndjson`)),
            outbound: readNdjson(path.join(harnessDir, `conn-${pid}-out.ndjson`))
        });
        // RE-READ everything here. The connection data used by the checks above
        // was snapshotted before the LOAD, and the media this section is about
        // arrives ~60s later - so searching those stale arrays could never find
        // it. (Same class of mistake as the stale whitelist and the stale
        // bundle: reading a snapshot instead of the current state.)
        const connectionsNow = readNdjson(path.join(harnessDir, "spawns.ndjson"))
            .filter(entry => entry.event === undefined)
            .map(entry => ({
                pid: entry.pid,
                inbound: readNdjson(
                    path.join(harnessDir, `conn-${entry.pid}-in.ndjson`)
                ),
                outbound: readNdjson(
                    path.join(harnessDir, `conn-${entry.pid}-out.ndjson`)
                )
            }));
        const discoveryConnectionsNow = connectionsNow.filter(c =>
            c.inbound.some(m => m.subject === "bridge:startDiscovery")
        );
        console.log(
            "connections at Stage 2 time:",
            JSON.stringify(
                discoveryConnectionsNow.map(c => ({
                    pid: c.pid,
                    inbound: [...new Set(c.inbound.map(m => m.subject))]
                }))
            )
        );
        const sessionConn = session
            ? readConn(session.pid)
            : { inbound: [], outbound: [] };
        const discoveryConn = discoveryConnectionsNow[0] || { inbound: [], outbound: [] };

        if (!assertStage2Hops) {
            console.log(
                "Stage 2 hops and case 1 are not asserted in this mode: " +
                    "the generation is deliberately held, and they require it to have been relayed " +
                    "alongside the media"
            );
        }
        // Hop 1: the session host publishes the LOAD's media.
        const sessionMedia = sessionConn.outbound.find(
            m =>
                m.subject === "main:rokuSessionMedia" &&
                afterLoad(m) &&
                m.message.data.deviceId === FAKE_DEVICE_ID &&
                markerOf(m.message.data.media) === HARNESS_MARKER
        );
        const loadFailed = sessionConn.outbound.find(
            m =>
                afterLoad(m) &&
                m.subject === "cast:sessionMessageReceived" &&
                String(m.message.data.messageData || "").includes("LOAD_FAILED")
        );
        check(
            "the session did not reject the LOAD (no LOAD_FAILED)",
            !loadFailed,
            JSON.stringify(loadFailed && loadFailed.message.data)
        );
        check(
            "hop 1: the session host published main:rokuSessionMedia",
            Boolean(sessionMedia),
            JSON.stringify(sessionConn.outbound.map(m => m.subject).slice(0, 10))
        );
        // Which direction the LOAD died in: if the extension never sent the
        // session a message, the loss is on the page->extension hop; if it did,
        // the session received it and did not act.
        console.log(
            "session connection subjects:",
            JSON.stringify({
                extensionToSession: [
                    ...new Set(sessionConn.inbound.map(m => m.subject))
                ].slice(0, 12),
                sessionToExtension: [
                    ...new Set(sessionConn.outbound.map(m => m.subject))
                ].slice(0, 12),
                // Full payload shape, not just the type: this is what separates
                // "the message never arrived", "wrong namespace", "the JSON was
                // not parsed", "the LOAD arrived but lost its media" and "routed
                // to the wrong session".
                // Does the ack correspond to the LOAD? A matching messageId
                // means the native router FOUND the session (an unknown
                // sessionId returns false without an ack) and handled it. It
                // still does not mean the async handleLoad() finished.
                ackPairing: (() => {
                    const loadMsg = sessionConn.inbound.find(
                        m =>
                            afterLoad(m) &&
                            m.subject === "bridge:sendCastSessionMessage"
                    );
                    const ack = sessionConn.outbound.find(
                        m =>
                            afterLoad(m) &&
                            m.subject === "cast:impl_sendMessage" &&
                            m.message.data.messageId ===
                                (loadMsg && loadMsg.message.data.messageId)
                    );
                    return {
                        loadMessageId:
                            loadMsg && loadMsg.message.data.messageId,
                        acked: Boolean(ack),
                        ack: ack && ack.message.data
                    };
                })(),
                loadPayloads: sessionConn.inbound
                    .filter(m => afterLoad(m))
                    .map(m => {
                        const data = m.message.data || {};
                        // The field is `messageData` (a JSON string), not
                        // `message` - reading the wrong one printed
                        // rawTypeof:"undefined" and hid the payload entirely.
                        const raw = data.messageData;
                        let parsed;
                        let parseError;
                        // Mirror production: the host parses only when it is a
                        // string, and passes an object straight through.
                        try {
                            if (typeof raw === "string") parsed = JSON.parse(raw);
                            else if (raw && typeof raw === "object") parsed = raw;
                        } catch (err) {
                            parseError = err.message;
                        }
                        return {
                            subject: m.subject,
                            sessionId: data.sessionId,
                            namespace: data.namespace,
                            messageId: data.messageId,
                            rawTypeof: typeof raw,
                            parseError,
                            parsedType: parsed && parsed.type,
                            requestId: parsed && parsed.requestId,
                            contentId:
                                parsed &&
                                parsed.media &&
                                parsed.media.contentId,
                            harnessMarker:
                                parsed &&
                                parsed.media &&
                                parsed.media.customData &&
                                parsed.media.customData.harnessMarker,
                                        keys: Object.keys(data).slice(0, 8)
                        };
                    })
                    .slice(0, 8)
            })
        );
        const sessionMediaData = (sessionMedia && sessionMedia.message && sessionMedia.message.data) || {};
        check(
            "hop 1: it is for the fake device and carries the DVR anchors",
            sessionMediaData.deviceId === FAKE_DEVICE_ID &&
                sessionMediaData.media &&
                sessionMediaData.media.customData &&
                sessionMediaData.media.customData.hlsDvr === true &&
                sessionMediaData.media.duration === 7200,
            JSON.stringify({
                deviceId: sessionMediaData.deviceId,
                duration: sessionMediaData.media && sessionMediaData.media.duration,
                customData: sessionMediaData.media && sessionMediaData.media.customData
            })
        );

        if (session) {
            const debugEvents = readNdjson(
                path.join(harnessDir, `conn-${session.pid}-out.ndjson`)
            )
                .filter(
                    m =>
                        m.subject === "main:rokuSessionMediaDebug" && afterLoad(m)
                )
                .map(m => m.message.data);
            console.log(
                "session media debug events:",
                JSON.stringify(debugEvents.slice(-4))
            );
            if (args.startupSynthesis) {
            check(
                "the publication came from the deferred-consume fallback",
                debugEvents.some(
                    event =>
                        JSON.stringify(event).includes("sessionMediaRegistered") &&
                        JSON.stringify(event).includes("true")
                ),
                JSON.stringify(debugEvents.slice(-4))
            );
            }
        }

        // Hop 2: the extension relayed the generation and the media to discovery.
        const discoveryInbound = discoveryConnectionsNow.flatMap(conn =>
            conn.inbound
        );

        const relayedGeneration = discoveryInbound.find(
            m =>
                m.subject === "bridge:rokuSetLoadGeneration" &&
                afterSessionRequest(m) &&
                m.message.data.deviceId === FAKE_DEVICE_ID
        );
        const relayedMedia = discoveryInbound.find(
            m =>
                m.subject === "bridge:rokuSetSessionMedia" &&
                afterLoad(m) &&
                m.message.data.deviceId === FAKE_DEVICE_ID &&
                markerOf(m.message.data.media) === HARNESS_MARKER
        );


        // The generation is created when the device is SELECTED, which is
        // legitimately before the LOAD, so it is filtered against the session
        // request boundary rather than the LOAD boundary.
        
        const generationData = (relayedGeneration && relayedGeneration.message.data) || {};
        const relayedData = (relayedMedia && relayedMedia.message.data) || {};
        if (assertStage2Hops) {
        check(
            "hop 2: the extension sent generation and session media to discovery",
            Boolean(relayedGeneration && relayedMedia),
            // Per connection, so a failure cannot be read as "nothing arrived
            // anywhere" when in fact the messages went to another process.
            JSON.stringify(
                discoveryConnectionsNow.map(conn => ({
                    pid: conn.pid,
                    subjects: [
                        ...new Set(conn.inbound.map(m => m.subject))
                    ].slice(0, 14)
                }))
            )
        );
        check(
            "hop 2: both name the fake device and agree on the generation",
            generationData.deviceId === FAKE_DEVICE_ID &&
                relayedData.deviceId === FAKE_DEVICE_ID &&
                generationData.loadGeneration === relayedData.loadGeneration,
            JSON.stringify({
                gen: generationData.loadGeneration,
                mediaGen: relayedData.loadGeneration,
                device: relayedData.deviceId
            })
        );
        check(
            "hop 2: the relayed media matches what the session published",
            relayedData.media &&
                relayedData.media.duration === 7200 &&
                relayedData.media.customData &&
                relayedData.media.customData.hlsDvr === true &&
                relayedData.ownerId === sessionMediaData.sessionId,
            JSON.stringify({
                duration: relayedData.media && relayedData.media.duration,
                ownerId: relayedData.ownerId,
                sessionOwner: sessionMediaData.ownerId
            })
        );

        }
        // Hop 3: the UI channel synthesises BUFFERING, and says so.
        const discoveryOutbound = discoveryConnectionsNow.flatMap(
            conn => conn.outbound
        );
        const statusEmission = discoveryOutbound.find(
            m =>
                m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                afterLoad(m) &&
                m.message.data.deviceId === FAKE_DEVICE_ID &&
                m.message.data.provenance &&
                m.message.data.provenance.source === "startup-synthetic" &&
                markerOf(m.message.data.status.media) === HARNESS_MARKER
        );
        if (args.startupSynthesis) {
        check(
            "hop 3: the media status is startup-synthetic BUFFERING with the session metadata",
            Boolean(
                statusEmission &&
                    statusEmission.message.data.status.playerState === "BUFFERING" &&
                    statusEmission.message.data.status.media &&
                    statusEmission.message.data.status.media.duration === 7200 &&
                    statusEmission.message.data.status.media.customData.hlsDvr === true
            ),
            JSON.stringify(
                statusEmission && {
                    state: statusEmission.message.data.status.playerState,
                    provenance: statusEmission.message.data.provenance.source,
                    media: statusEmission.message.data.status.media
                }
            )
        );
        } else {
            console.log(
                "hop 3 (startup synthesis) skipped in fast mode: the device was advanced out of idle on purpose"
            );
        }

        // Hop 4: the confirmation channel still sees the real, idle device.
        const observation = discoveryOutbound.find(
            m =>
                m.subject === "main:rokuPlaybackObservation" &&
                m.message.data.deviceId === FAKE_DEVICE_ID &&
                m.message.data.provenance &&
                m.message.data.provenance.source === "ecp-poll" &&
                // only samples that STARTED after this LOAD
                m.message.data.provenance.pollStartedAt >= loadStartedAt
        );
        const observationProvenance =
            (observation && observation.message.data.provenance) || {};
        check(
            "hop 4: a raw observation is still ecp-poll IDLE with poll timestamps",
            Boolean(
                observation &&
                    observation.message.data.status.playerState === "IDLE" &&
                    Number.isFinite(observationProvenance.pollStartedAt) &&
                    Number.isFinite(observationProvenance.pollCompletedAt) &&
                    observationProvenance.pollStartedAt <=
                        observationProvenance.pollCompletedAt
            ),
            JSON.stringify(observation && observation.message.data)
        );
        const latePageState = await driver.executeScript(
            "return window.__HARNESS_RESULT__;"
        );
        check(
            "the page's loadMedia settled once the media was published",
            Boolean(latePageState && latePageState.loadSucceeded),
            JSON.stringify({
                loadCalled: latePageState && latePageState.loadCalled,
                loadSucceeded: latePageState && latePageState.loadSucceeded,
                loadError: latePageState && latePageState.loadError
            })
        );
        await driver.switchTo().window(consoleTab);
        const diagnosticMarkers = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             browser.storage.local
                .get(${JSON.stringify([
                    "__fxHarnessDiagnosticRunId",
                    "__fxHarnessBgControl",
                    "__fxHarnessSyncMediaEnter",
                    "__fxHarnessSyncMediaIdentity",
                    "__fxHarnessBridgeConnected",
                    "__fxHarnessBridgeDisconnected",
                    "__fxHarnessBridgeRefresh",
                    "__fxHarnessBridgeReplay",
                    "__fxHarnessLoadGenerationBegan"
                ])})
                .then(v => done(v), err => done({ error: String(err) }));
             `
        );
        console.log(
            "background diagnostics:",
            JSON.stringify(diagnosticMarkers)
        );
        const markerOk = key =>
            diagnosticMarkers &&
            diagnosticMarkers[key] &&
            diagnosticMarkers[key].runId === diagnosticRunId;
        check(
            "the background control marker is alive for this run",
            Boolean(markerOk("__fxHarnessBgControl")),
            JSON.stringify(diagnosticMarkers && diagnosticMarkers.__fxHarnessBgControl)
        );
        await driver.switchTo().window(senderTab);
        // ---- Stage 3, case 2: media first, generation later -----------------
        //
        // The generation was HELD at the test copy, so the media that arrives
        // before it must stay pending and invisible; releasing the generation then
        // applies it. Nothing here is timing-based: the release is triggered by
        // the harness only after the media is confirmed on the wire.
        if (args.mediaBeforeGeneration) {
            const mediaOnWire = discoveryInbound.find(
                m =>
                    m.subject === "bridge:rokuSetSessionMedia" &&
                    afterLoad(m) &&
                    markerOf(m.message.data.media) === HARNESS_MARKER
            );
            const generationOnWire = discoveryInbound.find(
                m =>
                    m.subject === "bridge:rokuSetLoadGeneration" &&
                    afterSessionRequest(m) &&
                    m.message.data.deviceId === FAKE_DEVICE_ID
            );
            check(
                "stage3-2 A: the session media reached discovery first",
                Boolean(mediaOnWire) && !generationOnWire,
                JSON.stringify({
                    media: Boolean(mediaOnWire),
                    generationAlreadyThere: Boolean(generationOnWire)
                })
            );
            const synthesizedBeforeGeneration = discoveryOutbound.filter(
                m =>
                    m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    m.message.data.provenance &&
                    m.message.data.provenance.source === "startup-synthetic"
            );
            check(
                "stage3-2 B: nothing was synthesised while the generation was unknown",
                synthesizedBeforeGeneration.length === 0,
                JSON.stringify(synthesizedBeforeGeneration.map(m => m.at))
            );

            // explicit release: the harness says when, the background posts then
            await driver.switchTo().window(consoleTab);
            await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .set({
                        __fxHarnessReleaseHeldGeneration: {
                            runId: ${JSON.stringify(diagnosticRunId)},
                            deviceId: ${JSON.stringify(FAKE_DEVICE_ID)},
                            loadGeneration: 1
                        }
                    })
                    .then(() => done(true), err => done(String(err)));`
            );
            await sleep(1500);
            const released = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .get(["__fxHarnessHeldGeneration", "__fxHarnessGenerationReleased", "__fxHarnessReleaseFailed"])
                    .then(v => done(v), err => done({ error: String(err) }));`
            );
            console.log("held/released generation:", JSON.stringify(released));
            await driver.switchTo().window(senderTab);

            const afterRelease = discoveryConnectionsNow.flatMap(conn =>
                readNdjson(path.join(harnessDir, `conn-${conn.pid}-in.ndjson`))
            );
            const generationAfterRelease = afterRelease.find(
                m =>
                    m.subject === "bridge:rokuSetLoadGeneration" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    (!mediaOnWire ||
                        m.message.data.loadGeneration ===
                            mediaOnWire.message.data.loadGeneration)
            );
            // C: the point of the hold. Without this, an implementation that
            // receives the generation and still never applies the pending media
            // would satisfy every other case-2 assertion.
            await sleep(2500);
            const afterReleaseOut = discoveryConnectionsNow.flatMap(conn =>
                readNdjson(path.join(harnessDir, `conn-${conn.pid}-out.ndjson`))
            );
            const applied = afterReleaseOut.find(
                m =>
                    m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    m.message.data.status &&
                    m.message.data.status.media &&
                    markerOf(m.message.data.status.media) === HARNESS_MARKER &&
                    (!generationAfterRelease ||
                        m.at >= generationAfterRelease.at)
            );
            check(
                "stage3-2 C: the pending media became visible only after its generation arrived",
                Boolean(applied),
                JSON.stringify({
                    mediaStatusesAfterRelease: afterReleaseOut
                        .filter(
                            m =>
                                m.subject ===
                                "main:receiverDeviceMediaStatusUpdated"
                        )
                        .map(m => ({
                            at: m.at,
                            marker: markerOf(m.message.data.status.media),
                            state: m.message.data.status.playerState,
                            provenance: m.message.data.provenance.source
                        }))
                        .slice(-4),
                    generationAt: generationAfterRelease && generationAfterRelease.at
                })
            );
            check(
                "stage3-2 D: the released generation arrived, after the media",
                Boolean(
                    generationAfterRelease &&
                        mediaOnWire &&
                        generationAfterRelease.at >= mediaOnWire.at
                ),
                JSON.stringify({
                    generationAt: generationAfterRelease && generationAfterRelease.at,
                    mediaAt: mediaOnWire && mediaOnWire.at,
                    generation:
                        generationAfterRelease &&
                        generationAfterRelease.message.data.loadGeneration
                })
            );
        }

        // ---- Stage 3, case 1: generation first, media later ----------------
        //
        // This ordering happens naturally (the generation is pushed when the
        // device is selected; the media arrives after the consume gate), so the
        // case is about asserting the consequences rather than injecting a
        // reordering: nothing may be synthesised for a generation whose media has
        // not arrived, and the media that does arrive must bind to that same
        // generation.
        // Always emit this, so a missing relay shows up as the Stage 3 case
        // failing rather than as three checks that quietly never ran (Hop 2
        // would fail too, but a reader should not need to know that to read
        // this case's result).
        if (assertStage2Hops) {
        check(
            "stage3-1: the generation and the media were both relayed",
            Boolean(relayedGeneration && relayedMedia),
            JSON.stringify({
                generation: Boolean(relayedGeneration),
                media: Boolean(relayedMedia)
            })
        );
        if (relayedGeneration && relayedMedia) {
            check(
                "stage3-1: the generation arrived before the media",
                relayedGeneration.at <= relayedMedia.at,
                JSON.stringify({
                    generationAt: relayedGeneration.at,
                    mediaAt: relayedMedia.at
                })
            );
            const synthesizedBeforeMedia = discoveryOutbound.filter(
                m =>
                    m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    m.message.data.provenance &&
                    m.message.data.provenance.source === "startup-synthetic" &&
                    m.at < relayedMedia.at
            );
            check(
                "stage3-1: nothing was synthesised before the media arrived",
                synthesizedBeforeMedia.length === 0,
                JSON.stringify(
                    synthesizedBeforeMedia.map(m => m.at)
                )
            );
            check(
                "stage3-1: the media bound to the earlier generation",
                relayedMedia.message.data.loadGeneration ===
                    relayedGeneration.message.data.loadGeneration,
                JSON.stringify({
                    generation: relayedGeneration.message.data.loadGeneration,
                    mediaGeneration: relayedMedia.message.data.loadGeneration
                })
            );
        }
        }
        // ---- Stage 3, case 3: generation advance retires the old load --------
        if (args.generationAdvance) {
            const generationN = relayedMedia
                ? relayedMedia.message.data.loadGeneration
                : undefined;
            const statusN = discoveryOutbound.find(
                m =>
                    m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    m.message.data.status &&
                    markerOf(m.message.data.status.media) === HARNESS_MARKER
            );
            check(
                "stage3-3 A: generation N and its media are current",
                Boolean(relayedGeneration && relayedMedia && statusN),
                JSON.stringify({
                    generation: generationN,
                    media: Boolean(relayedMedia),
                    statusVisible: Boolean(statusN)
                })
            );
            const visibleAt = statusN ? statusN.at : undefined;

            // B: advance through the real producer, and do NOT publish N+1 media
            await driver.switchTo().window(consoleTab);
            await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local.set({
                    __fxHarnessAdvanceGenerationRequest: {
                        runId: ${JSON.stringify(diagnosticRunId)},
                        requestId: "advance-" + Date.now(),
                        deviceId: ${JSON.stringify(FAKE_DEVICE_ID)},
                        expectedCurrentGeneration: ${Number(generationN)}
                    }
                 }).then(() => done(true), err => done(String(err)));`
            );
            let advanced;
            const advanceDeadline = Date.now() + 25000;
            while (Date.now() < advanceDeadline) {
                advanced = await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .get("__fxHarnessGenerationAdvanced")
                        .then(v => done(v.__fxHarnessGenerationAdvanced || null), err => done(null));`
                );
                if (advanced && advanced.runId === diagnosticRunId) break;
                await sleep(500);
            }
            console.log("generation advanced:", JSON.stringify(advanced));
            await driver.switchTo().window(senderTab);
            await sleep(2000);

            const afterAdvanceIn = discoveryConnectionsNow.flatMap(conn =>
                readNdjson(path.join(harnessDir, `conn-${conn.pid}-in.ndjson`))
            );
            // The generation that was actually observed after the advance - never
            // N+1 computed by the harness: if a legal extra advance happened, the
            // assertions and the media that follows must use what is real.
            const actualNextGeneration =
                advanced && Number.isFinite(advanced.newGeneration)
                    ? advanced.newGeneration
                    : Number(generationN) + 1;
            const generationNPlus1 = afterAdvanceIn.find(
                m =>
                    m.subject === "bridge:rokuSetLoadGeneration" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    Number(m.message.data.loadGeneration) ===
                        Number(actualNextGeneration) &&
                    (!advanced || m.at >= advanced.at)
            );
            check(
                "stage3-3 C1: the new generation reached discovery",
                Boolean(generationNPlus1),
                JSON.stringify({
                    advanced,
                    generations: afterAdvanceIn
                        .filter(
                            m => m.subject === "bridge:rokuSetLoadGeneration"
                        )
                        .map(m => ({
                            at: m.at,
                            generation: m.message.data.loadGeneration
                        }))
                })
            );
            const mediaNPlus1Yet = afterAdvanceIn.find(
                m =>
                    m.subject === "bridge:rokuSetSessionMedia" &&
                    Number(m.message.data.loadGeneration) ===
                        Number(actualNextGeneration)
            );
            check(
                "stage3-3 C2: no N+1 media has arrived yet (retirement is not a swap)",
                !mediaNPlus1Yet,
                JSON.stringify(mediaNPlus1Yet && mediaNPlus1Yet.at)
            );
            const afterAdvanceOut = discoveryConnectionsNow.flatMap(conn =>
                readNdjson(path.join(harnessDir, `conn-${conn.pid}-out.ndjson`))
            );
            const staleAfterAdvance = afterAdvanceOut.find(
                m =>
                    m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    m.message.data.status &&
                    markerOf(m.message.data.status.media) === HARNESS_MARKER &&
                    generationNPlus1 &&
                    m.at > generationNPlus1.at
            );
            check(
                "stage3-3 C3: the retired load is no longer reported",
                !staleAfterAdvance,
                JSON.stringify({
                    visibleAt,
                    advanceAt: generationNPlus1 && generationNPlus1.at,
                    staleAt: staleAfterAdvance && staleAfterAdvance.at
                })
            );

            // D: a late copy of N's media must not revive it
            const mediaN = relayedMedia && relayedMedia.message.data.media;
            const ownerN = relayedMedia && relayedMedia.message.data.ownerId;
            await driver.switchTo().window(consoleTab);
            await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local.set({
                    __fxHarnessReplayMediaRequest: {
                        runId: ${JSON.stringify(diagnosticRunId)},
                        requestId: "replay-old-" + Date.now(),
                        deviceId: ${JSON.stringify(FAKE_DEVICE_ID)},
                        loadGeneration: ${Number(generationN)},
                        ownerId: ${JSON.stringify(ownerN || "")},
                        media: ${JSON.stringify(mediaN || null)}
                    }
                 }).then(() => done(true), err => done(String(err)));`
            );
            let posted;
            const postDeadline = Date.now() + 25000;
            while (Date.now() < postDeadline) {
                posted = await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .get(["__fxHarnessMediaPosted", "__fxHarnessMediaPostFailed"])
                        .then(v => done(v), err => done({ error: String(err) }));`
                );
                if (
                    (posted && posted.__fxHarnessMediaPosted) ||
                    (posted && posted.__fxHarnessMediaPostFailed)
                )
                    break;
                await sleep(500);
            }
            console.log("old media replayed:", JSON.stringify(posted));
            await driver.switchTo().window(senderTab);
            await sleep(2500);
            const afterReplayOut = discoveryConnectionsNow.flatMap(conn =>
                readNdjson(path.join(harnessDir, `conn-${conn.pid}-out.ndjson`))
            );
            const revived = afterReplayOut.find(
                m =>
                    m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    m.message.data.status &&
                    markerOf(m.message.data.status.media) === HARNESS_MARKER &&
                    posted &&
                    posted.__fxHarnessMediaPosted &&
                    m.at >= posted.__fxHarnessMediaPosted.at
            );
            check(
                "stage3-3 D: a late copy of the retired media does not revive it",
                !revived,
                JSON.stringify(revived && revived.at)
            );

            // E: only N+1's media may establish the new state
            const mediaNPlus1 = mediaN
                ? {
                      ...mediaN,
                      customData: {
                          ...(mediaN.customData || {}),
                          harnessMarker: NEXT_MARKER
                      }
                  }
                : undefined;
            await driver.switchTo().window(consoleTab);
            await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local.set({
                    __fxHarnessReplayMediaRequest: {
                        runId: ${JSON.stringify(diagnosticRunId)},
                        requestId: "replay-new-" + Date.now(),
                        deviceId: ${JSON.stringify(FAKE_DEVICE_ID)},
                        loadGeneration: ${Number(actualNextGeneration)},
                        ownerId: ${JSON.stringify(ownerN || "")},
                        media: ${JSON.stringify(mediaNPlus1 || null)}
                    }
                 }).then(() => done(true), err => done(String(err)));`
            );
            await sleep(4000);
            await driver.switchTo().window(senderTab);
            const afterNewOut = discoveryConnectionsNow.flatMap(conn =>
                readNdjson(path.join(harnessDir, `conn-${conn.pid}-out.ndjson`))
            );
            const newVisible = afterNewOut.find(
                m =>
                    m.subject === "main:receiverDeviceMediaStatusUpdated" &&
                    m.message.data.deviceId === FAKE_DEVICE_ID &&
                    m.message.data.status &&
                    markerOf(m.message.data.status.media) === NEXT_MARKER
            );
            check(
                "stage3-3 E: the new generation's media establishes the new state",
                Boolean(newVisible),
                JSON.stringify(
                    afterNewOut
                        .filter(
                            m =>
                                m.subject ===
                                "main:receiverDeviceMediaStatusUpdated"
                        )
                        .map(m => ({
                            at: m.at,
                            marker: markerOf(m.message.data.status.media)
                        }))
                        .slice(-4)
                )
            );
        }

        console.log(
            "stage 2 round 1 observed:",
            JSON.stringify({
                sessionMedia: Boolean(sessionMedia),
                relayedGeneration: Boolean(relayedGeneration),
                relayedMedia: Boolean(relayedMedia),
                syntheticBuffering: Boolean(statusEmission),
                rawIdleObservation: Boolean(observation)
            })
        );
        }
    } catch (err) {
        if (!(err && err.phaseAOnly)) throw err;
    } finally {
        if (driver) await driver.quit().catch(() => {});
        // Owned servers must be stopped explicitly or the process never exits.
        for (const gecko of ownedGeckodrivers) {
            try {
                gecko.kill("SIGTERM");
            } catch {
                // Already gone.
            }
        }
        roku.kill("SIGTERM");
        server.close();
        if (args.keepProfile) console.log("profile kept at:", profileDir);
        else fs.rmSync(profileDir, { recursive: true, force: true });
    }

    console.log("");
    console.log(pass + "/" + (pass + fail) + " checks passed");
    process.exit(fail ? 1 : 0);
}

main().catch(err => {
    console.error("sessionHarness ERROR", err);
    process.exit(1);
});

/**
 * Nothing may outlive the run: an abandoned fake Roku holds port 8060, which
 * makes the NEXT run fail with "the fake Roku did not start (port 8060 busy?)"
 * - i.e. a leftover of the previous run hides the real error of the next one,
 * which is exactly what happened. Owning geckodriver is the harness's own doing
 * (Selenium does not stop a server it did not start), so it reaps both.
 */
process.on("exit", () => {
    for (const gecko of ownedGeckodrivers) {
        try {
            gecko.kill("SIGKILL");
        } catch {
            // Already gone.
        }
    }
    for (const child of ownedChildren) {
        try {
            child.kill("SIGKILL");
        } catch {
            // Already gone.
        }
    }
});
