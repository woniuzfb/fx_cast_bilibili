#!/usr/bin/env node
"use strict";

/**
 * Time-domain audit: the padded presentation clock must never be used as a page
 * position, and vice versa.
 *
 * There are two clocks in a Bilibili DASH cast:
 *
 *   page clock         the page player's own timeline. AUTHORITATIVE for
 *                      positions: every seek target, every write to the page
 *                      element, every controller command.
 *   presentation clock the receiver's clock over the generated playlist, which
 *                      is `page + presentationOffset` (the pad runway).
 *
 * The mapping (`page = presentation - offset`) belongs at the boundary between
 * them and nowhere else: the sender's receiver->page conversion, the background's
 * `deviceManager` status publish, and the LOAD position the sender computes. This
 * audit drives the real sender and records every value that crosses, so a leak
 * shows up as a number in the wrong domain instead of as a symptom.
 *
 * Usage:
 *   node test/senders/timeDomainAudit.js
 *   node test/senders/timeDomainAudit.js --pre-fix   # control, from --rev (HEAD)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

const argv = process.argv.slice(2);
const PRE_FIX = argv.includes("--pre-fix");
const revIndex = argv.indexOf("--rev");
const REV =
    revIndex >= 0 && argv[revIndex + 1] ? argv[revIndex + 1] : "HEAD";

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

const PlayerState = {
    IDLE: "IDLE",
    PLAYING: "PLAYING",
    PAUSED: "PAUSED",
    BUFFERING: "BUFFERING"
};

function resolveSendersDir() {
    if (!PRE_FIX) return path.join(repoRoot, "extension/src/cast/senders");
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-domain-"));
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
    return path.join(worktree, "extension/src/cast/senders");
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

const timers = { timeouts: [] };
let timerId = 0;
let latestInterval;
const noop = () => {};

function installGlobals() {
    global.window = {
        location: {
            protocol: "moz-extension:",
            href: "moz-extension://test/sender.html"
        },
        setInterval: fn => {
            latestInterval = fn;
            return ++timerId;
        },
        clearInterval: noop,
        setTimeout: (fn, ms) => {
            const id = ++timerId;
            timers.timeouts.push({ id, fn, ms, cleared: false });
            return id;
        },
        clearTimeout: id => {
            const entry = timers.timeouts.find(item => item.id === id);
            if (entry) entry.cleared = true;
        },
        addEventListener: noop,
        removeEventListener: noop
    };
    global.HTMLMediaElement = class HTMLMediaElement {};
    global.HTMLVideoElement = class HTMLVideoElement extends (
        global.HTMLMediaElement
    ) {};
    global.HTMLImageElement = class HTMLImageElement {};
    global.document = {
        addEventListener: noop,
        removeEventListener: noop,
        querySelector: () => null,
        querySelectorAll: () => []
    };
    global.browser = {
        storage: {
            sync: {
                get: async () => ({
                    options: {
                        mediaSyncElement: true,
                        mediaStopOnUnload: true,
                        localMediaEnabled: true,
                        localMediaServerPort: 9555,
                        cctvDebugEnabled: false,
                        rokuTranscodePreset: "veryfast",
                        chromecastDashStartupPadding: true
                    }
                })
            }
        },
        runtime: {
            sendMessage: async () => undefined,
            onMessage: { addListener: noop, removeListener: noop },
            getPlatformInfo: async () => ({ os: "mac" })
        },
        i18n: { getMessage: key => key },
        tabs: { get: async () => undefined },
        menus: { getTargetElement: () => undefined }
    };
}

const flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
};

/** Every value that crossed a domain boundary, in order. */
const crossings = [];
const record = (boundary, domain, value, extra = {}) => {
    crossings.push({ boundary, domain, value: Number(value), ...extra });
};

/**
 * A page element whose reads and writes are recorded, so a padded value written
 * INTO the page (or read out of it as a seek target) is visible.
 */
function makeElement({ paused, currentTime, metrics }) {
    const listeners = new Map();
    const element = new global.HTMLMediaElement();
    let time = currentTime;
    element.paused = paused;
    element.duration = 600;
    element.muted = false;
    element.textTracks = [];
    Object.defineProperty(element, "currentTime", {
        get() {
            record("page-element-read", "page", time);
            return time;
        },
        set(value) {
            record("page-element-write", "page", value, {
                stack: new Error().stack.split("\n")[2]?.trim()
            });
            metrics.writes.push(value);
            time = value;
        }
    });
    element.addEventListener = (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
    };
    element.removeEventListener = (type, fn) => {
        const list = listeners.get(type);
        if (!list) return;
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
    };
    const emit = (type, detail) => {
        for (const fn of (listeners.get(type) ?? []).slice()) fn(detail);
    };
    element.play = () => {
        metrics.plays++;
        element.paused = false;
        emit("play");
        return Promise.resolve();
    };
    element.pause = () => {
        metrics.pauses++;
        element.paused = true;
        emit("pause");
    };
    element.emit = emit;
    return element;
}

