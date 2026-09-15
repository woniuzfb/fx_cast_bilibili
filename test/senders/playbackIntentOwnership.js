#!/usr/bin/env node
"use strict";

/**
 * Playback ownership: who is allowed to restart the DASH remux?
 *
 * ## The defect this pins
 *
 * Two clocks used to be able to trigger a seek:
 *
 *   page clock         the Bilibili player's own timeline
 *   presentation clock the receiver's clock over the generated playlist,
 *                      shifted by the pad runway the bridge inserted
 *
 * Both the sender's reconciliation and the background's merged status could
 * decide a position was wrong and restart the remux. The result was a loop:
 *
 *     receiver position -> conversion -> popup -> page write -> seeked
 *       -> remux restart -> LOAD -> receiver position -> ...
 *
 * Every movement therefore produced extra reloads, and play/pause could pick up
 * a stale position on its way past and restart the video.
 *
 * ## What it asserts
 *
 * The refactor's contract, stated as behaviour rather than as structure:
 *
 *   1. A receiver status report NEVER restarts the remux, in any player state,
 *      at any position, in any order.
 *   2. A page write made BY the extension (a drift correction, a seek hold, a
 *      capture prime) never restarts the remux through the `seeked` event it
 *      causes.
 *   3. Popup play/pause never restarts the remux and never moves the position.
 *   4. Only an explicit intent restarts it, it restarts it at most ONCE, and
 *      rapid intents coalesce onto the newest target.
 *
 * Method: the real `MediaSender` is bundled with esbuild (the extension's own
 * bundler) against a stubbed cast SDK, then driven through the production
 * protocol — bridge ready, LOAD callback, the 500ms reconciliation tick, and
 * the page element's own `seeking`/`seeked` events. A remux restart is observed
 * as a new `bridge:startRemoteMediaServer` post, which is the one thing only a
 * restart can produce.
 *
 * Usage:
 *   node test/senders/playbackIntentOwnership.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);
const sendersDir = path.join(repoRoot, "extension/src/cast/senders");

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

const noop = () => {};

// ---------------------------------------------------------------------------
// Globals: DOM + browser + a controllable clock, timer queue and event bus
// ---------------------------------------------------------------------------

const timers = { timeouts: [], intervals: [] };
let timerId = 0;
let latestInterval;
/** Event handlers registered on the media element, per event type. */
const elementListeners = new Map();
/** Handlers the sender registered on `window`, so a gesture can be dispatched. */
const windowListeners = new Map();

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
        addEventListener: (type, fn) => {
            if (!windowListeners.has(type))
                windowListeners.set(type, new Set());
            windowListeners.get(type).add(fn);
        },
        removeEventListener: (type, fn) => {
            windowListeners.get(type)?.delete(fn);
        }
    };
    /**
     * A real user gesture (a pointer/key event on the page). The sender's page
     * seek path authorizes a `seeked` through the arm its gesture-adjacent
     * `seeking` installs, so a case that means "the user dragged the progress
     * bar" has to produce the gesture as well - without it the event is the
     * page's own autonomous seek, which must NOT reach the receiver.
     */
    global.__dispatchGesture = () => {
        for (const fn of [...(windowListeners.get("pointerdown") ?? [])]) fn();
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

const flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

function writeStub(stubDir) {
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
        addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
        removeEventListener: (type, fn) => {
            const index = listeners.indexOf(fn);
            if (index >= 0) listeners.splice(index, 1);
        },
        start: noop,
        disconnect: noop,
        postMessage: message => { if (global.__onCastPortMessage) global.__onCastPortMessage(message); }
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

async function buildSender() {
    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cast-ownership-")
    );
    const entry = path.join(workDir, "entry.ts");
    const outfile = path.join(workDir, "sender.cjs");
    const stubDir = path.join(workDir, "stub");
    fs.mkdirSync(stubDir, { recursive: true });
    writeStub(stubDir);
    fs.writeFileSync(
        entry,
        `import MediaSender from ${JSON.stringify(
            path.join(sendersDir, "media.ts")
        )};\n` +
            `import PlaybackCoordinator from ${JSON.stringify(
                path.join(sendersDir, "playbackCoordinator.ts")
            )};\n` +
            `export { MediaSender, PlaybackCoordinator };\n`
    );
    const esbuild = require(esbuildPath).build
        ? require(esbuildPath)
        : require(esbuildPath).default;
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
                }
            }
        ]
    });
    return { outfile, workDir };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeElement({ paused, currentTime = 0 }) {
    const calls = { play: 0, pause: 0, seeks: [] };
    const element = new global.HTMLMediaElement();
    element.paused = paused;
    element._currentTime = currentTime;
    element.duration = 1000;
    element.muted = false;
    element.textTracks = [];
    Object.defineProperty(element, "currentTime", {
        get: () => element._currentTime,
        set: value => {
            element._currentTime = value;
            // A real element queues `seeking`/`seeked` on a later task; the
            // harness makes that explicit through emitSeeked() instead of
            // firing them inside the setter.
        }
    });
    element.play = () => {
        calls.play++;
        if (element.paused) {
            element.paused = false;
            element.emit("play");
        }
        return Promise.resolve();
    };
    element.pause = () => {
        calls.pause++;
        if (!element.paused) {
            element.paused = true;
            element.emit("pause");
        }
    };
    element.addEventListener = (type, handler) => {
        if (!elementListeners.has(type)) elementListeners.set(type, new Set());
        elementListeners.get(type).add(handler);
    };
    element.removeEventListener = (type, handler) => {
        elementListeners.get(type)?.delete(handler);
    };
    /** Fire an element/gesture event synchronously, as the browser would later. */
    element.emit = type => {
        for (const handler of elementListeners.get(type) ?? []) handler();
    };
    element.calls = calls;
    return element;
}

