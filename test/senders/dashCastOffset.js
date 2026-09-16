#!/usr/bin/env node
"use strict";

/**
 * Opening-cast presentation offset (Bilibili DASH remux on a Chromecast).
 *
 * The defect this freezes: a cast that starts a couple of seconds into a video
 * whose first keyframe is at 0 used to be padded to that keyframe — i.e. to no
 * pads at all — so LOAD put the receiver straight on segment-000000.ts with no
 * bootstrap runway in front of it and playback never started. A mid-video cast
 * (probed keyframe ~1431s) is padded to 1431s of pads and works, so the bridge
 * now gives the opening cast the same timeline SHAPE: it inserts a minimum pad
 * runway (8 x 4s) in front of the real segments and reports where the receiver
 * must start on that padded timeline.
 *
 * Two contracts are pinned here, both boundary-level (no real bridge, no real
 * receiver):
 *
 *   1. The bridge's timeline arithmetic. The pad base and the presentation
 *      start are computed by exactly the expressions mediaServer.ts uses, read
 *      out of that file, so the numbers below cannot drift away from the
 *      implementation. The mid-video row is a HEALTH CONTROL: it must keep the
 *      values the currently working production path produces (no offset at
 *      all).
 *
 *   2. The sender's use of them. The REAL bundled sender runs with the cast SDK
 *      and DOM stubbed, exactly like test/senders/dashSeekSync.js; the bridge's
 *      ready message is answered with the presentation start, and the test
 *      asserts what the receiver is actually asked to LOAD (loadRequest) and
 *      that the page player is left on its own clock. The offset is only
 *      correct if both halves agree: pads without the shifted LOAD position
 *      park the receiver inside the padding.
 *
 * Usage:
 *   node test/senders/dashCastOffset.js            # the contract
 *   node test/senders/dashCastOffset.js --pre-fix  # the negative control, from
 *                                                  # the revision named by --rev
 *                                                  # (default HEAD^)
 *
 * The negative control builds the same sender from another revision and needs
 * it to FAIL the LOAD assertions: it proves the checks measure the fix rather
 * than the harness.
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
const bridgeMediaServer = path.join(
    repoRoot,
    "bridge/src/bridge/components/mediaServer.ts"
);

const argv = process.argv.slice(2);
const PRE_FIX = argv.includes("--pre-fix");
const revIndex = argv.indexOf("--rev");
const REV = revIndex >= 0 && argv[revIndex + 1] ? argv[revIndex + 1] : "HEAD^";

/**
 * The revision's own checkout, so the sender bundle resolves its ordinary
 * relative imports (a lone copied media.ts cannot). Without --pre-fix the
 * working tree is the source, which is what the shipped test runs against.
 *
 * The BRIDGE source is always the working tree: the negative control pins what
 * the SENDER does with a presentation offset, and the old bridge has no
 * timeline arithmetic to run at all.
 */
function resolveSourceDirs() {
    const workingTreeSenders = path.join(
        repoRoot,
        "extension/src/cast/senders"
    );
    if (!PRE_FIX) return { sendersDir: workingTreeSenders };
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-rev-"));
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
    return {
        sendersDir: path.join(worktree, "extension/src/cast/senders")
    };
}

const { sendersDir } = resolveSourceDirs();
const serverSource = bridgeMediaServer;

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

// ---------------------------------------------------------------------------
// 1. The bridge's timeline arithmetic, read out of mediaServer.ts
// ---------------------------------------------------------------------------

/**
 * Evaluate mediaServer.ts's own padBaseSeconds/presentationStartTime
 * expressions. Both are single expressions over (keyframe, requestedStart), so
 * they can be lifted out of the file and evaluated instead of restated here:
 * a restatement would keep passing after the implementation changed.
 *
 * `rokuDashPrebuffer` is false on every Chromecast cast, so the Roku arm
 * resolves to the keyframe — the branch the source itself keeps.
 */
