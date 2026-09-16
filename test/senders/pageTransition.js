#!/usr/bin/env node
"use strict";

/**
 * Page-route playback transition: which stage of the page chain actually runs?
 *
 * Observed in a real session (Bilibili DASH remux, popup pause click):
 *
 *   Playback command handed to the page sender
 *       { commandId: 1, intent: "PAUSE", disposition: "transition-requested",
 *         receiverRequested: false }
 *   ... 12.8s of ECP samples rejected as `receiver-not-requested` ...
 *   Playback command finished
 *       { reason: "observation-unavailable", receiverPhase: "not-started" }
 *
 * i.e. the page route accepted the command, the receiver leg was never armed,
 * and the command died on the 12s dispatch watchdog. A SECOND click in the same
 * session paused the Roku within 88ms - so the page CAN drive the receiver - yet
 * the background still never saw `receiverPhase: "requested"`.
 *
 * This test drives the REAL bundled `media.ts` (cast SDK + DOM + `browser`
 * stubbed, the same scaffolding as `pauseSync.js`) through the same entry the
 * background uses - `MediaSender.controlPlayback()` - and records every stage of
 * the chain for the same commandId:
 *
 *   controlPlayback accepted            (route entered)
 *   page transition needed vs receiver-only   (the branch that decides arming)
 *   html pause/play submitted           (element.pause()/play() called)
 *   page event consumed by the arm      (consumeBleArm found this command)
 *   progress sent                       (browser.runtime.sendMessage payloads)
 *   cast media pause/play called        (the SDK call the receiver leg needs)
 *
 * Boundary: decision-level evidence, exactly like `pauseSync.js`. No real page,
 * no real receiver, no real CDN. It answers "which branch does the sender take,
 * and what does it report", not "how long the Roku took".
 *
 * Usage:
 *   node test/senders/pageTransition.js                          # gap facts
 *   node test/senders/pageTransition.js --fixed                  # post-fix contract
 *   node test/senders/pageTransition.js --pre-fix [<git-rev>]     # gap facts, older source
 *   node test/senders/pageTransition.js --pre-fix <rev> --fixed   # deliberately RED:
 *       post-fix expectations against pre-fix source (the reverse control)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const sendersDir = path.join(repoRoot, "extension/src/cast/senders");
const mediaSource = path.join(sendersDir, "media.ts");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

const argv = process.argv.slice(2);
/**
 * `--fixed` flips the two gap expectations into the post-fix ones, so one driver
 * serves both sides of the pair (the same facts are collected either way).
 */
const fixedExpectation = argv.includes("--fixed");
const preFixIndex = argv.indexOf("--pre-fix");
const preFix = preFixIndex !== -1;
const preFixRev = preFix ? argv[preFixIndex + 1] : undefined;

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
    if (cond) {
        pass++;
        console.log("  ok  ", name);
    } else {
        fail++;
        failures.push({ name, detail });
        console.log("  FAIL", name, detail === undefined ? "" : detail);
    }
};

/**
 * Narrow probe injected into the SOURCE before bundling: `consumeBleArm` is a
 * closure, so the only honest way to learn "was the page command's arm present
 * when this page event consumed the arm?" is to watch its own return decision.
 * Nothing else is touched.
 */