/**
 * A receiver media session, shaped like the real `cast/sdk/media/Media`: it
 * carries BOTH `mediaSessionId` and a nested `media` MediaInfo with its own
 * `contentId`, because the sender's presentation adapter matches a report on
 * exactly those two. A fake missing them cannot exercise the identity binding at
 * all — it makes the adapter refuse every report, which is how a real
 * "reports silently stop being converted" gap stayed invisible.
 */
function makeMedia(playerState, estimatedTime, mediaSessionId) {
    const calls = { pause: 0, play: 0, seek: 0 };
    return {
        playerState,
        idleReason: undefined,
        mediaSessionId,
        media: {
            contentId: `http://127.0.0.1:9555/s/gen-${mediaSessionId}/index.m3u8`,
            duration: 1000
        },
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
 * A Chromecast DASH-remux sender (NOT page-clock-master: that is the path where
 * the receiver position is mirrored onto the page and where the old code
 * corrected drift, i.e. the path that could write the page and then seek from
 * that write).
 */
async function makeSender(MediaSender, opts = {}) {
    elementListeners.clear();
    windowListeners.clear();
    timers.timeouts.length = 0;
    const element = makeElement({
        paused: opts.pagePaused ?? false,
        currentTime: opts.pageTime ?? 100
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
        // Default to the production Bilibili configuration (gesture gating ON).
        // The capture-window cases turn it OFF through opts, because the gate
        // returns from the mirror path before any position decision is made —
        // which would make their assertions pass without exercising the hold.
        gestureGatedControls: opts.gestureGatedControls ?? true,
        debug: noop
    });

    const sessionState = { media: [], loadRequests: [] };
    const portMessages = [];
    sender.session = {
        receiver: { label: "Chromecast-HARNESS" },
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
                media: makeMedia(
                    PlayerState.PLAYING,
                    opts.receiverTime ?? 0,
                    sessionState.loadRequests.length + 2
                )
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
        startedMediaServers: [],
        /** Number of remux restarts: the ONLY thing a seek may add to. */
        restarts: () => state.startedMediaServers.length,
        tick: () => {
            if (latestInterval) latestInterval();
        },
        /**
         * Swap in the receiver's current session media.
         *
         * APPENDS, as the real cast SDK does (`session.media` is the stack the
         * sender reconciles against and binds its presentation adapter to). A fake
         * that REPLACED the array with media the sender never saw would hand
         * every test status an identity the adapter could not know, which makes
         * the adapter refuse it — the exact condition that would hide a real
         * "reports stopped being converted" gap.
         */
        setReceiverState: (
            playerState,
            estimatedTime = 0,
            mediaSessionId = 1
        ) => {
            const media = makeMedia(playerState, estimatedTime, mediaSessionId);
            // The receiver reports the playlist the bridge built for THIS cast, so
            // its media states the generation's own content id. Inventing an
            // unrelated one would make the sender's evidence check refuse the
            // session — correct behaviour, but it would mean the harness was never
            // exercising the mapping it thinks it is.
            media.media = {
                contentId: state.receiverContentId(),
                duration: 1000
            };
            sessionState.media = [...sessionState.media.slice(-2), media];
            return media;
        },
        /** The content id a receiver session for the live generation reports. */
        receiverContentId: () =>
            `http://127.0.0.1:9555/s/${
                state.liveRequestId ?? "gen"
            }/index.m3u8`,
        liveRequestId: undefined,
        /** Swap in a receiver session whose media states a specific content id. */
        setReceiverStateForContent: (
            playerState,
            estimatedTime,
            mediaSessionId,
            contentId
        ) => {
            const media = makeMedia(playerState, estimatedTime, mediaSessionId);
            media.media = { contentId, duration: 1000 };
            sessionState.media = [...sessionState.media.slice(-2), media];
            return media;
        },
        answerMediaServerStarted: (requestId, extra = {}) => {
            state.liveRequestId = requestId;
            global.__castPortDispatch({
                subject: "mediaCast:mediaServerStarted",
                data: {
                    requestId,
                    // The bridge serves a GENERATION-scoped playlist path (the sender
                    // appends its own cache-busting query on top); a flat path would
                    // make the resolved content id carry no generation identity.
                    mediaPath: `s/${requestId}/index.m3u8`,
                    localAddress: "127.0.0.1",
                    mode: "dash-remux",
                    startTime: 0,
                    // A real bridge ALWAYS states where the receiver must start on
                    // the playlist it just built. Without it the sender has no
                    // presentation identity for the generation and its adapter is
                    // never built, so every receiver position would be refused —
                    // the harness would then be testing the "no bridge reply" path
                    // in every case that expects a working mapping.
                    presentationStartTime: 0,
                    pageDuration: 1000,
                    ...extra
                }
            });
        },
        resolveLoad: () => {
            const entry =
                sessionState.loadRequests[sessionState.loadRequests.length - 1];
            if (!entry) return false;
            entry.onSuccess(entry.media);
            return true;
        },
        /** The last LOAD position the bridge/receiver was asked to start at. */
        lastLoadTime: () =>
            sessionState.loadRequests.length
                ? sessionState.loadRequests[
                      sessionState.loadRequests.length - 1
                  ].request.currentTime
                : undefined
    };

    global.__onCastPortMessage = message => {
        portMessages.push(message);
        if (message?.subject === "bridge:startRemoteMediaServer") {
            state.startedMediaServers.push(message.data);
        }
    };
    await flush();
    return state;
}

/** Complete one cast: LOAD in flight, bridge ready, receiver accepted. */
async function completeInitialLoad(h, extra = {}) {
    h.sender.loadMedia().catch(() => undefined);
    await flush();
    const started = h.startedMediaServers.at(-1);
    if (!started)
        throw new Error("no bridge:startRemoteMediaServer was posted");
    h.answerMediaServerStarted(started.requestId, extra);
    await flush();
    h.resolveLoad();
    await flush();
    return started;
}

async function checkStatusNeverSeeks(MediaSender) {
    const h = await makeSender(MediaSender, { pageTime: 100 });
    await completeInitialLoad(h);
    const before = h.restarts();

    // Every shape a receiver report can take, including the ones that used to
    // look like a deliberate mismatch: the padded presentation position (page
    // + the 32s runway), the transient reset right after a reload, and the
    // exact page position.
    const reports = [
        [PlayerState.PLAYING, 132, 2],
        [PlayerState.PLAYING, 0, 2],
        [PlayerState.PAUSED, 132, 2],
        [PlayerState.BUFFERING, 100, 2],
        [PlayerState.IDLE, 0, 3],
        [PlayerState.PLAYING, 244, 3],
        [PlayerState.PAUSED, 0, 4]
    ];
    for (const [playerState, time, sessionId] of reports) {
        h.setReceiverState(playerState, time, sessionId);
        h.tick();
        await flush();
        h.tick();
        await flush();
    }

    check(
        "status: receiver reports in every state and position restarted the remux 0 times",
        h.restarts() === before,
        JSON.stringify({ before, after: h.restarts() })
    );
    check(
        "status: a stale session's report did not move the page position",
        h.element.currentTime === 100,
        JSON.stringify({ pageTime: h.element.currentTime })
    );
}

async function checkProgrammaticPageWriteNeverSeeks(MediaSender) {
    const h = await makeSender(MediaSender, { pageTime: 100 });
    await completeInitialLoad(h);
    const before = h.restarts();

    // A drift correction / seek hold writes the page element. The element then
    // fires `seeked`, which is the page's own report of the change. That event
    // is the exact thing that used to be misread as "the user asked to seek
    // here" and started another remux.
    h.element.currentTime = 5;
    h.element.emit("seeked");
    await flush();
    h.tick();
    await flush();

    check(
        "page write: the extension's own page write produced 0 remux restarts",
        h.restarts() === before,
        JSON.stringify({ before, after: h.restarts() })
    );
    check(
        "page write: no LOAD was issued for the write's echo",
        h.lastLoadTime() === undefined || h.restarts() === before,
        JSON.stringify({ lastLoadTime: h.lastLoadTime() })
    );
}

async function checkPauseNeverSeeks(MediaSender) {
    const h = await makeSender(MediaSender, {
        pageTime: 100,
        receiverTime: 132
    });
    await completeInitialLoad(h);
    const before = h.restarts();

    // The popup's Pause goes through the same page-route command the real popup
    // sends. It must not read any position: the popup may well be displaying a
    // stale one.
    h.setReceiverState(PlayerState.PLAYING, 132, 2);
    h.tick();
    await flush();
    h.sender.controlPlayback({
        intent: "PAUSE",
        commandId: "intent-1",
        mediaIdentity: "harness"
    });
    await flush();
    fireTimeout(2000);
    await flush();
    h.tick();
    await flush();

    check(
        "pause: the popup pause restarted the remux 0 times",
        h.restarts() === before,
        JSON.stringify({ before, after: h.restarts() })
    );
    check(
        "pause: the popup pause did not move the page position",
        h.element.currentTime === 100,
        JSON.stringify({ pageTime: h.element.currentTime })
    );
}

async function checkOneIntentOneRestart(MediaSender) {
    const h = await makeSender(MediaSender, { pageTime: 100 });
    await completeInitialLoad(h);
    const before = h.restarts();

    // The popup's seek route: exactly what background/castManager calls.
    h.sender.seekDashRemux(244);
    await flush();
    fireTimeout(800);
    await flush();
    const afterFirst = h.restarts();

    check(
        "intent: one popup seek produced exactly one remux restart",
        afterFirst === before + 1,
        JSON.stringify({ before, afterFirst })
    );
    check(
        "intent: the restart targets the requested PAGE position",
        h.startedMediaServers.at(-1)?.startTime === 244,
        JSON.stringify({
            startTime: h.startedMediaServers.at(-1)?.startTime
        })
    );

    // A second and third seek once the FIRST restart is genuinely in flight (its
    // debounce has fired and the bridge is working). These must coalesce onto the
    // running transaction, not start a second bridge generation — the duplicate
    // reload that per-click transactions produced.
    fireTimeout(800);
    await flush();
    const firstInFlight = h.restarts();
    check(
        "intent: the first seek's transaction actually started (its restart is in flight)",
        firstInFlight === afterFirst,
        JSON.stringify({ afterFirst, firstInFlight })
    );
    h.sender.seekDashRemux(250);
    h.sender.seekDashRemux(260);
    await flush();
    fireTimeout(800);
    await flush();
    check(
        "intent: seeks during an in-flight restart did not start a second remux",
        h.restarts() === firstInFlight,
        JSON.stringify({ firstInFlight, duringFlight: h.restarts() })
    );
    const coordinator = h.sender.getPlaybackCoordinator();
    check(
        "intent: the running transaction retargeted to the NEWEST seek",
        coordinator.getTransactionTarget() === 260,
        JSON.stringify({
            target: coordinator.getTransactionTarget(),
            phase: coordinator.getPhase()
        })
    );
}

/**
 * The other half of the gesture gate: the site's OWN seek must not restart the
 * remux.
 *
 * Bilibili's player seeks on its own (buffering recovery, quality switches, the
 * SPA taking over a new video) and every one of those fires `seeking`/`seeked`
 * with no user gesture behind it. The gate that refuses them is the same one
 * checkUserPageSeekStillWorks exercises from the accepting side, and it is
 * narrow on purpose: the `seeking` ARM (which a gesture-adjacent `seeking`
 * installs) or a BLE skip - never a bare pointerdown, which would re-open the
 * gate for whatever the page does in the next 1.5s.
 */
async function checkAutonomousPageSeekIsIgnored(MediaSender) {
    const h = await makeSender(MediaSender, { pageTime: 100 });
    await completeInitialLoad(h);
    const before = h.restarts();

    h.element.currentTime = 300;
    h.element.emit("seeking");
    h.element.emit("seeked");
    await flush();
    fireTimeout(800);
    await flush();

    check(
        "page autonomous seek: the player's own seek (no gesture, not BLE) restarted the remux 0 times",
        h.restarts() === before,
        JSON.stringify({ before, after: h.restarts() })
    );
}

async function checkUserPageSeekStillWorks(MediaSender) {
    const h = await makeSender(MediaSender, { pageTime: 100 });
    await completeInitialLoad(h);
    const before = h.restarts();

    // A user seeking on the site's progress bar: a gesture-adjacent `seeking`
    // arms the window, the element moves, and `seeked` follows. This is the ONE
    // page-originated shape that may restart the remux - and the GESTURE is part
    // of it: the arm is installed by `onSeeking`, which refuses to do so without
    // one, so a drag without a pointer event is the site's own autonomous seek
    // and must not reach the receiver (see checkAutonomousPageSeekIsIgnored).
    global.__dispatchGesture();
    h.element.currentTime = 300;
    h.element.emit("seeking");
    h.element.emit("seeked");
    await flush();
    fireTimeout(800);
    await flush();

    check(
        "page user seek: the user's own page seek still restarted the remux exactly once",
        h.restarts() === before + 1,
        JSON.stringify({ before, after: h.restarts() })
    );
    check(
        "page user seek: the restart targets the page's position",
        h.startedMediaServers.at(-1)?.startTime === 300,
        JSON.stringify({
            startTime: h.startedMediaServers.at(-1)?.startTime
        })
    );
}

function checkCoordinatorContract(PlaybackCoordinator) {
    const coordinator = new PlaybackCoordinator();
    check(
        "coordinator: exports a constructible class",
        typeof PlaybackCoordinator === "function"
    );

    const statusRequest = coordinator.requestSeek("receiver-status", 132);
    check(
        "coordinator: a receiver-status origin is refused as an intent",
        statusRequest.accepted === false &&
            statusRequest.restart === false &&
            statusRequest.reason === "not-a-seek-intent",
        JSON.stringify(statusRequest)
    );

    const syncRequest = coordinator.requestSeek("sync-write", 5);
    check(
        "coordinator: a sync-write origin is refused as an intent",
        syncRequest.restart === false,
        JSON.stringify(syncRequest)
    );

    const userRequest = coordinator.requestSeek("popup", 244);
    check(
        "coordinator: a user intent asks for a restart",
        userRequest.accepted === true && userRequest.restart === true,
        JSON.stringify(userRequest)
    );
    const generation = coordinator.getGeneration();
    coordinator.beginTransaction(userRequest.intentId, "seeking");
    check(
        "coordinator: beginning the transaction advances the generation",
        coordinator.getGeneration() === generation + 1,
        JSON.stringify({
            generation,
            now: coordinator.getGeneration()
        })
    );

    const second = coordinator.requestSeek("popup", 250);
    check(
        "coordinator: a second intent during the transaction coalesces",
        second.accepted === true && second.restart === false,
        JSON.stringify(second)
    );
    check(
        "coordinator: the running transaction retargets to the newest intent",
        coordinator.getTransactionTarget() === 250,
        JSON.stringify({ target: coordinator.getTransactionTarget() })
    );
    // A burst: the newest intent SUPERSEDES the older unserved one. Queueing them
    // all made the transaction loop serve one generation per click and end on the
    // oldest of them, i.e. the receiver finishing on a target the user had already
    // moved past.
    const third = coordinator.requestSeek("popup", 260);
    check(
        "coordinator: a newer intent replaces the older unserved one (only the newest can be served)",
        third.restart === false &&
            coordinator.getTransactionTarget() === 260 &&
            coordinator.describe().intentCount === 1,
        JSON.stringify(coordinator.describe())
    );

    // A receiver status observed during the transaction must not disturb it.
    coordinator.observeReceiverPosition({
        pageSeconds: 132,
        playerState: "PLAYING",
        mediaSessionId: 9
    });
    check(
        "coordinator: an observation during the transaction does not retarget it",
        coordinator.getTransactionTarget() === 260,
        JSON.stringify({ target: coordinator.getTransactionTarget() })
    );
    check(
        "coordinator: the observation is recorded as display state only",
        coordinator.getObservation()?.pageSeconds === 132,
        JSON.stringify(coordinator.getObservation())
    );

    coordinator.endTransaction("load-settled");
    const afterEnd = coordinator.requestSeek("receiver-status", 900);
    check(
        "coordinator: after the transaction, status still cannot ask for a restart",
        afterEnd.restart === false,
        JSON.stringify(afterEnd)
    );

    // ---- an item change is a GENERATION boundary --------------------------
    const beforeItem = coordinator.getGeneration();
    const itemGeneration = coordinator.beginItemChange();
    check(
        "coordinator: an item change advances the generation (old events die by identity)",
        itemGeneration === beforeItem + 1,
        JSON.stringify({ beforeItem, itemGeneration })
    );
    // Called ONCE: requestSeek consumes an intent id per call, so asking twice
    // for the condition and then for the detail would test two different calls.
    const duringItem = coordinator.requestSeek("popup", 400);
    check(
        "coordinator: during the item change no seek can start a second remux",
        duringItem.restart === false,
        JSON.stringify(duringItem)
    );
    coordinator.markItemSettled();
    check(
        "coordinator: the item change settles back to idle and KEEPS the unserved intent (it is served once the item's media is live)",
        coordinator.getPhase() === "idle" &&
            coordinator.peekIntent()?.targetPageSeconds === 400,
        JSON.stringify({
            phase: coordinator.getPhase(),
            intent: coordinator.peekIntent()
        })
    );
    const afterItem = coordinator.requestSeek("popup", 500);
    check(
        "coordinator: after the item change settles, a new seek restarts again",
        afterItem.restart === true,
        JSON.stringify(afterItem)
    );
}

// ---------------------------------------------------------------------------
// 6. A live capture window holds the page even after the coordinator is idle
// ---------------------------------------------------------------------------

/**
 * The page hold has to be ONE answer.
 *
 * `isHoldingPage()` covers three conditions: the coordinator's own transaction,
 * the capture-side seek priming, and an item transition. Two of those OUTLIVE a
 * completed transaction, so a hold derived from the coordinator alone reports
 * "not holding" while a window is still live — and the mirror path would then
 * apply the PREVIOUS generation's receiver position to the page.
 *
 * These cases put the coordinator in `idle` and then make a capture window live,
 * which is the only way to catch that divergence: with the transaction still
 * running, both derivations agree and the case proves nothing.
 */
async function checkCaptureWindowsHoldPage(MediaSender) {
    const Idle = "idle";

    // ---- 6a. the DECISION reports the right reason ------------------------
    // What is asserted here, and what is NOT:
    //
    // `isHoldingPage()` ORs three conditions, two of which OUTLIVE a completed
    // coordinator transaction. The defect this fixes was that the mirror hold read
    // a narrower alias (the coordinator's own transaction only), so during a live
    // capture window it answered "not holding".
    //
    // That defect is NOT observable through today's code paths, and this test does
    // not pretend otherwise: for a DASH remux the sender never mirrors the
    // receiver's position onto the page at all, and the item-transition window
    // returns from the reconciliation path before any state decision is made. Made
    // measurable by reintroducing the bug on the mirror-hold line: every
    // behavioural assertion still passed, so a behavioural row here would be
    // decoration.
    //
    // What IS asserted: the single decision point reports the coordinator
    // condition through the real path (a live seek transaction), so a future
    // refactor that collapses the three conditions keeps this contract visible.
    {
        const h = await makeSender(MediaSender, { pageTime: 100 });
        await completeInitialLoad(h);
        const coordinator = h.sender.getPlaybackCoordinator();
        check(
            "capture window: with nothing running the page is NOT held, by any condition",
            h.sender.describePageHold().holding === false,
            JSON.stringify({ hold: h.sender.describePageHold() })
        );

        // A real seek transaction: the one condition that is observable end to end.
        h.sender.seekDashRemux(300, "popup");
        await flush();
        fireTimeout(800);
        await flush();
        const during = h.sender.describePageHold();
        check(
            "capture window: a live seek transaction is reported as the reason the page is held",
            during.holding === true &&
                during.coordinatorTransaction === true &&
                coordinator.getPhase() !== Idle,
            JSON.stringify({ hold: during, phase: coordinator.getPhase() })
        );
    }

    // ---- 6b. playback STATE under a live item transition -------------------
    // Position is NOT the observable: for a DASH remux the sender never mirrors the
    // receiver's position onto the page, so a drift write cannot happen whether or
    // not a window is held. What a live window changes is the page's PLAY/PAUSE
    // state, which follows the receiver on every path.
    {
        const h = await makeSender(MediaSender, { pageTime: 100 });
        await completeInitialLoad(h);
        const coordinator = h.sender.getPlaybackCoordinator();

        // The item changed and the NEW item's media already settled, so the
        // coordinator is idle — while the transition window still covers the OLD
        // session's startup reports.
        h.sender.beginDashItemTransition();
        coordinator.markItemSettled();
        check(
            "capture window: the coordinator is idle while the item transition is still live",
            coordinator.getPhase() === Idle &&
                h.sender.describePageHold().itemTransition === true,
            JSON.stringify({ hold: h.sender.describePageHold() })
        );

        // The OLD session reports PAUSED. The page must keep playing: it is the
        // source the new item is being built from.
        h.setReceiverState(PlayerState.PAUSED, 100, 3);
        h.tick();
        await flush();
        check(
            "capture window: a live item transition keeps the page playing through the old session's PAUSED",
            h.element.paused === false,
            JSON.stringify({
                pagePaused: h.element.paused,
                hold: h.sender.describePageHold()
            })
        );
    }
}

// ---------------------------------------------------------------------------
// 7. The post-load settle (tighten) can never write the page for a DASH remux
// ---------------------------------------------------------------------------

/**
 * `dashTightenSync` is the last piece of the old settle machinery: a Chromecast
 * load arms it, it polls GET_STATUS, and it used to snap the page element onto
 * the receiver's position. That snap is incompatible with the invariant this
 * refactor establishes — for a Bilibili DASH cast the PAGE owns position — so the
 * assertion is that no path through the settle writes `currentTime` at all.
 *
 * Driven with a real seek transaction (which is what arms the tighten) and a
 * receiver reporting a position far from the page, which is exactly the shape
 * that used to trigger the snap.
 */
async function checkTightenNeverWritesPage(MediaSender) {
    // Gesture gating OFF so the sync tick actually reaches its position decision
    // instead of returning at the gate: with it on, "no write happened" would be
    // true for the wrong reason.
    const h = await makeSender(MediaSender, {
        pageTime: 100,
        gestureGatedControls: false
    });
    await completeInitialLoad(h);

    h.sender.seekDashRemux(300, "popup");
    await flush();
    fireTimeout(800);
    await flush();

    // The seek's own hold writes the page to the target, which is the page time
    // the transaction asked for — not a receiver position.
    check(
        "tighten: the seek moved the page to the PAGE target it was asked for",
        h.element.currentTime === 300,
        JSON.stringify({ pageTime: h.element.currentTime })
    );

    // Settle the transaction so the settle/tighten path is the one under test
    // rather than the transaction hold.
    h.answerMediaServerStarted(h.startedMediaServers.at(-1).requestId, {
        startTime: 300,
        presentationStartTime: 300
    });
    await flush();
    h.resolveLoad();
    await flush();
    check(
        "tighten: the transaction is over, so the settle path is reachable (not vacuous)",
        h.sender.describePageHold().holding === false,
        JSON.stringify({ hold: h.sender.describePageHold() })
    );

    // The receiver reports a position on its own clock, well beyond the page's.
    h.setReceiverState(PlayerState.PLAYING, 480, 5);
    h.tick();
    await flush();
    h.tick();
    await flush();

    check(
        "tighten: the post-load settle does NOT write the page position (the page owns position)",
        h.element.currentTime === 300,
        JSON.stringify({
            pageTime: h.element.currentTime,
            receiverTime: 480,
            offsetSeconds: h.startedMediaServers.at(-1).presentationStartTime
        })
    );
    // The adapter must still RECOGNISE the media the receiver reports. Without
    // this, the position would be dropped rather than converted — the page would
    // look correct for the wrong reason, and every receiver position would
    // silently stop reaching the popup. This is the check that found the real gap:
    // the adapter learned identity only from the LOAD callback's Media, which can
    // be the stale previous session.
    check(
        "tighten: the adapter still recognises the receiver's current media (positions are not silently dropped)",
        h.sender.canConvertReceiverPosition() === true,
        JSON.stringify({
            receiverMediaSessionId:
                h.sender.session?.media?.at(-1)?.mediaSessionId
        })
    );
}

// ---------------------------------------------------------------------------
// 8. Presentation identity is confirmed against the GENERATION's own content
// ---------------------------------------------------------------------------

/**
 * The adapter refuses media it cannot describe, and a refused report is neither
 * converted nor observed — the position is dropped silently and the page simply
 * looks static. So which identities an adapter accepts is load-bearing, and the
 * rule is evidence-based in two stages:
 *
 *   stage 1: the generation binds the content id IT declared (the bridge's URI
 *            for this load) — no receiver evidence needed, the sender chose it;
 *   stage 2: a media session id is added only when that media STATES a content id
 *            agreeing with the declared one. The LOAD callback's own Media object
 *            is NOT evidence: it can be the stale previous session, which is how
 *            binding it taught the adapter the OLD identity and made it refuse
 *            the new one.
 */
async function checkPresentationIdentityConfirmation(MediaSender) {
    const h = await makeSender(MediaSender, { pageTime: 100 });
    await completeInitialLoad(h);

    const declared = h.sender.describeDeclaredContentId();
    check(
        "identity: the generation declares its own content id before any report",
        typeof declared === "string" &&
            declared.length > 0 &&
            declared.includes(h.liveRequestId),
        JSON.stringify({ declared })
    );

    // A report whose media states an UNRELATED content id must be refused: an
    // unverifiable session id is exactly the guess the identity check replaces.
    h.setReceiverStateForContent(
        PlayerState.PLAYING,
        130,
        9,
        "https://example.invalid/s/other-generation/index.m3u8?v=1"
    );
    h.tick();
    await flush();
    check(
        "identity: a media stating a FOREIGN content id is refused (not converted)",
        h.sender.canConvertReceiverPosition() === false,
        JSON.stringify({
            declares: h.sender.describeDeclaredContentId(),
            receiverContentId:
                h.sender.describePresentationIdentity().reportedContentId
        })
    );

    // A media session stating THIS generation's content id (with the sender's own
    // cache-busting query, which the comparison normalizes away) IS confirmed.
    h.setReceiverStateForContent(PlayerState.PLAYING, 130, 10, declared);
    h.tick();
    await flush();
    check(
        "identity: a media stating THIS generation's content id is confirmed",
        h.sender.canConvertReceiverPosition() === true,
        JSON.stringify({
            receiverContentId:
                h.sender.describePresentationIdentity().reportedContentId,
            sessionId: h.sender.session?.media?.at(-1)?.mediaSessionId
        })
    );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

async function main() {
    const { outfile, workDir } = await buildSender();
    installGlobals();
    const { MediaSender, PlaybackCoordinator } = require(outfile);
    if (typeof MediaSender !== "function") {
        throw new Error(
            "playbackIntentOwnership: the bundle did not export MediaSender"
        );
    }

    checkCoordinatorContract(PlaybackCoordinator);
    await checkStatusNeverSeeks(MediaSender);
    await checkProgrammaticPageWriteNeverSeeks(MediaSender);
    await checkPauseNeverSeeks(MediaSender);
    await checkOneIntentOneRestart(MediaSender);
    await checkUserPageSeekStillWorks(MediaSender);
    await checkAutonomousPageSeekIsIgnored(MediaSender);
    await checkCaptureWindowsHoldPage(MediaSender);
    await checkTightenNeverWritesPage(MediaSender);
    await checkPresentationIdentityConfirmation(MediaSender);

    console.info("");
    console.info(`${pass}/${pass + fail} checks passed`);
    process.exitCode = fail ? 1 : 0;

    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
}

main().catch(err => {
    console.error("playbackIntentOwnership ERROR", err);
    process.exitCode = 1;
});
