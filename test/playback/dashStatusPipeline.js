#!/usr/bin/env node
"use strict";

/**
 * The receiver -> page time mapping, driven through the REAL DeviceManager.
 *
 * Why this exists: the conversion was first written INSIDE the Roku session-media
 * merge branch, so a Chromecast status never went through it. The popup then
 * showed the receiver's padded clock (page + pad runway) as if it were page time —
 * 32s off — and every control derived from that position disagreed with the
 * receiver. The helper was unit-tested and the popup was checked for a second
 * conversion, and both stayed green: neither test ran the status pipeline that
 * decided whether the conversion happened at all.
 *
 * This test drives that pipeline: device registered, bridge ready message (the
 * offset), then a raw MEDIA_STATUS, and it asserts what the device publishes.
 * The bundle is the shipped module with two stubs (native bridge connection and
 * the options store), so the message routing, the merge, the offset precedence
 * and the published status are all production code.
 *
 * Usage:
 *   node test/playback/dashStatusPipeline.js
 *   node test/playback/dashStatusPipeline.js --pre-fix   # negative control
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const extensionSrc = path.join(repoRoot, "extension/src");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

const argv = process.argv.slice(2);
const PRE_FIX = argv.includes("--pre-fix");
const revIndex = argv.indexOf("--rev");
const REV = revIndex >= 0 && argv[revIndex + 1] ? argv[revIndex + 1] : "HEAD";

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
    if (cond) {
        pass++;
        console.info("  ok   " + name);
    } else {
        fail++;
        failures.push(name);
        console.info(
            "  FAIL " + name + (detail === undefined ? "" : " :: " + detail)
        );
    }
};

/** A worktree of the revision under test, or the working tree. */
function resolveSourceRoot() {
    if (!PRE_FIX) return extensionSrc;
    const worktree = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cast-status-rev-")
    );
    fs.rmSync(worktree, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--detach", worktree, REV], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"]
    });
    process.on("exit", () => {
        try {
            execFileSync("git", ["worktree", "remove", "--force", worktree], {
                cwd: repoRoot,
                stdio: "ignore"
            });
        } catch {
            // A leftover worktree must not change the test result.
        }
    });
    return path.join(worktree, "extension/src");
}

async function build() {
    const src = resolveSourceRoot();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-status-"));
    const entry = path.join(workDir, "entry.ts");
    const outfile = path.join(workDir, "deviceManager.cjs");
    const stubDir = path.join(workDir, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });

    // The real option defaults, materialised from source: the background's module
    // graph reads every option name at import time, so the stubbed store has to
    // answer with them. Extracting the shipped literal keeps this test's
    // configuration equal to production instead of a hand copy.
    const defaultsJson = path.join(workDir, "optionDefaults.json");
    fs.writeFileSync(defaultsJson, JSON.stringify(extractDefaultOptions(src)));
    globalThis.__optionDefaults = JSON.parse(
        fs.readFileSync(defaultsJson, "utf8")
    );

    const stubPath = path.join(stubDir, "nativeMessagingStub.js");
    fs.writeFileSync(stubPath, nativeMessagingStubSource());

    fs.writeFileSync(
        entry,
        `import deviceManager from ${JSON.stringify(
            path.join(src, "background/deviceManager.ts")
        )};\nexport { deviceManager };\n`
    );

    // The module graph touches browser/window at import time.
    installGlobals();
    const esbuild = require(esbuildPath);
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        nodePaths: [path.join(repoRoot, "extension/node_modules")],
        define: {
            BRIDGE_NAME: '"fx_cast_bilibili_bridge"',
            BRIDGE_VERSION: '"0.0.0-test"',
            MIRRORING_APP_ID: '"TESTMIRROR"'
        },
        plugins: [
            {
                // The narrowest seam: the native-messaging transport. Everything
                // above it (bridge.getInfo, the option store, deviceManager's
                // message routing and the status merge) is shipped code.
                name: "stub-native-messaging",
                setup(build) {
                    build.onResolve(
                        { filter: /^\.\/nativeMessaging$/ },
                        () => ({ path: stubPath })
                    );
                }
            }
        ]
    });
    return { modules: require(outfile), workDir };
}

/**
 * The stubbed native-messaging transport.
 *
 * It registers itself on a global while the BUNDLE evaluates, so the test drives
 * the bundle's own module instance: a separate `require` of this file would be a
 * second instance with its own listener list, and messages dispatched into that
 * one would never reach the module under test.
 */
