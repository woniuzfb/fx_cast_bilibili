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
        instrument: false
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--keep-profile") args.keepProfile = true;
        else if (argv[i] === "--phase-a-only") args.phaseAOnly = true;
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
        const name = path.basename(new URL(req.url, "http://x").pathname);
        const file = path.join(__dirname, "pages", name);
        if (!fs.existsSync(file)) {
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
    let rokuReady = false;
    let rokuOut = "";
    roku.stdout.on("data", chunk => {
        rokuOut += chunk.toString();
        if (rokuOut.includes('"ready":true')) rokuReady = true;
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

    // 判定2: a test-only build that marks contentInitial's own execution. It is
    // made in the harness directory, never in dist/, and the mark is not part of
    // any production behaviour.
    let extensionDir = args.extensionDir;
    if (args.instrument) {
        extensionDir = path.join(harnessDir, "extension-instrumented");
        fs.cpSync(args.extensionDir, extensionDir, { recursive: true });
        const target = path.join(extensionDir, "cast/contentInitial.js");
        // HEAD and TAIL markers, because "never injected" and "injected and
        // threw" look identical from the page if the only marker sits at the
        // end of the file (the first attempt made exactly that mistake):
        //   head only        -> the script ran and threw before finishing
        //   head and tail    -> the script completed, so the patch itself is
        //                       what failed to affect the page
        //   neither          -> the script was not injected at all
        const original = fs.readFileSync(target, "utf8");
        const marker = name =>
            `try { document.documentElement.setAttribute(${JSON.stringify(
                name
            )}, "1"); } catch (e) {}\n`;
        fs.writeFileSync(
            target,
            "// HARNESS ONLY instrumentation\n" +
                'console.log("[harness] contentInitial.js entered");\n' +
                marker("data-fx-harness-ci-head") +
                original +
                "\n" +
                marker("data-fx-harness-ci-tail")
        );
        console.log("instrumented contentInitial:", target);
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
                    await new Promise(r => setTimeout(r, 1500));
                    const registered = await browser.scripting.getRegisteredContentScripts();
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
        await driver.get(`${origin}/sender.html?arm=A`);
        const senderTab = await driver.getWindowHandle();

        // O: an extension page, used only as the extension-side console (the
        // one place `browser.tabs.*` can be called from).
        await driver.switchTo().newWindow("tab");
        await driver.get(optionsUrl);
        await sleep(1500);

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

        await driver.switchTo().window(senderTab);
        await driver.navigate().refresh();
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
        await driver.executeScript(
            "window.__HARNESS_REQUEST_SESSION__().catch(() => {});"
        );

        const popupHandle = await findHandleByUrl(driver, "/ui/popup/", 20000);
        // Guard against a vacuous pass: the popup page renders every device as
        // soon as it mounts, so finding and clicking a row proves nothing about
        // requestSession. The page must have asked first.
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
            const clicked = await driver.executeAsyncScript(
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
                        done({ ok: true, rows: rows.length, clicked: button ? "cast-button" : "row" });
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
        const discovery = connections.find(c =>
            c.inbound.some(m => m.subject === "bridge:startDiscovery")
        );
        const session = connections.find(
            c =>
                c.pid !== (discovery && discovery.pid) &&
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
            "the session PID differs from the discovery PID",
            Boolean(session && discovery && session.pid !== discovery.pid),
            JSON.stringify([session && session.pid, discovery && discovery.pid])
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
        const ACTION_SUBJECTS = new Set([
            "bridge:sendMediaMessage",
            "bridge:sendReceiverMessage",
            "bridge:createCastSession",
            "bridge:stopCastSession",
            "bridge:rokuRequestConfirmationPoll"
        ]);
        for (const conn of connections) {
            for (const message of [...conn.inbound, ...conn.outbound]) {
                const data = (message.message && message.message.data) || {};
                if (data.deviceId) {
                    discovered.push(data.deviceId);
                    if (ACTION_SUBJECTS.has(String(message.subject))) {
                        actedOn.push(data.deviceId);
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
        check(
            "no command was sent to a non-fake device",
            !actedOn.some(id => id && id !== FAKE_DEVICE_ID),
            JSON.stringify([...new Set(actedOn)])
        );
        check(
            "the fake Roku received ECP traffic",
            readNdjson(path.join(rokuDir, "fake-roku-requests.ndjson")).length >
                0
        );
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
