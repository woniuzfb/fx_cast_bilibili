"use strict";

/**
 * The sender harness for the phase-3 model: DOM, browser and cast-SDK stubs
 * around the REAL bundled `MediaSender`, plus a driver whose every method is a
 * production entry point.
 *
 * Shared by `test/senders/dashLoadMatrix.js` (the load matrix) and
 * `test/senders/playbackInterleavings.js` (the model-based interleavings), so the
 * fixture that answers a LOAD, the fake clock that fires the seek debounce and the
 * receiver that reports its own position exist ONCE. The bridge arithmetic those
 * answers are built from is not restated here either: it comes from `./plan.js`,
 * which evaluates the bridge's own source.
 *
 * What is stubbed, and why each is the narrowest seam available:
 *
 *   - the cast SDK (`../export`) - the sender's only channel to a receiver. The
 *     stub records every receiver command, so "an observation is not a command" is
 *     checkable rather than assumed.
 *   - the browser: a `window`, an `HTMLMediaElement` subclass with its own listener
 *     set, and a timer layer whose deadlines the test fires (`fireTimeout`),
 *     because the seek debounce is 800ms of wall clock no row can spend.
 *   - the page: an element that fires `seeking`/`seeked` only for a move that
 *     really changed its position, so a programmatic echo stays distinguishable
 *     from a user seek.
 *
 * Everything above those seams is production code.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { bridgePlan, keyframeFor } = require("./plan");

const repoRoot = path.resolve(__dirname, "../..");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

/** The player states, mirrored from the SDK's enum for the fixture's own use. */
const PlayerState = {
    IDLE: "IDLE",
    PLAYING: "PLAYING",
    PAUSED: "PAUSED",
    BUFFERING: "BUFFERING"
};

const noop = () => {};

/**
 * Where the sender under test lives.
 *
 * `preFix` checks out another revision in a git worktree, so the SAME bundle, the
 * same fixture and the same assertions run against the source a contract is
 * supposed to catch. The bridge plan always comes from this checkout: an old
 * bridge has no runway arithmetic to run.
 */