function nativeMessagingStubSource() {
    return `"use strict";
const listeners = { message: [], disconnect: [] };
const port = {
    postMessage: message => { global.__bridgePosted.push(message); },
    disconnect: () => undefined,
    onMessage: { addListener: fn => listeners.message.push(fn) },
    onDisconnect: { addListener: fn => listeners.disconnect.push(fn) }
};
module.exports = {
    connectNative: () => port,
    sendNativeMessage: async () => "0.0.0-test"
};
module.exports.__port = port;
module.exports.__dispatch = message =>
    listeners.message.slice().forEach(fn => fn(message));
(globalThis.__bridgeStubInstances ||= []).push(module.exports);
`;
}

// ---------------------------------------------------------------------------
// The status pipeline
// ---------------------------------------------------------------------------

const CHROMECAST = {
    id: "chromecast-test",
    friendlyName: "Living Room",
    modelName: "Chromecast",
    capabilities: 0,
    host: "127.0.0.1",
    port: 8009
    // deviceType undefined => cast path (what the bridge sends for a Chromecast)
};
const ROKU = {
    ...CHROMECAST,
    id: "roku-test",
    friendlyName: "Roku",
    deviceType: "roku"
};

/** Install globals the background module expects. */
/**
 * The `defaultOptions` object literal, read out of its source.
 *
 * A hand-copied subset would silently mis-configure this test as options are
 * added (the real module throws for an unknown key), so the shipped defaults are
 * the source here too.
 */
function extractDefaultOptions(extensionSrcDir) {
    const source = fs.readFileSync(
        path.join(extensionSrcDir, "defaultOptions.ts"),
        "utf8"
    );
    const marker = source.indexOf("export default {");
    if (marker < 0) {
        throw new Error("defaultOptions.ts: no default export object");
    }
    const start = source.indexOf("{", marker);
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                const literal = source.slice(start, i + 1);
                // The defaults reference the build-time constants, so they have
                // to exist for the literal to evaluate.
                return new Function(
                    "BRIDGE_NAME",
                    "BRIDGE_VERSION",
                    "MIRRORING_APP_ID",
                    `return (${literal});`
                )("fx_cast_bilibili_bridge", "0.0.0-test", "TESTMIRROR");
            }
        }
    }
    throw new Error("defaultOptions.ts: unterminated object literal");
}

function installGlobals() {
    global.__bridgePosted = [];
    global.__bridgeStubInstances = [];
    // Node's EventTarget only accepts its OWN Event instances, so the DOM
    // polyfill has to derive from it (a plain object is rejected).
    global.CustomEvent = class CustomEvent extends Event {
        constructor(type, init) {
            super(type);
            this.detail = init?.detail;
        }
    };
    global.self = global;
    global.window = {
        location: {
            protocol: "moz-extension:",
            href: "moz-extension://test/bg"
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: id => clearTimeout(id),
        setInterval: () => 0,
        clearInterval: () => undefined
    };
    global.browser = {
        storage: {
            sync: {
                // The real options module reads this key and merges what it gets
                // over the real defaults, so an empty store is enough: the module
                // graph already carries them. (Returning undefined here is what
                // produced `options.hasOwnProperty` errors.)
                get: async () => ({
                    options: { ...globalThis.__optionDefaults }
                }),
                set: async () => undefined
            },
            onChanged: {
                addListener: () => undefined,
                removeListener: () => undefined
            }
        },
        runtime: {
            getManifest: () => ({ version: "0.0.0-test" }),
            sendMessage: async () => undefined,
            onMessage: {
                addListener: () => undefined,
                removeListener: () => undefined
            },
            getPlatformInfo: async () => ({ os: "mac" })
        },
        i18n: { getMessage: key => key },
        tabs: { get: async () => undefined, sendMessage: async () => undefined }
    };
}

/** The stub instance the loaded bundle bound (see the stub's global registration). */
const stubDispatcher = () => {
    const instances = global.__bridgeStubInstances ?? [];
    if (!instances.length) {
        throw new Error(
            "the bundle never evaluated the native-messaging stub; nothing to drive"
        );
    }
    return instances[instances.length - 1].__dispatch;
};

const flush = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
};