function makeMedia(playerState, estimatedTime, mediaSessionId) {
    const calls = { play: 0, pause: 0, seek: 0 };
    return {
        playerState,
        idleReason: undefined,
        mediaSessionId,
        currentTime: estimatedTime,
        getEstimatedTime: () => estimatedTime,
        addUpdateListener: noop,
        removeUpdateListener: noop,
        play: () => {
            calls.play++;
            return Promise.resolve();
        },
        pause: () => {
            calls.pause++;
            return Promise.resolve();
        },
        seek: request => {
            calls.seek++;
            record("receiver-seek-request", "receiver", request?.currentTime);
        },
        calls
    };
}

async function build(sendersDir) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-domain-"));
    const entry = path.join(workDir, "entry.ts");
    const outfile = path.join(workDir, "sender.cjs");
    const stubDir = path.join(workDir, "stub");
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(
        path.join(stubDir, "exportStub.js"),
        `"use strict";
const noop = () => {};
const PlayerState = { IDLE: "IDLE", PLAYING: "PLAYING", PAUSED: "PAUSED", BUFFERING: "BUFFERING" };
const IdleReason = { ERROR: "ERROR" };
class MediaInfo { constructor(url, type) { this.url = url; this.contentType = type; this.tracks = []; this.metadata = new GenericMediaMetadata(); } }
class GenericMediaMetadata {}
class LoadRequest { constructor(media) { this.media = media; this.autoplay = false; this.currentTime = 0; this.activeTrackIds = []; } }
class SeekRequest { constructor() { this.currentTime = 0; } }
class Track { constructor(id, type) { this.trackId = id; this.trackType = type; } }
class Image { constructor(url) { this.url = url; } }
const media = {
    PlayerState, IdleReason, DEFAULT: "DEFAULT", DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845",
    MediaInfo, GenericMediaMetadata, LoadRequest, SeekRequest, Track, Image,
    TrackType: { TEXT: "TEXT" }, TextTrackType: { SUBTITLES: "SUBTITLES" },
    StreamType: { BUFFERED: "BUFFERED", LIVE: "LIVE", OTHER: "OTHER" }
};
const cast = {
    media,
    Capability: { VIDEO_OUT: "VIDEO_OUT", VIDEO_IN: "VIDEO_IN", AUDIO_OUT: "AUDIO_OUT", AUDIO_IN: "AUDIO_IN" },
    ReceiverAvailability: { AVAILABLE: "AVAILABLE", UNAVAILABLE: "UNAVAILABLE" },
    ReceiverAction: { CAST: "CAST", STOP: "STOP" },
    AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: "TAB_AND_ORIGIN_SCOPED" },
    ApiConfig: class {}, SessionRequest: class {}, Image,
    addReceiverActionListener: noop, removeReceiverActionListener: noop,
    initialize: noop, requestSession: noop
};
async function ensureInit() {
    const listeners = [];
    const port = {
        addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
        removeEventListener: (t, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
        start: noop,
        disconnect: noop,
        postMessage: m => { if (global.__onCastPortMessage) global.__onCastPortMessage(m); }
    };
    global.__castPortDispatch = m => listeners.slice().forEach(fn => fn({ data: m }));
    return port;
}
module.exports = cast;
module.exports.default = cast;
module.exports.ensureInit = ensureInit;
`
    );
    fs.writeFileSync(
        entry,
        `import MediaSender from ${JSON.stringify(
            path.join(sendersDir, "media.ts")
        )};\n` +
            `import { createDashPresentation, identityPresentation, bindPresentationMedia } from ${JSON.stringify(
                path.join(sendersDir, "../dashPresentation.ts")
            )};\n` +
            `export { MediaSender, createDashPresentation, identityPresentation, bindPresentationMedia };\n`
    );
    const esbuild = require(esbuildPath);
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
        },
        plugins: [
            {
                name: "stub-cast-sdk",
                setup(build) {
                    build.onResolve({ filter: /^\.\.\/export$/ }, () => ({
                        path: path.join(stubDir, "exportStub.js")
                    }));
                    build.onResolve({ filter: /^\.\.?\// }, async args => {
                        if (!args.importer.startsWith(sendersDir)) {
                            return undefined;
                        }
                        const resolved = await build.resolve(args.path, {
                            resolveDir: sendersDir,
                            kind: args.kind
                        });
                        if (resolved.errors.length) {
                            return { errors: resolved.errors };
                        }
                        return { path: resolved.path };
                    });
                }
            }
        ]
    });
    return { ...require(outfile), workDir };
}

