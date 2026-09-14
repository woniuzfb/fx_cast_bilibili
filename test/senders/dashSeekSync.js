#!/usr/bin/env node
"use strict";

/**
 * DASH seek source-priming behaviour test (Bilibili on a Roku).
 *
 * The defect this freezes: after the popup seeks, the receiver's own PAUSED
 * state (the pause our own seek start issued, echoed by the OLD media session
 * while the new capture generation is being built) is mirrored onto the page
 * every 500ms sync tick. The page is the source of the capture feed, so the
 * page stalls exactly while the bridge needs it - the page only starts playing
 * again once the receiver reports PLAYING, which is why the Roku runs ahead of
 * the Bilibili page after a seek.
 *
 * Like pauseSync.js this drives the REAL bundled sender with the cast SDK and
 * the DOM stubbed. The receiver side is stubbed by a CastPort that speaks the
 * production protocol: the test captures the `bridge:startRemoteMediaServer`
 * requestId, answers with `mediaCast:mediaServerStarted` for the SAME id, lets
 * the production code create `activeMediaServerRequestId` and
 * `capturePrimeTarget`, and only then calls `primeCaptureSource(requestId)`
 * (what `bilibili:pageCaptureReady` does in a real page). No private field is
 * written to build state, and the source is never patched: whatever the states
 * under test mean comes from the production code paths themselves.
 *
 * Usage:
 *   node test/senders/dashSeekSync.js --fixed     # the post-fix contract (wired into test:senders)
 *   node test/senders/dashSeekSync.js             # pre-fix reproduction: the Gap, kept as the
 *                                                 # negative control - it fails on B once the
 *                                                 # seek-scoped priming is in place
 *
 * Cases:
 *   A seek-start-pause                        (shared fact, both modes)
 *   B primed-paused-gap                       (the frozen Gap / the Fixed flip)
 *   C buffering-recovers-page                 (health, both modes)
 *   D new-media-playing-releases              (health, both modes)
 *   E deadline-restores-receiver-authority    (behaviour only - no millisecond value)
 *   F initial-cast-does-not-prime-seek-state  (seek-scoped boundary)
 *
 * Boundary: decision-level evidence. It proves which branch the sender takes
 * and what it does to the page player; it observes no real page, no real CDN
 * and no real Roku. Capture backlog / captureOverflow and the receiver-side
 * timing after a seek need a real page + real session run.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const sendersDir = path.join(repoRoot, "extension/src/cast/senders");
const mediaSource = path.join(sendersDir, "media.ts");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

const FIXED = process.argv.slice(2).includes("--fixed");

let pass = 0;
let fail = 0;
const failures = [];
const skipped = [];
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
const skip = (name, why) => {
    skipped.push(name);
    console.info("  skip " + name + " :: " + why);
};

const PlayerState = {
    IDLE: "IDLE",
    PLAYING: "PLAYING",
    PAUSED: "PAUSED",
    BUFFERING: "BUFFERING"
};

const noop = () => {};

// ---------------------------------------------------------------------------
// Bundling (same shape as pauseSync.js: real source, cast SDK stubbed)
// ---------------------------------------------------------------------------

async function bundle({ source, outfile, stubDir, workDir }) {
    const esbuild = require(esbuildPath).build
        ? require(esbuildPath)
        : require(esbuildPath).default;
    const entry = path.join(workDir, "entry.js");
    fs.writeFileSync(
        entry,
        `import MediaSender from ${JSON.stringify(
            source
        )};\nexport { MediaSender };\n`
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
}

/**
 * The cast SDK stub. `ensureInit()` hands the sender a live CastPort so the
 * test can observe `bridge:*` messages and answer them (the production request
 * identity is created by the sender, never by the test).
 */