function resolveSendersDir({ preFix = false, rev = "HEAD" } = {}) {
    if (!preFix) return path.join(repoRoot, "extension/src/cast/senders");
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-rev-"));
    fs.rmSync(worktree, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--detach", worktree, rev], {
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
// The fixture: DOM, browser, cast SDK stub, real bundled sender
// ---------------------------------------------------------------------------

/** The page position a live cast sits at before an action is applied to it. */
const BASELINE_PAGE_TIME = 100;
/** Mirrors MediaSender.DASH_SEEK_DEBOUNCE_MS; the harness's clock is not real. */
const SEEK_DEBOUNCE_MS = 800;
const PAGE_DURATION = 6000;
const BILIBILI_REFERER = "https://www.bilibili.com/video/BVtest";

// ---------------------------------------------------------------------------
// 3. The fixture: DOM, browser, cast SDK stub, real bundled sender
// ---------------------------------------------------------------------------

/** Per-fixture option overlay; null means the production defaults. */
let fixtureOptions = null;
/** Monotonic totals of receiver-side commands, per fixture. */
const receiverCommands = { pause: 0, play: 0, seek: 0 };
/**
 * The state the extension last COMMANDED the receiver to be in.
 *
 * The receiver echoes what it was told, and one of those commands is the
 * extension's own: a DASH seek pauses the receiver to hold the frame while the
 * remux rebuilds. A fixture that did not model the echo could not tell a harness
 * `RECEIVER_PAUSED` (the user, on the physical remote) from the receiver simply
 * reporting the pause WE just asked for - which is exactly the distinction the
 * sender has to make, and the one that regressed.
 */
let lastCommandedReceiverState;
/** True while a row is holding the page's `seeked` back. */
let pageSeeksDeferred = false;
const timers = { timeouts: [] };
let timerId = 0;
let latestInterval;
/** window handlers, so a real user gesture can be dispatched. */
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
     * A real user gesture (a pointer/key event on the page). This is what
     * arms the sender's gesture gate; without it every page event must be
     * treated as the player's own, which is exactly the distinction the matrix
     * asserts.
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
                        rokuTranscodePreset: "veryfast",
                        chromecastDashStartupPadding: true,
                        ...(fixtureOptions ?? {})
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

async function buildSender(sendersDir) {
    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cast-load-matrix-")
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
        )};\nexport { MediaSender };\n`
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

/** A page media element with its own listener set and observable calls. */
function makeElement({ paused, currentTime, asyncSeek = true }) {
    const calls = { play: 0, pause: 0, writes: [] };
    const handlers = new Map();
    /**
     * A real element fires `seeking`/`seeked` only for a move that CHANGED its
     * position, and those events are the browser's, not the extension's: a write
     * that was a no-op (the sender's own guard skips it) produces no event at
     * all. Tracking it is what keeps a programmatic echo from being invented -
     * and an invented echo is a PAGE SEEK as far as the sender can tell.
     */
    let pendingWriteEcho = false;
    const element = new global.HTMLMediaElement();
    element.paused = paused;
    element._currentTime = currentTime;
    element.asyncSeek = asyncSeek;
    /**
     * The seek the element is ON ITS WAY to (`undefined` when it is going
     * nowhere), and whether it is still travelling.
     *
     * A browser seek is a REQUEST, not an assignment: assigning `currentTime`
     * starts a seek, the element reports `seeking`, and it reaches the position -
     * firing `seeked` - only once it has the data. For a DASH page player that is
     * a fetch plus a decode, and if the target is outside what that player can
     * reach, nothing arrives at all. The fixture models that two-phase shape on
     * purpose: a synchronous stub makes "the page has been ASKED to go there" and
     * "the page HAS arrived" the same fact, which is exactly the distinction the
     * seek handoff has to get right.
     */
    element.pendingSeek = undefined;
    element.seeking = false;
    /** Off by default; a row turns it on to model the page player's real rule. */
    element.pausedPlayerModel = false;
    // Long enough that the mid-video rows are inside the media and a BLE skip
    // is not clamped by the fixture rather than by the sender.
    element.duration = PAGE_DURATION;
    element.muted = false;
    element.textTracks = [];
    Object.defineProperty(element, "currentTime", {
        get: () => element._currentTime,
        set: value => {
            if (Math.abs(value - element._currentTime) > 1e-9) {
                pendingWriteEcho = true;
            }
            calls.writes.push(value);
            if (!element.asyncSeek) {
                element._currentTime = value;
                return;
            }
            element.pendingSeek = value;
            if (!element.seeking) {
                element.seeking = true;
                // `seeking` is the element acknowledging the REQUEST, so it is
                // fired by the write itself; `seeked` belongs to whoever delivers
                // the data (see completePageSeek).
                element.emit("seeking");
            }
        }
    });
    /**
     * The harness stating where the page IS - not a seek: the position lands
     * immediately, nothing is owed and no event is fired. Used for the inputs a
     * row supplies itself (where the page already is), never for a move the code
     * under test asked for.
     */
    element.placeAt = value => {
        element._currentTime = value;
        element.pendingSeek = undefined;
        element.seeking = false;
        element.takeWriteEcho();
    };
    /** The element arrives: the seek's target becomes its position. */
    element.completePageSeek = () => {
        if (element.pendingSeek === undefined) return false;
        element._currentTime = element.pendingSeek;
        element.pendingSeek = undefined;
        element.seeking = false;
        element.emit("seeked");
        return true;
    };
    /** Claim the event pair this element owes for its last move, if any. */
    element.takeWriteEcho = () => {
        const owed = pendingWriteEcho;
        pendingWriteEcho = false;
        return owed;
    };
    element.play = () => {
        calls.play++;
        if (element.paused) {
            element.paused = false;
            element.emit("play");
        }
        // The page player only fetches/decodes the target range once it is
        // PLAYING again: a seek requested while it is paused lands here.
        if (element.pausedPlayerModel && element.pendingSeek !== undefined) {
            element.completePageSeek();
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
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(handler);
    };
    element.removeEventListener = (type, handler) => {
        handlers.get(type)?.delete(handler);
    };
    /** Fire an element event synchronously, as the browser would later. */
    element.emit = type => {
        for (const handler of [...(handlers.get(type) ?? [])]) handler();
    };
    element.listenerCount = type => (handlers.get(type) ?? new Set()).size;
    element.calls = calls;
    return element;
}

/**
 * A receiver media session, shaped like the real `cast/sdk/media/Media`:
 * `mediaSessionId` plus a nested MediaInfo carrying the contentId, because the
 * sender's presentation adapter matches a report on exactly those two.
 */
function makeMedia(playerState, estimatedTime, mediaSessionId, contentId) {
    const calls = { pause: 0, play: 0, seek: 0 };
    return {
        playerState,
        idleReason: undefined,
        mediaSessionId,
        media: { contentId, duration: PAGE_DURATION },
        currentTime: estimatedTime,
        getEstimatedTime: () => estimatedTime,
        addUpdateListener: noop,
        removeUpdateListener: noop,
        pause: () => {
            calls.pause++;
            receiverCommands.pause++;
            lastCommandedReceiverState = "PAUSED";
            return Promise.resolve();
        },
        play: () => {
            calls.play++;
            receiverCommands.play++;
            lastCommandedReceiverState = "PLAYING";
            return Promise.resolve();
        },
        seek: () => {
            calls.seek++;
            receiverCommands.seek++;
        },
        calls
    };
}

/**
 * A Bilibili Chromecast sender: DASH remux (a separate audio URL), page
 * controls forwarded with the production gesture gate ON, position sync on.
 */
async function makeSender(MediaSender, opts = {}) {
    // Set BEFORE the sender's constructor: its init() reads the options once.
    fixtureOptions =
        opts.startupPadding === undefined
            ? null
            : { chromecastDashStartupPadding: opts.startupPadding };
    receiverCommands.pause = 0;
    receiverCommands.play = 0;
    receiverCommands.seek = 0;
    lastCommandedReceiverState = undefined;
    pageSeeksDeferred = false;
    timers.timeouts.length = 0;
    windowListeners.clear();
    const element = makeElement({
        paused: opts.pagePaused ?? false,
        currentTime: opts.pageTime ?? 0
    });
    // The page key of the media being played. A new element (a new video) gets a
    // new one; the initial cast starts on `video-a`.
    let mediaIdentity = "video-a";
    let mediaIdentityGeneration = 0;
    const sender = new MediaSender({
        mediaUrl: opts.mediaUrl ?? "https://example.invalid/video.m4s",
        mediaElement: element,
        mediaContentType: "application/x-mpegURL",
        mediaTitle: "matrix",
        mediaIdentity,
        isVideo: true,
        remoteProxy: {
            referer: BILIBILI_REFERER,
            audioUrl: opts.audioUrl ?? "https://example.invalid/audio.m4s"
        },
        forwardPageControls: true,
        gestureGatedControls: true,
        debug: noop
    });

    const sessionState = { media: [], loadRequests: [] };
    const started = [];
    const state = {
        sender,
        element,
        started,
        loadRequests: sessionState.loadRequests,
        /** The startup-padding policy this fixture is running under. */
        startupPadding: opts.startupPadding ?? true,
        /** Remux generations this sender has started (the observable restart). */
        restarts: () => started.length,
        tick: async () => {
            if (latestInterval) latestInterval();
            await flush();
        },
        /** The requestId of the generation the receiver is currently served. */
        liveRequestId: () => started.at(-1)?.requestId,
        /** The page key of the media being played right now. */
        mediaIdentity: () => mediaIdentity,
        /** The key a switch will adopt: a different video. */
        nextMediaIdentity: () =>
            `video-${String.fromCharCode(97 + ++mediaIdentityGeneration)}`,
        /** The content id a session for the live generation reports. */
        contentIdForGeneration: requestId =>
            `http://127.0.0.1:9555/s/${requestId}/index.m3u8`,
        setReceiverState: (
            playerState,
            estimatedTime,
            mediaSessionId,
            requestId = started.at(-1)?.requestId
        ) => {
            const media = makeMedia(
                playerState,
                estimatedTime,
                mediaSessionId,
                state.contentIdForGeneration(requestId)
            );
            sessionState.media = [...sessionState.media.slice(-2), media];
            return media;
        },
        lastLoad: () => sessionState.loadRequests.at(-1),
        /**
         * Hold the element's `seeked` back: the page has been ASKED to move and
         * has not arrived. The state a row uses to prove that nothing downstream
         * may start on an unconfirmed target.
         */
        deferPageSeeks: () => {
            pageSeeksDeferred = true;
        },
        /**
         * Deliver the element's `seeked`: the page has arrived. The CURRENT
         * element, not the one the fixture was built with - a switch replaces it
         * (see driveItemChange).
         */
        completePageSeek: () => state.element.completePageSeek(),
        /** The fixture's own arrival, for rows that are not testing the wait. */
        autoCompletePageSeek: () => {
            if (pageSeeksDeferred) return;
            // With the paused-player model the fixture may only deliver the
            // arrival if the element is playing - that rule IS the reported
            // symptom (pause the page, write currentTime, and the position waits
            // for something to play the page again).
            if (state.element.pausedPlayerModel && state.element.paused) return;
            state.element.completePageSeek();
        },
        /**
         * Model the page player as it really behaves: a seek requested while it is
         * PAUSED does not land until it is played again (`element.play()`, which
         * is what the receiver's PLAYING report causes through resumePage).
         */
        modelPausedPagePlayer: () => {
            state.element.pausedPlayerModel = true;
        },
        /**
         * Every receiver-side play/pause/seek the sender has issued, MONOTONIC
         * across sessions (a session window that slides must not make the total go
         * down). "Did the sender COMMAND the receiver" is a different question from
         * "what state did the receiver report": a status report must never produce
         * a command, and a skip must never produce a play.
         */
        receiverCommandTotals: () => ({ ...receiverCommands }),
        /**
         * What the extension last told the receiver to do - the state the receiver
         * will report back on its next status ("the echo"). `undefined` means
         * nothing has been commanded since the fixture was built.
         */
        lastCommandedReceiverState: () => lastCommandedReceiverState,
        resolveLoad: media => {
            const entry = sessionState.loadRequests.at(-1);
            if (!entry) return false;
            entry.onSuccess(media ?? entry.media);
            return true;
        }
    };

    sender.session = {
        receiver: { label: "Chromecast-MATRIX" },
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
                // A LOAD callback's own Media can be the previous session's
                // object (the real SDK behaves this way). The rows that need a
                // specific session pass one explicitly to resolveLoad.
                media: makeMedia(
                    PlayerState.PLAYING,
                    request.currentTime ?? 0,
                    sessionState.loadRequests.length + 1,
                    state.contentIdForGeneration(undefined)
                )
            });
        },
        addUpdateListener: noop,
        removeUpdateListener: noop,
        stop: noop,
        sendMessage: noop
    };

    latestInterval = undefined;
    sender.addMediaElementListeners(element);
    global.__onCastPortMessage = message => {
        if (message?.subject === "bridge:startRemoteMediaServer") {
            started.push(message.data);
        }
    };
    await flush();
    return state;
}