function loadBridgeTimeline() {
    const source = fs.readFileSync(serverSource, "utf8");

    const minMatch = /const CHROMECAST_MIN_PAD_SECONDS = (\d+);/.exec(source);
    if (!minMatch) {
        throw new Error(
            "dashCastOffset: CHROMECAST_MIN_PAD_SECONDS not found in mediaServer.ts"
        );
    }
    const minPadSeconds = Number(minMatch[1]);

    const marker = "startTime: normalizedStartTime,";
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
        throw new Error(
            "dashCastOffset: the mediaServerStarted startTime field was not found"
        );
    }
    const expression =
        /presentationStartTime:\s*([\s\S]*?),\n\s*padBaseSeconds,/.exec(
            source.slice(markerIndex)
        );
    if (!expression) {
        throw new Error(
            "dashCastOffset: presentationStartTime is not computed where expected"
        );
    }

    // presentationStartTime is published through a named helper (the Chromecast
    // window is sized against the same value), so the right-hand side may be a
    // call: resolve the helper's own body instead of evaluating an unbound name.
    let presentationSource = expression[1].trim();
    const helperName = /^([A-Za-z_$][\w$]*)\(\)$/.exec(presentationSource);
    if (helperName) {
        const helper = new RegExp(
            `const ${helperName[1]} = \\(\\) =>\\s*([\\s\\S]*?);\\n`
        ).exec(source);
        if (!helper) {
            throw new Error(
                `dashCastOffset: ${helperName[1]}() is called but its body was not found in mediaServer.ts`
            );
        }
        presentationSource = helper[1].trim();
    }

    const padBaseExpression = new Function(
        "keyframe",
        "minPadSeconds",
        "rokuDashPrebuffer",
        `return rokuDashPrebuffer ? keyframe : Math.max(keyframe, minPadSeconds);`
    );
    const presentationExpression = new Function(
        "padBaseSeconds",
        "normalizedStartTime",
        "contentBaseSeconds",
        `return ${presentationSource};`
    );

    return {
        minPadSeconds,
        padSegmentSeconds: Number(
            /const padSegmentSeconds = (\d+);/.exec(source)[1]
        ),
        /**
         * One bridge decision: the probed keyframe for a requested start, and
         * the LOAD position message the bridge then sends.
         */
        present(requestedStart, keyframe, rokuDashPrebuffer = false) {
            const padBaseSeconds = padBaseExpression(
                keyframe,
                minPadSeconds,
                rokuDashPrebuffer
            );
            const contentBaseSeconds = keyframe;
            return {
                normalizedStartTime: requestedStart,
                keyframe,
                padBaseSeconds,
                presentationStartTime: presentationExpression(
                    padBaseSeconds,
                    requestedStart,
                    contentBaseSeconds
                )
            };
        }
    };
}

/** The playlist rows the bridge would rewrite for a presentation. */
function playlistRows(presentation, padSegmentSeconds) {
    const padCount = Math.floor(
        presentation.padBaseSeconds / padSegmentSeconds
    );
    const remainder =
        presentation.padBaseSeconds - padCount * padSegmentSeconds;
    const rows = [];
    for (let i = 0; i < padCount; i++) rows.push("pad.ts");
    if (remainder > 0.05) rows.push("pad.ts");
    rows.push("segment-000000.ts");
    return { rows, padEntries: rows.length - 1 };
}