function writeStub(stubDir) {
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(
        path.join(stubDir, "exportStub.js"),
        `"use strict";
const noop = () => {};
const PlayerState = { IDLE: "IDLE", PLAYING: "PLAYING", PAUSED: "PAUSED", BUFFERING: "BUFFERING" };
const IdleReason = { CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED", FINISHED: "FINISHED", ERROR: "ERROR" };
class MediaInfo {
    constructor(url, contentType) { this.url = url; this.contentType = contentType; this.tracks = []; this.metadata = new GenericMediaMetadata(); }
}
class GenericMediaMetadata {}
class LoadRequest { constructor(media) { this.media = media; this.autoplay = false; this.currentTime = 0; this.activeTrackIds = []; } }
class SeekRequest { constructor() { this.currentTime = 0; this.resumeState = undefined; } }
class Track { constructor(id, type) { this.trackId = id; this.trackType = type; } }
class Image { constructor(url) { this.url = url; } }
const media = {
    PlayerState,
    IdleReason,
    DEFAULT: "DEFAULT",
    DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845",
    MediaInfo,
    GenericMediaMetadata,
    LoadRequest,
    SeekRequest,
    Track,
    Image,
    TrackType: { TEXT: "TEXT", AUDIO: "AUDIO", VIDEO: "VIDEO" },
    TextTrackType: { SUBTITLES: "SUBTITLES", CAPTIONS: "CAPTIONS", DESCRIPTIONS: "DESCRIPTIONS", CHAPTERS: "CHAPTERS", METADATA: "METADATA" },
    StreamType: { BUFFERED: "BUFFERED", LIVE: "LIVE", OTHER: "OTHER" }
};
const cast = {
    media,
    Capability: { VIDEO_OUT: "VIDEO_OUT", VIDEO_IN: "VIDEO_IN", AUDIO_OUT: "AUDIO_OUT", AUDIO_IN: "AUDIO_IN" },
    ReceiverAvailability: { AVAILABLE: "AVAILABLE", UNAVAILABLE: "UNAVAILABLE" },
    ReceiverAction: { CAST: "CAST", STOP: "STOP" },
    AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: "TAB_AND_ORIGIN_SCOPED", ORIGIN_SCOPED: "ORIGIN_SCOPED", PAGE_SCOPED: "PAGE_SCOPED" },
    ApiConfig: class { constructor(sessionRequest, sessionListener, receiverListener, autoJoinPolicy) { Object.assign(this, { sessionRequest, sessionListener, receiverListener, autoJoinPolicy }); } },
    SessionRequest: class { constructor(appId, capabilities) { Object.assign(this, { appId, capabilities }); } },
    Image,
    addReceiverActionListener: noop,
    removeReceiverActionListener: noop,
    initialize: noop,
    requestSession: noop
};
async function ensureInit() {
    const listeners = [];
    const port = {
        addEventListener: (type, fn) => {
            if (type === "message") listeners.push(fn);
        },
        removeEventListener: (type, fn) => {
            const index = listeners.indexOf(fn);
            if (index >= 0) listeners.splice(index, 1);
        },
        start: noop,
        disconnect: noop,
        postMessage: message => {
            if (global.__onCastPortMessage) global.__onCastPortMessage(message);
        }
    };
    global.__castPort = port;
    global.__castPortDispatch = message => {
        listeners.slice().forEach(fn => fn({ data: message }));
    };
    return port;
}
module.exports = cast;
module.exports.default = cast;
module.exports.ensureInit = ensureInit;
`
    );
}

// ---------------------------------------------------------------------------
// Globals: DOM + browser + a controllable clock and timer queue
// ---------------------------------------------------------------------------

const timers = { timeouts: [], intervals: [] };
let timerId = 0;
let latestInterval;

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
        clearInterval: () => {},
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
    // The sender reads a few options through browser.storage.sync.
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
                        rokuTranscodePreset: "veryfast"
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

/** Fire the pending, uncleared timers registered for exactly `ms`. */
function fireTimeout(ms) {
    const due = timers.timeouts.filter(
        entry => !entry.cleared && entry.ms === ms
    );
    for (const entry of due) {
        entry.cleared = true;
        entry.fn();
    }
    return due.length;
}

const flush = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};

// ---------------------------------------------------------------------------
// Sender fixture
// ---------------------------------------------------------------------------

function makeElement({ paused, currentTime = 0 }) {
    const calls = { play: 0, pause: 0 };
    const element = new global.HTMLMediaElement();
    element.paused = paused;
    element.currentTime = currentTime;
    element.duration = 300;
    element.muted = false;
    element.textTracks = [];
    element.play = () => {
        calls.play++;
        element.paused = false;
        return Promise.resolve();
    };
    element.pause = () => {
        calls.pause++;
        element.paused = true;
    };
    element.addEventListener = noop;
    element.removeEventListener = noop;
    element.calls = calls;
    return element;
}

function makeMedia(playerState, estimatedTime, mediaSessionId) {
    const calls = { pause: 0, play: 0, seek: 0 };
    return {
        playerState,
        idleReason: undefined,
        mediaSessionId,
        currentTime: estimatedTime,
        getEstimatedTime: () => estimatedTime,
        addUpdateListener: noop,
        removeUpdateListener: noop,
        pause: () => {
            calls.pause++;
            return Promise.resolve();
        },
        play: () => {
            calls.play++;
            return Promise.resolve();
        },
        seek: () => {
            calls.seek++;
        },
        calls
    };
}

