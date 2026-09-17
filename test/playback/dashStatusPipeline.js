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
 *   node test/playback/dashStatusPipeline.js --pre-fix                    # control against HEAD
 *   node test/playback/dashStatusPipeline.js --pre-fix --rev 63447f1      # control against a revision
 *
 * `--pre-fix` runs the SAME contract against another revision (a `git worktree`)
 * and requires the rows to fail for whatever defects that revision actually
 * carries — each defect is detected in the revision's own source, so the control
 * reports which ones it found instead of assuming one revision's shape. A
 * revision carrying none of them is an error: nothing would have been
 * controlled.
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
    return { modules: require(outfile), workDir, src };
}

/**
 * The stubbed native-messaging transport.
 *
 * It registers itself on a global while the BUNDLE evaluates, so the test drives
 * the bundle's own module instance: a separate `require` of this file would be a
 * second instance with its own listener list, and messages dispatched into that
 * one would never reach the module under test.
 *
 * A FRESH port per `connectNative` call, like the real transport (the background
 * opens one native connection per bridge process), and a dispatch that reaches
 * ONE port. Sharing a single port object grew its listener list by one per
 * connection, so every later message was handled once per registered device -
 * invisible while the handler was idempotent, and the actual reason a position
 * once came out as 41.5 -> 81.5 -> 121.5 (the conversion wrote into the message
 * object, so the second handling converted a page value as if it were a raw
 * one). Idempotence is now a property of the code under test, and it is asserted
 * by dispatching the same message twice on purpose (see the guard rows), not by
 * an accident of how many devices this file has registered so far.
 */