/**
 * A DASH remux sender where the receiver is on the PADDED clock: the page is at
 * `pageStart`, the presentation offset is 32, and the receiver reports
 * `page + 32` — the exact split that has been leaking.
 */
async function makeSender(MediaSender, { pageStart = 400, offset = 32 } = {}) {
    const metrics = { plays: 0, pauses: 0, writes: [] };
    const element = makeElement({
        paused: false,
        currentTime: pageStart,
        metrics
    });
    const sender = new MediaSender({
        mediaUrl: "https://example.invalid/video.m4s",
        mediaElement: element,
        mediaContentType: "application/x-mpegURL",
        mediaTitle: "harness",
        isVideo: true,
        remoteProxy: {
            referer: "https://www.bilibili.com/video/BVtest",
            audioUrl: "https://example.invalid/audio.m4s"
        },
        gestureGatedControls: true,
        debug: noop
    });
    const state = { media: [], loadRequests: [] };
    sender.session = {
        receiver: { label: "Chromecast-HARNESS" },
        get media() {
            return state.media;
        },
        set media(value) {
            state.media = value;
        },
        loadMedia: (request, onSuccess, onError) => {
            record("load-request", "page", request.currentTime);
            state.loadRequests.push({
                request,
                onSuccess,
                onError,
                media: makeMedia(
                    PlayerState.PLAYING,
                    pageStart + offset,
                    9
                )
            });
        },
        addUpdateListener: noop,
        removeUpdateListener: noop,
        sendMessage: (...args) =>
            record("receiver-message", "receiver", 0, { type: args[0] })
    };
    state.media = [makeMedia(PlayerState.PLAYING, pageStart + offset, 9)];
    latestInterval = undefined;
    sender.addMediaElementListeners(element);
    const startedMediaServers = [];
    global.__onCastPortMessage = message => {
        if (message?.subject === "bridge:startRemoteMediaServer") {
            startedMediaServers.push(message.data);
        }
    };
    await flush();
    return {
        sender,
        element,
        metrics,
        loadRequests: state.loadRequests,
        startedMediaServers,
        tick: () => latestInterval && latestInterval()
    };
}

/** The LOAD the sender computes, on the presentation timeline. */
function dashReply(startTime, offset) {
    return {
        startTime,
        probedKeyframeSeconds: startTime,
        padBaseSeconds: startTime + offset,
        presentationStartTime: startTime + offset
    };
}