function instrumentSource(text) {
    const entry = `const consumeBleArm = (kind: "play" | "pause" | "seek") => {`;
    const exit = "return { ble: armed, page };";
    for (const [anchor, name] of [
        [entry, "the consumeBleArm entry"],
        [exit, "the consumeBleArm return"]
    ]) {
        const occurrences = text.split(anchor).length - 1;
        if (occurrences !== 1) {
            throw new Error(
                `pageTransition: cannot instrument ${name} (found ${occurrences})`
            );
        }
    }
    // `pageArmPresentAfter` is NOT "was there an arm": a SUCCESSFUL consumption
    // calls clearPageArm() before the return, so the arm is legitimately gone by
    // then. The discriminating pair is (before, hasPage):
    //   before=false hasPage=false -> the event had no page-command arm to
    //                                 claim; the cause may be a command-handoff
    //                                 failure OR an event-before-arm ordering,
    //                                 and this probe does not separate them
    //   before=true  hasPage=true  -> correct consumption
    //   before=true  hasPage=false -> an arm existed but did not match
    return text
        .replace(
            entry,
            entry +
                `
            const __pageArmBefore = Boolean(pageArm);
            const __pageArmBeforeIntent = pageArm ? pageArm.command.intent : null;`
        )
        .replace(
            exit,
            `{ const __probe = {
                kind,
                armed,
                pageArmPresentBefore: __pageArmBefore,
                pageArmBeforeIntent: __pageArmBeforeIntent,
                hasPage: Boolean(page),
                pageArmPresentAfter: Boolean(pageArm),
                at: Date.now()
            }; (globalThis.__armProbe = globalThis.__armProbe || []).push(__probe); }
            return { ble: armed, page };`
        );
}