/**
 * A sender wired so the production protocol can be driven end to end:
 * the 500ms sync tick is fired directly, the CastPort is live.
 */
async function makeSender(MediaSender, opts = {}) {
    const element = makeElement({
        paused: opts.pagePaused ?? false,
        currentTime: opts.pageTime ?? 0
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
    sender.setPreserveSourcePlayback(true);

    // Session state lives in the fixture, not on the sender: the sender reads
    // `session.media` on every tick, so the test can swap the receiver's media.
    const sessionState = { media: [], loadRequests: [] };
    const portMessages = [];
    sender.session = {
        receiver: { label: "roku-HARNESS0001" },
        get media() {
            return sessionState.media;
        },
        set media(value) {
            sessionState.media = value;
        },
        loadMedia: (request, onSuccess, onError) => {
            sessionState.loadRequests.push({
                request,
                onSuccess,
                onError,
                media: makeMedia(PlayerState.PLAYING, 0, 2)
            });
        },
        addUpdateListener: noop,
        removeUpdateListener: noop,
        sendMessage: (...args) => portMessages.push({ subject: args[0], args })
    };

    latestInterval = undefined;
    sender.addMediaElementListeners(element);

    const state = {
        sender,
        element,
        portMessages,
        /** Every bridge:startRemoteMediaServer the sender posted. */
        startedMediaServers: [],
        /** The 500ms reconciliation tick. */
        tick: () => latestInterval && latestInterval(),
        /** Swap in a receiver media session; returns it for call assertions. */
        setReceiverState: (
            playerState,
            estimatedTime = 0,
            mediaSessionId = 1
        ) => {
            const media = makeMedia(playerState, estimatedTime, mediaSessionId);
            sessionState.media = [media];
            return media;
        },
        /** Answer a posted request as the bridge would. */
        answerMediaServerStarted: (requestId, extra = {}) => {
            global.__castPortDispatch({
                subject: "mediaCast:mediaServerStarted",
                data: {
                    requestId,
                    mediaPath: "index.m3u8",
                    localAddress: "127.0.0.1",
                    mode: "dash-remux",
                    startTime: 0,
                    pageDuration: 300,
                    ...extra
                }
            });
        },
        /** Invoke the session load callback for the latest load request. */
        resolveLoad: () => {
            const entry =
                sessionState.loadRequests[sessionState.loadRequests.length - 1];
            if (!entry) return false;
            entry.onSuccess(entry.media);
            return true;
        }
    };

    global.__onCastPortMessage = message => {
        portMessages.push(message);
        if (message?.subject === "bridge:startRemoteMediaServer") {
            state.startedMediaServers.push(message.data);
        }
    };
    // Let init() finish: it installs the CastPort and reads the options the
    // load path depends on (syncElementEnabled).
    await flush();
    return state;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** A: the seek start pauses the receiver; only the next tick pauses the page. */
async function runSeekStartPause(MediaSender) {
    const h = await makeSender(MediaSender, {
        pagePaused: false,
        pageTime: 10
    });
    const receiverMedia = h.setReceiverState(PlayerState.PLAYING, 10);
    h.tick();

    h.sender.seekDashRemux(50);
    check(
        "A: the seek start pauses the receiver exactly once (the hold the user asked for)",
        receiverMedia.calls.pause === 1,
        JSON.stringify({ receiverPause: receiverMedia.calls.pause })
    );
    check(
        "A: the seek start does NOT touch the page player (the page is primed later, after the new capture port listens)",
        h.element.calls.pause === 0 && h.element.paused === false,
        JSON.stringify({
            pagePause: h.element.calls.pause,
            paused: h.element.paused
        })
    );

    // The page pause comes from the receiver-state mirror on the next real tick.
    h.setReceiverState(PlayerState.PAUSED, 10);
    h.tick();
    check(
        "A: the following PAUSED sync tick pauses the page once (receiver -> page mirror)",
        h.element.paused === true && h.element.calls.pause === 1,
        JSON.stringify(h.element.calls)
    );
}

/**
 * Shared fixture for B-F: a real seek through the production protocol.
 * Returns the harness plus the requestId the production code created.
 */
async function seekAndPrime(MediaSender, target = 50) {
    const h = await makeSender(MediaSender, {
        pagePaused: false,
        pageTime: 10
    });
    h.setReceiverState(PlayerState.PLAYING, 10);
    h.tick();

    // Seek start: the receiver holds, and the receiver's own PAUSED reaches the
    // page on the next tick. This stage is accepted behaviour (see case A) and
    // is what the primed page has to recover from.
    h.sender.seekDashRemux(target);
    h.setReceiverState(PlayerState.PAUSED, 10, 1);
    h.tick();
    fireTimeout(800); // DASH_SEEK_DEBOUNCE_MS
    await flush();

    const started = h.startedMediaServers[h.startedMediaServers.length - 1];
    if (!started) return { h, requestId: undefined };

    // A real page: the capture port is listening before the bridge reports ready.
    h.sender.primeCaptureSource(started.requestId);
    await flush();
    h.answerMediaServerStarted(started.requestId, { startTime: target });
    await flush();
    h.resolveLoad();
    await flush();
    return { h, requestId: started.requestId, target };
}

/** B: the core gap - the old receiver's PAUSED must not stall the primed page. */
async function runPrimedPausedGap(MediaSender) {
    const { h, requestId, target } = await seekAndPrime(MediaSender);
    check(
        "B: the production request id, active request and capture target were built by the sender itself",
        typeof requestId === "string" &&
            h.sender.activeMediaServerRequestId === requestId,
        JSON.stringify({
            requestId,
            active: h.sender.activeMediaServerRequestId
        })
    );
    check(
        "B: priming seeks the page to the target and the page plays",
        h.element.currentTime === target &&
            h.element.paused === false &&
            h.element.calls.play >= 1,
        JSON.stringify({
            pageTime: h.element.currentTime,
            paused: h.element.paused,
            calls: h.element.calls
        })
    );

    // The OLD media session is still bound while the receiver loads the new one.
    const before = h.element.calls.pause;
    h.setReceiverState(PlayerState.PAUSED, target, 1);
    h.tick();
    const pausedAgain =
        h.element.paused === true && h.element.calls.pause > before;

    if (FIXED) {
        check(
            "B: after the new DASH capture generation was primed, the old receiver PAUSED state no longer stopped the Bilibili source",
            !pausedAgain,
            JSON.stringify({
                paused: h.element.paused,
                calls: h.element.calls
            })
        );
    } else {
        check(
            "B: after the new DASH capture generation was primed, the old receiver PAUSED state stopped the Bilibili source again (frozen Gap)",
            pausedAgain,
            JSON.stringify({
                paused: h.element.paused,
                calls: h.element.calls
            })
        );
    }
}

/** C: BUFFERING must keep using the existing resumePage() self-heal. */
async function runBufferingRecoversPage(MediaSender) {
    const { h } = await seekAndPrime(MediaSender);
    h.element.pause(); // the page stalls for any reason
    const before = h.element.calls.play;
    h.setReceiverState(PlayerState.BUFFERING, 50, 1);
    h.tick();
    check(
        "C: BUFFERING still resumes a stalled page (the source-watermark path is not swallowed by the priming guard)",
        h.element.paused === false && h.element.calls.play > before,
        JSON.stringify({ paused: h.element.paused, calls: h.element.calls })
    );
}

/** D: a new media session playing ends the transaction; the receiver regains authority. */
async function runNewMediaReleases(MediaSender) {
    const { h } = await seekAndPrime(MediaSender);
    h.setReceiverState(PlayerState.PLAYING, 50, 2);
    h.tick();
    check(
        "D: the new media session's PLAYING leaves the page playing",
        h.element.paused === false,
        JSON.stringify({ paused: h.element.paused })
    );

    h.setReceiverState(PlayerState.PAUSED, 50, 2);
    h.tick();
    check(
        "D: after the transaction, an external receiver PAUSED pauses the page again",
        h.element.paused === true,
        JSON.stringify({ paused: h.element.paused, calls: h.element.calls })
    );
}

/**
 * E: the deadline contract - a hold must be released by behaviour, never by a
 * hard-coded millisecond value.
 */
async function runDeadline(MediaSender) {
    const { h } = await seekAndPrime(MediaSender);
    const priming = h.sender.dashSeekSourcePriming;
    if (!FIXED && !priming) {
        // Pre-fix production has no seek-scoped priming at all: the receiver's
        // PAUSED is mirrored immediately, which is exactly the Gap B froze.
        const before = h.element.calls.pause;
        h.setReceiverState(PlayerState.PAUSED, 50, 1);
        h.tick();
        check(
            "E: without any source-priming hold, receiver PAUSED pauses the page immediately (frozen Gap)",
            h.element.paused === true && h.element.calls.pause > before,
            JSON.stringify({ paused: h.element.paused })
        );
        return;
    }
    if (!priming) {
        skip(
            "E: deadline-restores-receiver-authority",
            "--fixed run but the sender establishes no seek-scoped priming state"
        );
        return;
    }
    check(
        "E: the deadline is carried by the priming transaction itself (no product constant asserted here)",
        Number.isFinite(priming.deadline) &&
            priming.requestId === h.sender.activeMediaServerRequestId,
        JSON.stringify({
            deadline: priming.deadline,
            requestId: priming.requestId
        })
    );

    const before = h.element.calls.pause;
    h.setReceiverState(PlayerState.PAUSED, 50, 1);
    h.tick();
    check(
        "E: before the deadline, the receiver PAUSED does not stop the page",
        h.element.paused === false && h.element.calls.pause === before,
        JSON.stringify({ paused: h.element.paused, calls: h.element.calls })
    );

    // Advance only the CLOCK, not a millisecond expectation.
    global.__advanceClock(priming.deadline - Date.now() + 1);
    h.tick();
    check(
        "E: at the deadline the priming is cleared and the same tick applies the ordinary receiver authority",
        h.sender.dashSeekSourcePriming === undefined &&
            h.element.paused === true &&
            h.element.calls.pause > before,
        JSON.stringify({
            priming: h.sender.dashSeekSourcePriming,
            paused: h.element.paused,
            calls: h.element.calls
        })
    );
}

/**
 * G: ownership. A superseded seek's late capture-ready / late bridge response
 * must not create or disturb the newer transaction's priming.
 */
async function runSupersededSeekOwnership(MediaSender) {
    if (!FIXED) {
        // Ownership only exists once there is a transaction to own.
        skip("G: superseded-seek ownership", "post-fix case; run with --fixed");
        return;
    }
    const h = await makeSender(MediaSender, {
        pagePaused: false,
        pageTime: 10
    });
    h.setReceiverState(PlayerState.PLAYING, 10);
    h.tick();

    // Seek A: its load is in flight (waiting for the bridge).
    h.sender.seekDashRemux(50);
    fireTimeout(800);
    await flush();
    const requestA =
        h.startedMediaServers[h.startedMediaServers.length - 1]?.requestId;
    h.sender.primeCaptureSource(requestA);
    await flush();
    const primingA = Boolean(h.sender.dashSeekSourcePriming);

    // Seek B arrives while A still awaits; runDashSeek serialises the loop.
    h.sender.seekDashRemux(80);
    fireTimeout(800);
    await flush();
    h.answerMediaServerStarted(requestA);
    await flush();
    h.resolveLoad();
    await flush();
    const requestB =
        h.startedMediaServers[h.startedMediaServers.length - 1]?.requestId;

    check(
        "G: the superseding seek started its own load with a new request id and A's priming was dropped",
        primingA &&
            typeof requestA === "string" &&
            typeof requestB === "string" &&
            requestB !== requestA &&
            h.sender.activeMediaServerRequestId === requestB &&
            h.sender.dashSeekSourcePriming === undefined,
        JSON.stringify({
            primingA,
            requestA,
            requestB,
            active: h.sender.activeMediaServerRequestId,
            priming: h.sender.dashSeekSourcePriming
        })
    );

    // A's capture-ready arrives late: it must not arm anything for A.
    h.sender.primeCaptureSource(requestA);
    await flush();
    check(
        "G: a late capture-ready for the superseded request does not arm priming",
        h.sender.dashSeekSourcePriming === undefined &&
            h.sender.activeMediaServerRequestId === requestB,
        JSON.stringify({
            priming: h.sender.dashSeekSourcePriming,
            active: h.sender.activeMediaServerRequestId
        })
    );

    // B's own capture-ready arms its transaction...
    h.sender.primeCaptureSource(requestB);
    await flush();
    const primingB = h.sender.dashSeekSourcePriming;
    check(
        "G: the superseding seek's priming carries its own request id",
        primingB?.requestId === requestB,
        JSON.stringify({ priming: primingB })
    );

    // ...and a late bridge response for A must be inert against it.
    h.answerMediaServerStarted(requestA);
    await flush();
    check(
        "G: a late mediaServerStarted for the superseded request is inert",
        h.sender.dashSeekSourcePriming?.requestId === requestB,
        JSON.stringify({ priming: h.sender.dashSeekSourcePriming })
    );

    h.answerMediaServerStarted(requestB, { startTime: 80 });
    await flush();
    h.resolveLoad();
    await flush();
    h.setReceiverState(PlayerState.PLAYING, 80, 2);
    h.tick();
    check(
        "G: the surviving transaction still releases on the new session's PLAYING",
        h.sender.dashSeekSourcePriming === undefined &&
            h.element.paused === false,
        JSON.stringify({
            priming: h.sender.dashSeekSourcePriming,
            paused: h.element.paused
        })
    );
}

/** F: without an explicit seek, no seek-scoped priming may be created. */
async function runInitialCastNoPrime(MediaSender) {
    const h = await makeSender(MediaSender, {
        pagePaused: false,
        pageTime: 10
    });
    h.setReceiverState(PlayerState.PLAYING, 10);
    h.tick();

    // A normal load (item change / first cast): no seek transaction. It stays
    // pending until this test answers the bridge, so it must not be awaited
    // before the response is dispatched.
    let loadSettled = false;
    let loadError;
    const pendingLoad = h.sender
        .updateMedia({
            mediaUrl: "https://example.invalid/video.m4s",
            mediaElement: h.element,
            mediaContentType: "application/x-mpegURL",
            mediaTitle: "harness",
            remoteProxy: {
                referer: "https://www.bilibili.com/video/BVtest",
                audioUrl: "https://example.invalid/audio.m4s"
            }
        })
        .then(() => {
            loadSettled = true;
        })
        .catch(err => {
            loadSettled = true;
            loadError = err;
        });
    await flush();

    const started = h.startedMediaServers[h.startedMediaServers.length - 1];
    if (started) {
        // A real page primes its capture here too; that must not arm seek state.
        h.sender.primeCaptureSource(started.requestId);
        h.answerMediaServerStarted(started.requestId);
        await flush();
        h.resolveLoad();
        await flush();
    }
    await pendingLoad;

    check(
        "F: the normal load went through the production path (its request id was created and answered)",
        Boolean(started) && loadSettled && loadError === undefined,
        JSON.stringify({
            started: Boolean(started),
            settled: loadSettled,
            error: loadError === undefined ? undefined : String(loadError)
        })
    );
    check(
        "F: a normal load (no explicit seek) never establishes the seek-scoped priming state",
        h.sender.dashSeekSourcePriming === undefined,
        JSON.stringify({ priming: h.sender.dashSeekSourcePriming })
    );
    h.setReceiverState(PlayerState.PAUSED, 10, 1);
    h.tick();
    check(
        "F: receiver PAUSED still reaches the page on a non-seek load (9704dac unchanged)",
        h.element.paused === true,
        JSON.stringify({ paused: h.element.paused })
    );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-dashseeksync-"));
    const stubDir = path.join(workDir, "stub");

    // A controllable clock: only Date.now moves, and only when the test says so.
    const realNow = Date.now;
    let clock = realNow.call(Date);
    global.__advanceClock = ms => {
        clock += ms;
    };
    Date.now = () => clock;

    console.info(
        FIXED
            ? "dashSeekSync: asserting the FIXED (seek-scoped priming) contract"
            : "dashSeekSync: asserting the pre-fix Gap (negative control: B is expected to FAIL once the seek-scoped priming is in place)"
    );
    console.info("bundling the real sender with the cast SDK stubbed");
    writeStub(stubDir);
    const bundlePath = path.join(workDir, "media.js");
    await bundle({
        source: mediaSource,
        outfile: bundlePath,
        stubDir,
        workDir
    });

    installGlobals();
    const { MediaSender } = require(bundlePath);
    if (typeof MediaSender !== "function") {
        throw new Error("dashSeekSync: the bundle did not export MediaSender");
    }

    await runSeekStartPause(MediaSender);
    await runPrimedPausedGap(MediaSender);
    await runBufferingRecoversPage(MediaSender);
    await runNewMediaReleases(MediaSender);
    await runDeadline(MediaSender);
    await runInitialCastNoPrime(MediaSender);
    await runSupersededSeekOwnership(MediaSender);

    console.info("");
    console.info(
        `${pass}/${pass + fail} checks passed` +
            (skipped.length ? `, ${skipped.length} skipped` : "")
    );

    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
    // exitCode, not process.exit(): with a piped stdout the pending writes of
    // the last checks would be discarded by an immediate exit.
    process.exitCode = fail ? 1 : 0;
}

main().catch(err => {
    console.error("dashSeekSync ERROR", err);
    process.exitCode = 1;
});