async function main() {
    installGlobals();
    const {
        MediaSender,
        createDashPresentation,
        identityPresentation,
        bindPresentationMedia,
        workDir
    } = await build(resolveSendersDir());
    console.info(
        `time-domain audit (${PRE_FIX ? `revision ${REV}` : "working tree"})`
    );

    // ---- 1. the LOAD position is a deliberate crossing ---------------------
    const a = await makeSender(MediaSender, { pageStart: 400, offset: 32 });
    a.sender.loadMedia().catch(() => undefined);
    await flush();
    const started = a.startedMediaServers.at(-1);
    a.sender.session && (await flush());
    global.__castPortDispatch({
        subject: "mediaCast:mediaServerStarted",
        data: {
            requestId: started.requestId,
            mediaPath: "index.m3u8",
            localAddress: "127.0.0.1",
            mode: "dash-remux",
            ...dashReply(400, 32)
        }
    });
    await flush();
    const load = a.loadRequests.at(-1);
    check(
        "load: the receiver is loaded at page + offset (the one intended crossing)",
        Math.abs(Number(load.request.currentTime) - 432) < 1e-6,
        JSON.stringify({ loaded: load.request.currentTime })
    );

    // ---- 2. the receiver -> page conversion -------------------------------
    // The receiver reports the padded clock; the page must not be dragged onto it.
    a.tick();
    await flush();
    const pageWrites = a.metrics.writes.filter(value => value > 0);
    check(
        "receiver->page: a padded position is never written onto the page element",
        pageWrites.every(value => Math.abs(value - 432) > 1),
        JSON.stringify({ writes: a.metrics.writes })
    );

    // ---- 3. a page seek target stays in the page domain --------------------
    const b = await makeSender(MediaSender, { pageStart: 10.882462, offset: 22 });
    const startsBefore = b.startedMediaServers.length;
    b.sender.seekDashRemux(10.882462);
    await flush();
    for (const entry of timers.timeouts.filter(t => !t.cleared)) {
        entry.cleared = true;
        entry.fn();
    }
    await flush();
    const restart = b.startedMediaServers.at(-1);
    check(
        "page->remux: the restart position is the page target, not a padded one",
        b.startedMediaServers.length > startsBefore &&
            Math.abs(Number(restart.startTime) - 10.882462) < 1e-6,
        JSON.stringify({
            before: startsBefore,
            after: b.startedMediaServers.length,
            startTime: restart?.startTime
        })
    );

    // ---- 4. a popup PAUSE must not carry a position -------------------------
    // The popup's play/pause command has no position. What it must never do is
    // arrive at the remux as a seek, which is how a pause click reloaded the
    // receiver: the page's own re-seek inside the transition was forwarded.
    const c = await makeSender(MediaSender, { pageStart: 10.882462, offset: 22 });
    const cStarts = c.startedMediaServers.length;
    const accepted = c.sender.controlPlayback({ intent: "PAUSE", id: "cmd-1" });
    await flush();
    for (const entry of timers.timeouts.filter(t => !t.cleared)) {
        entry.cleared = true;
        entry.fn();
    }
    await flush();
    check(
        "pause: no crossing produced a remux restart",
        c.startedMediaServers.length === cStarts,
        JSON.stringify({
            accepted,
            before: cStarts,
            after: c.startedMediaServers.length
        })
    );
    const writerCrossings = crossings.filter(
        entry =>
            entry.boundary === "page-element-write" &&
            entry.value > 100 &&
            entry.value < 900
    );
    check(
        "page writes: no crossing wrote a padded (page + offset) position onto the page",
        writerCrossings.length === 0,
        JSON.stringify(writerCrossings.slice(0, 4))
    );

    // ---- 5. the crossing is scoped to a MEDIA GENERATION, by identity -------
    //
    // The offset is no longer a mutable number on the sender that a test (or,
    // in production, a later load) can overwrite: it is an adapter built from
    // one bridge reply and it answers only for the media of that generation. The
    // two behaviours below are the reason: an adapter with nothing established
    // must degrade to the identity rather than invent a subtraction, and an
    // adapter asked about FOREIGN media must refuse rather than apply its own
    // shift — the latter being the leak that moved the page by a whole runway.
    const own = createDashPresentation({
        generationId: "own",
        pageStart: 5,
        receiverStart: 37
    });
    bindPresentationMedia(own, { contentId: "own-media", mediaSessionId: 11 });

    const notEstablished = identityPresentation("no-bridge-reply");
    check(
        "isolation: with no established offset the crossing is the identity (no invented subtraction)",
        notEstablished.receiverToPage(37) === 37,
        JSON.stringify({ converted: notEstablished.receiverToPage(37) })
    );
    check(
        "isolation: an established generation subtracts exactly its own shift",
        own.receiverToPage(37) === 5,
        JSON.stringify({ converted: own.receiverToPage(37) })
    );
    check(
        "isolation: a foreign media is REFUSED instead of converted with this generation's shift",
        own.describes({ contentId: "some-other-media", mediaSessionId: 99 }) ===
            false,
        JSON.stringify({
            describes: own.describes({
                contentId: "some-other-media",
                mediaSessionId: 99
            })
        })
    );
    check(
        "isolation: the generation's own media is described (so the check cannot be vacuous)",
        own.describes({ contentId: "own-media?v=2", mediaSessionId: 11 }) ===
            true,
        JSON.stringify({
            describes: own.describes({ contentId: "own-media?v=2" })
        })
    );

    console.info("");
    if (PRE_FIX) {
        const expected = failures.filter(name => /remux restart|padded/.test(name));
        if (expected.length === 0) {
            console.error(
                `timeDomainAudit: --pre-fix expected a leak at ${REV}, saw none`
            );
            process.exitCode = 1;
        } else {
            console.info(
                `revision control (${REV}): ${fail} check(s) failed, including ${expected.length} expected`
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
    console.error("timeDomainAudit ERROR", err);
    process.exitCode = 1;
});