async function bundle({ source, outfile, stubDir, workDir }) {
    const esbuild = require(esbuildPath);
    const sourceDir = path.dirname(source);
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
                        if (!args.importer.startsWith(sourceDir)) {
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

function writeStub(stubDir) {
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(
        path.join(stubDir, "exportStub.js"),
        `"use strict";
const noop = () => {};
const PlayerState = { IDLE: "IDLE", PLAYING: "PLAYING", PAUSED: "PAUSED", BUFFERING: "BUFFERING" };
const IdleReason = { CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED", FINISHED: "FINISHED", ERROR: "ERROR" };
const cast = {
    media: { PlayerState, IdleReason, DEFAULT: "DEFAULT" },
    addReceiverActionListener: noop,
    removeReceiverActionListener: noop,
    initialize: noop,
    requestSession: noop
};
async function ensureInit() {
    return { addEventListener: noop, removeEventListener: noop, postMessage: noop };
}
module.exports = cast;
module.exports.default = cast;
module.exports.ensureInit = ensureInit;
`
    );
}

/** Globals the bundle touches at import time; listeners are CAPTURED here. */
function installGlobals() {
    const winListeners = new Map();
    const docListeners = new Map();
    const capture = map => (type, fn) => {
        if (!map.has(type)) map.set(type, []);
        map.get(type).push(fn);
    };
    const fire = map => (type, event) => {
        for (const fn of map.get(type) || []) fn(event || { type });
    };
    global.window = {
        location: {
            protocol: "moz-extension:",
            href: "moz-extension://test/sender.html"
        },
        setInterval: fn => {
            global.__intervalCallback = fn;
            return 1;
        },
        clearInterval: () => {},
        setTimeout: (fn, ms) => {
            global.__pageArmTimeout = fn;
            global.__pageArmTimeoutMs = ms;
            return 2;
        },
        clearTimeout: () => {},
        addEventListener: capture(winListeners),
        removeEventListener: () => {},
        fire: fire(winListeners)
    };
    global.document = {
        addEventListener: capture(docListeners),
        removeEventListener: () => {},
        fire: fire(docListeners),
        querySelector: () => null,
        body: { addEventListener: () => {}, removeEventListener: () => {} },
        documentElement: {
            addEventListener: () => {},
            removeEventListener: () => {}
        },
        readyState: "complete",
        visibilityState: "visible"
    };
    global.HTMLMediaElement = class HTMLMediaElement {};
    try {
        global.navigator = { userAgent: "node-test" };
    } catch {
        // Node >= 21 exposes a read-only `navigator`; a user-agent string is not
        // needed by the decision path this test drives.
    }
    // `reportProgress` posts through this; every payload is recorded so the
    // stage table can show exactly what the background WOULD have received.
    global.__progressSent = [];
    global.browser = {
        runtime: {
            sendMessage: msg => {
                global.__progressSent.push(msg);
                return Promise.resolve(undefined);
            },
            getManifest: () => ({ version: "0.0.0-test" }),
            onMessage: { addListener: () => {} },
            lastError: undefined
        },
        storage: {
            local: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve()
            }
        }
    };
}

function makeElement({
    paused,
    currentTime = 0,
    syncPauseEvent = false,
    onPauseCall
}) {
    const listeners = new Map();
    const element = new global.HTMLMediaElement();
    element.paused = paused;
    element.currentTime = currentTime;
    element.muted = false;
    element.readyState = 4;
    element.duration = 600;
    element.calls = { play: 0, pause: 0 };
    element.play = () => {
        element.calls.play++;
        element.paused = false;
        return Promise.resolve();
    };
    element.pause = () => {
        element.calls.pause++;
        element.paused = true;
        // Runs while `mediaElement.pause()` is still on the stack: this is where
        // a synchronous throw and a re-entrant command are injected.
        if (onPauseCall) onPauseCall();
        // In a real browser `pause()` dispatches the `pause` event as a task;
        // the production defect under test is an ORDERING one, so this flag
        // reproduces the worst case the same code path allows: the event
        // arriving while `mediaElement.pause()` is still on the stack.
        if (syncPauseEvent) element.fire("pause");
    };
    element.addEventListener = (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
    };
    element.removeEventListener = () => {};
    element.fire = (type, event) => {
        for (const fn of listeners.get(type) || []) fn(event || { type });
    };
    element.listenerTypes = () => [...listeners.keys()];
    return element;
}

function makeMedia(playerState, estimatedTime) {
    return {
        playerState,
        idleReason: undefined,
        mediaSessionId: 1,
        currentTime: estimatedTime,
        calls: { play: 0, pause: 0 },
        getEstimatedTime: () => estimatedTime,
        // The real SDK calls the error callback ONLY on failure: calling it
        // unconditionally made every dispatch look failed and hid the success
        // path this test is about.
        play() {
            this.calls.play++;
        },
        pause() {
            this.calls.pause++;
        },
        addUpdateListener: () => {},
        removeUpdateListener: () => {}
    };
}

/**
 * A sender wired so a page-route command can be driven exactly as the
 * background drives it: `controlPlayback()` into the same closure the page
 * events feed.
 */
function makeSender(MediaSender, opts = {}) {
    let firstPauseCall = true;
    let reentrantResult;
    const element = makeElement({
        paused: opts.pagePaused ?? false,
        currentTime: opts.pageTime ?? 0,
        syncPauseEvent: opts.syncPauseEvent === true,
        onPauseCall: () => {
            if (!firstPauseCall) return;
            firstPauseCall = false;
            if (opts.reentrantOnPauseThrow) {
                // Command B is issued while A's `pause()` is on the stack. Its
                // own pause call hits this hook again and does nothing.
                // PLAY, because A already set `paused = true`: a second PAUSE
                // would take the already-target route and arm nothing, so there
                // would be no arm for the older dispatch to (wrongly) clear.
                reentrantResult = senderRef.controlPlayback({
                    commandId: 2,
                    intent: "PLAY",
                    mediaIdentity: {
                        ownerId: "session:test",
                        loadGeneration: 1
                    }
                });
            }
            if (opts.pauseThrows) {
                throw new Error("harness: pause sync failure");
            }
        }
    });
    const debugLines = [];
    let senderRef;
    const media = makeMedia(
        opts.playerState ?? "PLAYING",
        opts.estimatedTime ?? 0
    );
    const sender = new MediaSender({
        mediaUrl: undefined,
        mediaElement: element,
        mediaContentType: "video/mp4",
        remoteProxy: { audioUrl: "https://example.invalid/audio.m4s" },
        gestureGatedControls: true,
        forwardPageControls: true,
        debug: (...args) => debugLines.push(args.map(String).join(" "))
    });
    sender.setPreserveSourcePlayback(true);
    const sessionMessages = [];
    sender.session = {
        receiver: { label: "roku-HARNESS0001" },
        media: [media],
        addUpdateListener: () => {},
        removeUpdateListener: () => {},
        sendMessage: (...args) => sessionMessages.push(args)
    };
    global.__intervalCallback = undefined;
    global.__progressSent = [];
    global.__armProbe = [];
    sender.addMediaElementListeners(element);
    senderRef = sender;
    return {
        sender,
        element,
        media,
        sessionMessages,
        debugLines,
        progress: () => global.__progressSent.slice(),
        armProbe: () => (global.__armProbe || []).slice(),
        reentrantResult: () => reentrantResult,
        command: {
            commandId: opts.commandId ?? 1,
            intent: "PAUSE",
            mediaIdentity: { ownerId: "session:test", loadGeneration: 1 }
        }
    };
}

/** The stage table for ONE scenario. */
function runScenario(MediaSender, label, opts) {
    const wired = makeSender(MediaSender, opts);
    let threw = null;
    let result;
    try {
        result = wired.sender.controlPlayback(wired.command);
    } catch (err) {
        // The pre-fix source lets the synchronous failure escape
        // `controlPlayback()` entirely; the fixed source reports it.
        threw = String((err && err.message) || err);
    }
    const afterDispatch = {
        elementPaused: wired.element.paused,
        elementCalls: { ...wired.element.calls },
        castCalls: { ...wired.media.calls },
        progress: wired.progress().map(m => m && m.data)
    };
    // A real user gesture precedes the page's own control in the reported case
    // (the popup click leads to the page player's own transition).
    if (opts.gesture) wired.element.fire("pointerdown");
    wired.element.fire("pause");
    if (opts.reentrantOnPauseThrow) {
        // B's own page transition: fired after A's failure unwound, which is
        // exactly what proves A did not clear B's arm.
        wired.element.fire("play");
    }
    // The delayed-event control: the page event arrives after
    // `controlPlayback()` has already returned (and therefore after the arm
    // install block ran to completion).
    const afterEvent = {
        elementPaused: wired.element.paused,
        elementCalls: { ...wired.element.calls },
        castCalls: { ...wired.media.calls },
        progress: wired.progress().map(m => m && m.data)
    };
    const armProbe = wired.armProbe();
    return {
        label,
        accepted: result,
        threw,
        reentrantResult: wired.reentrantResult(),
        dispatchOutcome: wired.sender.lastPlaybackDispatch,
        afterDispatch,
        afterEvent,
        armProbe,
        debugLines: wired.debugLines
    };
}

function phases(progressList) {
    return progressList.map(p => p && p.pagePhase).filter(Boolean);
}
function receiverPhases(progressList) {
    return progressList.map(p => p && p.receiverPhase).filter(Boolean);
}

async function main() {
    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-page-transition-")
    );
    const stubDir = path.join(workDir, "stub");
    writeStub(stubDir);

    // The probe goes into the SOURCE, so it works for the current tree and for a
    // pre-fix revision alike. (Skipping this write made `armProbe` empty on every
    // scenario, which reads exactly like "the arm was never consulted" - a
    // missing call site, not a failing one.)
    let raw = fs.readFileSync(mediaSource, "utf8");
    let label = "media.ts";
    if (preFix) {
        const rev = preFixRev || "HEAD^";
        const show = spawnSync(
            "git",
            ["show", `${rev}:extension/src/cast/senders/media.ts`],
            {
                cwd: repoRoot,
                encoding: "utf8"
            }
        );
        if (show.status !== 0) {
            console.error("cannot read media.ts from", rev, show.stderr);
            process.exit(1);
        }
        raw = show.stdout;
        label = `pre-fix media.ts (${rev})`;
    }
    // Written INSIDE the senders directory: the sender imports its siblings
    // relatively (`../../lib/logger`), so a copy in a temp dir cannot resolve
    // them. Removed in the `finally` below, whatever happens.
    const source = path.join(sendersDir, ".pageTransition.instrumented.ts");
    fs.writeFileSync(source, instrumentSource(raw));
    const bundlePath = path.join(workDir, "media.bundle.cjs");
    console.log("bundling", label, "(consumeBleArm probe injected)");
    await bundle({ source, outfile: bundlePath, stubDir, workDir });

    installGlobals();
    const { MediaSender } = require(bundlePath);

    const scenarios = [
        {
            label: "page PLAYING, page event arrives DURING mediaElement.pause() (production order)",
            pagePaused: false,
            gesture: true,
            playerState: "PLAYING",
            syncPauseEvent: true
        },
        {
            label: "page PLAYING, page event arrives AFTER controlPlayback returned (control)",
            pagePaused: false,
            gesture: true,
            playerState: "PLAYING",
            syncPauseEvent: false
        },
        {
            label: "page PAUSED, gesture, pause (already-target route)",
            pagePaused: true,
            gesture: true,
            playerState: "PAUSED"
        },
        {
            label: "page PLAYING, pause() throws synchronously",
            pagePaused: false,
            gesture: true,
            playerState: "PLAYING",
            pauseThrows: true,
            syncPauseEvent: false
        },
        {
            label: "page PLAYING, pause() throws AFTER a re-entrant command B armed",
            pagePaused: false,
            gesture: true,
            playerState: "PLAYING",
            pauseThrows: true,
            reentrantOnPauseThrow: true,
            syncPauseEvent: false
        }
    ];
    const results = scenarios.map(s => runScenario(MediaSender, s.label, s));

    console.log("\n=== stage table ===");
    for (const r of results) {
        console.log(`\n[${r.label}]`);
        console.log("  controlPlayback ->", JSON.stringify(r.accepted));
        console.log(
            "  lastPlaybackDispatch ->",
            JSON.stringify(r.dispatchOutcome)
        );
        console.log("  element listeners:", "(see above)");
        console.log(
            "  after dispatch: page calls",
            JSON.stringify(r.afterDispatch.elementCalls),
            "cast calls",
            JSON.stringify(r.afterDispatch.castCalls),
            "progress",
            JSON.stringify(r.afterDispatch.progress)
        );
        console.log(
            "  after page pause event: page calls",
            JSON.stringify(r.afterEvent.elementCalls),
            "cast calls",
            JSON.stringify(r.afterEvent.castCalls),
            "progress",
            JSON.stringify(r.afterEvent.progress)
        );
        console.log("  consumeBleArm probe:", JSON.stringify(r.armProbe));
        if (r.debugLines.length)
            console.log("  debug:", JSON.stringify(r.debugLines.slice(-6)));
    }

    console.log("\n=== segmented facts ===");
    // Indices, not adjectives: results[1] is the DELAYED-event control, and
    // reading it as "the paused page" asserted the already-target expectations
    // against the wrong scenario.
    const syncCase = results[0];
    const delayedCase = results[1];
    const alreadyTargetCase = results[2];

    check(
        "sync page event: controlPlayback reports the page transition route (receiverRequested false, exactly like the real session log)",
        syncCase.accepted &&
            syncCase.accepted.accepted === true &&
            syncCase.accepted.disposition === "transition-requested" &&
            syncCase.accepted.receiverRequested === false,
        JSON.stringify(syncCase.accepted)
    );
    check(
        "sync page event: html pause was submitted exactly once",
        syncCase.afterDispatch.elementCalls.pause === 1,
        JSON.stringify(syncCase.afterDispatch.elementCalls)
    );
    check(
        "sync page event: the receiver WAS driven (cast media.pause called exactly once)",
        syncCase.afterEvent.castCalls.pause === 1,
        JSON.stringify(syncCase.afterEvent.castCalls)
    );
    // Shared facts above; the two timing scenarios now each have a gap and a
    // post-fix expectation, so `--fixed` cannot leave a stale gap assertion
    // behind and fail a correct fix.
    const syncClaimed = syncCase.armProbe.some(
        p =>
            p.kind === "pause" &&
            p.armed === true &&
            p.pageArmPresentBefore === true &&
            p.hasPage === true &&
            p.pageArmPresentAfter === false
    );
    const syncReported =
        phases(syncCase.afterEvent.progress).includes("target-observed") &&
        receiverPhases(syncCase.afterEvent.progress).includes("requested");
    if (!fixedExpectation) {
        check(
            "gap: the synchronous page event had no page-command arm to claim (the receiver was driven through the BLE arm)",
            syncCase.afterEvent.progress.length === 0 &&
                syncCase.armProbe.some(
                    p =>
                        p.kind === "pause" &&
                        p.armed === true &&
                        p.pageArmPresentBefore === false &&
                        p.hasPage === false
                ),
            JSON.stringify({
                progress: syncCase.afterEvent.progress,
                armProbe: syncCase.armProbe
            })
        );
    } else {
        check(
            "post-fix: the synchronous page event claimed its page-command arm",
            syncClaimed,
            JSON.stringify({ armProbe: syncCase.armProbe })
        );
        check(
            "post-fix: the synchronous page event reported the receiver dispatch (target-observed, then receiverPhase=requested)",
            syncReported,
            JSON.stringify(syncCase.afterEvent.progress)
        );
    }

    const delayedClaimed = delayedCase.armProbe.some(
        p =>
            p.kind === "pause" &&
            p.pageArmPresentBefore === true &&
            p.hasPage === true &&
            p.pageArmPresentAfter === false
    );
    const delayedReported =
        phases(delayedCase.afterEvent.progress).includes("target-observed") &&
        receiverPhases(delayedCase.afterEvent.progress).includes("requested");
    if (fixedExpectation) {
        check(
            "post-fix: the page event CLAIMS its page-command arm (before=true, hasPage=true, after=false)",
            delayedClaimed,
            JSON.stringify({ armProbe: delayedCase.armProbe })
        );
        check(
            "post-fix: the page command is reported to the receiver leg (target-observed, then receiverPhase=requested)",
            delayedReported,
            JSON.stringify(delayedCase.afterEvent.progress)
        );
    } else {
        check(
            "the page command was stored on the sender instance but never reached the listener closure that installs the page arm",
            delayedCase.armProbe.some(
                p =>
                    p.kind === "pause" &&
                    p.pageArmPresentBefore === false &&
                    p.hasPage === false
            ) && delayedCase.afterEvent.progress.length === 0,
            JSON.stringify({
                progress: delayedCase.afterEvent.progress,
                armProbe: delayedCase.armProbe
            })
        );
    }

    check(
        "already-target control: the receiver leg is reported synchronously (no page progress needed)",
        alreadyTargetCase.accepted &&
            alreadyTargetCase.accepted.disposition === "already-target" &&
            alreadyTargetCase.accepted.receiverRequested === true &&
            typeof alreadyTargetCase.accepted.receiverDispatchStartedAt ===
                "number",
        JSON.stringify(alreadyTargetCase.accepted)
    );
    check(
        "already-target control: the page player is NOT touched and the receiver is driven exactly once",
        alreadyTargetCase.afterEvent.elementCalls.pause === 0 &&
            alreadyTargetCase.afterEvent.castCalls.pause === 1,
        JSON.stringify({
            element: alreadyTargetCase.afterEvent.elementCalls,
            cast: alreadyTargetCase.afterEvent.castCalls
        })
    );

    const throwCase = results[3];
    const reentrantCase = results[4];
    const throwCastPause = throwCase.afterEvent.castCalls.pause;
    const throwReportedRequested = receiverPhases(
        throwCase.afterEvent.progress
    ).includes("requested");
    const bClaimed = reentrantCase.armProbe.some(
        p =>
            // B's own transition is a PLAY, so its event is a play event.
            p.kind === "play" &&
            p.pageArmPresentBefore === true &&
            p.pageArmBeforeIntent === "PLAY" &&
            p.hasPage === true
    );
    const bReported = reentrantCase.afterEvent.progress.some(
        m => m && m.commandId === 2 && m.pagePhase === "target-observed"
    );
    const bRequested = reentrantCase.afterEvent.progress.some(
        m => m && m.commandId === 2 && m.receiverPhase === "requested"
    );
    const bDisposition = reentrantCase.reentrantResult;
    console.log("\n=== synchronous-throw scenarios ===");
    console.log(
        `  4A plain throw: threw=${JSON.stringify(
            throwCase.threw
        )} accepted=${JSON.stringify(
            throwCase.accepted
        )} castPause=${throwCastPause} progress=${JSON.stringify(
            throwCase.afterEvent.progress
        )} probe=${JSON.stringify(throwCase.armProbe)}`
    );
    console.log(
        `  4B re-entrant:  threw=${JSON.stringify(
            reentrantCase.threw
        )} accepted=${JSON.stringify(
            reentrantCase.accepted
        )} B=${JSON.stringify(
            bDisposition
        )} Bclaimed=${bClaimed} Bprogress=${JSON.stringify(
            reentrantCase.afterEvent.progress.filter(
                m => m && m.commandId === 2
            )
        )}`
    );
    if (fixedExpectation) {
        check(
            "post-fix 4A: a synchronous page failure is REPORTED (not thrown), with its own error text",
            throwCase.threw === null &&
                throwCase.accepted &&
                throwCase.accepted.accepted === false &&
                throwCase.accepted.error ===
                    "Page transition could not be started",
            JSON.stringify({
                threw: throwCase.threw,
                accepted: throwCase.accepted
            })
        );
        check(
            "post-fix 4A: the failed transition never dispatched the receiver and never reported a receiver request",
            throwCase.afterDispatch.elementCalls.pause === 1 &&
                throwCastPause === 0 &&
                !throwReportedRequested,
            JSON.stringify({
                element: throwCase.afterDispatch.elementCalls,
                cast: throwCastPause,
                progress: throwCase.afterEvent.progress
            })
        );
        check(
            "post-fix 4A: the failed command claims no later page event (its arm and the BLE arm were cleared)",
            throwCase.armProbe.every(
                p => p.hasPage === false && p.pageArmPresentBefore === false
            ),
            JSON.stringify(throwCase.armProbe)
        );
        check(
            "post-fix 4B: the older failing dispatch does not clobber the re-entrant command (its disposition, arm and progress survive)",
            reentrantCase.threw === null &&
                reentrantCase.accepted &&
                reentrantCase.accepted.accepted === false &&
                bDisposition &&
                bDisposition.accepted === true &&
                bDisposition.disposition === "transition-requested" &&
                bClaimed &&
                bReported &&
                bRequested,
            JSON.stringify({
                aAccepted: reentrantCase.accepted,
                bDisposition,
                bClaimed,
                bReported,
                bRequested
            })
        );
    } else {
        check(
            "gap 4A: the synchronous page failure ESCAPES controlPlayback and still drives the receiver through the stray BLE arm, with no page progress",
            typeof throwCase.threw === "string" &&
                throwCastPause === 1 &&
                !throwReportedRequested,
            JSON.stringify({
                threw: throwCase.threw,
                cast: throwCastPause,
                progress: throwCase.afterEvent.progress
            })
        );
        check(
            "gap 4B: with the command never reaching the closure, neither the failing command nor the re-entrant one is claimed",
            !bClaimed && !bReported,
            JSON.stringify({ bClaimed, bReported })
        );
    }

    console.log(
        `\n=== timing matrix (consumeBleArm boundary; mode=${
            fixedExpectation ? "fixed" : "gap"
        }) ===`
    );
    for (const r of results) {
        console.log(`  ${r.label}`);
        console.log(`    probe: ${JSON.stringify(r.armProbe)}`);
        console.log(
            `    pagePhases=${JSON.stringify(
                phases(r.afterEvent.progress)
            )} receiverPhases=${JSON.stringify(
                receiverPhases(r.afterEvent.progress)
            )} progressCount=${r.afterEvent.progress.length}`
        );
    }

    console.log(`\n${pass}/${pass + fail} checks passed`);
    if (fail) {
        console.log("\nfailures:");
        for (const f of failures) console.log("  -", f.name, f.detail || "");
        fs.rmSync(source, { force: true });
        process.exit(1);
    }
    fs.rmSync(source, { force: true });
    console.log("work dir:", workDir);
}

main().catch(err => {
    fs.rmSync(path.join(sendersDir, ".pageTransition.instrumented.ts"), {
        force: true
    });
    console.error("pageTransition ERROR", err);
    process.exit(1);
});