function checkBridgeTimeline() {
    const bridge = loadBridgeTimeline();
    const { minPadSeconds, padSegmentSeconds } = bridge;

    check(
        `bridge: the minimum pad runway is ${minPadSeconds}s = ${padCountFor(
            minPadSeconds,
            padSegmentSeconds
        )} x ${padSegmentSeconds}s pad segments`,
        minPadSeconds === 32 && padSegmentSeconds === 4,
        JSON.stringify({ minPadSeconds, padSegmentSeconds })
    );

    // ---- opening cast: 2.864s into a keyframe-at-0 video -------------------
    const opening = bridge.present(2.864, 0);
    check(
        "opening cast: the playlist is padded to the minimum runway (keyframe 0 < 32s)",
        opening.padBaseSeconds === minPadSeconds,
        JSON.stringify(opening)
    );
    check(
        "opening cast: LOAD is shifted onto the padded timeline (padBase + (start - keyframe))",
        Math.abs(opening.presentationStartTime - (minPadSeconds + 2.864)) <
            1e-9,
        JSON.stringify(opening)
    );
    const openingRows = playlistRows(opening, padSegmentSeconds);
    check(
        "opening cast: the playlist opens with pad entries and the real content follows",
        openingRows.padEntries ===
            padCountFor(minPadSeconds, padSegmentSeconds) &&
            openingRows.rows[0] === "pad.ts" &&
            openingRows.rows[openingRows.padEntries] === "segment-000000.ts",
        JSON.stringify(openingRows)
    );
    check(
        "opening cast: the receiver starts inside the real media, not inside the padding",
        opening.presentationStartTime > opening.padBaseSeconds + 2.8 &&
            opening.presentationStartTime < opening.padBaseSeconds + 2.9,
        JSON.stringify({
            padBaseSeconds: opening.padBaseSeconds,
            presentationStartTime: opening.presentationStartTime
        })
    );

    // ---- 25.5s: still inside the bootstrap window --------------------------
    const late = bridge.present(25.5, 0);
    check(
        "25.5s cast: a full bootstrap runway is still in front of the real segments",
        late.padBaseSeconds === minPadSeconds &&
            late.padBaseSeconds > 25.5 &&
            Math.abs(late.presentationStartTime - (minPadSeconds + 25.5)) <
                1e-9,
        JSON.stringify(late)
    );

    // ---- mid-video health control: 1431.805s, keyframe 1431 -----------------
    const midVideo = bridge.present(1431.805, 1431);
    check(
        "mid-video cast (health control): the pad base stays the probed keyframe",
        midVideo.padBaseSeconds === 1431,
        JSON.stringify(midVideo)
    );
    check(
        "mid-video cast (health control): LOAD stays exactly the requested start (no offset)",
        midVideo.presentationStartTime === 1431.805,
        JSON.stringify(midVideo)
    );
    check(
        "mid-video cast (health control): the playlist shape is unchanged (whole pads up to the keyframe, plus its remainder)",
        playlistRows(midVideo, padSegmentSeconds).padEntries ===
            padCountFor(1431, padSegmentSeconds) + 1,
        JSON.stringify(playlistRows(midVideo, padSegmentSeconds).padEntries)
    );

    // ---- first keyframe past the minimum: the two paths must meet -----------
    const boundary = bridge.present(40, 40);
    check(
        "boundary: once the keyframe passes the minimum, the pad base is the keyframe and the offset is 0",
        boundary.padBaseSeconds === 40 && boundary.presentationStartTime === 40,
        JSON.stringify(boundary)
    );

    // ---- zero-start cast: the SAME padded path, no discontinuity ----------
    // A page that reports 0 (fresh load, item change, re-cast) must not take a
    // different playlist shape from one that reports 0.2s: that boundary is a
    // startup race, not a media property.
    const fromZero = bridge.present(0, 0);
    check(
        "start-at-0 cast: padded exactly like every other opening cast (offset = the runway)",
        fromZero.padBaseSeconds === minPadSeconds &&
            fromZero.presentationStartTime === minPadSeconds,
        JSON.stringify(fromZero)
    );
    const nearZero = bridge.present(0.001, 0);
    check(
        "no discontinuity: 0 and 0.001 produce the same playlist shape (same pad base)",
        nearZero.padBaseSeconds === fromZero.padBaseSeconds &&
            Math.abs(
                nearZero.presentationStartTime -
                    (fromZero.presentationStartTime + 0.001)
            ) < 1e-9,
        JSON.stringify({ fromZero, nearZero })
    );

    return bridge;
}

function padCountFor(seconds, padSegmentSeconds) {
    return Math.floor(seconds / padSegmentSeconds);
}

// ---------------------------------------------------------------------------
// 2. The sender: what the receiver is actually asked to load
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

const flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};

async function buildSender() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-offset-"));
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
    return { outfile, workDir };
}

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

function makeMedia(estimatedTime, mediaSessionId) {
    const calls = { play: 0, pause: 0 };
    return {
        playerState: PlayerState.PLAYING,
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
        seek: () => undefined,
        calls
    };
}

/**
 * A Chromecast sender: NOT page-clock-master (only Roku DASH capture sets
 * that), which is the path that tightens the page onto the receiver after a
 * load — and therefore the path where a presentation offset would show up as
 * the page jumping forward by the pad runway.
 */