/**
 * Answer the newest `bridge:startRemoteMediaServer` with the plan for the page
 * position it asked for and the keyframe the probe would report. This is the
 * only place a bridge answer is fabricated, and it is fabricated from the
 * bridge's own arithmetic (layer 1).
 */
async function answerBridgeWithPlan(plan) {
    const requestId = global.__lastStartedRequestId;
    global.__castPortDispatch({
        subject: "mediaCast:mediaServerStarted",
        data: {
            requestId,
            // Generation-scoped, as the bridge serves it; the sender appends its
            // own cache-busting query on top.
            mediaPath: `s/${requestId}/index.m3u8`,
            localAddress: "127.0.0.1",
            mode: "dash-remux",
            startTime: plan.pageStart,
            padBaseSeconds: plan.padBase,
            probedKeyframeSeconds: plan.contentBase,
            presentationStartTime: plan.receiverStart,
            pageDuration: PAGE_DURATION
        }
    });
    await flush();
}

// ---------------------------------------------------------------------------
// 4. Driving the origin's entry point
// ---------------------------------------------------------------------------

/** A real user drag on the site's progress bar: gesture, then the event pair. */
async function drivePageSeek(h, target, { gesture = true } = {}) {
    if (gesture) global.__dispatchGesture();
    h.element.placeAt(target);
    // This pair IS the element's echo of the move above (a user's own drag), so
    // nothing is left owed for a later programmatic-write echo to invent.
    h.element.emit("seeking");
    h.element.emit("seeked");
    await flush();
    await fireSeekDebounce(h);
}