function nativeMessagingStubSource() {
    return `"use strict";
const ports = [];
function makePort() {
    const listeners = { message: [], disconnect: [] };
    const port = {
        postMessage: message => { global.__bridgePosted.push(message); },
        disconnect: () => undefined,
        onMessage: { addListener: fn => listeners.message.push(fn) },
        onDisconnect: { addListener: fn => listeners.disconnect.push(fn) }
    };
    ports.push({ port, listeners });
    return port;
}
module.exports = {
    connectNative: () => makePort(),
    sendNativeMessage: async () => "0.0.0-test"
};
module.exports.__dispatch = message => {
    const newest = ports[ports.length - 1];
    if (!newest) throw new Error("no native port was ever connected");
    newest.listeners.message.slice().forEach(fn => fn(message));
};
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

    // A COPY of the caller's literal: the module under test keeps the object it
    // is given and writes the device's live state onto it (mediaStatus, status).
    // Passing the shared const meant a device registered later inherited the
    // state a previous scenario had written onto the same literal - which is how
    // a "fresh" device arrived with a media status already set.
    stubDispatcher()({
        subject: "main:deviceUp",
        data: { deviceId: device.id, deviceInfo: { ...device } }
    });
    await flush();
    return modules.deviceManager.getDeviceById(device.id);
}

/**
 * @param provenance The bridge's statement of how this sample was produced.
 *   Real `ecp-poll` samples carry `{source, pollStartedAt, pollCompletedAt,
 *   sequence}`; the synthetic sources carry only `{source}`; the Chromecast path
 *   sends none at all.
 */
function sendMediaStatus(modules, device, status, provenance) {
    stubDispatcher()({
        subject: "main:receiverDeviceMediaStatusUpdated",
        data: {
            deviceId: device.id,
            status,
            ...(provenance === undefined ? {} : { provenance })
        }
    });
}

/** An `ecp-poll` provenance whose identity is (sequence, pollStartedAt). */
function pollProvenance(sequence, pollStartedAt) {
    return {
        source: "ecp-poll",
        pollStartedAt,
        pollCompletedAt: pollStartedAt + 40,
        sequence
    };
}

function sendReceiverStatus(modules, device, applications) {
    stubDispatcher()({
        subject: "main:receiverDeviceStatusUpdated",
        data: {
            deviceId: device.id,
            status: { applications, volume: { level: 1 } }
        }
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
    const { modules, workDir, src: sourceUnderTest } = await build();
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
    // The receiver reports 36.389605 on ITS clock; that media's content starts at
    // page 4.001269 behind a 32s runway, so the page position is
    // 36.389605 - 32 = 4.389605. The runway is the WHOLE shift for a Chromecast:
    // its playlist is padded up to the seek target, so that clock already runs on
    // page time and `dashStart` must NOT be added again — doing so publishes
    // `page + dashStart` = 8.390874 here, and roughly twice the real position on
    // a mid-video cast (a cast at 23:51 showed ~47:42).
    check(
        "Chromecast: the runway is removed and the LOAD position restored (36.389605 -> 4.389605)",
        Math.abs(Number(chromecastTime) - 4.389605) < 1e-6,
        JSON.stringify({ published: chromecastTime })
    );
    check(
        "Chromecast: the position is page time, not the padded clock and not the seek target added twice",
        Math.abs(Number(chromecastTime) - 36.389605) > 1 &&
            Math.abs(Number(chromecastTime) - 8.390874) > 1,
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
            contentId:
                "http://10.0.0.111:9555/s/gen-zero-offset/index.m3u8?v=1",
            customData: dashCustomData(436.014207, 0)
        })
    );
    await flush();
    // dashStart 436.014207 with offset 0: this media was loaded without a runway,
    // so its 436.014207 IS page time and nothing may be applied to it. The check
    // rules out both wrong answers at once — the earlier generation's 32 would
    // publish 404.014207, and adding this media's own dashStart would publish
    // 872.028414.
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
            contentId:
                "http://10.0.0.111:9555/s/gen-zero-offset/index.m3u8?v=1",
            customData: dashCustomData(436.014207, 0)
        })
    );
    await flush();
    check(
        "Chromecast mid-video (offset 0): the receiver's own position IS the page position (500.5, not 936.5)",
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
            contentId: "http://10.0.0.111:9555/s/other-gen/index.m3u8?v=9"
        })
    );
    await flush();
    check(
        "Chromecast: a report from an unknown media generation is NOT converted (no guessed shift)",
        modules.deviceManager.getDeviceById(chromecast.id)?.mediaStatus
            ?.currentTime === 500,
        JSON.stringify({
            published: modules.deviceManager.getDeviceById(chromecast.id)
                ?.mediaStatus?.currentTime
        })
    );

    // ---- Roku: page time already, and offset 0 by construction -------------
    const roku = await registerDevice(modules, ROKU);
    setDeviceOffset(modules, roku.id, 0);
    sendMediaStatus(
        modules,
        ROKU,
        makeStatus({
            currentTime: 41.5,
            contentId: "http://10.0.0.111:9555/s/roku-gen/index.m3u8?v=1",
            customData: dashCustomData(40, 0)
        })
    );
    await flush();
    const rokuTime = Number(roku.mediaStatus?.currentTime);
    // Roku reports the same way (remux-relative) with offset 0, so page time is
    // dashStart + raw: 40 + 41.5 = 81.5.
    check(
        "Roku: the page position is dashStart + the reported position (40 + 41.5)",
        Math.abs(rokuTime - 81.5) < 1e-6,
        JSON.stringify({
            published: rokuTime,
            note: "no Roku session media registered here, so it stays as reported"
        })
    );

    // ---- the conversion is idempotent by IDENTITY, never by value -----------
    //
    // A fresh sample whose raw position happens to equal the page value published
    // last is still a raw position: 81.5 here is what the previous report was
    // PUBLISHED as, and it is also a perfectly legal remux-relative position for
    // the next one. A guard that asks "does this equal the page I last published?"
    // cannot tell the two apart and leaves it unconverted — handing the popup a
    // remux-relative number while claiming it is page time.
    sendMediaStatus(
        modules,
        ROKU,
        makeStatus({
            currentTime: 81.5,
            contentId: "http://10.0.0.111:9555/s/roku-gen/index.m3u8?v=1",
            customData: dashCustomData(40, 0)
        }),
        pollProvenance(6, 1_000_000)
    );
    await flush();
    check(
        "Roku: a raw position equal to the last published page is still converted (81.5 -> 121.5)",
        Math.abs(Number(roku.mediaStatus?.currentTime) - 121.5) < 1e-6,
        JSON.stringify({ published: roku.mediaStatus?.currentTime })
    );

    // The guard's own purpose, from the other side: ONE position is converted
    // once, however many times its message is handled. Asserted on a FRESH device
    // whose first report is the one that used to alias the message object, and by
    // dispatching the same message twice on purpose rather than by relying on how
    // many listeners the harness happens to have registered.
    const replayDevice = await registerDevice(modules, {
        id: "roku-replay-test",
        friendlyName: "Roku (replay)",
        modelName: "Roku",
        capabilities: 0,
        host: "127.0.0.1",
        port: 8060,
        deviceType: "roku"
    });
    const replayed = makeStatus({
        currentTime: 84.5,
        contentId: "http://10.0.0.111:9555/s/roku-replay/index.m3u8?v=1",
        customData: dashCustomData(40, 0)
    });
    const replayedProvenance = pollProvenance(1, 2_000_000);
    sendMediaStatus(modules, replayDevice, replayed, replayedProvenance);
    await flush();
    const afterFirstHandling = Number(replayDevice.mediaStatus?.currentTime);
    sendMediaStatus(modules, replayDevice, replayed, replayedProvenance);
    await flush();
    check(
        "the conversion does not write into the message it was given (a replay stays a raw position)",
        replayed.currentTime === 84.5,
        JSON.stringify({ messageCurrentTime: replayed.currentTime })
    );
    check(
        "one message handled twice converts one position once (84.5 -> 124.5 both times)",
        Math.abs(afterFirstHandling - 124.5) < 1e-6 &&
            Math.abs(Number(replayDevice.mediaStatus?.currentTime) - 124.5) <
                1e-6,
        JSON.stringify({
            afterFirstHandling,
            afterSecondHandling: replayDevice.mediaStatus?.currentTime
        })
    );

    // ---- a SEEK RELOAD: the superseded generation's reports ------------------
    //
    // A DASH seek restarts the bridge remux: the sender appends a fresh
    // `?v=<timestamp>` and LOADs a media whose `dashStart` is the new page
    // position (600 here), while the receiver is still playing the PREVIOUS
    // stream (anchor 300) for a beat. Periodic reports about that previous stream
    // carry no customData, so they can only be resolved through the identity map
    // (`mediaSessionId` / contentId) — and the map now holds the NEW generation,
    // because remembering a generation replaces that device's entries.
    //
    // Converting such a report with the new generation's anchor invents a
    // position above both the old and the new one: the old remux clock (100)
    // plus the NEW dashStart (600) publishes 700, which is neither where the
    // receiver is (400) nor where it is going (605). On the popup that is a
    // jump of a whole seek target — the same class of defect as the doubled
    // Chromecast position above, and the reason this test drives the real merge.
    const seekReloadDevice = await registerDevice(modules, {
        ...ROKU,
        id: "roku-seek-reload-test"
    });
    const oldGenerationContentId =
        "http://10.0.0.111:9555/s/roku-seek/index.m3u8?v=1";
    const newGenerationContentId =
        "http://10.0.0.111:9555/s/roku-seek/index.m3u8?v=2";
    // Generation 1: the media the popup is watching, loaded from page 300.
    sendMediaStatus(
        modules,
        seekReloadDevice,
        makeStatus({
            currentTime: 100,
            contentId: oldGenerationContentId,
            customData: dashCustomData(300, 0)
        })
    );
    await flush();
    const beforeSeek = Number(seekReloadDevice.mediaStatus?.currentTime);
    check(
        "seek reload: generation 1 reads on its own anchor (300 + 100)",
        Math.abs(beforeSeek - 400) < 1e-6,
        JSON.stringify({ published: beforeSeek })
    );
    // The seek's own LOAD: page 600, still offset 0.
    sendMediaStatus(
        modules,
        seekReloadDevice,
        makeStatus({
            currentTime: 5,
            contentId: newGenerationContentId,
            customData: dashCustomData(600, 0)
        })
    );
    await flush();
    const afterReload = Number(seekReloadDevice.mediaStatus?.currentTime);
    check(
        "seek reload: generation 2 reads on the NEW anchor (600 + 5)",
        Math.abs(afterReload - 605) < 1e-6,
        JSON.stringify({ published: afterReload })
    );
    // The stale report: the receiver's own bare media snapshot for the stream it
    // is still finishing. Its identity is generation 1's.
    sendMediaStatus(
        modules,
        seekReloadDevice,
        makeStatus({
            currentTime: 100,
            bareMedia: true,
            contentId: oldGenerationContentId
        }),
        pollProvenance(7, 3_000_000)
    );
    await flush();
    const staleReported = Number(seekReloadDevice.mediaStatus?.currentTime);
    check(
        "seek reload: the superseded generation's report is ignored, not converted with the new anchor (605, not 700 nor a bare 100)",
        Math.abs(staleReported - 605) < 1e-6,
        JSON.stringify({
            published: staleReported,
            mergedWithTheNewAnchor: 700,
            theStaleStreamsOwnPosition: 100
        })
    );
    // ...and refusing that report must not wedge the map for the generation that
    // IS current: the next bare report of generation 2 is still converted.
    sendMediaStatus(
        modules,
        seekReloadDevice,
        makeStatus({
            currentTime: 9,
            bareMedia: true,
            contentId: newGenerationContentId
        })
    );
    await flush();
    const currentAfterStale = Number(seekReloadDevice.mediaStatus?.currentTime);
    check(
        "seek reload: the current generation's next bare report is still converted (600 + 9)",
        Math.abs(currentAfterStale - 609) < 1e-6,
        JSON.stringify({ published: currentAfterStale })
    );

    // ---- what counts as EVIDENCE of a new generation ------------------------
    //
    // The gate exists to drop a report about a stream the device has replaced, and
    // it may only fire on evidence: the sender's per-remux marker is `?v=<ts>`,
    // so a contentId carrying ANY OTHER query changed nothing about which stream
    // the receiver is on. A gate that reads "the query changed" as "the generation
    // changed" discards legitimate statuses - the popup then sits on a stale
    // position, which is the symptom the gate was added to prevent.
    const markerDevice = await registerDevice(modules, {
        ...ROKU,
        id: "roku-marker-test"
    });
    const markerBase = "http://10.0.0.111:9555/s/roku-marker/index.m3u8";
    // Generation 1 of this device's stream, loaded from page 300.
    sendMediaStatus(
        modules,
        markerDevice,
        makeStatus({
            currentTime: 100,
            contentId: `${markerBase}?v=1`,
            customData: dashCustomData(300, 0)
        })
    );
    await flush();
    const markerBaseline = Number(markerDevice.mediaStatus?.currentTime);
    /**
     * A bare report (the periodic broadcast shape: identity fields only) whose
     * raw position is 10 on this generation's clock. Converted, it is 300 + 10;
     * dropped as a superseded generation, the published value stays at the
     * baseline - so the two answers are distinguishable, which is what makes
     * these rows say something.
     */
    const markerProbe = async contentId => {
        sendMediaStatus(
            modules,
            markerDevice,
            makeStatus({ currentTime: 10, bareMedia: true, contentId }),
            pollProvenance(9, 4_000_000)
        );
        await flush();
        return Number(markerDevice.mediaStatus?.currentTime);
    };
    check(
        "generation marker: the device's own generation reads on its anchor (300 + 100)",
        Math.abs(markerBaseline - 400) < 1e-6,
        JSON.stringify({ published: markerBaseline })
    );
    check(
        "generation marker: a different `?v=` on the same base IS a different generation (dropped, 400)",
        Math.abs((await markerProbe(`${markerBase}?v=2`)) - 400) < 1e-6,
        JSON.stringify({ published: markerDevice.mediaStatus?.currentTime })
    );
    check(
        "generation marker: a different `?token=` alone is NOT evidence (converted, 310)",
        Math.abs((await markerProbe(`${markerBase}?token=b`)) - 310) < 1e-6,
        JSON.stringify({
            published: markerDevice.mediaStatus?.currentTime,
            note: "a non-generation query says nothing about which stream this is"
        })
    );
    check(
        "generation marker: `?v=1&token=b` is the SAME generation (converted, 310)",
        Math.abs((await markerProbe(`${markerBase}?v=1&token=b`)) - 310) < 1e-6,
        JSON.stringify({ published: markerDevice.mediaStatus?.currentTime })
    );
    check(
        "generation marker: an unmarked id is not evidence either way (converted, 310)",
        Math.abs((await markerProbe(markerBase)) - 310) < 1e-6,
        JSON.stringify({ published: markerDevice.mediaStatus?.currentTime })
    );
    // A different base path is a DIFFERENT media, so it is not a superseded
    // generation of this device's stream: it is published as reported (it has no
    // identity of its own here, and an unattributable position is never guessed
    // at) - where a superseded generation would have left the baseline standing.
    check(
        "generation marker: a different BASE is another media, not a superseded generation (published as reported, 10)",
        Math.abs(
            (await markerProbe(
                "http://10.0.0.111:9555/s/roku-other/index.m3u8?v=9"
            )) - 10
        ) < 1e-6,
        JSON.stringify({
            published: markerDevice.mediaStatus?.currentTime,
            droppedAsSuperseded: 400
        })
    );

    // ---- a receiver relaunch must not look like the end of the cast ---------
    // A Roku DASH remux LOAD relaunches the player app, so the device reports no
    // application for a moment. Treating that as the end tore the media status
    // (the popup's progress bar) down and dropped the transport ownership (Stop
    // back to Cast) mid-seek — observed on-device 2026-09-17 02:17.
    const relaunchDevice = await registerDevice(modules, {
        ...ROKU,
        id: "roku-relaunch-test"
    });
    modules.deviceManager.setRokuSessionMedia(
        relaunchDevice.id,
        "roku-session-test",
        {
            contentId: "http://10.0.0.111:9555/s/relaunch/index.m3u8?v=1",
            duration: 6022,
            customData: {
                dashRemux: true,
                dashStart: 100,
                presentationOffsetSeconds: 0
            }
        }
    );
    await flush();
    // The app must be running first: the grace only applies to an app that
    // DISAPPEARS, which is the relaunch case.
    sendReceiverStatus(modules, relaunchDevice, [
        {
            appId: "CC1AD845",
            isIdleScreen: false,
            transportId: "roku-relaunch-transport"
        }
    ]);
    await flush();
    const beforeAppGone = modules.deviceManager.getDeviceById(relaunchDevice.id)
        ?.mediaStatus?.media?.contentId;
    sendReceiverStatus(modules, relaunchDevice, []);
    await flush();
    check(
        "relaunch: a device that reports no app while a cast is owned keeps its media status",
        modules.deviceManager.getDeviceById(relaunchDevice.id)?.mediaStatus
            ?.media?.contentId === beforeAppGone && beforeAppGone !== undefined,
        JSON.stringify({
            before: beforeAppGone,
            after: modules.deviceManager.getDeviceById(relaunchDevice.id)
                ?.mediaStatus?.media?.contentId
        })
    );
    // ...but a genuinely closed app must still tear down. The window is a
    // constant in the module, so the check is asserted against the real source
    // rather than by waiting 8s.
    const deviceManagerSource = fs.readFileSync(
        path.join(sourceUnderTest, "background/deviceManager.ts"),
        "utf8"
    );
    /**
     * The body of the DASH remux status handler, so a control row can ask what
     * THIS revision's handler does instead of matching a pattern anywhere in the
     * file.
     *
     * The distinction matters: `device.mediaStatus = status;` (writing the
     * message object straight onto the device) also appears in three unrelated
     * branches, so a whole-file match claimed the mutation defect for a revision
     * that had already fixed it — the control then reported a defect whose rows
     * passed, which is a false alarm rather than a caught regression.
     */
    const statusHandlerSource = (() => {
        const start = deviceManagerSource.indexOf(
            'case "main:receiverDeviceMediaStatusUpdated"'
        );
        if (start < 0) return "";
        const next = deviceManagerSource.indexOf('case "', start + 10);
        return deviceManagerSource.slice(
            start,
            next < 0 ? deviceManagerSource.length : next
        );
    })();

    /** Does this revision decide the conversion by value (the guard this test
     *  replaces)? Source, not behavior: a pre-fix revision that lacks the guard
     *  entirely must not be required to fail its row. */
    const versionHasValueGuard =
        /dashLastConversion/.test(deviceManagerSource) &&
        /lastConversion\.page/.test(deviceManagerSource);
    check(
        "relaunch: the hold is bounded (an app that stays gone still tears down)",
        /RECEIVER_APP_GONE_GRACE_MS = \d+;/.test(deviceManagerSource) &&
            Number(
                /RECEIVER_APP_GONE_GRACE_MS = (\d+);/.exec(
                    deviceManagerSource
                )?.[1]
            ) >= 4000,
        "the relaunch hold has no bound"
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
        // The control is CAPABILITY-based, because the rows below were written
        // for defects that landed in different revisions: whatever this revision
        // actually carries must fail the row that exists for it, and a row for a
        // defect it does not carry must not be required to fail. Read from the
        // revision's own source, so the control says which defects it found
        // instead of assuming one revision's shape.
        const defects = [
            {
                id: "one anchor for both receiver families",
                present:
                    /Math\.max\(0, dashStart \+ raw - presentationOffset\)/.test(
                        deviceManagerSource
                    ),
                rows: /runway is removed|position is page time/,
                least: 2
            },
            {
                id: "the value-based already-converted guard",
                present: /dashLastConversion/.test(deviceManagerSource),
                rows: /equal to the last published page/,
                least: 1
            },
            {
                // The defect this stage's last rows were written for: the map and
                // the metadata merge both matched a report to a generation by its
                // BASE contentId, so the `?v=` marker that distinguishes one remux
                // from the next was discarded exactly where it was needed.
                id: "a superseded generation matched by base id alone",
                present: !/differentDashGeneration/.test(deviceManagerSource),
                rows: /superseded generation's report is ignored/,
                least: 1
            },
            {
                // ...and its mirror: reading "the query changed" as "the
                // generation changed", which drops legitimate reports over a
                // parameter that says nothing about the stream.
                id: "any query read as a generation marker",
                present: !/dashGenerationMarker/.test(deviceManagerSource),
                rows: /NOT evidence|SAME generation/,
                least: 2
            },
            {
                id: "the conversion writes into the message object",
                present:
                    statusHandlerSource !== "" &&
                    !/device\.mediaStatus = \{ \.\.\.status \};/.test(
                        statusHandlerSource
                    ),
                // Only the mutation row: a revision with this defect and an
                // already-converted guard still reads the same page value on a
                // replay, which is precisely why that guard looked sufficient.
                rows: /does not write into the message/,
                least: 1
            }
        ].filter(defect => defect.present);
        const missing = defects.filter(
            defect =>
                failures.filter(name => defect.rows.test(name)).length <
                defect.least
        );
        console.info(
            `revision control (${REV}): carries ${defects.length} defect(s)` +
                (defects.length
                    ? ` [${defects.map(d => d.id).join("; ")}]`
                    : " [none]")
        );
        for (const name of failures) console.info("  - " + name);
        if (defects.length === 0) {
            console.error(
                `dashStatusPipeline: --pre-fix ${REV} carries none of the defects these rows exist for; nothing was controlled`
            );
            process.exitCode = 1;
        } else if (missing.length) {
            console.error(
                `dashStatusPipeline: --pre-fix ${REV} did not fail the rows for: ${missing
                    .map(d => d.id)
                    .join("; ")}`
            );
            process.exitCode = 1;
        } else {
            console.info(
                `every defect this revision carries failed its own row (${fail} check(s) failed)`
            );
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