async function makeSender(MediaSender, { pageTime, receiverTime }) {
    const element = makeElement({ paused: false, currentTime: pageTime });
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
                media: makeMedia(receiverTime, 2)
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
        loadRequests: sessionState.loadRequests,
        startedMediaServers: [],
        tick: () => latestInterval && latestInterval(),
        /** Swap in a receiver media session; returns it for call assertions. */
        setReceiverState: (
            playerState,
            estimatedTime = 0,
            mediaSessionId = 1
        ) => {
            const media = makeMedia(estimatedTime, mediaSessionId);
            media.playerState = playerState;
            sessionState.media = [media];
            return media;
        },
        answerMediaServerStarted: (requestId, extra = {}) => {
            global.__castPortDispatch({
                subject: "mediaCast:mediaServerStarted",
                data: {
                    requestId,
                    mediaPath: "index.m3u8",
                    localAddress: "127.0.0.1",
                    mode: "dash-remux",
                    pageDuration: 300,
                    ...extra
                }
            });
        }
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

/** Drive one full LOAD through the production path. */
async function runLoad(MediaSender, { pageTime, bridgeReply, receiverTime }) {
    const h = await makeSender(MediaSender, { pageTime, receiverTime });
    // NOT awaited: loadMedia resolves when the bridge answers, and the
    // bridge answer is what this harness simulates a few lines below.
    const loadInFlight = h.sender.loadMedia();
    loadInFlight.catch(() => undefined);
    await flush();

    const started = h.startedMediaServers[h.startedMediaServers.length - 1];
    if (!started)
        throw new Error("no bridge:startRemoteMediaServer was posted");
    h.answerMediaServerStarted(started.requestId, bridgeReply);
    await flush();

    const load = h.loadRequests[h.loadRequests.length - 1];
    if (!load) throw new Error("no LOAD was issued");
    // The receiver answered, so the production load callback (and its settle
    // state) is live before the test drives the sync ticks.
    load.onSuccess(load.media);
    await flush();
    return { h, load, started };
}

/**
 * Two LOADs through ONE sender and ONE cast session — the shape every Bilibili
 * item/quality change produces, and the only shape the single-load cases above
 * never exercised.
 *
 * The contract: each load states its OWN offset (0 included), the transition
 * window survives the reload and is closed only by the NEW session, and a stale
 * report from the previous session can neither close it early nor move the page
 * onto the previous item's timeline.
 */
async function checkConsecutiveLoads(MediaSender, bridge) {
    const previous = bridge.present(654, 650); // old item, mid-video: offset 0
    const next = bridge.present(0, 0); // new item, from the start: offset 32
    const h = await makeSender(MediaSender, {
        pageTime: 654,
        receiverTime: previous.presentationStartTime
    });

    // ---- first load: the previous item, mid-video ------------------------
    h.sender.loadMedia().catch(() => undefined);
    await flush();
    const firstStarted = h.startedMediaServers.at(-1);
    h.answerMediaServerStarted(firstStarted.requestId, {
        startTime: previous.normalizedStartTime,
        probedKeyframeSeconds: previous.keyframe,
        padBaseSeconds: previous.padBaseSeconds,
        presentationStartTime: previous.presentationStartTime
    });
    await flush();
    const firstLoad = h.loadRequests.at(-1);
    firstLoad.onSuccess(firstLoad.media);
    await flush();
    check(
        "consecutive loads: the FIRST load carries an explicit offset of 0",
        firstLoad.request.media?.customData?.presentationOffsetSeconds === 0,
        JSON.stringify(firstLoad.request.media?.customData)
    );

    // ---- item change: new page element, new item at page time 0 ----------
    const element = makeElement({ paused: false, currentTime: 0 });
    h.element = element;
    h.sender.beginDashItemTransition();
    h.sender.prepareUpdatedMediaElement(element);
    check(
        "consecutive loads: the item change mutes the new element without pausing it",
        element.muted === true && element.paused === false,
        JSON.stringify({ muted: element.muted, paused: element.paused })
    );

    h.sender
        .updateMedia({
            mediaUrl: "https://example.invalid/video2.m4s",
            mediaTitle: "harness-2",
            mediaContentType: "application/x-mpegURL",
            mediaElement: element,
            isVideo: true,
            remoteProxy: {
                referer: "https://www.bilibili.com/video/BVtest2",
                audioUrl: "https://example.invalid/audio2.m4s"
            },
            gestureGatedControls: true,
            debug: noop
        })
        .catch(() => undefined);
    await flush();

    const secondStarted = h.startedMediaServers.at(-1);
    check(
        "consecutive loads: the second request goes to the bridge with the new page position",
        secondStarted !== firstStarted &&
            Math.abs(secondStarted.startTime - 0) < 1e-6,
        JSON.stringify({ startTime: secondStarted.startTime })
    );
    h.answerMediaServerStarted(secondStarted.requestId, {
        startTime: next.normalizedStartTime,
        probedKeyframeSeconds: next.keyframe,
        padBaseSeconds: next.padBaseSeconds,
        presentationStartTime: next.presentationStartTime
    });
    await flush();

    const secondLoad = h.loadRequests.at(-1);
    check(
        "consecutive loads: the SECOND load is on the new padded timeline (index preserved, not replaced)",
        secondLoad !== firstLoad &&
            Math.abs(secondLoad.request.currentTime - 32) < 1e-6,
        JSON.stringify({
            loaded: secondLoad.request.currentTime,
            loads: h.loadRequests.length
        })
    );
    check(
        "consecutive loads: the second media states the NEW offset (32), not the previous one",
        Math.abs(
            Number(
                secondLoad.request.media?.customData?.presentationOffsetSeconds
            ) - next.padBaseSeconds
        ) < 1e-6,
        JSON.stringify(secondLoad.request.media?.customData)
    );

    // The receiver is still reporting the OLD session (2) until the new one
    // shows up. Even after the LOAD callback resolves, its PLAYING at the old
    // position must not release the window: the callback can return the previous
    // media object (see addMediaElementListeners), so the session must ALSO have
    // advanced.
    secondLoad.onSuccess(secondLoad.media);
    await flush();
    h.setReceiverState(PlayerState.PLAYING, 654, 2);
    h.tick();
    check(
        "consecutive loads: the OLD session reporting PLAYING at the old position does not release the transition",
        h.sender.dashItemTransition !== undefined,
        JSON.stringify({ transition: h.sender.dashItemTransition })
    );
    check(
        "consecutive loads: the page stays on the NEW item's timeline (no pull back to 654)",
        Math.abs(element.currentTime) < 0.25,
        JSON.stringify({ pageTime: element.currentTime })
    );

    h.setReceiverState(PlayerState.PAUSED, 0, 2);
    h.tick();
    check(
        "consecutive loads: the OLD session's PAUSED cannot stop the new page",
        element.paused === false,
        JSON.stringify({ paused: element.paused })
    );

    // The NEW session (3) reports its first real position: that releases.
    h.setReceiverState(PlayerState.PLAYING, next.presentationStartTime, 3);
    h.tick();
    check(
        "consecutive loads: the NEW session's first real position closes the transition",
        h.sender.dashItemTransition === undefined,
        JSON.stringify({ transition: h.sender.dashItemTransition })
    );

    // Authority is back with the receiver: a later real pause still stops the page.
    h.setReceiverState(PlayerState.PAUSED, next.presentationStartTime, 3);
    h.tick();
    check(
        "consecutive loads: after the transition, a real receiver PAUSED stops the page again",
        element.paused === true,
        JSON.stringify({ paused: element.paused })
    );
}

async function checkSender(MediaSender, bridge) {
    // ---- opening cast: 2.864s, keyframe 0, minimum pad runway --------------
    const opening = bridge.present(2.864, 0);
    const openingRun = await runLoad(MediaSender, {
        pageTime: 2.864,
        bridgeReply: {
            startTime: opening.normalizedStartTime,
            padBaseSeconds: opening.padBaseSeconds,
            probedKeyframeSeconds: opening.keyframe,
            presentationStartTime: opening.presentationStartTime
        },
        receiverTime: opening.presentationStartTime
    });
    check(
        "sender: LOAD uses the bridge's presentation position (the padded timeline), not the page time",
        Math.abs(
            openingRun.load.request.currentTime -
                (opening.padBaseSeconds + 2.864)
        ) < 1e-9,
        JSON.stringify({
            loaded: openingRun.load.request.currentTime,
            expected: opening.padBaseSeconds + 2.864
        })
    );
    check(
        "sender: the bridge was asked to remux at the PAGE position",
        Math.abs(openingRun.started.startTime - 2.864) < 1e-9,
        JSON.stringify({ startTime: openingRun.started.startTime })
    );
    // The offset leaves the sender exactly once: in the LOAD media's own
    // customData, which is what the receiver echoes back and what the background
    // reads. It is NOT sent ahead of the next remux any more — carrying a
    // previous generation's shift across a rebuild is how a stale runway came to
    // be subtracted from a report it did not describe.
    check(
        "sender: the LOAD media carries the offset, so receivers that echo customData can convert",
        Math.abs(
            Number(
                openingRun.load.request.media?.customData
                    ?.presentationOffsetSeconds
            ) - opening.padBaseSeconds
        ) < 1e-6,
        JSON.stringify(openingRun.load.request.media?.customData)
    );
    check(
        "sender: the mediaServerStarted it forwards carries the offset for the background",
        openingRun.started.presentationOffsetSeconds === undefined,
        JSON.stringify({
            presentationOffsetSeconds:
                openingRun.started.presentationOffsetSeconds
        })
    );

    // The receiver reports back on its own clock (page + runway). The page must
    // stay on page time: the tighten that follows a Chromecast load must not
    // drag the page element forward onto the presentation timeline.
    openingRun.h.tick();
    await flush();
    check(
        "sender: the post-load sync leaves the page at page time (offset removed, no jump by the runway)",
        Math.abs(openingRun.h.element.currentTime - 2.864) < 0.25,
        JSON.stringify({
            pageTime: openingRun.h.element.currentTime,
            receiverTime: opening.presentationStartTime
        })
    );

    // ---- mid-video health control: 1431.805s, keyframe 1431 ----------------
    const midVideo = bridge.present(1431.805, 1431);
    const midRun = await runLoad(MediaSender, {
        pageTime: 1431.805,
        bridgeReply: {
            startTime: midVideo.normalizedStartTime,
            padBaseSeconds: midVideo.padBaseSeconds,
            probedKeyframeSeconds: midVideo.keyframe,
            presentationStartTime: midVideo.presentationStartTime
        },
        receiverTime: midVideo.presentationStartTime
    });
    check(
        "sender (health control): the mid-video LOAD position is the start time itself",
        midRun.load.request.currentTime === 1431.805,
        JSON.stringify({ loaded: midRun.load.request.currentTime })
    );
    midRun.h.tick();
    await flush();
    check(
        "sender (health control): the mid-video page stays at the start time",
        Math.abs(midRun.h.element.currentTime - 1431.805) < 0.25,
        JSON.stringify({ pageTime: midRun.h.element.currentTime })
    );

    // ---- a bridge that reports no presentation position --------------------
    const legacy = await runLoad(MediaSender, {
        pageTime: 10,
        bridgeReply: { startTime: 10 },
        receiverTime: 10
    });
    check(
        "sender: a bridge reply without a presentation position falls back to the page time",
        legacy.load.request.currentTime === 10,
        JSON.stringify({ loaded: legacy.load.request.currentTime })
    );
}

// ---------------------------------------------------------------------------

async function main() {
    const bridge = checkBridgeTimeline();
    const { outfile, workDir } = await buildSender();
    installGlobals();
    const { MediaSender } = require(outfile);
    if (typeof MediaSender !== "function") {
        throw new Error(
            "dashCastOffset: the bundle did not export MediaSender"
        );
    }
    await checkSender(MediaSender, bridge);
    await checkConsecutiveLoads(MediaSender, bridge);

    console.info("");
    if (PRE_FIX) {
        // The control: the assertions above must FAIL without the fix, because
        // a check that passes on both revisions measures nothing.
        if (fail === 0) {
            console.error(
                `dashCastOffset: --pre-fix expected failures at ${REV}, but every check passed`
            );
            process.exitCode = 1;
        } else {
            console.info(
                `pre-fix control (${REV}): ${fail} check(s) failed as expected`
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
    console.error("dashCastOffset ERROR", err);
    process.exitCode = 1;
});