/** The popup's seek route (background/castManager -> page sender). */
async function drivePopupSeek(h, target) {
    h.sender.seekDashRemux(target);
    await flush();
    await fireSeekDebounce(h);
}

/**
 * Fire the seek debounce and let the page arrive.
 *
 * The restart's own page hold is a WRITE; the element then reports `seeked` when
 * it has the data, and the sender's handoff waits for exactly that before it
 * starts the generation (see MediaSender#ensurePageAtTarget). A row that is
 * proving the wait holds the arrival back itself (see deferPageSeeks), which is
 * why this is a helper and not something baked into the driver's actions.
 */
async function fireSeekDebounce(h) {
    fireTimeout(SEEK_DEBOUNCE_MS);
    await flush();
    h.autoCompletePageSeek();
    await flush();
}

/**
 * The browser's echo of the extension's OWN page write.
 *
 * `writePageTime` moves the element, and a real element then queues a
 * `seeking`/`seeked` pair for that move; the sender attributes that pair to its
 * own write. A harness whose setter fires nothing leaves the attribution window
 * open for the full PAGE_WRITE_ACK_WINDOW_MS and the NEXT user seek gets
 * swallowed by it - a harness artifact, not a product behaviour. It is emitted
 * only when the element actually moved: a write the sender skipped (the page was
 * already at the target) produces no event in a browser either, and inventing one
 * would be indistinguishable from a page seek.
 */
