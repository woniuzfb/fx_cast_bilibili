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
const {
    install,
    snapshot: snapshotUserManifest,
    restore: restoreUserManifest
} = require("./installManifest");

/**
 * The user-level native manifest this harness has to install for Firefox to
 * spawn the WRAPPER, and the state it had before. That directory is read by the
 * user's normal browser too, and a harness manifest left behind shadows a
 * system-level bridge install - so a killed harness run must never be able to
 * break normal usage:
 *
 *  - every exit path restores what was here before (`restoreManifest`),
 *  - `process.on("exit")` and the signal handlers cover the honest ones,
 *  - a SIGKILL cannot run them, so `hostWrapper.js` ALSO passes through to the
 *    installed bridge when no harness run is active, and a later restore()
 *    treats a leftover harness manifest as "there was nothing here before".
 */
let userManifestState;
let manifestRestored = false;
function restoreManifest(reason) {
    if (manifestRestored || !userManifestState) return;
    manifestRestored = true;
    try {
        for (const line of restoreUserManifest(userManifestState))
            console.log(`native manifest (${reason}):`, line);
    } catch (err) {
        console.error(
            "native manifest restore FAILED:",
            String(err),
            "- run: node test/integration/installManifest.js --remove"
        );
    }
}

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
/**
 * Everything the harness reads about the product comes from the SOURCE tree,
 * never from dist/: dist/ belongs to the developer's own build and packaging
 * (`npm run package:extension` replaces it with an artifact), and a harness that
 * depended on it both broke when that happened and tempted the harness to write
 * there.
 */
const bridgeConfig = require(path.join(repoRoot, "bridge/config.json"));
const EXTENSION_ID = bridgeConfig.extensionId;
/**
 * The harness asks for its OWN native messaging host name, and builds an
 * extension copy that requests it, so the manifest it installs cannot shadow a
 * real bridge install - the real name is never touched, and a harness run and a
 * normal browser session can be used at the same time.
 */
const HARNESS_HOST_NAME = `${bridgeConfig.applicationName}_harness`;
/** The fake device's SSDP responder port: NOT 1900, so the developer's own
 *  bridge (which searches on 1900) can never discover the harness's fake Roku. */
const HARNESS_SSDP_PORT = 19009;
/** Pinned so the harness can address the extension's own pages before launch. */
const EXTENSION_UUID = "8a1f3c2e-9d4b-4c7a-9f21-2b6c5d8e0a13";

const popupUrl = `moz-extension://${EXTENSION_UUID}/ui/popup/index.html`;
const optionsUrl = `moz-extension://${EXTENSION_UUID}/ui/options/index.html`;

/**
 * The cleanup steps `--cleanup-fault` can inject a throw into, as an ordered
 * list because the ORDER is part of what is asserted (the message listener is
 * removed before the action state is reset).
 *
 * `message` is a STABLE IDENTIFIER, not a message: it appears literally in the
 * injected Error, and the harness tests for it separately in the injected
 * cleanup error and in the error the outer handler caught. Without that, "the
 * original error propagated" would be unfalsifiable whenever a cleanup error
 * could have landed in the same outer catch.
 */