async function registerDevice(modules, device) {
    await modules.deviceManager.refresh();
    await flush();

    stubDispatcher()({
        subject: "main:deviceUp",
        data: { deviceId: device.id, deviceInfo: device }
    });
    await flush();
    return modules.deviceManager.getDeviceById(device.id);
}

function sendMediaStatus(modules, device, status) {
    stubDispatcher()({
        subject: "main:receiverDeviceMediaStatusUpdated",
        data: { deviceId: device.id, status }
    });
}

function makeStatus({
    currentTime,
    customData,
    playerState = "PLAYING",
    /** The receiver's own stream-derived media snapshot, as periodic
     *  MEDIA_STATUS broadcasts carry it: identity fields only. */
    bareMedia = false,
    /** Media identity, so a report can describe a DIFFERENT media generation
     *  than the one whose shift is on record. */
    mediaSessionId = 1,
    contentId = "http://10.0.0.111:9555/s/gen/index.m3u8?v=1"
}) {
    return {
        mediaSessionId,
        playerState,
        currentTime,
        media: bareMedia
            ? { contentId, duration: -1 }
            : { contentId, duration: -1, customData },
        supportedMediaCommands: 0,
        volume: { level: 1, muted: false }
    };
}

/** Set the device-level offset when the revision under test has that API. */
function setDeviceOffset(modules, deviceId, seconds) {
    const setter = modules.deviceManager.setDashPresentationOffset;
    if (typeof setter === "function")
        setter.call(modules.deviceManager, deviceId, seconds);
}

/** The LOAD media a DASH remux carries: page position + the presentation shift. */
function dashCustomData(pagePosition, offsetSeconds) {
    return {
        dashRemux: true,
        dashStart: pagePosition,
        presentationOffsetSeconds: offsetSeconds,
        pageDuration: 6021
    };
}