async function echoProgrammaticWrite(h) {
    if (!h.element.takeWriteEcho()) return false;
    // The write fired its own `seeking` (the element acknowledging the request);
    // this is the arrival, which the fixture delivers now unless the row is
    // deliberately holding it back (see deferPageSeeks).
    h.autoCompletePageSeek();
    await flush();
    return true;
}

/** A BLE skip that lands on `target`: the page sits one step ahead of it. */
async function driveBleSeek(h, target, step = 30) {
    h.element.placeAt(target + step);
    h.sender.controlFromBleRemote("seek_backward", step, 0);
    await flush();
    await fireSeekDebounce(h);
}

/**
 * A new video (or a new element for the same video): the page sender's own
 * sequence — the transition window opens BEFORE the reload, then the updated
 * element is handed to `updateMedia`.
 */
async function driveItemChange(
    h,
    target,
    { sameElement = false, identity } = {}
) {
    const element = sameElement
        ? h.element
        : makeElement({ paused: false, currentTime: target });
    if (!sameElement) {
        // The harness states where the new page is; that is not a browser event
        // for a later programmatic-write echo to claim.
        element.placeAt(target);
        h.element = element;
    }
    // A new page element is a NEW video, so its key changes; a quality change is
    // the same video (and the same key), which is what lets a pending seek survive
    // one and not the other (see MediaSender#adoptMediaIdentity).
    const mediaIdentity =
        identity ?? (sameElement ? h.mediaIdentity() : h.nextMediaIdentity());
    h.sender.beginDashItemTransition();
    h.sender.prepareUpdatedMediaElement(element);
    void h.sender
        .updateMedia({
            mediaUrl: sameElement
                ? "https://example.invalid/video-quality-2.m4s"
                : "https://example.invalid/video-next.m4s",
            mediaTitle: "matrix-next",
            mediaContentType: "application/x-mpegURL",
            mediaElement: element,
            mediaIdentity,
            isVideo: true,
            remoteProxy: {
                referer: BILIBILI_REFERER,
                audioUrl: "https://example.invalid/audio-next.m4s"
            },
            forwardPageControls: true,
            gestureGatedControls: true,
            debug: noop
        })
        .catch(() => undefined);
    await flush();
    return element;
}