const CLEANUP_FAULTS = [
    {
        id: "removeListener",
        site: "onMessage.removeListener",
        message: "harness: cleanup fault at onMessage.removeListener",
        // Global counter of the REAL call this fault replaces, kept on
        // `globalThis.__fxHarnessCleanupCalls` so the gate can read it
        // synchronously and a checker outside the browser can read it too.
        counter: "removeListener"
    },
    {
        id: "actionState",
        site: "updateActionState(Default)",
        message: "harness: cleanup fault at updateActionState",
        counter: "actionState"
    }
];

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
        // No default: the harness builds its own copy (see main()) so that it
        // never reads or writes dist/, which the developer's own build and
        // packaging own. `--extension-dir` overrides it for controls.
        extensionDir: undefined,
        phaseAOnly: false,
        startupSynthesis: false,
        mediaBeforeGeneration: false,
        generationAdvance: false,
        autoCastGap: false,
        autoCastFixed: false,
        // The page's requestSession SETTLEMENT contract, on a route where the
        // extension (not the page's request) creates the session. Deliberately
        // its own pair: `--auto-cast-*` already carries the load-generation
        // sense of "gap", and one mode must not mean two defects.
        requestSettlementGap: false,
        requestSettlementFixed: false,
        // Proves the ORDER inside the SDK's cancel branch: the request fields are
        // cleared BEFORE the user's error callback runs, so a callback that
        // synchronously starts a new requestSession does not get its state wiped
        // by the tail of the old handler.
        requestSettlementReentrant: false,
        // Owner-aware session-media clear: a retired owner's LATE clear must not
        // drop the current owner's media, locally or across the bridge.
        ownerAwareClear: false,
        // The discovery host is a separate native process whose caches start
        // empty: after it is recreated, the extension INTENDS to replay the
        // current load generation AND the current session media to it. Measured
        // today only the generation arrives - the source table was cleared by the
        // disconnect itself - so this is a red/green pair, not a single mode:
        // `gap` asserts the measured loss, `fixed` the intended replay.
        discoveryReconnectGap: false,
        discoveryReconnectFixed: false,
        createFailure: false,
        interleave: false,
        // Which checkpoint of createCastSession the injection fires at.
        failStage: "p0",
        // Which caller drives the session start under test. Both labels mount
        // the popup LATE (after requestSession opened its selector); what
        // differs is whether the first `popup:init` is suppressed:
        //
        //   "queued" suppresses it, so the popup believes no selector exists,
        //   its auto-cast replaces the selector and loadSender owns the session;
        //   "selector" does not suppress it, so the popup binds to the selector
        //   that already exists (clearing its auto-cast timer) and the click
        //   resolves through main:requestSession, which owns the session.
        requestSource: "queued",
        // Pre-fix expectation for the staged matrix: the failed call left an
        // idle native host behind. Without it the matrix expects the cleanup
        // (no idle host survives), which is the post-fix behaviour.
        expectResidue: false,
        // Which step of the partial-session cleanup is injected to THROW, on
        // top of the original p2 failure. The cleanup is best-effort by design
        // (each step has its own catch), so this asks whether a failing step
        // can still leave the port closed and the ORIGINAL error propagating.
        // Only meaningful together with --fail-stage p2:
        //
        //   p0 fires at the top of createCastSession, BEFORE `bridge.connect()`
        //   and before the internal `try` exists. It does not enter that
        //   catch/finally at all, owns no port, and propagates straight to its
        //   caller (which is what releases the announcement and settles the
        //   page);
        //   p1 fires inside that `try` with a port in hand, but BEFORE
        //   `opts.instance.session = session` ran, so the identity guard below
        //   is false: the finally still detaches the disconnect listener and
        //   closes the port;
        //   only p2 has the reference attached, so only p2 reaches the two
        //   steps instrumented below (both sit inside
        //   `if (opts.instance.session === session)`).
        cleanupFault: undefined,
        expectReleased: false,
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
        else if (argv[i] === "--auto-cast-gap") args.autoCastGap = true;
        else if (argv[i] === "--request-settlement-gap")
            args.requestSettlementGap = true;
        else if (argv[i] === "--request-settlement-fixed")
            args.requestSettlementFixed = true;
        else if (argv[i] === "--request-settlement-reentrant")
            args.requestSettlementReentrant = true;
        else if (argv[i] === "--owner-aware-clear") args.ownerAwareClear = true;
        else if (argv[i] === "--discovery-reconnect-gap")
            args.discoveryReconnectGap = true;
        else if (argv[i] === "--discovery-reconnect-fixed")
            args.discoveryReconnectFixed = true;
        else if (argv[i] === "--auto-cast-fixed") args.autoCastFixed = true;
        else if (argv[i] === "--request-source") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new Error(
                    "sessionHarness: --request-source needs a value (selector or queued)"
                );
            }
            args.requestSource = value;
            i++;
        } else if (argv[i] === "--expect-residue") args.expectResidue = true;
        else if (argv[i] === "--cleanup-fault") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new Error(
                    "sessionHarness: --cleanup-fault needs a value (removeListener or actionState)"
                );
            }
            args.cleanupFault = value;
            i++;
        } else if (argv[i] === "--fail-stage") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new Error(
                    "sessionHarness: --fail-stage needs a value (p0, p1 or p2)"
                );
            }
            args.failStage = value;
            i++;
        }
        else if (argv[i] === "--create-failure-gap") {
            args.createFailure = true;
            args.expectReleased = false;
        } else if (argv[i] === "--create-failure-fixed") {
            args.createFailure = true;
            args.expectReleased = true;
        } else if (argv[i] === "--interleave-gap") {
            args.interleave = true;
            args.expectReleased = false;
        } else if (argv[i] === "--interleave-fixed") {
            args.interleave = true;
            args.expectReleased = true;
        } else if (argv[i] === "--extension-dir") args.extensionDir = argv[++i];
        else if (argv[i] === "--instrument-content-initial")
            args.instrument = true;
        else throw new Error(`sessionHarness: unknown argument ${argv[i]}`);
    }
    if (!["p0", "p1", "p2"].includes(args.failStage)) {
        // Without this an unknown stage simply never matches, every checkpoint
        // lets the cast through, and the run fails much later with "the session
        // was created anyway" instead of naming the real mistake.
        throw new Error(
            `sessionHarness: --fail-stage must be p0, p1 or p2 (got ${args.failStage})`
        );
    }
    if (!["selector", "queued"].includes(args.requestSource)) {
        throw new Error(
            `sessionHarness: --request-source must be selector or queued (got ${args.requestSource})`
        );
    }
    if (
        args.cleanupFault !== undefined &&
        !["removeListener", "actionState"].includes(args.cleanupFault)
    ) {
        throw new Error(
            `sessionHarness: --cleanup-fault must be removeListener or actionState (got ${args.cleanupFault})`
        );
    }
    if (args.requestSettlementGap && args.requestSettlementFixed) {
        // The pair is a red/green EXPECTATION pair about the same production
        // behaviour; accepting both would silently run the gap expectation and
        // report "green" for the unfixed build, which is the opposite of what a
        // reader of that command line would conclude.
        throw new Error(
            "sessionHarness: --request-settlement-gap and --request-settlement-fixed are mutually exclusive"
        );
    }
    if (args.cleanupFault !== undefined && args.failStage !== "p2") {
        // p0 fires before `bridge.connect()` and before the internal try, so
        // it owns no port and does not enter this cleanup at all. p1 enters
        // the internal try with a port, but fails before
        // `opts.instance.session = session`, so the identity guard around both
        // instrumented steps is false. Only p2 reaches those two instrumented
        // cleanup steps. Accepting the other combinations would arm a fault
        // that can never fire and then read the absence of its marker as
        // "the cleanup was not reached" - the exact ambiguity this flag
        // exists to remove.
        throw new Error(
            `sessionHarness: --cleanup-fault needs --fail-stage p2 (the only checkpoint that reaches the two instrumented cleanup steps; got ${args.failStage})`
        );
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
/**
 * ALL handles whose current URL contains `fragment`. The click target for the
 * failure matrix is the single `/ui/popup/` handle, and the COUNT is the point:
 * the harness asserts it is exactly one, so "the first match" cannot be a coin
 * flip between two callers without saying so.
 *
 * An earlier version tried to identify that handle by the tab id recorded in
 * `__fxHarnessSelectorOpened`. That is the tab the SELECTION IS FOR (the sender
 * page, served over http by this harness) - not the tab hosting the UI - so it
 * matched nothing and the run collapsed without ever clicking (measured:
 * 30/50, "no popup handle"). The route is decided by the popup's mount timing
 * and by whether its first `popup:init` was suppressed, not by which handle is
 * clicked, and it is asserted afterwards from the outer-catch markers.
 */
async function findHandlesByUrl(driver, fragment, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    while (Date.now() < deadline) {
        last = [];
        for (const handle of await driver.getAllWindowHandles()) {
            try {
                await driver.switchTo().window(handle);
                const url = await driver.getCurrentUrl();
                if (url.includes(fragment)) last.push(handle);
            } catch {
                // The handle may have gone away between listing and switching.
            }
        }
        if (last.length) return last;
        await sleep(300);
    }
    return last;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    /**
     * The queued-selection gap mode.
     *
     * Production defect under test: a Roku App session created by
     * `loadSender()`'s App branch never establishes a load generation, because
     * the only `beginRokuMediaLoad()` call sits in the `main:requestSession`
     * handler — a path a *replacement* selector never reaches. The session is
     * real (the page's requestSession succeeds, a session host process exists,
     * `bridge:createCastSession` goes out) and then nothing of it can ever be
     * mirrored to discovery: a silent failure, not a visible one.
     *
     * How the replacement selector is produced here, deterministically: the
     * popup's own auto-cast timer (500 ms after the popup mounts, "the selector
     * never told me it was ready") calls `castCurrentTab()` with no selection ->
     * `action:castCurrentTab` -> `triggerCast()` -> `getReceiverSelection()`,
     * which CLOSES the `requestSession` selector and opens its own. The click
     * that follows then resolves the replacement, so `triggerCast()` — not the
     * `main:requestSession` handler — owns the session that gets created.
     *
     * That race is real but not schedulable: normally the popup tab is mounted
     * seconds before `requestSession`, so the auto-cast fires harmlessly first.
     * The mode therefore manipulates only the ORDER, not any production logic:
     *   (a) the popup tab is navigated to the popup page AFTER the
     *       requestSession selector has opened (a run-bound marker written in
     *       the test copy's `ReceiverSelector.open` says so), and
     *   (b) the FIRST `popup:init` post is suppressed, so the popup does not
     *       learn that a selector is ready and its own timer fires. Suppressed
     *       is a run-bound, one-shot, test-copy-only edit; the popup's timers,
     *       the production init data path and every other mode are untouched.
     * `--auto-cast-gap` asserts the pre-fix outcome (session created, no
     * generation), `--auto-cast-fixed` asserts the post-fix outcome (the same
     * session-creation evidence, exactly one generation, media bound to it).
     */
    const gapMode = args.autoCastGap || args.autoCastFixed;
    const expectGap = args.autoCastGap;
    /**
     * The settlement modes drive the SAME queued route as `--auto-cast-*` (the
     * popup's auto-cast owns the session, so the page's own request is the one
     * that gets cancelled) but assert nothing about load generations: they exist
     * to pin the page-callback contract. `gap` = the measured pre-fix behaviour,
     * `fixed` = the behaviour the SDK fix must produce; both collect exactly the
     * same facts so only the expectation flips.
     */
    const discoveryReconnectMode =
        args.discoveryReconnectGap || args.discoveryReconnectFixed;
    const expectDiscoveryReplayRecovered = args.discoveryReconnectFixed;
    const settlementMode =
        args.requestSettlementGap ||
        args.requestSettlementFixed ||
        args.requestSettlementReentrant;
    const expectDoubleSettlement = args.requestSettlementGap;
    /**
     * The session-creation-failure modes.
     *
     * `--create-failure-*`: the queued-selection session start announces its
     * load generation and then `createCastSession()` fails. What is under test
     * is NOT the generation (it stays monotonic and is never rolled back) but
     * the local pending-media gate the announcement opened: the ECP evidence
     * blocking in `deviceManager` must be released by the lifecycle that opened
     * it, or that device's media status is filtered forever.
     *
     * `--interleave-*`: two starts for the same device overlap - the queued one
     * announces G and is held, a later requestSession announces G+1 and is also
     * held, and then the OLDER one fails. Its failure must not release the gate
     * the NEWER start still needs.
     *
     * Both use the gap modes' provocation to route the first click into
     * `loadSender()`, so the injection point (`createCastSession`) sits after
     * the announcement exactly as it does in production.
     */
    const failureMode = args.createFailure || args.interleave;
    /**
     * Modes that need the popup mounted LATE, i.e. after `requestSession` has
     * opened its selector. Late mounting alone is enough to make the first click
     * the `requestSession` path (the popup's port matches that selector
     * immediately, so its auto-cast timer is cleared); suppressing the first
     * `popup:init` on top of it is what turns the same click into a REPLACEMENT
     * selector. `--interleave-*` wants the former, `--auto-cast-*` and
     * `--create-failure-*` the latter.
     *
     * With `--request-source selector` nothing is suppressed: the popup mounts
     * late and finds the selector that already exists, so the click resolves
     * through `main:requestSession` instead of the popup's auto-cast. Which of
     * the two actually ran is asserted (`request-source ...: the click went
     * through ...`), because the label alone was wrong in most earlier runs.
     */
    /**
     * Mounting the popup LATE - after `requestSession` has opened its selector -
     * is what makes the click's route deterministic at all, and it is wanted for
     * BOTH labels: for `queued` the popup's port is then answered with the
     * suppressed `popup:init` (the replacement selector, i.e. the auto-cast
     * route), for `selector` the port matches the selector that already exists
     * (the popup clears its auto-cast timer and the click resolves through
     * `main:requestSession`). Mounting it early made the route a race: 3 of 4
     * runs labelled `selector` were in fact served by the popup's auto-cast, so
     * the label was a lie and the caller-identity check below could not catch it.
     */
    const deferPopup = gapMode || failureMode || settlementMode;
    const suppressPopupInit =
        (gapMode || args.createFailure || settlementMode) &&
        args.requestSource === "queued";
    const expectReleased = args.expectReleased;
    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-harness-s1-"));
    console.log("harness dir:", harnessDir);
    // Snapshot BEFORE installing: whatever the user had here (usually nothing,
    // since their bridge is installed system-wide) is put back on exit.
    userManifestState = snapshotUserManifest({ name: HARNESS_HOST_NAME });
    if (userManifestState.existed && userManifestState.wasHarnessLeftover) {
        console.log(
            "native manifest: found a leftover harness manifest from a killed run; it will be removed rather than restored"
        );
    }
    install({ name: HARNESS_HOST_NAME });
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
        [
            path.join(__dirname, "fakeRoku.js"),
            "--harness-dir",
            rokuDir,
            "--ssdp-port",
            String(HARNESS_SSDP_PORT)
        ],
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

    // --- the harness's OWN builds, outside dist/ ---------------------------
    //
    // dist/ is the developer's (and their packaging replaces it with an
    // artifact), so the harness builds private copies into its own directory:
    // the extension with its own host name, and the bridge whose launcher the
    // wrapper execs. Neither the repo's dist/ nor the installed bridge is read
    // or written.
    const harnessBuildDir = path.join(harnessDir, "build");
    const buildInto = (label, script, outDir, extra) => {
        const built = spawnSync(
            process.execPath,
            [script, "--out-dir", outDir, ...(extra || [])],
            { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
        );
        if (built.status !== 0) {
            throw new Error(
                `sessionHarness: ${label} build failed: ` +
                    String(built.stderr || built.stdout).slice(-600)
            );
        }
        console.log(`harness ${label} build:`, outDir);
    };
    buildInto(
        "extension",
        path.join(repoRoot, "extension/bin/build.js"),
        path.join(harnessBuildDir, "extension"),
        ["--bridge-name", HARNESS_HOST_NAME]
    );
    buildInto(
        "bridge",
        path.join(repoRoot, "bridge/bin/build.js"),
        path.join(harnessBuildDir, "bridge")
    );
    // Isolate device discovery: the harness bridge searches on its own SSDP
    // port, so the developer's bridge (1900) never sees the fake device. This
    // patches the harness's private copy only.
    {
        const browser = path.join(
            harnessBuildDir,
            "bridge/src/bridge/components/roku/deviceBrowser.js"
        );
        const text = fs.readFileSync(browser, "utf8");
        const marker = "const SSDP_PORT = 1900;";
        if (!text.includes(marker)) {
            throw new Error(
                `sessionHarness: cannot isolate SSDP in ${browser} (marker not found)`
            );
        }
        fs.writeFileSync(
            browser,
            text.replace(marker, `const SSDP_PORT = ${HARNESS_SSDP_PORT};`)
        );
        console.log(
            `harness bridge: SSDP isolated to port ${HARNESS_SSDP_PORT} (the repo's build and the installed bridge keep 1900)`
        );
    }
    // What the wrapper execs when a harness run launches it, and what Firefox
    // loads: both are the harness's private copies.
    process.env.FX_HOST_ENTRY = path.join(
        harnessBuildDir,
        "bridge/fx_cast_bilibili_bridge.sh"
    );
    if (!args.extensionDir) {
        args.extensionDir = path.join(harnessBuildDir, "extension");
    }

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
        //
        // `loadGenerationCalls` counts the hook's calls for this background, so
        // "a generation was created" and "exactly one generation was created for
        // this session start" are different assertions rather than the same one.
        patch(
            "background/background.js",
            "nextRokuLoadGeneration(deviceId);",
            () =>
                storageMarker(
                    "__fxHarnessLoadGenerationBegan",
                    "deviceId, loadGeneration, loadGenerationCalls: (this.__fxHarnessLoadGenerationCalls = (this.__fxHarnessLoadGenerationCalls || 0) + 1)"
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
        // The page's own timeline says what IT saw; this says how many times the
        // background told it "cancelled", and from where - which is how a double
        // settlement (the replaced selector's cancel plus the failed start's) shows
        // up as a number instead of a guess.
        {
            // Locate every `postMessage({ subject: "cast:sessionRequestCancelled" ... })`
            // by brace matching instead of guessing each site's indentation, and
            // append a counter after the statement. Wrapping only some sites would
            // report a double settlement as a single one.
            const cancelFile = path.join(
                extensionDir,
                "background/background.js"
            );
            const cancelText = fs.readFileSync(cancelFile, "utf8");
            const needle = 'subject: "cast:sessionRequestCancelled"';
            /**
             * Each post marker carries the IDENTITY of the site that fired, not
             * just the run-wide ordinal: `count` alone said "one cancel was
             * posted" without saying WHICH of the three sites posted it, and
             * "which site settled the page" is exactly what the page-contract
             * question turns on. The identity is a snippet of the site's own
             * source context, taken at patch time, so a reader never has to trust
             * a hand-maintained index.
             */
            /**
             * The error the site's own `catch` is handling, when there is one in
             * scope. `typeof` is safe on an undeclared identifier, so this is the
             * same expression at every site: the two `if` sites have no binding
             * and record an empty string, the `catch (err)` site records what it
             * actually caught - which is the fact that decides whether the page
             * was settled by the failed start or by the selector that replaced it.
             */
            const caughtErrorExpr =
                "(function () { try { if (typeof err === 'undefined' || !err) return ''; return String(err.message || err); } catch (e) { return ''; } })()";
            const counterFor = (site, hint) =>
                "try { const __fxN = (globalThis.__fxHarnessCancelPosts = (globalThis.__fxHarnessCancelPosts || 0) + 1); " +
                "void browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => browser.storage.local.set({ " +
                `['__fxHarnessCancelPost_' + __fxN]: { runId: r && r.__fxHarnessDiagnosticRunId, count: __fxN, site: ${site}, siteHint: ${JSON.stringify(
                    hint
                )}, caughtError: ${caughtErrorExpr}, at: Date.now() } ` +
                "})).catch(() => {}); } catch (e) {}";
            let cancelPatched = "";
            let cancelCursor = 0;
            let cancelSites = 0;
            /** Human-readable site map, printed so the marker's index is never a guess. */
            const cancelSiteLabels = [];
            for (;;) {
                const subjectAt = cancelText.indexOf(needle, cancelCursor);
                if (subjectAt === -1) break;
                const callAt = cancelText.lastIndexOf(
                    "postMessage({",
                    subjectAt
                );
                if (callAt === -1) {
                    throw new Error(
                        "sessionHarness: cannot find the postMessage( of a sessionRequestCancelled"
                    );
                }
                const objectAt = callAt + "postMessage(".length;
                let depth = 0;
                let endAt = -1;
                for (let i = objectAt; i < cancelText.length; i++) {
                    if (cancelText[i] === "{") depth++;
                    else if (cancelText[i] === "}") {
                        depth--;
                        if (depth === 0) {
                            endAt = i;
                            break;
                        }
                    }
                }
                let statementEnd = endAt + 1;
                const skipSpace = () => {
                    while (
                        statementEnd < cancelText.length &&
                        /\s/.test(cancelText[statementEnd])
                    ) {
                        statementEnd++;
                    }
                };
                skipSpace();
                if (endAt === -1 || cancelText[statementEnd] !== ")") {
                    throw new Error(
                        "sessionHarness: unexpected sessionRequestCancelled post shape"
                    );
                }
                statementEnd++;
                skipSpace();
                if (cancelText[statementEnd] !== ";") {
                    throw new Error(
                        "sessionHarness: unexpected sessionRequestCancelled post shape"
                    );
                }
                statementEnd++;
                const siteHint = cancelText
                    .slice(Math.max(0, callAt - 160), callAt)
                    .replace(/\s+/g, " ")
                    .trim();
                cancelSiteLabels.push(`${cancelSites + 1}: ...${siteHint.slice(-70)}`);
                cancelPatched +=
                    cancelText.slice(cancelCursor, statementEnd) +
                    " " +
                    counterFor(cancelSites + 1, siteHint) +
                    "\n";
                cancelCursor = statementEnd;
                cancelSites++;
            }
            cancelPatched += cancelText.slice(cancelCursor);
            if (!cancelSites) {
                throw new Error(
                    "sessionHarness: no sessionRequestCancelled posts found to count"
                );
            }
            fs.writeFileSync(cancelFile, cancelPatched);
            console.log(
                `failure mode: counting ${cancelSites} sessionRequestCancelled post site(s)`
            );
            for (const label of cancelSiteLabels) {
                console.log(`  cancel site ${label}`);
            }
        }

        patch(
            "background/background.js",
            "setRokuSessionMedia(deviceId, ownerId, media) {",
            () =>
                storageMarker(
                    "__fxHarnessBgControl",
                    // `ownerId` and the media's own marker are what the
                    // owner-aware clear case reads: "which owner wrote this" is
                    // the whole question there, and a bare deviceId/isClear pair
                    // cannot tell owner A's write from owner B's.
                    "deviceId: String(deviceId), isClear: media === null, ownerId: String(ownerId), mediaMarker: (media && media.customData && media.customData.harnessMarker) || null, mediaTitle: (media && media.metadata && media.metadata.title) || null, loadGeneration: (currentRokuMediaIdentity(deviceId) || {}).loadGeneration ?? null"
                ) +
                // A COUNTABLE family as well: the key above is a single slot, so
                // it can prove "a write happened" but never "one more write
                // happened since the baseline" - which is the only form an
                // owner-aware delta assertion can use.
                "\ntry { const __fxInSeq = (globalThis.__fxHarnessSetMediaInputs = (globalThis.__fxHarnessSetMediaInputs || 0) + 1); browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => { void browser.storage.local.set({ ['__fxHarnessSetMediaInput_' + __fxInSeq]: { runId: r && r.__fxHarnessDiagnosticRunId, seq: __fxInSeq, deviceId: String(deviceId), ownerId: String(ownerId), isClear: media === null, marker: (media && media.customData && media.customData.harnessMarker) || null, loadGeneration: (currentRokuMediaIdentity(deviceId) || {}).loadGeneration ?? null, at: Date.now() } }).catch(() => {}); }).catch(() => {}); } catch (e) {}" +
                // One-time control listener for the owner-aware clear case: the
                // harness writes a run-bound request and this calls the method
                // UNDER TEST with it. Installed here because this method is
                // guaranteed to run during any Roku load, and `this` is the
                // deviceManager instance the real caller would reach.
                "\n" +
                "      if (!globalThis.__fxHarnessOwnerClearHook) {\n" +
                "        globalThis.__fxHarnessOwnerClearHook = true;\n" +
                "        const __fxOwnerSelf = this;\n" +
                "        try {\n" +
                "          browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => {\n" +
                "            void browser.storage.local.set({ __fxHarnessOwnerClearHookInstalled: { runId: r && r.__fxHarnessDiagnosticRunId, at: Date.now() } }).catch(() => {});\n" +
                "          }).catch(() => {});\n" +
                "          browser.storage.onChanged.addListener((changes, area) => {\n" +
                "            if (area !== 'local') return;\n" +
                "            const req = changes.__fxHarnessOwnerClearRequest && changes.__fxHarnessOwnerClearRequest.newValue;\n" +
                "            if (!req || !req.requestId) return;\n" +
                "            if (globalThis.__fxHarnessOwnerClearConsumed === req.requestId) return;\n" +
                "            browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => {\n" +
                "              const runId = r && r.__fxHarnessDiagnosticRunId;\n" +
                "              if (req.runId !== runId) return;\n" +
                "              if (globalThis.__fxHarnessOwnerClearConsumed === req.requestId) return;\n" +
                "              globalThis.__fxHarnessOwnerClearConsumed = req.requestId;\n" +
                "              const media = req.media || null;\n" +
                "              try {\n" +
                "                __fxOwnerSelf.setRokuSessionMedia(req.deviceId, req.ownerId, media);\n" +
                "                void browser.storage.local.set({ ['__fxHarnessOwnerClearConsumed_' + req.requestId]: { runId: runId, requestId: req.requestId, deviceId: req.deviceId, ownerId: req.ownerId, isClear: media === null, at: Date.now() } }).catch(() => {});\n" +
                "              } catch (e) {\n" +
                "                void browser.storage.local.set({ ['__fxHarnessOwnerClearError_' + req.requestId]: { runId: runId, requestId: req.requestId, error: String(e) } }).catch(() => {});\n" +
                "              }\n" +
                "            }).catch(() => {});\n" +
                "          });\n" +
                "        } catch (e) {}\n" +
                "      }"
        );
        // The owner-aware clear case needs to know WHICH outcome the guard took,
        // not just that the method ran: an ignored clear and an applied clear
        // look identical in the entry marker. One outcome marker family, written
        // on the matching side of the guard, carrying both owners and the
        // generation the decision was made under.
        const clearOutcomeMarker = outcome =>
            "\n" +
            "        try {\n" +
            "          const __fxSeq = (globalThis.__fxHarnessClearOutcomes = (globalThis.__fxHarnessClearOutcomes || 0) + 1);\n" +
            "          browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => {\n" +
            "            void browser.storage.local.set({ ['__fxHarnessClearOutcome_' + __fxSeq]: { runId: r && r.__fxHarnessDiagnosticRunId, seq: __fxSeq, outcome: " +
            JSON.stringify(outcome) +
            ", deviceId: String(deviceId), ownerId: String(ownerId), currentOwnerId: current && current.ownerId ? String(current.ownerId) : null, loadGeneration: (currentRokuMediaIdentity(deviceId) || {}).loadGeneration ?? null, at: Date.now() } }).catch(() => {});\n" +
            "          }).catch(() => {});\n" +
            "        } catch (e) {}";
        patch(
            "background/background.js",
            "if (current?.ownerId === ownerId) {",
            () => clearOutcomeMarker("applied")
        );
        // The ignored side is reached only when the guard does NOT match, so the
        // patch turns the guard into `if/else` rather than appending after it.
        {
            const file = path.join(extensionDir, "background/background.js");
            const text = fs.readFileSync(file, "utf8");
            const anchor =
                "        }\n        return;\n      }\n      this.rokuSessionMedia.set(deviceId, { ownerId, media });";
            const occurrences = text.split(anchor).length - 1;
            if (occurrences !== 1) {
                throw new Error(
                    `sessionHarness: the owner-aware clear branch was not found exactly once (found ${occurrences})`
                );
            }
            fs.writeFileSync(
                file,
                text.replace(
                    anchor,
                    "        } else {" +
                        clearOutcomeMarker("ignored") +
                        "\n        }\n        return;\n      }\n      this.rokuSessionMedia.set(deviceId, { ownerId, media });"
                )
            );
        }
        patch(
            "background/background.js",
            "syncRokuSessionMediaToBridge(deviceId, ownerId, media) {",
            () =>
                storageMarker(
                    "__fxHarnessSyncMediaEnter",
                    "deviceId, ownerId, isClear: media === null, hasBridgePort: Boolean(this.bridgePort), mediaPresent: media !== null"
                ) +
                // Countable: every crossing of the extension -> discovery
                // boundary, so "the retired owner's clear did not cross" can be
                // a delta of 0 rather than an absence in a single-slot key.
                "\ntry { const __fxMSeq = (globalThis.__fxHarnessMirrors = (globalThis.__fxHarnessMirrors || 0) + 1); browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => { void browser.storage.local.set({ ['__fxHarnessMirror_' + __fxMSeq]: { runId: r && r.__fxHarnessDiagnosticRunId, seq: __fxMSeq, deviceId: String(deviceId), ownerId: String(ownerId), isClear: media === null, marker: (media && media.customData && media.customData.harnessMarker) || null, loadGeneration: (currentRokuMediaIdentity(deviceId) || {}).loadGeneration ?? null, at: Date.now() } }).catch(() => {}); }).catch(() => {}); } catch (e) {}"
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
        // The REPLAY path's own view, recorded where it runs: how many
        // identities and session-media entries the extension still holds when a
        // fresh discovery process is told about them. Without this, "the new
        // process was not told" cannot be told apart from "there was nothing to
        // tell it at that moment".
        {
            const file = path.join(extensionDir, "background/background.js");
            const text = fs.readFileSync(file, "utf8");
            // esbuild strips the `private` modifier, and the method is called
            // once and defined once - anchor on the definition text.
            const anchor = "replayRokuLoadGenerations() {";
            if (text.split(anchor).length - 1 !== 1) {
                throw new Error(
                    "sessionHarness: cannot instrument replayRokuLoadGenerations (anchor not found exactly once)"
                );
            }
            fs.writeFileSync(
                file,
                text.replace(
                    anchor,
                    anchor +
                        "\n        try {\n" +
                        "          const __fxRepSeq = (globalThis.__fxHarnessReplays = (globalThis.__fxHarnessReplays || 0) + 1);\n" +
                        "          const __fxIdentities = [...currentRokuMediaIdentities()].map(([deviceId, identity]) => ({ deviceId: String(deviceId), loadGeneration: identity && identity.loadGeneration }));\n" +
                        "          const __fxEntries = [...this.rokuSessionMedia].map(([deviceId, entry]) => ({ deviceId: String(deviceId), ownerId: entry && entry.ownerId ? String(entry.ownerId) : null, marker: (entry && entry.media && entry.media.customData && entry.media.customData.harnessMarker) || null }));\n" +
                        "          browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => {\n" +
                        "            void browser.storage.local.set({ ['__fxHarnessReplay_' + __fxRepSeq]: { runId: r && r.__fxHarnessDiagnosticRunId, seq: __fxRepSeq, hasBridgePort: Boolean(this.bridgePort), identityCount: __fxIdentities.length, identities: __fxIdentities, mediaEntryCount: __fxEntries.length, mediaEntries: __fxEntries, at: Date.now() } }).catch(() => {});\n" +
                        "          }).catch(() => {});\n" +
                        "        } catch (e) {}\n"
                )
            );
        }
        if (deferPopup) {
            // Run-bound proof that a receiver selector OPENED, which is the
            // order this mode has to establish: the popup must mount while the
            // `requestSession` selector is already waiting. Without that, the
            // popup's first port connection is answered with popup:init and its
            // auto-cast timer is cleared - no replacement selector, no gap.
            patch("background/background.js", "async open(opts) {", () =>
                storageMarker(
                    "__fxHarnessSelectorOpened",
                    "selectorTabId: this.tabId, selectorOpenLog: (() => { const log = (globalThis.__fxHarnessSelectorOpenLog = globalThis.__fxHarnessSelectorOpenLog || {}); const key = String(this.tabId); const entry = (log[key] = log[key] || { count: 0, firstAt: Date.now() }); entry.count++; entry.lastAt = Date.now(); return log; })()"
                )
            );
            // Suppress the FIRST `popup:init` post of this run, once, on a
            // run-bound flag. This is the queued label's provocation, and it is deliberately
            // narrow: it reproduces the exact production failure the popup's
            // own watchdog exists for ("a stale page<->background messaging
            // channel... that message never arrives"), i.e. a ready selector
            // whose init data does not reach the popup. Everything else - the
            // popup's timers, its state machine, the init data itself - stays
            // production code.
            if (suppressPopupInit) {
                const initFile = path.join(
                    extensionDir,
                    "background/background.js"
                );
                const initText = fs.readFileSync(initFile, "utf8");
                const subjectAt = initText.indexOf('subject: "popup:init",');
                const callAt =
                    subjectAt === -1
                        ? -1
                        : initText.lastIndexOf(
                              "this.messagePort.postMessage({",
                              subjectAt
                          );
                if (subjectAt === -1 || callAt === -1) {
                    throw new Error(
                        "sessionHarness: cannot instrument the popup:init post (anchor not found)"
                    );
                }
                const objectAt =
                    callAt + "this.messagePort.postMessage(".length;
                let depth = 0;
                let objectEnd = -1;
                for (let i = objectAt; i < initText.length; i++) {
                    if (initText[i] === "{") depth++;
                    else if (initText[i] === "}") {
                        depth--;
                        if (depth === 0) {
                            objectEnd = i;
                            break;
                        }
                    }
                }
                let statementEnd = objectEnd + 1;
                while (
                    statementEnd < initText.length &&
                    /\s/.test(initText[statementEnd])
                )
                    statementEnd++;
                if (
                    objectEnd === -1 ||
                    initText[statementEnd] !== ")" ||
                    initText[statementEnd + 1] !== ";"
                ) {
                    throw new Error(
                        "sessionHarness: the popup:init post does not have the expected shape"
                    );
                }
                statementEnd += 2;
                // `this` stays the ReceiverSelector: the arrow function keeps the
                // method's lexical `this`, so the data object (`this.appInfo`,
                // `this.devices`, ...) needs no rewriting.
                const replacement =
                    "\n      {\n" +
                    "        const __fxInitSelf = this;\n" +
                    "        const __fxInitPost = () => __fxInitSelf.messagePort.postMessage(" +
                    initText.slice(objectAt, objectEnd + 1) +
                    ");\n" +
                    "        try {\n" +
                    "          browser.storage.local.get(['__fxHarnessSuppressPopupInit', '__fxHarnessDiagnosticRunId']).then(r => {\n" +
                    "            const flag = r && r.__fxHarnessSuppressPopupInit;\n" +
                    "            const runId = r && r.__fxHarnessDiagnosticRunId;\n" +
                    "            if (flag && flag.runId === runId && !globalThis.__fxHarnessPopupInitSuppressedOnce) {\n" +
                    "              globalThis.__fxHarnessPopupInitSuppressedOnce = true;\n" +
                    "              void browser.storage.local.set({ __fxHarnessPopupInitSuppressed: { runId: runId, selectorTabId: __fxInitSelf.tabId, at: Date.now() } }).catch(() => {});\n" +
                    "              return;\n" +
                    "            }\n" +
                    "            __fxInitPost();\n" +
                    "          }, () => __fxInitPost()).catch(() => __fxInitPost());\n" +
                    "        } catch (e) { __fxInitPost(); }\n" +
                    "      }";
                fs.writeFileSync(
                    initFile,
                    initText.slice(0, callAt) +
                        replacement +
                        initText.slice(statementEnd)
                );
                console.log(
                    "gap mode: the first popup:init post is suppressible for this run"
                );
            }
        }
        if (failureMode) {
            // Fault injection, run-bound and one-shot per call index.
            //
            // The SAME gate is installed at three checkpoints of
            // createCastSession, and the run-bound control selects which one
            // fires (`stage`), because "session creation failed" is not one
            // event: the resources that exist when it fails differ per stage.
            //
            //   p0  entry - before bridge.connect(): nothing has been created
            //   p1  after bridge.connect() resolved: a native host process and
            //       a port exist, but the instance does not reference them yet
            //   p2  after instance.session and both listeners are installed,
            //       before the caller posts bridge:createCastSession
            //
            // Every stage still runs AFTER the caller announced its load
            // generation, which is the production ordering under test. Injected
            // errors are re-thrown untouched; only the gate's own storage reads
            // may be swallowed.
            // Each checkpoint counts ITS OWN invocations. One shared counter
            // would count checkpoint executions, not calls: at p1 the p0 gate has
            // already incremented it, so the p1 gate would see call 2 and an
            // armed `calls: {1: ...}` would never match.
            const sessionGate = stage =>
                "\n" +
                "    {\n" +
                `        const __fxCall = (globalThis['__fxHarnessCreateSessionCalls_${stage}'] = (globalThis['__fxHarnessCreateSessionCalls_${stage}'] || 0) + 1);\n` +
                "        try {\n" +
                "            const __fxRead = await browser.storage.local.get(['__fxHarnessCreateSessionControl', '__fxHarnessDiagnosticRunId']);\n" +
                "            const __fxCtl = __fxRead && __fxRead.__fxHarnessCreateSessionControl;\n" +
                "            const __fxRunId = __fxRead && __fxRead.__fxHarnessDiagnosticRunId;\n" +
                `            const __fxStage = (__fxCtl && __fxCtl.stage) || 'p0';\n` +
                `            const __fxAction = __fxCtl && __fxCtl.runId === __fxRunId && __fxStage === ${JSON.stringify(
                    stage
                )} && __fxCtl.calls ? __fxCtl.calls[__fxCall] : undefined;\n` +
                "            if (__fxAction) {\n" +
                `                const __fxWhere = { runId: __fxRunId, callIndex: __fxCall, stage: ${JSON.stringify(
                    stage
                )}, action: __fxAction, at: Date.now() };\n` +
                "                void browser.storage.local.set({ ['__fxHarnessCreateSessionEntered_' + __fxCall]: __fxWhere }).catch(() => {});\n" +
                "                if (__fxAction === 'failNow') {\n" +
                "                    void browser.storage.local.set({ ['__fxHarnessCreateSessionFailed_' + __fxCall]: __fxWhere }).catch(() => {});\n" +
                "                    throw new Error('harness: injected createCastSession failure (call ' + __fxCall + ', stage ' + __fxStage + ')');\n" +
                "                }\n" +
                "                if (__fxAction === 'hold') {\n" +
                "                    void browser.storage.local.set({ ['__fxHarnessCreateSessionHeld_' + __fxCall]: __fxWhere }).catch(() => {});\n" +
                "                    for (;;) {\n" +
                "                        await new Promise(r => setTimeout(r, 150));\n" +
                "                        const __fxRel = await browser.storage.local.get(['__fxHarnessReleaseCreateSession', '__fxHarnessDiagnosticRunId']);\n" +
                "                        const __fxRec = __fxRel && __fxRel.__fxHarnessReleaseCreateSession;\n" +
                "                        if (__fxRec && __fxRec.runId === (__fxRel && __fxRel.__fxHarnessDiagnosticRunId) && __fxRec.callIndex === __fxCall) {\n" +
                "                            void browser.storage.local.set({ ['__fxHarnessCreateSessionReleased_' + __fxCall]: { ...__fxWhere, action: __fxRec.action, at: Date.now() } }).catch(() => {});\n" +
                "                            if (__fxRec.action === 'fail') {\n" +
                "                                void browser.storage.local.set({ ['__fxHarnessCreateSessionFailed_' + __fxCall]: { ...__fxWhere, at: Date.now() } }).catch(() => {});\n" +
                "                                throw new Error('harness: released createCastSession failure (call ' + __fxCall + ', stage ' + __fxStage + ')');\n" +
                "                            }\n" +
                "                            break;\n" +
                "                        }\n" +
                "                    }\n" +
                "                }\n" +
                "            }\n" +
                "        } catch (__fxErr) {\n" +
                "            if (String((__fxErr && __fxErr.message) || '').startsWith('harness: ')) throw __fxErr;\n" +
                "        }\n" +
                "    }";
            patch(
                "background/background.js",
                "async function createCastSession(opts) {",
                () => sessionGate("p0")
            );
            // p1: the native host and port exist; instance.session does NOT.
            patch(
                "background/background.js",
                "if (opts.instance.contentContext) {",
                () => sessionGate("p1")
            );
            // p2: instance.session and both listeners exist, and the caller has
            // not yet posted bridge:createCastSession.
            //
            // The anchor is the LAST statement of the function, not `return
            // session;`: patch() inserts AFTER its marker, so anchoring on the
            // return would make the gate unreachable dead code (it did, and the
            // p2 run looked like "the injection never fired").
            patch(
                "background/background.js",
                "if (opts.instance.contentContext?.tabId !== void 0) {",
                () => sessionGate("p2")
            );
            console.log(
                "failure mode: createCastSession is gate-able for this run (run-bound control)"
            );

            // --- injecting a fault into the cleanup ITSELF ------------------
            //
            // The p2 failure reaches the catch that cleans up the half-created
            // session. That cleanup is best-effort: each step has its own catch
            // and the two port-closing steps sit in a `finally`, so a throwing
            // step must not (a) leak the native host or (b) replace the error
            // that explains the failure. Both are properties of the production
            // structure, and until now they had only static backing plus the
            // happy path's dynamic evidence - a cleanup step that never threw
            // in a test cannot show that the finally still ran.
            //
            // Only p2 can reach this code (parseArgs rejects the rest), and the
            // gates below are run-bound and read the SAME control record the
            // stage gates use, so a fault cannot fire in another run.
            const cleanupFile = path.join(
                extensionDir,
                "background/background.js"
            );
            const cleanupText = fs.readFileSync(cleanupFile, "utf8");
            /**
             * A gate plus a marker, inserted at the TOP of the cleanup `try`
             * block whose call may be faulted.
             *
             * The gate is run-bound AND type-checked (`fault === this site's
             * id`), so the other site's gate reads the same record and passes:
             * without the check, arming one fault would make BOTH cleanup steps
             * throw and the exit path would no longer be the production one.
             *
             * The marker is deliberate even when no fault is armed: it says
             * "this block was entered and got past the gate", which is what
             * makes the bail-out assertion below falsifiable rather than
             * vacuous when the fault marker is missing.
             */
            const instrumentCleanupSite = (text, anchor, fault) => {
                const at = text.indexOf(anchor);
                if (at === -1) {
                    throw new Error(
                        `sessionHarness: cannot instrument the cleanup step ${fault.site} (anchor not found): ${anchor}`
                    );
                }
                if (text.indexOf(anchor, at + anchor.length) !== -1) {
                    throw new Error(
                        `sessionHarness: the cleanup anchor for ${fault.site} is not unique: ${anchor}`
                    );
                }
                const insertAt = at + anchor.length;
                // The observable entry marker: storage, because in-memory
                // counters in the background are invisible to the harness, and
                // "the cleanup reached this step" must be a fact the run can read
                // (it is what makes the fault marker's absence meaningful).
                const siteEntry =
                    `\n          try { await browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => browser.storage.local.set({ ${JSON.stringify(
                        `__fxHarnessCleanupSiteEntered_${fault.id}`
                    )}: { runId: r && r.__fxHarnessDiagnosticRunId, site: ${JSON.stringify(
                        fault.site
                    )}, at: Date.now() } })); } catch (e) {}`;
                const gate =
                    siteEntry +
                    ` await __fxHarnessCleanupGate(${JSON.stringify(
                        fault.id
                    )}, ${JSON.stringify(fault.message)}, ${JSON.stringify(
                        fault.site
                    )});\n          `;
                return (
                    text.slice(0, insertAt) +
                    gate +
                    text.slice(insertAt)
                );
            };
            /**
             * The gate itself: hoisted function declaration (so its position in
             * the bundle cannot matter), run-bound, and it throws ONLY the fault.
             *
             * It deliberately does NOT catch the fault it raises: the point is for
             * the PRODUCTION catch of the step it guards to receive it - that is
             * the code path under test (does the outer `finally` still close the
             * port, and does the original error still reach the caller, when a
             * cleanup step throws). An earlier version absorbed its own fault and
             * therefore tested nothing while looking green.
             *
             * Awaiting is correct here even though the guarded calls are
             * synchronous: the gate runs BEFORE the call inside the same `try`, so
             * the call is skipped and the throw lands in the same production catch
             * - the extra storage round trip cannot make the injection "too late",
             * it can only delay it.
             */
            const cleanupGateSource =
                "async function __fxHarnessCleanupGate(faultId, message, site) {\n" +
                "    let ctl;\n" +
                "    let runId;\n" +
                "    try {\n" +
                "        const r = await browser.storage.local.get(['__fxHarnessCleanupFaultControl', '__fxHarnessDiagnosticRunId']);\n" +
                "        ctl = r && r.__fxHarnessCleanupFaultControl;\n" +
                "        runId = r && r.__fxHarnessDiagnosticRunId;\n" +
                "    } catch (e) { return; }\n" +
                "    if (!ctl || ctl.runId !== runId || ctl.fault !== faultId) {\n" +
                "        return;\n" +
                "    }\n" +
                "    try {\n" +
                "        await browser.storage.local.set({ ['__fxHarnessCleanupFaultRaised_' + faultId]: { runId: runId, fault: faultId, site: site, message: message, at: Date.now() } });\n" +
                "    } catch (e) {}\n" +
                "    throw new Error(message);\n" +
                "}";
            {
                // Both sites always carry a gate; the CONTROL decides whether
                // anything throws, so a run without --cleanup-fault behaves
                // exactly as it did before (the gate reads a key that is absent
                // or belongs to another run).
                let text = instrumentCleanupSite(
                    cleanupText,
                    "try {\n            if (opts.instance.bridgeMessageListener) {",
                    CLEANUP_FAULTS[0]
                );
                text = instrumentCleanupSite(
                    text,
                    "opts.instance.session = void 0;\n          try {\n            if (opts.instance.contentContext?.tabId !== void 0) {",
                    CLEANUP_FAULTS[1]
                );
                fs.writeFileSync(cleanupFile, text);
                // The gate function must be patched in AFTER this write: the
                // block above reads the bundle into `text` and writes the whole
                // file back, so a patch applied between that read and this
                // write is silently clobbered (the call sites live in `text`,
                // a separate patch call does not).
                patch(
                    "background/background.js",
                    "async function createCastSession(opts) {",
                    () => "\n" + cleanupGateSource + "\n"
                );
                console.log(
                    args.cleanupFault
                        ? `failure mode: the partial-session cleanup is gate-able (every cleanup site carries a gate; injecting a throw into ${args.cleanupFault})`
                        : "failure mode: the partial-session cleanup is gate-able (both sites carry a gate, no fault armed)"
                );
            }
            // Both handlers are the places the ORIGINAL error is finally
            // consumed, and they are different code for the two callers:
            //
            //   the main:requestSession handler catches it, logs it, and tells
            //   the page "cancelled" (the `--request-source selector` path);
            //   triggerCast() catches what loadSender rethrows and only logs
            //   (the `--request-source queued` path - the popup's auto-cast).
            //
            // A marker holding the message they ACTUALLY caught is the only
            // thing that can distinguish "the original error propagated" from
            // "both errors landed in the same outer catch", which is what the
            // cleanup fault is meant to rule out.
            //
            // The anchor is a complete statement or block END, never the `{` of
            // a call's argument object: inserting into those braces produced
            // `logger.error("...", { <marker> mediaType: ... })`, which does not
            // parse (the harness's own syntax gate caught it before launching -
            // which is why that gate is not optional).
            const outerCaughtMarker = name =>
                `try { void browser.storage.local.get('__fxHarnessDiagnosticRunId').then(r => browser.storage.local.set({ ${JSON.stringify(
                    `__fxHarnessOuterCaught_${name}`
                )}: { handler: ${JSON.stringify(
                    name
                )}, runId: r && r.__fxHarnessDiagnosticRunId, message: String((err && err.message) || err), at: Date.now() } })).catch(() => {}); } catch (e) {}`;
            for (const outer of [
                {
                    anchor:
                        '} catch (err) {\n          pendingRokuMedia?.release();',
                    name: "requestSessionHandler"
                },
                {
                    anchor: '} catch (err) {\n          rokuLoad?.release();',
                    name: "loadSender"
                }
            ]) {
                patch("background/background.js", outer.anchor, () =>
                    `\n          ${outerCaughtMarker(outer.name)}\n`
                );
            }
            // triggerCast's catch holds a single logging CALL, so its marker
            // goes after that statement ends (`});`) and before the catch block
            // closes - located by matching braces instead of spelling out the
            // catch block's shape, which changes with every reformat.
            {
                const file = path.join(extensionDir, "background/background.js");
                const text = fs.readFileSync(file, "utf8");
                const site = text.indexOf(
                    'logger_default.error("loadSender failed (triggerCast)"'
                );
                const callEnd = site === -1 ? -1 : text.indexOf("});", site);
                let closeAt = callEnd === -1 ? -1 : callEnd + 3;
                if (closeAt !== -1) {
                    let depth = 0;
                    let found = -1;
                    for (let i = closeAt; i < text.length; i++) {
                        if (text[i] === "{") depth++;
                        else if (text[i] === "}") {
                            if (depth === 0) {
                                found = i;
                                break;
                            }
                            depth--;
                        }
                    }
                    closeAt = found;
                }
                if (closeAt === -1) {
                    throw new Error(
                        "sessionHarness: cannot instrument the triggerCast catch (loadSender failed (triggerCast) anchor not found)"
                    );
                }
                fs.writeFileSync(
                    file,
                    text.slice(0, closeAt) +
                        `\n          ${outerCaughtMarker("triggerCast")}\n` +
                        text.slice(closeAt)
                );
            }
            console.log(
                "failure mode: every outer handler records the error it actually caught"
            );
        }
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
        //
        // In the gap modes the navigation is deliberately NOT scheduled here:
        // those modes need the popup to mount after `requestSession` has opened
        // its selector, so they navigate this same tab later (see the
        // requestSession block below). Navigating it early would let the
        // popup's auto-cast fire harmlessly before the selector exists.
        const popupTabId = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             (async () => {
                try {
                    const tab = await browser.tabs.create({
                        url: "about:blank",
                        active: false
                    });
                    ${
                        deferPopup
                            ? ""
                            : `setTimeout(() => {
                        browser.tabs.update(tab.id, {
                            url: ${JSON.stringify(popupUrl)}
                        });
                    }, 2500);`
                    }
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
            "__fxHarnessSyncMediaIdentity",
            // Gap-mode keys: cleared every run so "no selector had opened yet"
            // and "the first init was suppressed" cannot be read from an
            // earlier run's leftovers.
            "__fxHarnessSelectorOpened",
            "__fxHarnessPopupInitSuppressed",
            "__fxHarnessSuppressPopupInit",
            // Session-failure keys, likewise cleared so an earlier run's
            // injection state or its markers cannot be read as this run's. One
            // key PER CALL INDEX: a shared held/failed key lets a later call
            // overwrite an earlier one, which would make "was call 1 still
            // held?" unanswerable.
            "__fxHarnessCreateSessionControl",
            "__fxHarnessReleaseCreateSession",
            "__fxHarnessCreateSessionEntered_1",
            "__fxHarnessCreateSessionEntered_2",
            "__fxHarnessCreateSessionHeld_1",
            "__fxHarnessCreateSessionHeld_2",
            "__fxHarnessCreateSessionReleased_1",
            "__fxHarnessCreateSessionReleased_2",
            "__fxHarnessCreateSessionFailed_1",
            "__fxHarnessCreateSessionFailed_2",
            // Cancellations counted by this run (a double settlement shows up as
            // count > 1).
            "__fxHarnessCancelPost_1",
            "__fxHarnessCancelPost_2",
            "__fxHarnessCancelPost_3",
            // Cleanup-fault injection: the run-bound control, the marker each
            // cleanup site writes when it throws, and one marker PER OUTER
            // HANDLER holding the message it caught. A shared key would let the
            // handler that runs second overwrite the first - and "which error
            // reached which handler" is the whole question.
            "__fxHarnessCleanupFaultControl",
            // The gate reads the control straight out of storage on every
            // call (no cached event), so these are the only keys involved:
            // the control, the marker the armed site writes before it throws,
            // and the marker each site writes on entry (present without a
            // fault too - it is what proves the gate is really in the path).
            ...CLEANUP_FAULTS.map(f => `__fxHarnessCleanupFaultRaised_${f.id}`),
            ...CLEANUP_FAULTS.map(f => `__fxHarnessCleanupSiteEntered_${f.id}`),
            "__fxHarnessOuterCaught_requestSessionHandler",
            "__fxHarnessOuterCaught_loadSender",
            "__fxHarnessOuterCaught_triggerCast"
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

        // The late-popup modes arm their control here, while an extension page is still
        // the current context (the probe above ran in it): the flag has to be
        // readable by the background BEFORE the first popup:init post of this
        // run, and awaiting the write is what makes that an ordering fact.
        let selectorOpenedBeforeRequest;
        let senderTabId;
        let requestSelectorTabId;
        let senderTabInfo;
        /** Lower bound for "this failure phase": set when the injection is armed. */
        let injectionArmedAt;
        /**
         * Lower bounds that must precede the failure ACTION (the click that
         * triggers the first createCastSession, or the release request that
         * fails a held one): a failed session start writes
         * `load-generation-cancelled` and a refused release writes a refusal,
         * and the background can write BOTH before this process gets around to
         * reading the console. Captured once, at arming time.
         */
        let failureActionBaseline;
        /**
         * Wrapper PIDs that already existed when the injection was armed. The
         * residue assertions must be about hosts THIS failure created, not about
         * any idle wrapper that happened to be around: a leftover from an earlier
         * phase would otherwise be counted as this checkpoint's leak (or hide one).
         */
        let failureHostPidsBefore;
        if (deferPopup) {
            // Independent identity for the sender tab. `tabs.query({url})` with a
            // match pattern returned nothing here even with the `tabs`
            // permission, so the list is filtered by URL instead, and the raw
            // list is reported when it is not exactly one tab.
            senderTabId = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.tabs.query({}).then(tabs => {
                    const matches = tabs.filter(t => String(t.url || "").startsWith(${JSON.stringify(
                        origin
                    )}));
                    done(matches.length === 1
                        ? matches[0].id
                        : { count: matches.length, urls: tabs.map(t => String(t.url || "").slice(0, 60)) });
                 }, err => done({ error: String(err) }));`
            );
            check(
                "gap mode: the sender tab is addressable on its own (the selector's tabId)",
                typeof senderTabId === "number",
                JSON.stringify(senderTabId)
            );
            const armed = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .set({ __fxHarnessSuppressPopupInit: { runId: ${JSON.stringify(
                        diagnosticRunId
                    )}, at: Date.now() } })
                    .then(() => done(true), err => done(String(err)));`
            );
            if (suppressPopupInit) {
                check(
                    "gap mode: the one-shot popup:init suppression is armed for this run",
                    armed === true,
                    String(armed)
                );
            }
            selectorOpenedBeforeRequest = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .get("__fxHarnessSelectorOpened")
                    .then(v => done(v.__fxHarnessSelectorOpened || null), err => done(String(err)));`
            );
        }
        if (failureMode) {
            // The injection is armed here, before the click, so the FIRST
            // createCastSession of this run is the one that fails (or is held).
            const calls = args.interleave
                ? { 1: "hold", 2: "hold" }
                : { 1: "failNow" };
            const armedInjection = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .set({ __fxHarnessCreateSessionControl: { runId: ${JSON.stringify(
                        diagnosticRunId
                    )}, calls: ${JSON.stringify(calls)}, stage: ${JSON.stringify(
                        args.failStage
                    )}, at: Date.now() } })
                    .then(() => done(true), err => done(String(err)));`
            );
            check(
                `session-failure mode: the createCastSession injection is armed for this run (stage ${args.failStage})`,
                armedInjection === true,
                JSON.stringify({ armed: armedInjection, calls, stage: args.failStage })
            );
            if (args.cleanupFault !== undefined) {
                // Armed together with the stage gate and before the click, so
                // the fault can only reach the cleanup of the start under test.
                // `callIndex: 1` matches the stage gate's `{1: "failNow"}`: both
                // are about the same invocation.
                const armedCleanupFault = await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .set({ __fxHarnessCleanupFaultControl: { runId: ${JSON.stringify(
                            diagnosticRunId
                        )}, fault: ${JSON.stringify(
                            args.cleanupFault
                        )}, callIndex: 1, at: Date.now() } })
                        .then(() => done(true), err => done(String(err)));`
                );
                check(
                    `session-failure mode: the cleanup fault is armed (${args.cleanupFault} throws inside the p2 cleanup)`,
                    armedCleanupFault === true,
                    JSON.stringify({
                        armed: armedCleanupFault,
                        fault: args.cleanupFault
                    })
                );
                // The background reads the control at fault time (its own
                // storage read inside the gate), so what has to hold is that the
                // arm has LANDED before the click. Reading it back is that
                // ordering fact; there is no cache to wait for any more.
                const armedBack = await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .get("__fxHarnessCleanupFaultControl")
                        .then(v => done(v.__fxHarnessCleanupFaultControl || null), err => done({ error: String(err) }));`
                );
                check(
                    "session-failure mode: the cleanup-fault control is readable before the click",
                    Boolean(
                        armedBack &&
                            armedBack.runId === diagnosticRunId &&
                            armedBack.fault === args.cleanupFault
                    ),
                    JSON.stringify({
                        armedBack: armedBack || null,
                        runId: diagnosticRunId,
                        fault: args.cleanupFault
                    })
                );
            }
            // The failure phase's lower bound for the wire assertions, taken
            // after the arm has landed: nothing this phase produces can predate
            // it, so an earlier generation (or a replay) cannot be counted as
            // this phase's.
            injectionArmedAt = Date.now();
            {
                const consoleText =
                    phaseBConsole && fs.existsSync(phaseBConsole)
                        ? fs.readFileSync(phaseBConsole, "utf8")
                        : "";
                const countTrace = event =>
                    (
                        consoleText.match(
                            new RegExp(
                                `Roku media trace \\[${FAKE_DEVICE_ID}\\] ${event}`,
                                "g"
                            )
                        ) || []
                    ).length;
                // `traceLines`/`readConsoleText` are defined later, next to the
                // failure assertions, so this early capture reads the file
                // directly - the ORDER is the point, not the helper.
                failureHostPidsBefore = new Set(
                    readNdjson(path.join(harnessDir, "spawns.ndjson"))
                        .filter(entry => entry.event === undefined)
                        .map(entry => entry.pid)
                );
                failureActionBaseline = {
                    cancelled: countTrace("load-generation-cancelled"),
                    refused: (
                        consoleText.match(
                            /Roku media load release ignored/g
                        ) || []
                    ).length
                };
                console.log(
                    "session-failure mode: failure-action baseline:",
                    JSON.stringify(failureActionBaseline)
                );
            }
            {
                // Every failure mode may start a second cast through
                // `action:castCurrentTab`, whose handler resolves its target with
                // `tabs.query({active: true, currentWindow: true})`. Pin that
                // resolution to the sender tab explicitly instead of hoping the
                // WebDriver window switches left it active.
                senderTabInfo = await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.tabs.query({}).then(tabs => {
                        const matches = tabs.filter(t => String(t.url || "").startsWith(${JSON.stringify(
                            origin
                        )}));
                        done(matches.length === 1
                            ? { id: matches[0].id, windowId: matches[0].windowId }
                            : { count: matches.length, urls: tabs.map(t => String(t.url || "").slice(0, 60)) });
                     }, err => done({ error: String(err) }));`
                );
                check(
                    "interleave mode: the sender tab is addressable with its window",
                    Boolean(senderTabInfo && typeof senderTabInfo.id === "number"),
                    JSON.stringify(senderTabInfo)
                );
            }
        }

        await driver.switchTo().window(senderTab);

        const marksBeforeSession = markCount();
        if (args.requestSettlementReentrant) {
            // Armed BEFORE the request is issued, because the cancel this probe
            // reacts to is produced by the popup's auto-cast replacing the
            // page's selector - which happens when the popup mounts, i.e. after
            // the request and BEFORE the click. Arming at click time was too
            // late: measured, the error callback had already run.
            const armed = await driver.executeScript(
                "window.__HARNESS_REISSUE_ON_CANCEL__ = true; return window.__HARNESS_REISSUE_ON_CANCEL__ === true;"
            );
            check(
                "request-settlement-reentrant: the page is armed to start a second requestSession synchronously from the cancelled request's error callback",
                armed === true,
                String(armed)
            );
        }
        const requestAtSession = Date.now();
        await driver.executeScript(
            "window.__HARNESS_REQUEST_SESSION__().catch(() => {});"
        );

        if (deferPopup) {
            // The popup mounts only now, i.e. AFTER requestSession opened its
            // selector: mounting it earlier is what makes the popup's auto-cast
            // fire harmlessly before any selector exists, which is why the
            // production race only shows up occasionally.
            await driver.switchTo().window(consoleTab);
            let selectorOpened;
            const selectorDeadline = Date.now() + 20000;
            while (Date.now() < selectorDeadline) {
                selectorOpened = await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .get("__fxHarnessSelectorOpened")
                        .then(v => done(v.__fxHarnessSelectorOpened || null), err => done(String(err)));`
                );
                // The tab IDENTITY comes from the marker itself: it is the tab
                // whose selector the run's requestSession opened, which is what
                // the suppressed init and the replacement have to match. The
                // separately resolved sender tab id is only a cross-check.
                const log =
                    selectorOpened &&
                    selectorOpened.selectorOpenLog &&
                    selectorOpened.selectorOpenLog[
                        String(selectorOpened.selectorTabId)
                    ];
                if (
                    selectorOpened &&
                    selectorOpened.runId === diagnosticRunId &&
                    log &&
                    log.firstAt >= requestAtSession
                )
                    break;
                selectorOpened = undefined;
                await sleep(100);
            }
            requestSelectorTabId =
                selectorOpened && selectorOpened.selectorTabId;
            check(
                "gap mode: the requestSession selector opened before the popup was mounted",
                Boolean(selectorOpened) &&
                    !selectorOpenedBeforeRequest &&
                    senderTabId === requestSelectorTabId,
                JSON.stringify({
                    before: selectorOpenedBeforeRequest || null,
                    after: selectorOpened || null,
                    openedForSelectorTab: requestSelectorTabId,
                    senderTabId,
                    requestAt: requestAtSession
                })
            );
            // Navigating from this extension page (rather than by switching to
            // the popup tab) keeps the sender tab the ACTIVE tab of its window -
            // the popup derives its `popup:<tabId>` port name from it, and the
            // background's `action:castCurrentTab` handler resolves the same
            // way.
            await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.tabs
                    .update(${JSON.stringify(
                        popupTabId
                    )}, { url: ${JSON.stringify(popupUrl)} })
                    .then(() => done(true), err => done(String(err)));`
            );
            await driver.switchTo().window(senderTab);
        }

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

        // ONE `/ui/popup/` handle, and that fact is asserted rather than
        // assumed: the sender page is served over http by this harness (`file://`
        // is not a whitelisted SDK origin), so it can never collide with the UI's
        // URL, and the selector UI plus the popup are the same tab.
        const popupUrlHandles = await findHandlesByUrl(
            driver,
            "/ui/popup/",
            20000
        );
        const popupHandle = popupUrlHandles[0];
        check(
            "the selector/popup UI is addressable AND unique (exactly one /ui/popup/ handle, so the click cannot be a coin flip)",
            popupUrlHandles.length === 1,
            JSON.stringify({
                popupUrlHandles: popupUrlHandles.length,
                totalHandles: (await driver.getAllWindowHandles()).length,
                requestSelectorTabId: requestSelectorTabId ?? null,
                senderTabId: senderTabId ?? null
            })
        );
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
            /**
             * Every `cast:sessionRequestCancelled` post of THIS run, in post
             * order, each carrying the IDENTITY of the site that posted it and
             * (where a `catch` binding is in scope) the error it was handling.
             * A bare count could not distinguish "the page was settled by its own
             * failed start" from "by the selector that replaced it".
             */
            const readCancelState = () =>
                driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local.get(null).then(all => {
                        const runId = all && all.__fxHarnessDiagnosticRunId;
                        const keys = Object.keys(all || {}).filter(k => k.indexOf("__fxHarnessCancelPost_") === 0);
                        const mine = keys.map(k => all[k]).filter(m => m && m.runId === runId);
                        done({
                            runId,
                            markerKeys: keys.length,
                            markersForRun: mine.length,
                            maxCount: mine.length ? Math.max(...mine.map(m => m.count)) : 0,
                            posts: mine
                                .sort((a, b) => a.count - b.count)
                                .map(m => ({
                                    count: m.count,
                                    site: m.site,
                                    siteHint: m.siteHint,
                                    caughtError: m.caughtError || null
                                }))
                        });
                     }, err => done({ error: String(err) }));`
                );

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
        /**
         * Who owns the session, and who settled the request - BY ROUTE.
         *
         * `requestSessionSucceeded` used to be the universal definition of "the
         * cast worked", and that was only true because of the double-settlement
         * defect: on the queued route the page's request was cancelled and then
         * settled AGAIN by the session the extension created. Under the contract
         * (one request settles exactly once; an extension-created session is
         * delivered through `ApiConfig`'s sessionListener) the two routes differ:
         *
         *   selector: the page's own requestSession owns the session;
         *   queued:   the request is cancelled and the sessionListener delivers
         *             the extension-created session, which the page then adopts.
         *
         * Keeping this in one place is the point: "the page has a session" must
         * not be re-derived per check from whichever field happened to be set by
         * the behaviour of the day.
         */
        const pageSessionOwnership = (route, page) => {
            const callbacks = (page && page.sessionCallbacks) || [];
            const listeners = (page && page.listenerSessions) || [];
            const listenerCalls = (page && page.sessionListenerCalls) || 0;
            if (route === "selector") {
                return {
                    route,
                    owner: "the page's own requestSession (success callback)",
                    requestSettled:
                        callbacks.length === 1 &&
                        callbacks[0].type === "success",
                    requestCallbackCount: callbacks.length,
                    sessionAvailable: Boolean(page && page.sessionId),
                    sessionId: (page && page.sessionId) || null,
                    listenerCalls
                };
            }
            return {
                route,
                owner: "the extension-created session, via sessionListener",
                requestSettled:
                    callbacks.length === 1 &&
                    callbacks[0].type === "error" &&
                    Boolean(callbacks[0].payload) &&
                    callbacks[0].payload.code === "cancel",
                requestCallbackCount: callbacks.length,
                sessionAvailable:
                    listeners.length === 1 &&
                    Boolean(listeners[0] && listeners[0].sessionId),
                sessionId: (listeners[0] && listeners[0].sessionId) || null,
                listenerCalls
            };
        };
        // Which route this run took. In the modes that MOUNT the popup
        // deliberately (settlement, auto-cast, failure) the route is controlled
        // and `suppressPopupInit` states it. In the plain success run it is a
        // race the harness does not control (the popup mounts ~2.5s after the
        // page's selector opens), so there the route is MEASURED - which channel
        // actually delivered the session - and the ownership check asserts the
        // consistency of that shape instead of a route the run never promised.
        const controlledRoute = suppressPopupInit ? "queued" : null;

        // The failure modes deliberately never reach a session, so waiting for
        // the success callback would just burn the whole deadline.
        const pageResult = failureMode
            ? await driver.executeScript(
                  "return window.__HARNESS_RESULT__ || null;"
              )
            : await driver.executeAsyncScript(
                  `const done = arguments[arguments.length - 1];
             const deadline = Date.now() + 30000;
             const tick = () => {
                const r = window.__HARNESS_RESULT__;
                // Wait for a DELIVERED session, through either channel - not
                // for "a request callback exists". A cancel is a request callback
                // too, so the earlier version returned in the window between the
                // cancel and the session, and then read an ownership shape that
                // only looked broken (measured: one error callback, no listener,
                // no session - on a run whose session did arrive moments later).
                // (No backticks in here: this whole script is a template literal
                // in the harness.)
                const ready =
                    r &&
                    ((r.sessionCallbacks || []).some(
                        c => c.type === "success"
                    ) ||
                        (r.sessionListenerCalls || 0) >= 1);
                if (ready) { done(r); return; }
                if (Date.now() > deadline) { done(r); return; }
                setTimeout(tick, 250);
             };
             tick();`
              );
        // The route is now derived from the captured page result, which is why
        // this happens here and not next to the helper: reading it earlier threw
        // `Cannot access 'pageResult' before initialization` on EVERY mode.
        const pageFacts = pageResult || {};
        const deliveredByListener =
            !(pageFacts.sessionCallbacks || []).some(
                c => c.type === "success"
            ) && (pageFacts.sessionListenerCalls || 0) >= 1;
        const pageRoute = controlledRoute
            ? controlledRoute
            : deliveredByListener
              ? "queued"
              : "selector";
        const pageOwnership = pageSessionOwnership(pageRoute, pageResult);
        // `--request-settlement-reentrant` issues TWO requests on purpose (the
        // second from inside the first one's error callback), so the
        // single-request ownership model above does not describe it: its
        // per-ATTEMPT assertions are the authority there, and they are strictly
        // stronger (they say which request each callback belonged to). Enforcing
        // the one-request model on top would only add reds that mean "this mode
        // does what it says".
        const useOwnershipModel =
            !failureMode && !args.requestSettlementReentrant;
        if (failureMode) {
            check(
                "session-failure mode: the page's requestSession did NOT succeed (the injected failure is real)",
                Boolean(pageResult) &&
                    pageResult.requestSessionSucceeded !== true,
                JSON.stringify(pageResult)
            );
            check(
                "session-failure mode: the page has no session id",
                Boolean(pageResult) && !pageResult.sessionId,
                JSON.stringify(pageResult && pageResult.sessionId)
            );
        } else if (useOwnershipModel) {
            console.log(
                `page session ownership (${pageOwnership.route}):`,
                JSON.stringify(pageOwnership)
            );
            check(
                `the page's requestSession settled exactly once, the way its route defines (owner: ${pageOwnership.owner})`,
                pageOwnership.requestSettled,
                JSON.stringify(pageOwnership)
            );
            check(
                `the page has a usable session for LOAD, delivered by ${pageOwnership.owner}`,
                pageOwnership.sessionAvailable,
                JSON.stringify(pageOwnership)
            );
        }

        // The success routes are the CONTROL for the page contract: a session IS
        // established for the tab, so the page must see a success. Whether the
        // replaced selector ALSO posts a cancel, and whether that arrives before
        // or after the session, is what tells "one external contract" apart from
        // "two internal paths that happen to converge".
        if (!failureMode) {
            // The current context here is the SENDER page (an http page, where
            // `browser` does not exist); the storage read must run in an
            // extension page.
            await driver.switchTo().window(consoleTab);
            const cancelState = await readCancelState();
            console.log(
                // NOT `args.requestSource`: outside the failure matrix that label
                // is just its default value (a default run prints "queued" while
                // it actually clicked the requestSession selector - path A).
                `page settlement (${
                    gapMode
                        ? `--auto-cast-${expectGap ? "gap" : "fixed"}`
                        : "default"
                }):`,
                JSON.stringify({
                    requestSessionCalls: pageResult && pageResult.requestSessionCalls,
                    successCount: pageResult && pageResult.successCount,
                    errorCount: pageResult && pageResult.errorCount,
                    settleType: pageResult && pageResult.settleType,
                    sessionId: (pageResult && pageResult.sessionId) || null,
                    backgroundCancels: cancelState.maxCount,
                    cancelMarkers: cancelState.markersForRun,
                    cancelSites: cancelState.posts,
                    callbacks: ((pageResult && pageResult.sessionCallbacks) || []).map(
                        c => ({
                            type: c.type,
                            code: c.payload && c.payload.code
                        })
                    ),
                    sessionListenerCalls: pageResult && pageResult.sessionListenerCalls,
                    listenerSessions: (pageResult && pageResult.listenerSessions) || []
                })
            );
        }

        // --- the page's requestSession SETTLEMENT contract -------------------
        //
        // Contract (agreed): one `requestSession()` call settles EXACTLY ONCE -
        // success(session) or error(CastError) - and after that terminal state
        // neither of its callbacks may run again. A session the EXTENSION
        // created (the queued/auto-cast route) is therefore NOT a settlement of
        // a request that was already cancelled: it must be published through
        // `ApiConfig`'s sessionListener instead.
        //
        // Both modes below collect the SAME facts (page callback timeline, the
        // sessionListener timeline, and which background cancel site posted);
        // only the expectation flips, so there is one reader to trust.
        if (settlementMode) {
            await driver.switchTo().window(consoleTab);
            const cancelState = await readCancelState();
            const callbacks = (pageResult && pageResult.sessionCallbacks) || [];
            const types = callbacks.map(c => c.type);
            const codes = callbacks.map(c => c.payload && c.payload.code);
            const listenerSessions =
                (pageResult && pageResult.listenerSessions) || [];
            const listenerCalls =
                (pageResult && pageResult.sessionListenerCalls) || 0;
            const sessionId = (pageResult && pageResult.sessionId) || null;
            const sites = cancelState.posts.map(p => p.site);
            const facts = {
                requestSessionCalls: pageResult && pageResult.requestSessionCalls,
                successCount: pageResult && pageResult.successCount,
                errorCount: pageResult && pageResult.errorCount,
                settleType: pageResult && pageResult.settleType,
                callbackTypes: types,
                callbackCodes: codes,
                sessionCallbacks: callbacks.length,
                sessionId,
                backgroundCancels: cancelState.maxCount,
                cancelSites: cancelState.posts,
                sessionListenerCalls: listenerCalls,
                listenerSessions
            };
            console.log(
                `request settlement (${
                    expectDoubleSettlement
                        ? "gap"
                        : args.requestSettlementReentrant
                          ? "reentrant"
                          : "fixed"
                }):`,
                JSON.stringify(facts)
            );
            // Both modes first require that the session really WAS created and
            // really REACHED the page - otherwise "the stale callback did not
            // run" would be trivially true for a session that never existed.
            //
            // The two ownership channels are mutually exclusive by design, and
            // the check accepts EITHER, because which one is legitimate depends on
            // the build:
            //
            //   pre-fix: the stale request success callback exposes the session
            //   (and sets the page's top-level `sessionId`);
            //   fixed:   the sessionListener exposes it, and the page's own
            //   `sessionId` STAYS EMPTY - the listener deliberately records the
            //   session without adopting it (see pages/sender.html), so requiring
            //   a non-empty `sessionId` here would raise a third, unrelated red
            //   against a CORRECT fix.
            const requestCallbackExposedSession =
                Boolean(sessionId) && types.includes("success");
            const listenerExposedSession = listenerSessions.some(entry =>
                Boolean(entry && entry.sessionId)
            );
            check(
                `request-settlement: the extension created a session for this tab and it reached the page (through the request success callback, or through the sessionListener when the request was already cancelled)`,
                requestCallbackExposedSession || listenerExposedSession,
                JSON.stringify({
                    ...facts,
                    requestCallbackExposedSession,
                    listenerExposedSession
                })
            );
            check(
                `request-settlement: the ORIGINAL request was cancelled by the background (${
                    expectDoubleSettlement ? "site 1" : "a background cancel"
                } still posts)`,
                sites.includes(1),
                JSON.stringify({ cancelSites: cancelState.posts })
            );
            if (expectDoubleSettlement) {
                // Pre-fix control: measured, not assumed.
                check(
                    "request-settlement-gap: the cancelled request was later settled again by the extension-created session",
                    callbacks.length === 2 &&
                        types[0] === "error" &&
                        codes[0] === "cancel" &&
                        types[1] === "success" &&
                        (pageResult && pageResult.settleType) === "error" &&
                        (pageResult && pageResult.successCount) === 1 &&
                        (pageResult && pageResult.errorCount) === 1,
                    JSON.stringify(facts)
                );
                check(
                    "request-settlement-gap: the extension-created session did NOT reach the page through sessionListener (it was misrouted into the stale request callback instead)",
                    listenerCalls === 0,
                    JSON.stringify({ sessionListenerCalls: listenerCalls })
                );
            } else if (args.requestSettlementReentrant) {
                // --- the ORDER inside the cancel branch ----------------------
                //
                // Contract: one requestSession() call settles exactly once, and
                // its fields are cleared BEFORE its error callback runs. The
                // observable consequence is this: a callback that synchronously
                // starts the NEXT request must find that next request still
                // usable afterwards. If the SDK cleared its fields after calling
                // the callback, the tail of the old handler would wipe the new
                // request's slot and callbacks, and the new request would never
                // settle - which is indistinguishable from "the session was
                // swallowed" unless the per-request attribution below is read.
                //
                // NOT covered here (deliberately): the cancel message carries no
                // request identity, so a LATE cancel belonging to the first
                // request arriving after the second was created cannot be
                // attributed. That is a separate protocol gap and outside this
                // minimal fix.
                const attempts = (pageResult && pageResult.requestAttempts) || [];
                const first = attempts.find(a => a.label === "A");
                const second = attempts.find(a => a.label === "B");
                const settledTypes = a =>
                    ((a && a.callbacks) || []).map(c => c.type);
                const settleCodes = a =>
                    ((a && a.callbacks) || []).map(
                        c => c.payload && c.payload.code
                    );
                const reentrancy = {
                    attempts: attempts.map(a => ({
                        label: a.label,
                        requestId: a.requestId,
                        settleType: a.settleType,
                        callbacks: settledTypes(a),
                        codes: settleCodes(a),
                        sessionIds: ((a && a.callbacks) || [])
                            .map(c => c.payload && c.payload.sessionId)
                            .filter(Boolean)
                    })),
                    firstStartedBeforeSecond: Boolean(
                        first && second && first.startedAt <= second.startedAt
                    ),
                    sessionListenerCalls:
                        (pageResult && pageResult.sessionListenerCalls) || 0
                };
                console.log(
                    "request settlement (reentrant):",
                    JSON.stringify(reentrancy)
                );
                check(
                    "request-settlement-reentrant: the first request settled exactly once, with error(cancel)",
                    Boolean(first) &&
                        settledTypes(first).length === 1 &&
                        settledTypes(first)[0] === "error" &&
                        settleCodes(first)[0] === "cancel",
                    JSON.stringify(reentrancy)
                );
                check(
                    "request-settlement-reentrant: the error callback synchronously started a SECOND request",
                    Boolean(second) &&
                        attempts.length === 2 &&
                        reentrancy.firstStartedBeforeSecond,
                    JSON.stringify(reentrancy)
                );
                check(
                    "request-settlement-reentrant: the second request was still alive after the first handler returned, and settled exactly once (its fields were NOT wiped by the old request's cleanup)",
                    Boolean(second) &&
                        settledTypes(second).length === 1 &&
                        Boolean(second.settledAt) &&
                        second.settledAt >= first.callbacks[0].at,
                    JSON.stringify(reentrancy)
                );
                check(
                    "request-settlement-reentrant: the session reached the SECOND request's success callback (a pending request owns the session, so the listener is not used here)",
                    Boolean(second) &&
                        settledTypes(second)[0] === "success" &&
                        Boolean(
                            second.callbacks[0].payload &&
                                second.callbacks[0].payload.sessionId
                        ) &&
                        reentrancy.sessionListenerCalls === 0,
                    JSON.stringify(reentrancy)
                );
            } else {
                // Post-fix target: one terminal state, and the session exposed
                // the way the SDK documents for extension-created sessions.
                check(
                    "request-settlement-fixed: the request settled exactly once, with error(cancel)",
                    callbacks.length === 1 &&
                        types[0] === "error" &&
                        codes[0] === "cancel" &&
                        (pageResult && pageResult.successCount) === 0 &&
                        (pageResult && pageResult.errorCount) === 1,
                    JSON.stringify(facts)
                );
                check(
                    "request-settlement-fixed: the extension-created session reached the page through sessionListener, exactly once, with a session id",
                    listenerCalls === 1 &&
                        listenerSessions.length === 1 &&
                        Boolean(listenerSessions[0] && listenerSessions[0].sessionId),
                    JSON.stringify({
                        sessionListenerCalls: listenerCalls,
                        listenerSessions
                    })
                );
            }
        }
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
        if (failureMode) {
            // The injected failure happens after the generation was announced
            // and before any session host exists, so "no session" is the
            // positive expectation here, not a broken harness.
            check(
                "session-failure mode: no session host was created (the injected failure is real)",
                !session,
                JSON.stringify(connections.map(c => c.pid))
            );
        } else {
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
        }

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
        // Is the observing channel itself proven for this run?
        //
        // Both channels that matter are proven independently of the path the
        // click took: the popup wrote its click-time marker (popup context), and
        // the background answered this run's storage probe (`backgroundControl`,
        // asserted above, and the only run-bound proof of the BACKGROUND's write
        // path).
        //
        // The selection marker is deliberately NOT part of this predicate. It is
        // written immediately before the production Roku branch, so a click that
        // resolves a replacement selector (the popup's auto-cast route) never
        // reaches it - and requiring it read "the click went the other way" as
        // "the channel is broken", which is how a missing Gate B marker was
        // mis-read twice. Its presence or absence is diagnostic, printed below
        // and asserted explicitly where it is the point (`--auto-cast-gap`).
        // SUPPORTING route evidence, not the authoritative one. This marker is
        // written immediately before the production Roku branch of
        // `main:requestSession`, so its presence is positive proof that the click
        // resolved through that handler; its ABSENCE, however, is a bounded
        // "not seen" observation (the read above waited for this run's own
        // positive markers - the popup's click control and the load generation -
        // and gave up after 15s), and a late write could in principle arrive
        // after that window. The authoritative caller evidence is therefore the
        // outer-catch assertions over the same failure matrix (they read what
        // each caller's own catch actually received): in `--cleanup-fault` runs
        // inside the cleanup-fault block, otherwise in the block that follows the
        // page-settlement checks.
        // Only the single-caller FAILURE matrix (`--create-failure-*`, with or
        // without `--cleanup-fault`), because that is the only place where
        // `--request-source` is a caller-ownership claim:
        //
        //   `--interleave-*` starts BOTH callers on purpose (a requestSession
        //   start and the popup's own start), and the requestSession one walks
        //   this very branch - under the default `queued` label this check would
        //   demand an ABSENT marker in a run where the marker is legitimately
        //   present;
        //   the success modes (default, `--media-before-generation`,
        //   `--generation-advance`, `--startup-synthesis`, `--auto-cast-*`) never
        //   claimed single-caller ownership at all, so a default `queued` label
        //   must not impose one on them either.
        //
        // Both cases would fail the harness's own assumption rather than the
        // product. Interleave asserts its own two-start facts instead (which
        // start announced, whose release was refused).
        if (args.createFailure && !args.interleave) {
            check(
                `request-source ${args.requestSource}: supporting evidence - the Roku-branch marker of main:requestSession is ${
                    args.requestSource === "selector" ? "present" : "absent"
                } (the authoritative caller check is the outer-catch assertion)`,
                args.requestSource === "selector"
                    ? Boolean(selectionMarker)
                    : !selectionMarker,
                JSON.stringify({
                    selectionAtRokuBranch: selectionMarker || null,
                    clickControl: clickControl || null,
                    requestSelectorTabId: requestSelectorTabId ?? null,
                    senderTabId: senderTabId ?? null
                })
            );
        }
        check(
            "Gate B channel self-proof: the popup's click marker and the background's probe/ack are both present for this run",
            Boolean(clickControl && backgroundControl),
            JSON.stringify({
                clickControl: clickControl || null,
                selectionMarker: selectionMarker || null,
                backgroundStorageControl: Boolean(backgroundControl)
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
        // The failure modes have no session at all, so there is nothing to LOAD
        // through: Stage 2 would assert against a session that the injected
        // failure prevented on purpose.
        const pathBWasTaken = !pathA || !gateBOk || failureMode;
        // In `--auto-cast-gap` the missing generation IS the expected result, so
        // that mode asserts its absence here (and this check is one of the ones
        // allowed to flip once the defect is fixed). Every other mode - including
        // `--auto-cast-fixed` - requires the generation.
        check(
            gapMode && expectGap
                ? "gap mode: no load generation was created for the fake device (the pre-fix defect)"
                : "Gate B: a load generation was created for the fake device",
            gapMode && expectGap ? !gateBOk : gateBOk,
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

        let gapGenerationMarker;
        if (gapMode) {
            // ================= the queued-selection gap ======================
            //
            // Reported at the root-cause boundary on purpose: the defect is
            // "this session start never established a load generation", not the
            // Stage 2 cascade that follows from it. `--auto-cast-gap` asserts the
            // pre-fix outcome, `--auto-cast-fixed` the post-fix one; the session
            // creation evidence is asserted identically by both, so a fix can
            // only flip the generation assertions.
            await driver.switchTo().window(consoleTab);
            gapGenerationMarker = undefined;
            const gapEvidence = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local
                    .get(["__fxHarnessPopupInitSuppressed", "__fxHarnessSelectorOpened", "__fxHarnessLoadGenerationBegan"])
                    .then(v => done(v), err => done({ error: String(err) }));`
            );
            const suppressed = markerFor(
                gapEvidence,
                "__fxHarnessPopupInitSuppressed"
            );
            const opened = markerFor(gapEvidence, "__fxHarnessSelectorOpened");
            const generationMarker = markerFor(
                gapEvidence,
                "__fxHarnessLoadGenerationBegan"
            );
            gapGenerationMarker = generationMarker;
            // The popup's own words: its auto-cast timer fired, and the cast it
            // started was the current-tab one (`action:castCurrentTab`). Read
            // from the captured extension console, which is the only place the
            // popup's mirrored debug log shows up.
            const popupLogs =
                phaseBConsole && fs.existsSync(phaseBConsole)
                    ? fs.readFileSync(phaseBConsole, "utf8")
                    : "";
            const autoCastFired = popupLogs.includes("auto-cast timer fired");
            const castCurrentTabSent = popupLogs.includes(
                "castCurrentTab -> action:castCurrentTab"
            );
            const selectorRetried = popupLogs.includes(
                "selector did not open in time; auto-retrying cast once"
            );
            check(
                "gap mode: the popup's own auto-cast fired and sent the current-tab cast (popup log)",
                autoCastFired && castCurrentTabSent,
                JSON.stringify({
                    autoCastFired,
                    castCurrentTabSent,
                    selectorRetried
                })
            );
            check(
                "gap mode: the popup's first init for this run was suppressed, for the requestSession selector's tab",
                Boolean(
                    suppressed &&
                        suppressed.runId === diagnosticRunId &&
                        suppressed.selectorTabId === requestSelectorTabId
                ),
                JSON.stringify({
                    suppressed: suppressed || null,
                    expectedRunId: diagnosticRunId,
                    expectedTabId: requestSelectorTabId
                })
            );
            check(
                "gap mode: the requestSession selector was REPLACED by the auto-cast's selector for the same tab",
                Boolean(
                    opened &&
                        opened.runId === diagnosticRunId &&
                        opened.selectorOpenLog &&
                        opened.selectorOpenLog[String(requestSelectorTabId)] &&
                        opened.selectorOpenLog[String(requestSelectorTabId)]
                            .count >= 2
                ),
                JSON.stringify({
                    opened: opened || null,
                    expectedTabId: requestSelectorTabId,
                    selectorOpens:
                        opened &&
                        opened.selectorOpenLog &&
                        opened.selectorOpenLog[String(requestSelectorTabId)]
                })
            );
            // Positive half: the session is real. Its native host has its own
            // PID, the bridge was told to create the session, and the page's own
            // requestSession success callback ran.
            const sessionCreated = Boolean(
                session &&
                    session.inbound.some(
                        m => m.subject === "bridge:createCastSession"
                    )
            );
            check(
                "gap mode: bridge:createCastSession reached the session host",
                sessionCreated,
                JSON.stringify(
                    session
                        ? session.inbound.map(m => m.subject).slice(0, 10)
                        : null
                )
            );
            check(
                `auto-cast: the queued cast still delivered the extension-created session to the page (the page's own request was cancelled: owner is ${pageOwnership.owner})`,
                pageOwnership.requestSettled &&
                    pageOwnership.sessionAvailable &&
                    pageOwnership.listenerCalls === 1,
                JSON.stringify({
                    ownership: pageOwnership,
                    pageRequestSessionSucceeded: Boolean(
                        pageResult && pageResult.requestSessionSucceeded
                    )
                })
            );
            // Negative half: nothing in the normal path ran, and no generation
            // exists for this device on ANY connection.
            const generationRelays = discoveryConnections.flatMap(conn =>
                [...conn.inbound, ...conn.outbound].filter(
                    m =>
                        m.subject === "bridge:rokuSetLoadGeneration" &&
                        m.message &&
                        m.message.data &&
                        m.message.data.deviceId === FAKE_DEVICE_ID
                )
            );
            check(
                "gap mode: the selection marker before the Roku branch is absent for this run",
                !selectionMarker,
                JSON.stringify({
                    selectionMarker: selectionMarker || null,
                    clickMarkerPresent: Boolean(clickControl)
                })
            );
            if (expectGap) {
                check(
                    "queued Roku App session was created without establishing a load generation",
                    Boolean(sessionCreated) &&
                        pageOwnership.requestSettled &&
                        pageOwnership.sessionAvailable &&
                        Boolean(clickControl) &&
                        Boolean(backgroundControl) &&
                        !selectionMarker &&
                        !generationMarker &&
                        generationRelays.length === 0,
                    JSON.stringify({
                        sessionCreated,
                        pageOwnership: pageOwnership,
                        backgroundStorageControl: Boolean(backgroundControl),
                        selectionMarker: selectionMarker || null,
                        loadGenerationBegan: generationMarker || null,
                        generationRelaysOnDiscovery: generationRelays.length,
                        discoveryConnections: discoveryConnections.length
                    })
                );
            } else {
                // Post-fix: the same session start must establish EXACTLY one
                // generation - not "at least one". A second advance would retire
                // the media the session is about to publish, because
                // RokuSessionMediaSync.apply() retires stale generations first.
                check(
                    "fixed mode: this session start established exactly one load generation",
                    Boolean(
                        generationMarker &&
                            generationMarker.deviceId === FAKE_DEVICE_ID &&
                            Number.isFinite(generationMarker.loadGeneration) &&
                            generationMarker.loadGenerationCalls === 1
                    ),
                    JSON.stringify(generationMarker || null)
                );
                check(
                    "fixed mode: that generation reached a discovery connection",
                    generationRelays.some(
                        m =>
                            m.message.data.loadGeneration ===
                            (generationMarker &&
                                generationMarker.loadGeneration)
                    ),
                    JSON.stringify(
                        generationRelays.map(m => ({
                            pid: m.pid,
                            at: m.at,
                            subject: m.subject,
                            loadGeneration: m.message.data.loadGeneration
                        }))
                    )
                );
                check(
                    "queued Roku App session established exactly one load generation",
                    Boolean(sessionCreated) &&
                        Boolean(generationMarker) &&
                        generationMarker.loadGenerationCalls === 1 &&
                        generationRelays.length > 0,
                    JSON.stringify({
                        sessionCreated,
                        loadGenerationBegan: generationMarker || null,
                        generationRelaysOnDiscovery: generationRelays.length
                    })
                );
            }
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

        if (failureMode) {
            // ===== the pending gate when a session start fails ================
            //
            // What is under test is NOT the generation: it is monotonic by
            // design, the previous load's media was already retired at discovery
            // when the new generation was relayed, and the wire is asserted to
            // carry no lower generation. What is under test is the LOCAL
            // pending-media gate the announcement opened: while it is set,
            // `deviceManager` drops that device's ECP media status (trace
            // `remote-status-blocked`), and only a release, or a real session
            // media, clears it.
            //
            // Which gate state each mode expects:
            //
            //   --create-failure-fixed  this start's own failure releases it  -> open
            //   --create-failure-gap    (pre-fix) nothing releases it          -> closed
            //   --interleave-fixed      the OLDER failure is refused           -> closed
            //   --interleave-gap        (pre-fix) the OLDER failure clears the
            //                           NEWER start's gate                    -> open
            //
            // Evidence discipline, because a false green here would certify a
            // broken ownership model:
            //
            //  * injection markers are PER CALL INDEX. With one shared key,
            //    "is call 1 still held" read back call 2's marker, so an overlap
            //    assertion proved nothing about overlap.
            //  * every trace and wire assertion is a DELTA against a baseline
            //    taken after the failure and before the device is driven, and
            //    the sample is identified by the state it was driven TO
            //    (PLAYING at 30s), never by a count of pre-existing lines.
            //  * the accepted/blocked branch is read from lines that carry that
            //    driven state as their input.
            const gateOpensAfterFailure = expectReleased !== args.interleave;
            const announcedStarts = args.interleave ? 2 : 1;
            const callMarkerKeys = index => [
                `__fxHarnessCreateSessionHeld_${index}`,
                `__fxHarnessCreateSessionReleased_${index}`,
                `__fxHarnessCreateSessionFailed_${index}`
            ];
            const failureMarkerKeys = [
                ...callMarkerKeys(1),
                ...callMarkerKeys(2),
                "__fxHarnessLoadGenerationBegan",
                // The cleanup-fault run's own evidence: what each cleanup site
                // reached and raised, and what each outer handler caught.
                ...CLEANUP_FAULTS.map(
                    f => `__fxHarnessCleanupFaultRaised_${f.id}`
                ),
                ...CLEANUP_FAULTS.map(
                    f => `__fxHarnessCleanupSiteEntered_${f.id}`
                ),
                "__fxHarnessOuterCaught_requestSessionHandler",
                "__fxHarnessOuterCaught_loadSender",
                "__fxHarnessOuterCaught_triggerCast"
            ];
            // Storage markers are only reachable from an extension page, and
            // this block runs after the click switched contexts around, so the
            // reader switches to the console page itself.
            const readFailureMarkers = async () => {
                await driver.switchTo().window(consoleTab);
                return driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .get(${JSON.stringify(failureMarkerKeys)})
                        .then(v => done(v), err => done({ error: String(err) }));`
                );
            };
            const waitForFailureMarker = async (key, predicate, timeoutMs) => {
                const deadline = Date.now() + timeoutMs;
                for (;;) {
                    const marker = markerFor(await readFailureMarkers(), key);
                    if (marker && (!predicate || predicate(marker)))
                        return marker;
                    if (Date.now() > deadline) return undefined;
                    await sleep(250);
                }
            };
            /**
             * The AUTHORITATIVE caller evidence: which producer of this run
             * actually received the injected failure, read from the marker each
             * outer `catch` wrote (`__fxHarnessOuterCaught_<handler>`).
             *
             * Why not the Roku-branch marker: that one is written by an async
             * `storage.get().then(set)` chain, so its ABSENCE is only a bounded
             * "not seen" observation. What each caller's own `catch` received is
             * a positive fact written by the code path that ran.
             *
             * `loadSender` is deliberately unconstrained: it is an intermediate
             * handler that rethrows into `triggerCast`, so the queued route
             * legitimately fills BOTH. Only the handler of the OTHER route is
             * required to be free of THIS failure.
             *
             * Only used where exactly one caller is supposed to own the session:
             * `--interleave-*` starts both callers on purpose, so it asserts its
             * own two-start facts instead.
             */
            const readCallerRouteEvidence = async (
                originalIdentifier,
                cleanupIdentifier
            ) => {
                const keys = [
                    "requestSessionHandler",
                    "loadSender",
                    "triggerCast"
                ];
                const caught = {};
                for (const key of keys) {
                    const marker = await waitForFailureMarker(
                        `__fxHarnessOuterCaught_${key}`,
                        undefined,
                        key === keys[0] ? 15000 : 5000
                    );
                    if (marker) caught[key] = marker;
                }
                const expected =
                    args.requestSource === "queued"
                        ? "triggerCast"
                        : "requestSessionHandler";
                const other =
                    expected === "triggerCast"
                        ? "requestSessionHandler"
                        : "triggerCast";
                const identifies = key => {
                    const message = caught[key] && caught[key].message;
                    return (
                        typeof message === "string" &&
                        message.includes(originalIdentifier) &&
                        !(
                            cleanupIdentifier &&
                            message.includes(cleanupIdentifier)
                        )
                    );
                };
                return {
                    expected,
                    other,
                    caught,
                    expectedMarker: caught[expected] || null,
                    expectedSawFailure: identifies(expected),
                    otherSawFailure: identifies(other),
                    messages: Object.fromEntries(
                        keys.map(key => [
                            key,
                            (caught[key] && caught[key].message) || null
                        ])
                    )
                };
            };
            const readConnectionsNow = () =>
                readNdjson(path.join(harnessDir, "spawns.ndjson"))
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
            const wireStatusSamples = conns =>
                conns
                    .flatMap(c => c.outbound)
                    .filter(
                        m =>
                            m.subject ===
                                "main:receiverDeviceMediaStatusUpdated" &&
                            m.message &&
                            m.message.data &&
                            m.message.data.deviceId === FAKE_DEVICE_ID
                    );
            const readConsoleText = () =>
                phaseBConsole && fs.existsSync(phaseBConsole)
                    ? fs.readFileSync(phaseBConsole, "utf8")
                    : "";
            const traceLines = event =>
                readConsoleText()
                    .split("\n")
                    .filter(line =>
                        line.includes(
                            `Roku media trace [${FAKE_DEVICE_ID}] ${event}`
                        )
                    );
            /** Lines whose recorded input is the state the harness drove. */
            const drivenInput = line =>
                /inputPlayerState:\s*"?PLAYING"?/.test(line) &&
                /inputCurrentTime:\s*"?30"?/.test(line);

            /**
             * The popup's own current-tab cast message, sent from the popup page
             * (the context production sends it from), with the popup's window put
             * in front first so the background's `currentWindow` query resolves to
             * the sender tab. Used by the interleave modes and by the staged
             * failure matrix, where it answers "does the residue of a partial
             * session break the NEXT cast?".
             */
            const sendPopupCast = async () => {
                if (!popupHandle) return "(no popup handle)";
                await driver.switchTo().window(popupHandle);
                if (senderTabInfo && typeof senderTabInfo.id === "number") {
                    await driver.executeAsyncScript(
                        `const done = arguments[arguments.length - 1];
                         (async () => {
                            try {
                                await browser.windows.update(${JSON.stringify(
                                    senderTabInfo.windowId
                                )}, { focused: true });
                                await browser.tabs.update(${JSON.stringify(
                                    senderTabInfo.id
                                )}, { active: true });
                                done(true);
                            } catch (err) {
                                done(String(err));
                            }
                         })();`
                    );
                }
                return driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     (async () => {
                        try {
                            // Fire and forget, exactly like the popup's own
                            // 'void castCurrentTab()': the handler does not settle
                            // until the session it started settles.
                            void browser.runtime
                                .sendMessage({
                                    subject: "action:castCurrentTab",
                                    data: {
                                        selection: {
                                            device: {
                                                id: ${JSON.stringify(FAKE_DEVICE_ID)},
                                                name: ${JSON.stringify(FAKE_DEVICE_NAME)},
                                                deviceType: "roku"
                                            },
                                            mediaType: 1
                                        },
                                        quality: 0
                                    }
                                })
                                .catch(() => {});
                            done(true);
                        } catch (err) {
                            done(String(err));
                        }
                     })();`
                );
            };

            // --- start 2 (interleave only): a newer lifecycle ---------------
            //
            // The popup's OWN current-tab cast message, sent from the popup page
            // (the context production sends it from) rather than by clicking
            // Stop -> Cast: the Stop affordance only appears once a session is
            // connected, and this mode needs the newer start to announce while
            // the older one is still in flight.
            if (args.interleave) {
                let secondStarted;
                if (popupHandle) {
                    await driver.switchTo().window(popupHandle);
                    // `action:castCurrentTab` resolves its target with
                    // `tabs.query({active: true, currentWindow: true})`. Put the
                    // sender tab in front and active - the state a real click in
                    // the popup leaves behind - instead of assuming the WebDriver
                    // window switches did it.
                    if (senderTabInfo && typeof senderTabInfo.id === "number") {
                        await driver.executeAsyncScript(
                            `const done = arguments[arguments.length - 1];
                             (async () => {
                                try {
                                    await browser.windows.update(${JSON.stringify(
                                        senderTabInfo.windowId
                                    )}, { focused: true });
                                    await browser.tabs.update(${JSON.stringify(
                                        senderTabInfo.id
                                    )}, { active: true });
                                    done(true);
                                } catch (err) {
                                    done(String(err));
                                }
                             })();`
                        );
                    }
                    // Mirror, from the popup's own window, exactly what the
                    // background's handler will resolve.
                    const resolvedTarget = await driver.executeAsyncScript(
                        `const done = arguments[arguments.length - 1];
                         browser.tabs.query({ active: true, currentWindow: true })
                            .then(tabs => done(tabs.map(t => ({ id: t.id, url: String(t.url || "").slice(0, 40) }))), err => done(String(err)));`
                    );
                    check(
                        "interleave mode: the popup's window has the sender tab active (what the background resolves)",
                        Array.isArray(resolvedTarget) &&
                            resolvedTarget.some(
                                t => t.id === (senderTabInfo && senderTabInfo.id)
                            ),
                        JSON.stringify({ resolvedTarget, senderTabInfo })
                    );
                    secondStarted = await sendPopupCast();
                }
                check(
                    "interleave mode: the popup's current-tab cast started a second lifecycle",
                    secondStarted === true,
                    String(secondStarted)
                );
                await waitForFailureMarker(
                    "__fxHarnessCreateSessionHeld_2",
                    undefined,
                    20000
                );
                // The overlap is proved by BOTH markers existing in the SAME
                // read, and by call 1 having been held no later than call 2.
                const bothHeld = await readFailureMarkers();
                const heldFirst = markerFor(
                    bothHeld,
                    "__fxHarnessCreateSessionHeld_1"
                );
                const heldSecond = markerFor(
                    bothHeld,
                    "__fxHarnessCreateSessionHeld_2"
                );
                check(
                    "interleave mode: both session starts are held at the same moment (call 1 and call 2 differ)",
                    Boolean(
                        heldFirst &&
                            heldSecond &&
                            heldFirst.callIndex === 1 &&
                            heldSecond.callIndex === 2 &&
                            heldFirst.at <= heldSecond.at
                    ),
                    JSON.stringify({ heldFirst: heldFirst || null, heldSecond: heldSecond || null })
                );
            }

            // --- fail the FIRST start, after both are held -------------------
            //
            // The refusal baseline comes from `failureActionBaseline`, captured
            // when the injection was armed - before this release request and
            // before the click. Reading it here would classify the very line
            // under test as pre-existing (the background polls this request
            // every 150ms and runs the production catch immediately).
            const refusedBaseline = failureActionBaseline.refused;
            if (args.interleave) {
                await driver.switchTo().window(consoleTab);
                await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .set({ __fxHarnessReleaseCreateSession: { runId: ${JSON.stringify(
                            diagnosticRunId
                        )}, callIndex: 1, action: "fail", at: Date.now() } })
                        .then(() => done(true), err => done(String(err)));`
                );
            }
            const failedFirst = await waitForFailureMarker(
                "__fxHarnessCreateSessionFailed_1",
                undefined,
                30000
            );
            check(
                "session-failure mode: the first session start failed after announcing its load",
                Boolean(failedFirst),
                JSON.stringify(failedFirst || null)
            );
            // The predicate waits for the EXPECTED number of announcements:
            // accepting the first finite marker would read calls=1 in a two
            // start run and then fail against the expectation at random.
            const generationMarker = await waitForFailureMarker(
                "__fxHarnessLoadGenerationBegan",
                m =>
                    Number.isFinite(m.loadGeneration) &&
                    m.loadGenerationCalls === announcedStarts,
                20000
            );
            check(
                `session-failure mode: ${announcedStarts} start(s) announced, ${announcedStarts} load generation(s), no double advance`,
                Boolean(generationMarker),
                JSON.stringify(generationMarker || null)
            );

            // --- baselines, then drive the device to a known sample ----------
            // Baselines are taken for the SAME sample identity the assertions
            // use (the state the harness is about to drive), not merely for the
            // event: a leftover PLAYING@30 line from an earlier phase would
            // otherwise satisfy them.
            const blockedBaseline = traceLines("remote-status-blocked").length;
            const inputBaseline = traceLines("remote-status-input").length;
            // NOT read here: the cancel this mode is about (if the gate was
            // released) already happened in the production catch, before the
            // failure marker this block waited for. It comes from the
            // arming-time baseline instead, or `cancelDelta` would be 0 for a
            // CORRECT implementation.
            const cancelledBaseline = failureActionBaseline.cancelled;
            const blockedDrivenBaseline = traceLines("remote-status-blocked").filter(
                drivenInput
            ).length;
            const inputDrivenBaseline = traceLines("remote-status-input").filter(
                drivenInput
            ).length;
            const sampleStartedAt = Date.now();
            await post("/state", {
                playerState: "play",
                position: 30,
                duration: 600,
                title: "harness-stale-sample"
            });
            console.log(
                "session-failure mode: fake roku driven to a non-idle sample (PLAYING at 30s)"
            );
            const sampleDeadline = Date.now() + 30000;
            let drivenSamples = [];
            let blockedDriven = [];
            let inputDriven = [];
            for (;;) {
                drivenSamples = wireStatusSamples(readConnectionsNow()).filter(
                    m =>
                        m.at >= sampleStartedAt &&
                        m.message.data.status &&
                        m.message.data.status.playerState === "PLAYING" &&
                        m.message.data.status.currentTime === 30
                );
                blockedDriven = traceLines("remote-status-blocked").filter(
                    drivenInput
                );
                inputDriven = traceLines("remote-status-input").filter(
                    drivenInput
                );
                if (
                    drivenSamples.length &&
                    (blockedDriven.length || inputDriven.length)
                )
                    break;
                if (Date.now() > sampleDeadline) break;
                await sleep(500);
            }
            check(
                "session-failure mode: the driven ECP sample (PLAYING at 30s) reached the extension after the failure",
                drivenSamples.length > 0,
                JSON.stringify({
                    drivenSamples: drivenSamples.length,
                    blockedDriven: blockedDriven.length,
                    inputDriven: inputDriven.length
                })
            );
            const cancels = traceLines("load-generation-cancelled").length;
            const cancelDelta = cancels - cancelledBaseline;
            const blockedDrivenDelta = blockedDriven.length - blockedDrivenBaseline;
            const inputDrivenDelta = inputDriven.length - inputDrivenBaseline;
            if (gateOpensAfterFailure) {
                check(
                    "session-failure mode: the gate was released (a NEW load-generation-cancelled) and the DRIVEN sample is accepted",
                    cancelDelta >= 1 &&
                        inputDrivenDelta >= 1 &&
                        blockedDrivenDelta === 0,
                    JSON.stringify({
                        cancelDelta,
                        blockedDrivenDelta,
                        inputDrivenDelta,
                        baseline: {
                            blockedBaseline,
                            inputBaseline,
                            blockedDrivenBaseline,
                            inputDrivenBaseline
                        }
                    })
                );
            } else {
                check(
                    "session-failure mode: the gate stays closed (no new cancel, the DRIVEN sample is blocked and never accepted)",
                    cancelDelta === 0 &&
                        blockedDrivenDelta >= 1 &&
                        inputDrivenDelta === 0,
                    JSON.stringify({
                        cancelDelta,
                        blockedDrivenDelta,
                        inputDrivenDelta,
                        baseline: {
                            blockedBaseline,
                            inputBaseline,
                            blockedDrivenBaseline,
                            inputDrivenBaseline
                        }
                    })
                );
            }
            if (args.interleave && expectReleased) {
                // Delta, not an absolute search of the whole phase-B console: a
                // same-worded line from an earlier lifecycle or another device
                // must not satisfy it.
                const refusalLines = readConsoleText()
                    .split("\n")
                    .filter(line =>
                        line.includes("Roku media load release ignored")
                    );
                const refusedDelta = refusalLines.length - refusedBaseline;
                check(
                    "interleave mode: the older start's release was refused in favour of the newer start (one NEW refusal)",
                    refusedDelta === 1,
                    JSON.stringify({
                        refusedDelta,
                        refusalLines: refusalLines.slice(-1),
                        cancelDelta,
                        blockedDriven: blockedDriven.length
                    })
                );
            }
            const connsAfter = readConnectionsNow();
            // Only generations from THIS failure phase: the arming timestamp is
            // the phase's lower bound, so a replay or a leftover generation from
            // before the injection cannot be counted as this run's.
            const generations = connsAfter
                .flatMap(c => [...c.inbound, ...c.outbound])
                .filter(
                    m =>
                        m.subject === "bridge:rokuSetLoadGeneration" &&
                        m.message &&
                        m.message.data &&
                        m.message.data.deviceId === FAKE_DEVICE_ID &&
                        m.at >= injectionArmedAt
                )
                .map(m => m.message.data.loadGeneration);
            const uniqueGenerations = [...new Set(generations)];
            const ascending =
                JSON.stringify(uniqueGenerations) ===
                JSON.stringify([...uniqueGenerations].sort((a, b) => a - b));
            check(
                "session-failure mode: the generation is monotonic on the wire - never rolled back, never re-sent lower",
                generations.length > 0 &&
                    uniqueGenerations.length === announcedStarts &&
                    uniqueGenerations.every(g => Number.isFinite(g) && g > 0) &&
                    ascending &&
                    Math.max(...uniqueGenerations) ===
                        (generationMarker && generationMarker.loadGeneration),
                JSON.stringify({
                    generations,
                    uniqueGenerations,
                    announced: generationMarker && generationMarker.loadGeneration
                })
            );

            // --- page settlement: what the page SAW, and how often -----------
            //
            // Facts first (this is a measurement, not a fix): the SDK's own
            // callback timeline, plus how many times the background posted
            // `cast:sessionRequestCancelled`. "Did it fail" and "how many times was
            // the page settled, and with what" are different questions, and the
            // second is where a double settlement - the replaced selector's cancel
            // plus the failed start's - shows up as a number.
            {
                await driver.switchTo().window(senderTab);
                const pageSettlement = await driver.executeScript(
                    "return window.__HARNESS_RESULT__ || null;"
                );
                const settle = pageSettlement || {};
                const callbacks = Array.isArray(settle.sessionCallbacks)
                    ? settle.sessionCallbacks
                    : [];
                await driver.switchTo().window(consoleTab);
                // Read every cancel marker of THIS run and take the largest
                // `count`: each post writes its own key, so reading key _1 alone
                // would report 1 even when a second settlement happened - hiding
                // exactly what this measurement exists to find.
                const cancelState = await readCancelState();
                console.log(
                    `page settlement (${args.requestSource}/${args.failStage}):`,
                    JSON.stringify({
                        requestSessionCalls: settle.requestSessionCalls,
                        successCount: settle.successCount,
                        errorCount: settle.errorCount,
                        settleType: settle.settleType,
                        sessionId: settle.sessionId,
                        backgroundCancels: cancelState.maxCount,
                        cancelMarkers: cancelState.markersForRun,
                        // Which cancel SITE posted, in order. `maxCount` alone
                        // cannot tell "the page was settled by its own failed
                        // start" from "it was settled by the selector that got
                        // replaced", and those are different contracts.
                        cancelSites: cancelState.posts,
                        callbacks: callbacks.map(c => ({
                            type: c.type,
                            code: c.payload && c.payload.code
                        }))
                    })
                );
                check(
                    `session-failure mode (${args.requestSource}/${args.failStage}): the page's requestSession was settled (not left hanging)`,
                    callbacks.length >= 1,
                    JSON.stringify({ callbacks })
                );
                check(
                    `session-failure mode (${args.requestSource}/${args.failStage}): the background settled the page at least once (counted as the largest count among this run's markers)`,
                    cancelState.maxCount >= 1,
                    JSON.stringify(cancelState)
                );
                if (args.failStage === "p0") {
                    check(
                        `session-failure mode (${args.requestSource}/p0): the page was settled exactly once and with an error`,
                        callbacks.length === 1 && settle.errorCount === 1,
                        JSON.stringify({
                            successCount: settle.successCount,
                            errorCount: settle.errorCount,
                            callbacks
                        })
                    );
                }
            }

            // --- which caller really ran (the label is asserted, not assumed) --
            //
            // The settlement assertions above are quoted per `--request-source`,
            // so the label has to be a fact: the authoritative evidence is what
            // each caller's own `catch` received (see
            // readCallerRouteEvidence). Without this, a run labelled `selector`
            // could be settled entirely by the popup's auto-cast - which is what
            // 3 of 4 earlier "selector" runs did before the route was asserted.
            //
            // `--interleave-*` is excluded on purpose: it starts BOTH callers, so
            // "the other route did not receive it" is false by design there, and
            // that mode asserts its own two-start facts (which start announced,
            // whose release was refused). `--cleanup-fault` runs are excluded
            // because the cleanup-fault block asserts the same route facts with
            // the cleanup error identifier added, and a second bounded wait for
            // the same markers would only make the run slower.
            if (args.createFailure && !args.interleave && !args.cleanupFault) {
                const originalId =
                    "harness: injected createCastSession failure";
                const route = await readCallerRouteEvidence(originalId);
                console.log(
                    `caller route (${args.requestSource}/${args.failStage}):`,
                    JSON.stringify({
                        expected: route.expected,
                        other: route.other,
                        caught: Object.keys(route.caught),
                        messages: route.messages
                    })
                );
                check(
                    `session-failure mode (${args.requestSource}/${args.failStage}): the labelled caller's handler (${route.expected}) received the injected failure`,
                    route.expectedSawFailure,
                    JSON.stringify({
                        expected: route.expected,
                        caughtHandlers: Object.keys(route.caught),
                        messages: route.messages,
                        originalIdentifier: originalId
                    })
                );
                check(
                    `session-failure mode (${args.requestSource}/${args.failStage}): the other route's handler (${route.other}) did NOT receive it, so only the labelled caller ran`,
                    Boolean(route.expectedMarker) &&
                        route.expectedSawFailure &&
                        !route.otherSawFailure,
                    JSON.stringify({
                        expected: route.expected,
                        other: route.other,
                        caughtHandlers: Object.keys(route.caught),
                        messages: route.messages
                    })
                );
            }

            // --- partial-session residue at this checkpoint ------------------
            //
            // Create-failure modes only: the interleave modes legitimately post
            // bridge:createCastSession for their second start, so the "nothing was
            // posted" and "no host was created" invariants do not apply to them.
            //
            // "Session creation failed" is not one event. Which resources exist
            // when it fails depends on the checkpoint, so this records what each
            // one leaves behind instead of assuming one cleanup fits all.
            if (!args.interleave) {
                const connsNow = readConnectionsNow();
                const alive = pid => {
                    try {
                        process.kill(pid, 0);
                        return true;
                    } catch {
                        return false;
                    }
                };
                // Hosts that appeared DURING this failure phase, not every idle
                // wrapper in the run.
                const hostsBefore = failureHostPidsBefore || new Set();
                const newHosts = connsNow.filter(c => !hostsBefore.has(c.pid));
                const idleNewHosts = newHosts.filter(
                    c => c.inbound.length === 0 && c.outbound.length === 0
                );
                const idleNewAlive = idleNewHosts.filter(h => alive(h.pid));
                const postedCreateSession = connsNow.some(c =>
                    c.inbound.some(
                        m => m.subject === "bridge:createCastSession"
                    )
                );
                check(
                    `session-failure mode (${args.failStage}): the failure stayed inside createCastSession (no bridge:createCastSession was posted)`,
                    !postedCreateSession,
                    JSON.stringify({ postedCreateSession })
                );

                // --- the cleanup's OWN failure: did the exit path hold? ------
                //
                // The original failure happens INSIDE createCastSession, this
                // cleanup fault is raised by the catch that reacts to it, and
                // the error is consumed two frames further out. "The page saw
                // one cancel" cannot tell the two errors apart - both would land
                // in the same outer catch - so the discriminator is the message
                // that outer handler ACTUALLY caught, tested against the stable
                // identifiers of both errors.
                if (args.cleanupFault !== undefined) {
                    const fault = CLEANUP_FAULTS.find(
                        f => f.id === args.cleanupFault
                    );
                    const raised = await waitForFailureMarker(
                        `__fxHarnessCleanupFaultRaised_${fault.id}`,
                        undefined,
                        15000
                    );
                    const otherFault = CLEANUP_FAULTS.find(
                        f => f.id !== fault.id
                    );
                    // A bounded wait: the entry marker is written before the
                    // fault, but both are storage writes and their order in the
                    // log is what is asserted below.
                    let enteredMine;
                    let enteredOther;
                    {
                        const enteredDeadline = Date.now() + 10000;
                        for (;;) {
                            const siteMarkers = await readFailureMarkers();
                            enteredMine = markerFor(
                                siteMarkers,
                                `__fxHarnessCleanupSiteEntered_${fault.id}`
                            );
                            enteredOther = markerFor(
                                siteMarkers,
                                `__fxHarnessCleanupSiteEntered_${otherFault.id}`
                            );
                            if (
                                (enteredMine && enteredOther) ||
                                Date.now() > enteredDeadline
                            )
                                break;
                            await sleep(200);
                        }
                    }
                    // Two SEPARATE layers of evidence, deliberately not merged:
                    //
                    //   the fault was raised at THAT site with THAT message and
                    //   the step's own block WAS entered (so the fault marker's
                    //   absence would mean something) - this is the injection;
                    //
                    //   the OTHER cleanup step was still reached - this proves
                    //   the identity-guarded cleanup sequence continued past the
                    //   fault that this step's own production catch absorbed. It
                    //   is NOT evidence about the `finally`: that the port was
                    //   really closed is proved independently, later, by the
                    //   half-created port existing and its idle host exiting.
                    check(
                        `session-failure mode (cleanup fault ${fault.id}): the injected error was raised at ${fault.site} before the call it replaces, and the step's own handler caught it`,
                        Boolean(raised) &&
                            raised.fault === fault.id &&
                            raised.site === fault.site &&
                            raised.message === fault.message &&
                            Boolean(enteredMine) &&
                            enteredMine.site === fault.site,
                        JSON.stringify({
                            raised: raised || null,
                            expectedMessage: fault.message,
                            expectedSite: fault.site,
                            enteredMine: enteredMine || null
                        })
                    );
                    check(
                        `session-failure mode (cleanup fault ${fault.id}): the other cleanup step was still reached (the absorbed fault did not abort the identity-guarded sequence; whether the finally closed the port is asserted separately by the host-exit check)`,
                        Boolean(enteredOther) &&
                            enteredOther.site === otherFault.site,
                        JSON.stringify({
                            enteredOther: enteredOther || null,
                            expectedOtherSite: otherFault.site,
                            enteredMine: enteredMine || null
                        })
                    );
                    const originalId =
                        "harness: injected createCastSession failure";
                    // The same reader the non-cleanup failure modes use: the
                    // cleanup error identifier is additional here, because on
                    // this path a handler that caught the CLEANUP error instead
                    // of the original one is exactly the failure being ruled out.
                    const route = await readCallerRouteEvidence(
                        originalId,
                        fault.message
                    );
                    const caught = route.caught;
                    const expectedOuter = route.expected;
                    const caughtMarker = route.expectedMarker;
                    const message = caughtMarker && caughtMarker.message;
                    const fromOriginal = route.expectedSawFailure;
                    const fromCleanup =
                        typeof message === "string" &&
                        message.includes(fault.message);
                    console.log(
                        `cleanup fault (${fault.id}/${args.requestSource}): what the outer handler caught:`,
                        JSON.stringify({
                            expectedOuter,
                            caught: Object.keys(caught),
                            message: message || null
                        })
                    );
                    check(
                        `session-failure mode (cleanup fault ${fault.id}/${args.requestSource}): ${expectedOuter} caught the ORIGINAL request failure, not the cleanup error`,
                        Boolean(caughtMarker) &&
                            caughtMarker.handler === expectedOuter &&
                            fromOriginal &&
                            !fromCleanup,
                        JSON.stringify({
                            expectedOuter,
                            caught: caughtMarker || null,
                            caughtHandlers: Object.keys(caught),
                            originalIdentifier: originalId,
                            cleanupIdentifier: fault.message
                        })
                    );
                    const otherOuter = route.other;
                    const otherCaughtOriginal = route.otherSawFailure;
                    check(
                        `session-failure mode (cleanup fault ${fault.id}/${args.requestSource}): the other route's handler (${otherOuter}) did NOT receive this failure, so only the labelled caller ran`,
                        Boolean(caughtMarker) &&
                            fromOriginal &&
                            !otherCaughtOriginal,
                        JSON.stringify({
                            expectedOuter,
                            otherOuter,
                            caughtHandlers: Object.keys(caught),
                            messages: route.messages,
                            originalIdentifier: originalId
                        })
                    );
                }
                // The discriminator is IDLENESS, not "a new connection appeared":
                // the background also opens short-lived version-probe hosts
                // (bridge:/getInfo -> raw:<version>) which answer and exit, and
                // counting those would make every checkpoint look like it leaked.
                if (args.failStage === "p0") {
                    check(
                        "session-failure mode (p0): no IDLE native host was created, so there is nothing to leak (a probe host that answers and exits is not one)",
                        idleNewHosts.length === 0 && idleNewAlive.length === 0,
                        JSON.stringify({
                            newHosts: newHosts.map(h => h.pid),
                            idleNewHosts: idleNewHosts.map(h => h.pid),
                            hostsBefore: [...hostsBefore]
                        })
                    );
                } else if (args.expectResidue) {
                    check(
                        `session-failure mode (${args.failStage}, pre-fix expectation): exactly one NEW IDLE native host, still alive (the port bridge.connect() created and nobody uses)`,
                        idleNewHosts.length === 1 &&
                            idleNewAlive.length === 1,
                        JSON.stringify({
                            newHosts: newHosts.map(h => h.pid),
                            idleNewHosts: idleNewHosts.map(h => h.pid),
                            idleNewAlive: idleNewAlive.map(h => h.pid),
                            failStage: args.failStage
                        })
                    );
                } else {
                    // Closing the port makes the native host exit, which is
                    // asynchronous, so wait for the residue to disappear instead
                    // of reading once at an arbitrary moment.
                    let leftover = idleNewAlive;
                    const residueDeadline = Date.now() + 15000;
                    while (leftover.length && Date.now() < residueDeadline) {
                        await sleep(250);
                        const connsAgain = readConnectionsNow();
                        const stillNew = connsAgain.filter(
                            c => !hostsBefore.has(c.pid)
                        );
                        leftover = stillNew
                            .filter(
                                c =>
                                    c.inbound.length === 0 &&
                                    c.outbound.length === 0
                            )
                            .filter(h => alive(h.pid));
                    }
                    // The pair matters: the half-created PORT must have existed
                    // (otherwise "no residue" could be vacuous because nothing
                    // was ever created), and it must not SURVIVE the failure. The
                    // host needs a moment to exit after the port closes, so the
                    // initial read seeing it is expected - what is asserted is
                    // that it is gone by the end of the bounded wait.
                    check(
                        `session-failure mode (${args.failStage}): the half-created port existed and left no idle native host behind (closed, host exited)`,
                        idleNewHosts.length === 1 && leftover.length === 0,
                        JSON.stringify({
                            newHosts: newHosts.map(h => h.pid),
                            idleNewHosts: idleNewHosts.map(h => h.pid),
                            leftover: leftover.map(h => h.pid),
                            failStage: args.failStage
                        })
                    );
                }

                // Does a partial session poison the NEXT cast? This is the
                // behavioral probe for "instance.session was left set": at p1 it
                // was never assigned (expect a clean new session), at p2 it
                // references a host the device never heard of.
                if (args.failStage !== "p0") {
                    const pidsBefore = new Set(connsNow.map(c => c.pid));
                    const started = await sendPopupCast();
                    check(
                        `session-failure mode (${args.failStage}): a cast started after the failure`,
                        started === true,
                        String(started)
                    );
                    let newSession;
                    const sessionDeadline = Date.now() + 30000;
                    while (Date.now() < sessionDeadline) {
                        newSession = readConnectionsNow().find(
                            c =>
                                !pidsBefore.has(c.pid) &&
                                c.inbound.some(
                                    m =>
                                        m.subject ===
                                            "bridge:createCastSession" &&
                                        m.message &&
                                        m.message.data &&
                                        m.message.data.receiverDevice &&
                                        m.message.data.receiverDevice.id ===
                                            FAKE_DEVICE_ID
                                )
                        );
                        if (newSession) break;
                        await sleep(500);
                    }
                    check(
                        `session-failure mode (${args.failStage}): the next cast still created its own session host (the residue did not poison it)`,
                        Boolean(newSession),
                        JSON.stringify({
                            newSessionPid: newSession && newSession.pid,
                            previousPids: [...pidsBefore],
                            idleNewHosts: idleNewHosts.map(h => h.pid)
                        })
                    );
                }
            }

            // --- the newer start must survive the older one's failure -------
            if (args.interleave) {
                // Association, not "some session exists": the newer host has to
                // be a NEW process, created after the release, for the fake
                // device.
                const sessionPidsBefore = new Set(
                    readConnectionsNow()
                        .filter(c =>
                            c.inbound.some(
                                m => m.subject === "bridge:createCastSession"
                            )
                        )
                        .map(c => c.pid)
                );
                await driver.switchTo().window(consoleTab);
                await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local
                        .set({ __fxHarnessReleaseCreateSession: { runId: ${JSON.stringify(
                            diagnosticRunId
                        )}, callIndex: 2, action: "proceed", at: Date.now() } })
                        .then(() => done(true), err => done(String(err)));`
                );
                const releasedSecond = await waitForFailureMarker(
                    "__fxHarnessCreateSessionReleased_2",
                    undefined,
                    20000
                );
                let newerSession;
                const sessionDeadline = Date.now() + 30000;
                while (Date.now() < sessionDeadline) {
                    newerSession = readConnectionsNow().find(
                        c =>
                            !sessionPidsBefore.has(c.pid) &&
                            c.inbound.some(
                                m =>
                                    m.subject ===
                                        "bridge:createCastSession" &&
                                    m.at >=
                                        (releasedSecond
                                            ? releasedSecond.at
                                            : Number.MAX_SAFE_INTEGER) &&
                                    m.message &&
                                    m.message.data &&
                                    m.message.data.receiverDevice &&
                                    m.message.data.receiverDevice.id ===
                                        FAKE_DEVICE_ID
                            )
                    );
                    if (newerSession) break;
                    await sleep(500);
                }
                check(
                    "interleave mode: the newer start created a NEW session host after its release (new PID, fake device)",
                    Boolean(releasedSecond && newerSession),
                    JSON.stringify({
                        releasedSecond: releasedSecond || null,
                        newerSessionPid: newerSession && newerSession.pid,
                        previousPids: [...sessionPidsBefore]
                    })
                );
            }

            // --- what the popup renders: DIAGNOSTIC, not evidence -----------
            //
            // Measured fact (2026-09-13, --create-failure-gap): the popup's row
            // shows the driven title "Media Assistant . harness-stale-sample"
            // even while the pending gate BLOCKS that device's media status.
            // The row's now-playing line does not come from
            // `main:receiverDeviceMediaStatusUpdated`, so it is NOT gated and
            // cannot serve as evidence either way - an earlier version of this
            // mode asserted on it and was wrong in both directions. The gate's
            // evidence is the production branch trace plus the wire sample.
            let popupText;
            if (popupHandle) {
                try {
                    await driver.switchTo().window(popupHandle);
                    popupText = await driver.executeScript(
                        "return (document.body && document.body.innerText) || '';"
                    );
                } catch (err) {
                    popupText = `(popup read failed: ${err.message})`;
                }
            }
            console.log(
                "session-failure mode: popup text (diagnostic, not gated):",
                JSON.stringify(String(popupText || "").slice(0, 120))
            );
        }
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
            if (gapMode) {
                // The queued session's own media has to carry the generation
                // the session start established - not merely *a* generation.
                check(
                    "fixed mode: the session media carries the generation this session start established",
                    Boolean(gapGenerationMarker) &&
                        Number.isFinite(gapGenerationMarker.loadGeneration) &&
                        relayedMedia.message.data.loadGeneration ===
                            gapGenerationMarker.loadGeneration,
                    JSON.stringify({
                        sessionStartGeneration:
                            gapGenerationMarker &&
                            gapGenerationMarker.loadGeneration,
                        mediaGeneration:
                            relayedMedia.message.data.loadGeneration,
                        generationOnDiscovery:
                            relayedGeneration.message.data.loadGeneration
                    })
                );
            }
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

        // ---- discovery reconnect: the new process must be replayed to -------
        //
        // The discovery host owns the polling loop and caches what the extension
        // told it (load generations and session media). Killing it therefore
        // proves the REPLAY path rather than the cache: a NEW pid must receive
        // the current generation and the current session media, and neither may
        // drift. Independent case: no owner change, no generation advance, no
        // startup deadline.
        if (discoveryReconnectMode) {
            const OWNER_R = "session:harness-replay";
            const MARKER_R = "reconnect-replay";
            /**
             * The current state is ESTABLISHED by this case, not inferred from an
             * earlier wire message: `relayedMedia` is an event from the LOAD, and
             * by the time this phase runs the session may already have cleared
             * its media - reading that event as "what is current now" is the
             * snapshot-as-current-state mistake this harness keeps punishing
             * (measured: the first version of this case asserted a media replay
             * for a registry that was already empty).
             */
            const readReplayMarkers = async () => {
                await driver.switchTo().window(consoleTab);
                return driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local.get(null).then(all => {
                        const runId = all && all.__fxHarnessDiagnosticRunId;
                        const prefix = (p) =>
                            Object.keys(all || {})
                                .filter(k => k.indexOf(p) === 0)
                                .map(k => all[k])
                                .filter(m => m && m.runId === runId)
                                .sort((a, b) => a.seq - b.seq);
                        done({
                            runId,
                            installed: (all || {}).__fxHarnessOwnerClearHookInstalled || null,
                            inputs: prefix("__fxHarnessSetMediaInput_"),
                            mirrors: prefix("__fxHarnessMirror_"),
                            replays: prefix("__fxHarnessReplay_"),
                            syncIdentities: prefix("__fxHarnessSyncMediaIdentity"),
                            consumed: prefix("__fxHarnessOwnerClearConsumed_"),
                            generations: prefix("__fxHarnessLoadGenerationBegan")
                        });
                     }, err => done({ error: String(err) }));`
                );
            };
            let markers = await readReplayMarkers();
            const hookDeadline = Date.now() + 20000;
            while (
                (!markers.installed ||
                    markers.installed.runId !== diagnosticRunId) &&
                Date.now() < hookDeadline
            ) {
                await sleep(300);
                markers = await readReplayMarkers();
            }
            const generationN = markers.inputs.length
                ? markers.inputs[markers.inputs.length - 1].loadGeneration
                : undefined;
            const mediaTemplate =
                (relayedMedia && relayedMedia.message.data.media) || null;
            check(
                "discovery reconnect: the injection hook is installed and the current generation is known",
                Boolean(
                    markers.installed &&
                        markers.installed.runId === diagnosticRunId
                ) && Number.isFinite(generationN),
                JSON.stringify({
                    installed: markers.installed || null,
                    generationN,
                    inputs: markers.inputs.length
                })
            );

            // Establish the current session media for the CURRENT generation.
            const mediaR = mediaTemplate
                ? {
                      ...mediaTemplate,
                      customData: {
                          ...(mediaTemplate.customData || {}),
                          harnessMarker: MARKER_R
                      },
                      metadata: {
                          ...(mediaTemplate.metadata || {}),
                          title: "reconnect replay media"
                      }
                  }
                : null;
            const establishAt = Date.now();
            await driver.switchTo().window(consoleTab);
            await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local.set({
                    __fxHarnessOwnerClearRequest: {
                        runId: ${JSON.stringify(diagnosticRunId)},
                        requestId: "reconnect-establish",
                        deviceId: ${JSON.stringify(FAKE_DEVICE_ID)},
                        ownerId: ${JSON.stringify(OWNER_R)},
                        media: ${JSON.stringify(mediaR)}
                    }
                 }).then(() => done(true), err => done(String(err)));`
            );
            let established;
            const establishDeadline = Date.now() + 20000;
            for (;;) {
                const m = await readReplayMarkers();
                established = m.inputs.find(
                    i => i.ownerId === OWNER_R && i.at >= establishAt
                );
                if (established || Date.now() > establishDeadline) break;
                await sleep(300);
            }
            check(
                "discovery reconnect: the current session media was established for generation N (owner and marker known by construction)",
                Boolean(established) &&
                    established.marker === MARKER_R &&
                    established.loadGeneration === generationN,
                JSON.stringify(established || null)
            );
            // Let the (pre-kill) discovery host receive it, so the KILLED process
            // is the one that held it - otherwise the replay could be satisfied
            // by the process that never had it.
            await sleep(2500);
            const readReplayConnections = () =>
                readNdjson(path.join(harnessDir, "spawns.ndjson"))
                    .filter(entry => entry.event === undefined)
                    .map(entry => ({
                        pid: entry.pid,
                        inbound: readNdjson(
                            path.join(harnessDir, `conn-${entry.pid}-in.ndjson`)
                        )
                    }))
                    .filter(c =>
                        c.inbound.some(m => m.subject === "bridge:startDiscovery")
                    );
            const holder = readReplayConnections().find(c =>
                c.inbound.some(
                    m =>
                        m.subject === "bridge:rokuSetSessionMedia" &&
                        m.message.data.ownerId === OWNER_R
                )
            );
            const beforeKillConnections = readReplayConnections().map(c => ({
                pid: c.pid,
                subjects: [...new Set(c.inbound.map(m => m.subject))]
            }));
            console.log(
                "discovery reconnect: current state before the kill:",
                JSON.stringify({
                    generation: generationN,
                    owner: OWNER_R,
                    marker: MARKER_R,
                    holderPid: holder && holder.pid,
                    connections: beforeKillConnections
                })
            );
            check(
                "discovery reconnect: the discovery host that HOLDS the current session media is identified before the kill",
                Boolean(holder) &&
                    holder.inbound.some(
                        m =>
                            m.subject === "bridge:rokuSetSessionMedia" &&
                            m.message.data.ownerId === OWNER_R &&
                            m.message.data.loadGeneration === generationN
                    ),
                JSON.stringify(beforeKillConnections)
            );
            const victim = holder;
            const killAt = Date.now();
            let killed = false;
            try {
                if (victim) process.kill(victim.pid, "SIGKILL");
                killed = Boolean(victim);
            } catch (err) {
                killed = false;
            }
            check(
                "discovery reconnect: the current discovery host was killed (its caches die with it)",
                killed,
                JSON.stringify({
                    pid: victim && victim.pid,
                    beforeKillConnections
                })
            );

            let revived;
            const reviveDeadline = Date.now() + 60000;
            for (;;) {
                revived = readReplayConnections().find(
                    c =>
                        c.pid !== (victim && victim.pid) &&
                        c.inbound.some(
                            m =>
                                m.subject === "bridge:startDiscovery" &&
                                m.at >= killAt
                        )
                );
                if (revived || Date.now() > reviveDeadline) break;
                await sleep(1000);
            }
            const revivedIn = revived ? revived.inbound : [];
            const replayedGeneration = revivedIn.find(
                m =>
                    m.subject === "bridge:rokuSetLoadGeneration" &&
                    m.at >= killAt &&
                    m.message.data.deviceId === FAKE_DEVICE_ID
            );
            const replayedMedia = revivedIn.find(
                m =>
                    m.subject === "bridge:rokuSetSessionMedia" &&
                    m.at >= killAt &&
                    m.message.data.deviceId === FAKE_DEVICE_ID
            );
            const reconnectFacts = {
                victim: victim && victim.pid,
                revivedPid: revived && revived.pid,
                revivedSubjects: [...new Set(revivedIn.map(m => m.subject))],
                replayedGeneration: replayedGeneration
                    ? {
                          generation: replayedGeneration.message.data.loadGeneration,
                          at: replayedGeneration.at
                      }
                    : null,
                replayedMedia: replayedMedia
                    ? {
                          ownerId: replayedMedia.message.data.ownerId,
                          generation:
                              replayedMedia.message.data.loadGeneration,
                          marker: markerOf(replayedMedia.message.data.media),
                          at: replayedMedia.at
                      }
                    : null
            };
            console.log(
                "discovery reconnect: what the NEW process was told:",
                JSON.stringify(reconnectFacts)
            );
            check(
                "discovery reconnect: a NEW discovery host pid connected AND ran startDiscovery after the kill",
                Boolean(revived) &&
                    revived.pid !== (victim && victim.pid),
                JSON.stringify(reconnectFacts)
            );
            check(
                "discovery reconnect: the new process was replayed the CURRENT load generation",
                Boolean(replayedGeneration) &&
                    replayedGeneration.message.data.loadGeneration ===
                        generationN,
                JSON.stringify(reconnectFacts)
            );
            const replayMarkers = (await readReplayMarkers()).replays.filter(
                r => r.at >= killAt
            );
            console.log(
                "discovery reconnect: what the replay loop itself saw:",
                JSON.stringify(replayMarkers)
            );
            const replayLoop = replayMarkers[replayMarkers.length - 1];
            check(
                "discovery reconnect: the replay loop ran for the replacement process and still knew this device's load identity",
                Boolean(replayLoop) &&
                    replayLoop.hasBridgePort === true &&
                    (replayLoop.identities || []).some(
                        i =>
                            i.deviceId === FAKE_DEVICE_ID &&
                            i.loadGeneration === generationN
                    ),
                JSON.stringify(replayMarkers.slice(-2))
            );
            if (expectDiscoveryReplayRecovered) {
                check(
                    "discovery-reconnect-fixed: the replay loop still HELD the current session-media mirror (so there was something to replay)",
                    Boolean(replayLoop) &&
                        replayLoop.mediaEntryCount === 1 &&
                        (replayLoop.mediaEntries || []).some(
                            e =>
                                e.ownerId === OWNER_R && e.marker === MARKER_R
                        ),
                    JSON.stringify(replayMarkers.slice(-2))
                );
                check(
                    "discovery-reconnect-fixed: the new process was replayed the CURRENT session media, with no owner, generation or marker drift",
                    Boolean(replayedMedia) &&
                        replayedMedia.message.data.ownerId === OWNER_R &&
                        replayedMedia.message.data.loadGeneration ===
                            generationN &&
                        markerOf(replayedMedia.message.data.media) === MARKER_R,
                    JSON.stringify(reconnectFacts)
                );
            } else {
                check(
                    "discovery-reconnect-gap: the discovery replacement recovered the load generation but lost the current session-media mirror",
                    Boolean(replayedGeneration) &&
                        replayedGeneration.message.data.loadGeneration ===
                            generationN &&
                        !replayedMedia &&
                        Boolean(replayLoop) &&
                        replayLoop.mediaEntryCount === 0,
                    JSON.stringify({
                        reconnectFacts,
                        replayMarkers: replayMarkers.slice(-2)
                    })
                );
            }
            // Drift check on the extension's OWN state: the replay must be a copy
            // of the current identity, not a new one.
            const identityAfter = await driver.executeAsyncScript(
                `const done = arguments[arguments.length - 1];
                 browser.storage.local.get(null).then(all => {
                    const runId = all && all.__fxHarnessDiagnosticRunId;
                    const inputs = Object.keys(all || {})
                        .filter(k => k.indexOf("__fxHarnessSetMediaInput_") === 0)
                        .map(k => all[k])
                        .filter(m => m && m.runId === runId)
                        .sort((a, b) => a.seq - b.seq);
                    const last = inputs[inputs.length - 1] || null;
                    done({
                        last,
                        count: inputs.length,
                        inputsAfterKill: inputs.filter(
                            m => m.at >= ${killAt}
                        ).length
                    });
                 }, err => done({ error: String(err) }));`
            );
            const lastInput = identityAfter && identityAfter.last;
            // The replay must be a COPY of the retained mirror: if a producer (or
            // the harness) had re-published media through the real setter, the
            // wire evidence would look identical while the mechanism would not be
            // the one under test.
            const inputsAfterKill = identityAfter
                ? identityAfter.inputsAfterKill
                : undefined;
            check(
                "discovery reconnect: the replay did NOT re-enter setRokuSessionMedia (no producer re-published the media)",
                Number.isFinite(inputsAfterKill) && inputsAfterKill === 0,
                JSON.stringify({
                    inputsAfterKill,
                    lastInput: lastInput || null
                })
            );
            check(
                "discovery reconnect: the extension-side identity is unchanged by the replay (same owner, marker and generation)",
                Boolean(lastInput) &&
                    lastInput.ownerId === OWNER_R &&
                    lastInput.marker === MARKER_R &&
                    lastInput.loadGeneration === generationN,
                JSON.stringify({ lastInput: lastInput || null })
            );
        }

        // ---- owner-aware clear: who may remove the current session media ----
        //
        // Injected at `deviceManager.setRokuSessionMedia()`, which is where the
        // whole owner-aware decision lives: the `main:rokuSessionMedia` handler
        // only forwards deviceId/sessionId/media. Downstream is REAL -
        // `syncRokuSessionMediaToBridge` -> discovery host -> RokuSessionMediaSync
        // -> `main:receiverDeviceMediaStatusUpdated`. What this case does NOT
        // cover is that handler's field forwarding, and it deliberately does not
        // advance the generation, reconnect, or touch any startup deadline.
        if (args.ownerAwareClear) {
            const OWNER_A = "session:harness-A";
            const OWNER_B = "session:harness-B";
            const MARKER_A = "owner-clear-A";
            const MARKER_B = "owner-clear-B";
            const generationN =
                relayedMedia && relayedMedia.message.data.loadGeneration;
            const mediaTemplate = relayedMedia && relayedMedia.message.data.media;

            const readOwnerMarkers = async () => {
                await driver.switchTo().window(consoleTab);
                return driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local.get(null).then(all => {
                        const runId = all && all.__fxHarnessDiagnosticRunId;
                        const prefix = (p) =>
                            Object.keys(all || {})
                                .filter(k => k.indexOf(p) === 0)
                                .map(k => all[k])
                                .filter(m => m && m.runId === runId);
                        done({
                            runId,
                            installed: (all || {}).__fxHarnessOwnerClearHookInstalled || null,
                            inputs: prefix("__fxHarnessSetMediaInput_"),
                            mirrors: prefix("__fxHarnessMirror_"),
                            outcomes: prefix("__fxHarnessClearOutcome_"),
                            consumed: prefix("__fxHarnessOwnerClearConsumed_"),
                            errors: prefix("__fxHarnessOwnerClearError_"),
                            generationSet: prefix("__fxHarnessLoadGenerationBegan")
                        });
                     }, err => done({ error: String(err) }));`
                );
            };
            const statusSamplesSince = at =>
                discoveryConnectionsNow
                    .flatMap(conn =>
                        readNdjson(
                            path.join(harnessDir, `conn-${conn.pid}-out.ndjson`)
                        )
                    )
                    .filter(
                        m =>
                            m.subject ===
                                "main:receiverDeviceMediaStatusUpdated" &&
                            m.message.data.deviceId === FAKE_DEVICE_ID &&
                            m.at >= at
                    )
                    .map(m => ({
                        at: m.at,
                        marker: markerOf(m.message.data.status.media),
                        owner: m.message.data.status.media
                            ? m.message.data.status.media.sessionId || null
                            : null
                    }));
            const refreshDevice = async label => {
                // A real refresh that cannot change the session-media OWNER: the
                // device is re-driven over ECP, which makes the discovery host
                // re-poll and publish a fresh status. Using only a pre-clear DOM
                // read would let "nothing happened" look like "B is still here".
                await post("/state", {
                    playerState: "play",
                    position: 35,
                    duration: 600,
                    title: `harness-owner-clear-${label}`
                });
                await sleep(3000);
            };
            const requestOwnerWrite = async (requestId, ownerId, marker) => {
                const media = marker
                    ? {
                          ...(mediaTemplate || {}),
                          customData: {
                              ...((mediaTemplate && mediaTemplate.customData) ||
                                  {}),
                              harnessMarker: marker
                          },
                          metadata: {
                              ...((mediaTemplate && mediaTemplate.metadata) ||
                                  {}),
                              title: `session media ${marker}`
                          }
                      }
                    : null;
                await driver.switchTo().window(consoleTab);
                await driver.executeAsyncScript(
                    `const done = arguments[arguments.length - 1];
                     browser.storage.local.set({
                        __fxHarnessOwnerClearRequest: {
                            runId: ${JSON.stringify(diagnosticRunId)},
                            requestId: ${JSON.stringify(requestId)},
                            deviceId: ${JSON.stringify(FAKE_DEVICE_ID)},
                            ownerId: ${JSON.stringify(ownerId)},
                            media: ${JSON.stringify(media)}
                        }
                     }).then(() => done(true), err => done(String(err)));`
                );
                return Date.now();
            };
            const waitForConsumed = async requestId => {
                const deadline = Date.now() + 20000;
                for (;;) {
                    const markers = await readOwnerMarkers();
                    const done = markers.consumed.find(
                        c => c.requestId === requestId
                    );
                    if (done || Date.now() > deadline) return markers;
                    await sleep(300);
                }
            };
            const countOutcomes = (markers, outcome, at) =>
                markers.outcomes.filter(
                    o => o.outcome === outcome && (!at || o.at >= at)
                );
            const countMirrors = (markers, isClear, at) =>
                markers.mirrors.filter(
                    m => m.isClear === isClear && (!at || m.at >= at)
                );
            const wireClearsSince = at =>
                discoveryConnectionsNow
                    .flatMap(conn =>
                        readNdjson(
                            path.join(harnessDir, `conn-${conn.pid}-in.ndjson`)
                        )
                    )
                    .filter(
                        m =>
                            m.subject === "bridge:rokuSetSessionMedia" &&
                            m.at >= at &&
                            m.message &&
                            m.message.data &&
                            m.message.data.media === null &&
                            m.message.data.deviceId === FAKE_DEVICE_ID
                    );

            let markers = await readOwnerMarkers();
            const hookDeadline = Date.now() + 20000;
            while (
                (!markers.installed || markers.installed.runId !== diagnosticRunId) &&
                Date.now() < hookDeadline
            ) {
                await sleep(300);
                markers = await readOwnerMarkers();
            }
            check(
                "owner-aware clear: the injection hook is installed (a load ran, so setRokuSessionMedia was reached)",
                Boolean(
                    markers.installed && markers.installed.runId === diagnosticRunId
                ),
                JSON.stringify(markers.installed || null)
            );
            check(
                "owner-aware clear: the case runs inside ONE load generation (the media template and its generation exist)",
                Boolean(mediaTemplate) && Number.isFinite(generationN),
                JSON.stringify({
                    hasMedia: Boolean(mediaTemplate),
                    generation: generationN
                })
            );

            // --- A: owner A writes ------------------------------------------
            const setAAt = await requestOwnerWrite("oc-set-A", OWNER_A, MARKER_A);
            markers = await waitForConsumed("oc-set-A");
            await refreshDevice("A");
            const samplesA = statusSamplesSince(setAAt);
            const inputA = markers.inputs.filter(
                i => i.ownerId === OWNER_A && i.at >= setAAt
            );
            const mirrorA = countMirrors(markers, false, setAAt);
            console.log(
                "owner-aware clear A:",
                JSON.stringify({
                    inputs: inputA.map(i => ({
                        ownerId: i.ownerId,
                        marker: i.marker,
                        generation: i.loadGeneration
                    })),
                    mirrorSets: mirrorA.length,
                    statusMarkers: samplesA.map(s => s.marker)
                })
            );
            check(
                "owner-aware clear A: owner A's write was adopted locally and mirrored to discovery once, under generation N",
                inputA.length === 1 &&
                    inputA[0].marker === MARKER_A &&
                    inputA[0].loadGeneration === generationN &&
                    mirrorA.length === 1 &&
                    mirrorA[0].ownerId === OWNER_A &&
                    mirrorA[0].marker === MARKER_A,
                JSON.stringify({ inputA, mirrorA })
            );
            check(
                "owner-aware clear A: A's media is visible downstream (a fresh discovery status carries it)",
                samplesA.some(s => s.marker === MARKER_A),
                JSON.stringify(samplesA.slice(-4))
            );

            // --- B: owner B replaces A --------------------------------------
            const setBAt = await requestOwnerWrite("oc-set-B", OWNER_B, MARKER_B);
            markers = await waitForConsumed("oc-set-B");
            await refreshDevice("B");
            const samplesB = statusSamplesSince(setBAt);
            const mirrorB = countMirrors(markers, false, setBAt);
            const bVisibleAt =
                (samplesB.find(s => s.marker === MARKER_B) || {}).at ||
                setBAt;
            console.log(
                "owner-aware clear B:",
                JSON.stringify({
                    mirrorSets: mirrorB.length,
                    statusMarkers: samplesB.map(s => s.marker),
                    bVisibleAt
                })
            );
            check(
                "owner-aware clear B: owner B's write replaced A and was mirrored once",
                mirrorB.length === 1 &&
                    mirrorB[0].ownerId === OWNER_B &&
                    mirrorB[0].marker === MARKER_B,
                JSON.stringify(mirrorB)
            );
            check(
                "owner-aware clear B: B's media is visible downstream (the new baseline for the stale clear)",
                samplesB.some(s => s.marker === MARKER_B),
                JSON.stringify(samplesB.slice(-4))
            );

            // --- C: owner A's LATE clear ------------------------------------
            const staleClearAt = await requestOwnerWrite(
                "oc-clear-A",
                OWNER_A,
                null
            );
            markers = await waitForConsumed("oc-clear-A");
            await refreshDevice("stale");
            const ignored = countOutcomes(markers, "ignored", staleClearAt);
            const appliedAfterStale = countOutcomes(
                markers,
                "applied",
                staleClearAt
            );
            const mirrorClearsAfterStale = countMirrors(
                markers,
                true,
                staleClearAt
            );
            const wireClearsAfterStale = wireClearsSince(staleClearAt);
            const samplesStale = statusSamplesSince(staleClearAt);
            const staleFacts = {
                ignored: ignored.map(i => ({
                    ownerId: i.ownerId,
                    currentOwnerId: i.currentOwnerId,
                    generation: i.loadGeneration
                })),
                applied: appliedAfterStale.length,
                mirrorClears: mirrorClearsAfterStale.length,
                wireClears: wireClearsAfterStale.length,
                statusMarkers: samplesStale.map(s => s.marker)
            };
            console.log(
                "owner-aware clear C (stale):",
                JSON.stringify(staleFacts)
            );
            check(
                "the retired owner's late clear did not cross the local or wire boundary",
                ignored.length === 1 &&
                    ignored[0].ownerId === OWNER_A &&
                    ignored[0].currentOwnerId === OWNER_B &&
                    ignored[0].loadGeneration === generationN &&
                    appliedAfterStale.length === 0 &&
                    mirrorClearsAfterStale.length === 0 &&
                    wireClearsAfterStale.length === 0,
                JSON.stringify(staleFacts)
            );
            check(
                "owner-aware clear C: B's media is STILL visible in a status published AFTER the stale clear",
                samplesStale.some(s => s.marker === MARKER_B),
                JSON.stringify(staleFacts.statusMarkers)
            );

            // --- D: the current owner clears --------------------------------
            const appliedClearAt = await requestOwnerWrite(
                "oc-clear-B",
                OWNER_B,
                null
            );
            markers = await waitForConsumed("oc-clear-B");
            await refreshDevice("applied");
            const applied = countOutcomes(markers, "applied", appliedClearAt);
            const mirrorClearsApplied = countMirrors(
                markers,
                true,
                appliedClearAt
            );
            const wireClearsApplied = wireClearsSince(appliedClearAt);
            const samplesApplied = statusSamplesSince(appliedClearAt);
            const appliedFacts = {
                applied: applied.map(a => ({
                    ownerId: a.ownerId,
                    currentOwnerId: a.currentOwnerId,
                    generation: a.loadGeneration
                })),
                mirrorClears: mirrorClearsApplied.map(m => ({
                    ownerId: m.ownerId,
                    generation: m.loadGeneration
                })),
                wireClears: wireClearsApplied.map(m => ({
                    ownerId: m.message.data.ownerId,
                    generation: m.message.data.loadGeneration,
                    deviceId: m.message.data.deviceId
                })),
                statusMarkers: samplesApplied.map(s => s.marker)
            };
            console.log(
                "owner-aware clear D (applied):",
                JSON.stringify(appliedFacts)
            );
            check(
                "owner-aware clear D: the CURRENT owner's clear was applied, mirrored once and crossed the wire under generation N",
                applied.length === 1 &&
                    applied[0].ownerId === OWNER_B &&
                    applied[0].currentOwnerId === OWNER_B &&
                    applied[0].loadGeneration === generationN &&
                    mirrorClearsApplied.length === 1 &&
                    mirrorClearsApplied[0].ownerId === OWNER_B &&
                    mirrorClearsApplied[0].loadGeneration === generationN &&
                    wireClearsApplied.length === 1 &&
                    wireClearsApplied[0].message.data.ownerId === OWNER_B &&
                    wireClearsApplied[0].message.data.loadGeneration ===
                        generationN &&
                    wireClearsApplied[0].message.data.deviceId === FAKE_DEVICE_ID,
                JSON.stringify(appliedFacts)
            );
            check(
                "owner-aware clear D: after the applied clear, no status sample still carries B's media",
                !samplesApplied.some(s => s.marker === MARKER_B) &&
                    samplesApplied.length >= 1,
                JSON.stringify(appliedFacts.statusMarkers)
            );
            const generationSetAfter = (
                await readOwnerMarkers()
            ).generationSet.filter(g => g.at >= setAAt);
            check(
                "owner-aware clear sequence did not advance the LOAD generation",
                generationSetAfter.length === 0,
                JSON.stringify(generationSetAfter)
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
        restoreManifest("run finished");
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

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
        // A killed run must not leave the user's bridge shadowed.
        restoreManifest(signal);
        process.exit(1);
    });
}

/**
 * Nothing may outlive the run: an abandoned fake Roku holds port 8060, which
 * makes the NEXT run fail with "the fake Roku did not start (port 8060 busy?)"
 * - i.e. a leftover of the previous run hides the real error of the next one,
 * which is exactly what happened. Owning geckodriver is the harness's own doing
 * (Selenium does not stop a server it did not start), so it reaps both.
 */
process.on("exit", () => {
    // Covers every path that reaches process.exit(), including ones that never
    // run the try/finally above.
    restoreManifest("exit");
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