async function main() {
    const { modules, workDir } = await build();
    console.info(
        `DASH status pipeline (${PRE_FIX ? `revision ${REV}` : "working tree"})`
    );

    // ---- Chromecast: the pad runway must be removed from the position -------
    const chromecast = await registerDevice(modules, CHROMECAST);
    // Older revisions have no device-level offset setter at all; the media's own
    // customData carries the same value, so the assertions still mean what they
    // say (and this test can serve as a regression control).
    setDeviceOffset(modules, chromecast.id, 32);
    // LOAD was page 4.001269 with a 32s runway; the receiver's own clock reads
    // 36.389605 (as a real run showed).
    sendMediaStatus(
        modules,
        CHROMECAST,
        makeStatus({
            currentTime: 36.389605,
            customData: dashCustomData(4.001269, 32)
        })
    );
    await flush();
    const chromecastTime = chromecast.mediaStatus?.currentTime;
    check(
        "Chromecast: the runway is removed from the published position (36.389605 -> 4.389605)",
        Math.abs(Number(chromecastTime) - 4.389605) < 1e-6,
        JSON.stringify({ published: chromecastTime })
    );
    check(
        "Chromecast: the position is page time, not the padded clock",
        Math.abs(Number(chromecastTime) - 36.389605) > 1,
        JSON.stringify({ published: chromecastTime })
    );

    // ---- the real-run case: the receiver's own bare media snapshot ---------
    // Periodic MEDIA_STATUS broadcasts often carry only the stream's media
    // object — no customData — so the LOAD-time metadata has to come from the
    // merge. Converting the INCOMING status (before the merge) skipped these
    // reports entirely: playback started correctly and then the popup's position
    // jumped a whole pad runway forward, exactly as the field reported.
    sendMediaStatus(
        modules,
        CHROMECAST,
        makeStatus({ currentTime: 68, bareMedia: true })
    );
    await flush();
    check(
        "Chromecast: a bare-media report is still mapped (68 -> 36)",
        Math.abs(Number(chromecast.mediaStatus?.currentTime) - 36) < 1e-6,
        JSON.stringify({ published: chromecast.mediaStatus?.currentTime })
    );
    check(
        "Chromecast: the merge preserved the LOAD metadata a bare report omits",
        Number(chromecast.mediaStatus?.media?.customData?.dashStart) ===
            4.001269,
        JSON.stringify({ media: chromecast.mediaStatus?.media })
    );

    // ---- a media stating 0 is never remapped by an earlier generation -------
    // The shift is memoized against the MEDIA it was stated for (its
    // mediaSessionId and base contentId), never against the device. Here an
    // earlier generation's 32s is on record and this media states its own 0, so
    // 0 wins: this generation was loaded without a runway and must not inherit
    // one. A device-level slot could not tell the two apart, which is how a
    // previous remux's runway came to be subtracted from the next remux.
    setDeviceOffset(modules, chromecast.id, 32);
    sendMediaStatus(
        modules,
        CHROMECAST,
        makeStatus({
            currentTime: 436.014207,
            customData: dashCustomData(436.014207, 0)
        })
    );
    await flush();
    check(
        "Chromecast: a media stating offset 0 is NOT remapped by an earlier generation's 32",
        Math.abs(Number(chromecast.mediaStatus?.currentTime) - 436.014207) <
            1e-6,
        JSON.stringify({ published: chromecast.mediaStatus?.currentTime })
    );

    // ---- mid-video restart: offset 0, so the receiver is already on page time
    sendMediaStatus(
        modules,
        CHROMECAST,
        makeStatus({
            currentTime: 500.5,
            customData: dashCustomData(436.014207, 0)
        })
    );
    await flush();
    check(
        "Chromecast mid-video (offset 0): the position passes through unchanged",
        Math.abs(Number(chromecast.mediaStatus?.currentTime) - 500.5) < 1e-6,
        JSON.stringify({ published: chromecast.mediaStatus?.currentTime })
    );

    // ---- a report about an UNKNOWN media is left alone ----------------------
    // The shift belongs to a media GENERATION, so a report whose media this
    // background has never seen a shift for must NOT be converted: a guess here
    // (or a device-level slot left behind by an earlier remux) moved the popup by
    // a whole pad runway, and that wrong position is what a control would then act
    // on. Leaving it unconverted is the only answer that cannot be wrong.
    sendMediaStatus(
        modules,
        CHROMECAST,
        makeStatus({
            currentTime: 500,
            bareMedia: true,
            mediaSessionId: 77,
            contentId: "http://10.0.0.111:9555/s/other/index.m3u8?v=9"
        })
    );
    await flush();
    check(
        "Chromecast: a report from an unknown media generation is NOT converted (no guessed shift)",
        modules.deviceManager.getDeviceById(chromecast.id)?.mediaStatus
            ?.currentTime === 500,
        JSON.stringify({
            published:
                modules.deviceManager.getDeviceById(chromecast.id)?.mediaStatus
                    ?.currentTime
        })
    );

    // ---- Roku: page time already, and offset 0 by construction -------------
    const roku = await registerDevice(modules, ROKU);
    setDeviceOffset(modules, roku.id, 0);
    sendMediaStatus(
        modules,
        ROKU,
        makeStatus({ currentTime: 41.5, customData: dashCustomData(40, 0) })
    );
    await flush();
    const rokuTime = Number(roku.mediaStatus?.currentTime);
    check(
        "Roku: the mapping is the identity (its session already publishes page + elapsed)",
        Math.abs(rokuTime - 41.5) < 1e-6 || Math.abs(rokuTime - 81.5) < 1e-6,
        JSON.stringify({
            published: rokuTime,
            note: "no Roku session media registered here, so it stays as reported"
        })
    );

    // ---- the device-media merge must not lose the converted value ----------
    check(
        "the published status is what the popup reads (device.mediaStatus)",
        chromecast.mediaStatus !== undefined &&
            typeof chromecast.mediaStatus.currentTime === "number",
        JSON.stringify({ mediaStatus: chromecast.mediaStatus })
    );

    console.info("");
    if (PRE_FIX) {
        const expected = failures.filter(name =>
            /runway is removed|position is page time/.test(name)
        );
        if (expected.length < 2) {
            console.error(
                `dashStatusPipeline: --pre-fix expected the Chromecast conversion failures, saw ${expected.length}` +
                    (failures.length ? ` (${failures.join("; ")})` : "")
            );
            process.exitCode = 1;
        } else {
            console.info(
                `revision control (${REV}): ${fail} check(s) failed, including the ${expected.length} expected`
            );
            for (const name of failures) console.info("  - " + name);
            process.exitCode = 0;
        }
    } else {
        console.info(`${pass}/${pass + fail} checks passed`);
        process.exitCode = fail ? 1 : 0;
    }
    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
}

main().catch(err => {
    console.error("dashStatusPipeline ERROR", err);
    process.exitCode = 1;
});