/**
 * ONE live cast, driven step by step. Every method is a production entry point;
 * the only thing the driver adds is the counterpart each entry point needs: the
 * bridge's answer (built from the bridge's own arithmetic), a receiver that
 * accepts the LOAD and then reports its own position, and the browser's echo of
 * the extension's own page writes.
 */
async function startCast(
    MediaSender,
    { pageTime = 0, startupPadding = undefined } = {}
) {
    const h = await makeSender(MediaSender, { pageTime, startupPadding });
    const answered = new Set();
    const generations = [];
    let sessionId = 1;

    const cast = {
        h,
        generations,
        /**
         * The media session the receiver is currently reporting on. Rows that
         * deliver their own receiver state need it: "the session we already had
         * moved" and "a new session appeared" are different events, and only the
         * first one is the user acting on another controller.
         */
        receiverSessionId: () => sessionId,
        /**
         * The bridge's plan for a requested start. `startupPadding` defaults to
         * this fixture's policy, because the plan a LOAD is answered with is the
         * BRIDGE's decision under that option - a row that wants the other policy
         * passes it explicitly.
         */
        plan: (pageStart, startupPadding = h.startupPadding) =>
            bridgePlan.plan(pageStart, keyframeFor(pageStart), startupPadding),

        /**
         * Answer the newest unanswered generation: the bridge states the plan
         * for the position the sender asked for, the receiver accepts the LOAD,
         * and then reports where it was loaded (the padded position) on its own
         * clock. That report is also what closes an item transition and releases
         * a seek's priming window, so it belongs in every step.
         */
        async answerNewest() {
            const started = h.started.at(-1);
            if (!started || answered.has(started.requestId)) return false;
            answered.add(started.requestId);
            const plan = cast.plan(started.startTime);
            cast.lastPlan = plan;
            global.__lastStartedRequestId = started.requestId;
            await answerBridgeWithPlan(plan);
            const load = h.lastLoad();
            const session = ++sessionId;
            // What the receiver does with the LOAD follows its `autoplay`, which
            // is the sender's statement of the USER's playback intent: a reload
            // for a paused user loads paused and stays paused. A harness that
            // always reported PLAYING here would make "the pause survived" and
            // "the pause was overwritten" indistinguishable.
            const receiverState =
                load?.request?.autoplay === false
                    ? PlayerState.PAUSED
                    : PlayerState.PLAYING;
            h.resolveLoad(
                makeMedia(
                    receiverState,
                    plan.receiverStart,
                    session,
                    h.contentIdForGeneration(started.requestId)
                )
            );
            await flush();
            h.setReceiverState(
                receiverState,
                plan.receiverStart,
                session,
                started.requestId
            );
            await h.tick();
            generations.push({
                requestId: started.requestId,
                startTime: started.startTime,
                plan,
                load
            });
            return true;
        },

        /**
         * Answer the newest generation's bridge request and then have the
         * receiver REFUSE the LOAD (the SDK error callback). The rows about a
         * FAILED item load need this: the question is what happens to an explicit
         * seek that the failed load had coalesced.
         */
        async answerAndRefuseNewest(reason = "INTERRUPTED") {
            const started = h.started.at(-1);
            if (!started || answered.has(started.requestId)) return false;
            answered.add(started.requestId);
            const plan = cast.plan(started.startTime);
            cast.lastPlan = plan;
            global.__lastStartedRequestId = started.requestId;
            await answerBridgeWithPlan(plan);
            const load = h.lastLoad();
            generations.push({
                requestId: started.requestId,
                startTime: started.startTime,
                plan,
                load,
                refused: true
            });
            load?.onError?.({ code: "INVALID_REQUEST", description: reason });
            await flush();
            return true;
        },

        /** Await the bridge request a just-started action is going to post. */
        async waitForGeneration(rounds = 40) {
            for (let i = 0; i < rounds; i++) {
                const started = h.started.at(-1);
                if (started && !answered.has(started.requestId)) return started;
                await flush(2);
            }
            return undefined;
        },

        /**
         * Drain the transaction loop. A burst that was queued while one
         * generation was in flight is served one generation per intent, so the
         * loop's own sequencing is part of what a step measures.
         */
        async settle(max = 8) {
            // The page's own arrival is part of "settled": a row that is not
            // testing the wait must not have to deliver it by hand. It is
            // re-checked every round, because a restart the settle itself
            // releases can owe a fresh one.
            for (let round = 0; round < max; round++) {
                h.autoCompletePageSeek();
                if (!(await cast.answerNewest())) break;
                h.autoCompletePageSeek();
                await flush();
            }
            h.autoCompletePageSeek();
            return cast;
        },

        /** The cast's own load (an initial cast, or a recovery-shaped reload). */
        async boot() {
            h.sender.loadMedia().catch(() => undefined);
            await flush();
            return cast.settle();
        },

        // ---- the user's actions ------------------------------------------
        /** The page's progress bar: a gesture, then the browser's event pair. */
        /**
         * Hold the element's `seeked` back: the page has been ASKED to move and
         * has not arrived. This is the state a row uses to prove nothing
         * downstream may start on an unconfirmed target.
         */
        deferPageSeeks() {
            h.deferPageSeeks();
            return cast;
        },

        /**
         * Model the page player as it really behaves: a seek asked for while it is
         * PAUSED only lands once it is played again.
         */
        modelPausedPagePlayer() {
            h.modelPausedPagePlayer();
            return cast;
        },

        /** Deliver the element's `seeked`: the page has arrived. */
        async completePageSeek() {
            pageSeeksDeferred = false;
            h.completePageSeek();
            await flush();
            return cast;
        },

        /** The fixture's own arrival, for rows that are not testing the wait. */
        autoCompletePageSeek() {
            h.autoCompletePageSeek();
            return cast;
        },

        async pageSeek(seconds, { gesture = true } = {}) {
            if (gesture) global.__dispatchGesture();
            h.element.placeAt(seconds);
            // The pair below IS the element's event for that move.
            h.element.emit("seeking");
            h.element.emit("seeked");
            await flush();
            await fireSeekDebounce(h);
            return cast;
        },

        /** The player's own seek (buffering, quality, navigation): no gesture. */
        autonomousSeek(seconds) {
            return cast.pageSeek(seconds, { gesture: false });
        },

        /**
         * The popup's seek. `debounce: false` leaves it queued inside the
         * debounce window, which is what a second drag before the first restart
         * begins looks like; the default fires the window, starting the restart.
         */
        async popupSeek(seconds, { debounce = true } = {}) {
            h.sender.seekDashRemux(seconds);
            await flush();
            // The hold parks the page at the target; the element's echo of that
            // write belongs to the write (see echoProgrammaticWrite).
            await echoProgrammaticWrite(h);
            if (debounce) await fireSeekDebounce(h);
            return cast;
        },

        /** A BLE skip that lands on `seconds`: the page sits one step ahead. */
        /**
         * A raw BLE remote command, with no help from the page.
         *
         * `at` places the page exactly there first, and `target` places it one step
         * away from a skip's landing position - both are "where the page already
         * is", written without events, because that is the input the command needs.
         * Without either, the page stays where it is, which is what the no-op rows
         * (a skip at a boundary) and the play/pause rows need.
         */
        async ble(action, { target, at, step = 30 } = {}) {
            if (at !== undefined) {
                h.element.placeAt(at);
            } else if (target !== undefined) {
                h.element.placeAt(
                    action === "seek_backward" ? target + step : target - step
                );
            }
            h.sender.controlFromBleRemote(
                action,
                action === "seek_backward" ? step : 0,
                action === "seek_forward" ? step : 0
            );
            await flush();
            await echoProgrammaticWrite(h);
            await fireSeekDebounce(h);
            return cast;
        },

        /** A BLE backward skip that lands on `seconds`. */
        bleSeek(seconds, step = 30) {
            return cast.ble("seek_backward", { target: seconds, step });
        },

        /**
         * A video switch: a new element for a new video, at `at`. `identity`
         * overrides the page key the switch adopts (the cross-video rows name the
         * videos they mean).
         */
        async switchVideo(at, options = {}) {
            await driveItemChange(h, at, options);
            return cast;
        },

        /**
         * A quality change: the same element, the same video, a new URL. The
         * page is wherever playback has reached, so "the page is at `at`" is
         * stated by moving the element there - deliberately not a seek: no
         * events, no intent.
         */
        async qualityChange(at) {
            // "Playback reached here" is not a browser event either.
            h.element.placeAt(at);
            await driveItemChange(h, at, { sameElement: true });
            return cast;
        },

        async pause() {
            h.sender.controlPlayback({
                intent: "PAUSE",
                commandId: `matrix-${++cast.commandId}`,
                mediaIdentity: "matrix"
            });
            await flush();
            fireTimeout(2000);
            await flush();
            return cast;
        },

        async play() {
            h.sender.controlPlayback({
                intent: "PLAY",
                commandId: `matrix-${++cast.commandId}`,
                mediaIdentity: "matrix"
            });
            await flush();
            fireTimeout(2000);
            await flush();
            return cast;
        },

        /**
         * A receiver session report, from ANY generation - including one that no
         * longer exists, which is the order a real receiver produces after a
         * reload: the old session keeps broadcasting while the new one starts.
         */
        async report(playerState, seconds, mediaSessionId, requestId) {
            h.setReceiverState(
                playerState,
                seconds,
                mediaSessionId,
                requestId ?? h.liveRequestId()
            );
            await h.tick();
            return cast;
        },

        /**
         * The receiver keeps talking after every action: its session reports
         * positions on its own (padded) clock, and a generation that no longer
         * exists can still broadcast. None of that may start a generation or
         * move the page.
         */
        async noise() {
            const current = h.liveRequestId();
            const padded = cast.lastPlan ? cast.lastPlan.receiverStart : 0;
            for (const [playerState, seconds] of [
                [PlayerState.PLAYING, padded],
                [PlayerState.PLAYING, 0],
                [PlayerState.PAUSED, padded],
                [PlayerState.BUFFERING, padded + 12],
                [PlayerState.PLAYING, padded + 40]
            ]) {
                h.setReceiverState(playerState, seconds, ++sessionId, current);
                await h.tick();
            }
            h.setReceiverState(
                PlayerState.PLAYING,
                999,
                999,
                "stale-generation"
            );
            await h.tick();
            return cast;
        }
    };
    cast.commandId = 0;
    return cast;
}

module.exports = {
    BASELINE_PAGE_TIME,
    SEEK_DEBOUNCE_MS,
    PAGE_DURATION,
    BILIBILI_REFERER,
    PlayerState,
    noop,
    repoRoot,
    esbuildPath,
    resolveSendersDir,
    installGlobals,
    fireTimeout,
    flush,
    buildSender,
    makeElement,
    makeMedia,
    makeSender,
    answerBridgeWithPlan,
    drivePageSeek,
    drivePopupSeek,
    fireSeekDebounce,
    echoProgrammaticWrite,
    driveBleSeek,
    driveItemChange,
    startCast
};
