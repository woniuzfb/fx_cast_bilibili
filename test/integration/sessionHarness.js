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
    const args = { keepProfile: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--keep-profile") args.keepProfile = true;
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

function makeProfile(harnessDir) {
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
        cwd: path.join(repoRoot, "dist/extension")
    });
    if (zipped.status !== 0) throw new Error("zip failed: " + zipped.stderr);
    fs.copyFileSync(
        xpiPath,
        path.join(profileDir, "extensions", `${EXTENSION_ID}.xpi`)
    );
    return profileDir;
}

async function startFirefox(options, label) {
    console.log(`starting Firefox (${label})...`);
    const driver = await new webdriver.Builder()
        .forBrowser("firefox")
        .setFirefoxOptions(options)
        .build();
    // The default 30s script timeout is shorter than the selector waits below.
    await driver.manage().setTimeouts({ script: 45000 });
    return driver;
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

    const profileDir = makeProfile(harnessDir);
    const firefoxPath = [
        "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
        "/Applications/Firefox.app/Contents/MacOS/firefox"
    ].find(candidate => fs.existsSync(candidate));
    if (!firefoxPath) throw new Error("sessionHarness: no Firefox found");

    const options = new firefox.Options()
        .setBinary(firefoxPath)
        .setProfile(profileDir);
    const geckoCache = path.join(harnessDir, "selenium-cache");
    fs.mkdirSync(geckoCache, { recursive: true });
    process.env.SE_CACHE_PATH = geckoCache;
    // Privileged navigations (the extension's own pages) are refused unless
    // Firefox starts with system access allowed.
    process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

    let driver;
    try {
        // --- phase A: whitelist, then restart ---------------------------------
        driver = await startFirefox(options, "phase A: whitelist");
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
                    const list = Array.isArray(options.siteWhitelist)
                        ? options.siteWhitelist.slice()
                        : [];
                    const pattern = ${JSON.stringify(origin)} + "/*";
                    if (!list.some(entry => entry.pattern === pattern)) {
                        list.push({ pattern, isEnabled: true });
                    }
                    options.siteWhitelist = list;
                    options.siteWhitelistEnabled = true;
                    await browser.storage.sync.set({ options });
                    done({ ok: true, count: list.length });
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
        await driver.quit();
        driver = undefined;
        console.log(
            "restarted: the SDK-rewriting content script is registered at startup"
        );
        await sleep(1500);

        // --- phase B: the real run -------------------------------------------
        driver = await startFirefox(options, "phase B: session");

        // S: the sender page (must stay the active tab).
        await driver.get(`${origin}/sender.html`);
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
        const sdk = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             window.__HARNESS_WAIT_FOR_SDK__(20000).then(() => done(true), err => done(String(err)));`
        );
        check(
            "the page got chrome.cast from the extension (SDK redirect worked)",
            sdk === true,
            String(sdk)
        );
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

        const deviceIds = [];
        for (const conn of connections) {
            for (const message of [...conn.inbound, ...conn.outbound]) {
                const data = message.message && message.message.data;
                if (data && data.deviceId) deviceIds.push(data.deviceId);
            }
        }
        console.log(
            "deviceIds on the wire:",
            JSON.stringify([...new Set(deviceIds)])
        );
        check(
            "no LAN Roku was acted on (only the fake device)",
            !deviceIds.some(
                id => id && id.startsWith("roku-") && id !== FAKE_DEVICE_ID
            ),
            JSON.stringify([...new Set(deviceIds)])
        );
        check(
            "the fake Roku received ECP traffic",
            readNdjson(path.join(rokuDir, "fake-roku-requests.ndjson")).length >
                0
        );
    } finally {
        if (driver) await driver.quit().catch(() => {});
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
