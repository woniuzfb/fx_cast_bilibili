#!/usr/bin/env node
"use strict";

/**
 * Page-sender behaviour test: receiver play/pause -> page, and pause/resume
 * never breaks the source supply.
 *
 * The sender's reconciliation lives in a closure inside
 * `MediaSender#addMediaElementListeners`, so this test drives the REAL bundled
 * source with the cast SDK and the DOM stubbed, and fires the captured 500ms
 * interval callback directly. That makes the question answerable without a
 * browser, a page or a receiver:
 *
 *   - which receiver states pause or resume the PAGE player, per sender kind
 *     (Bilibili on Roku, CCTV, Bilibili on Chromecast);
 *   - that a page which supplies the capture watermark (Bilibili on Roku) keeps
 *     the POSITION authority while still following the receiver's play/pause;
 *   - that a pause does not consume anything the resume needs: no seek/load
 *     transaction is left armed, no GET_STATUS polling starts, and after a long
 *     pause the page still resumes exactly once - repeatedly.
 *
 * `--pre-fix [<git-rev>]` builds the same file from another revision (default
 * HEAD^, the parent of the commit that introduced the fix) and asserts the KNOWN
 * pre-fix failures instead of success, so the test demonstrates what it is
 * testing rather than only passing.
 *
 * Usage:
 *   node test/senders/pauseSync.js
 *   node test/senders/pauseSync.js --pre-fix           # HEAD^ = before the fix
 *   node test/senders/pauseSync.js --pre-fix <git-rev>
 *
 * Boundary: this is decision-level evidence. It does not run a real Bilibili
 * page, a real receiver session or a real CDN, so it does not observe DASH
 * segment requests; it proves which branch the sender takes and what it does to
 * the page player.
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
const preFixIndex = argv.indexOf("--pre-fix");
const preFix = preFixIndex !== -1;
const preFixRev = preFix ? argv[preFixIndex + 1] : undefined;

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

/** The sender kinds this test covers, and why each one is here. */
const PlayerState = {
    IDLE: "IDLE",
    PLAYING: "PLAYING",
    PAUSED: "PAUSED",
    BUFFERING: "BUFFERING"
};

const KIND = {
    BILIBILI_ROKU: "bilibili-roku",
    CCTV: "cctv",
    BILIBILI_CHROMECAST: "bilibili-chromecast"
};

/**
 * Bundles the sender with the cast SDK stubbed.
 *
 * `source` may live outside the tree (the pre-fix revision is written to a temp
 * file), so relative imports of that copy are resolved against the real senders
 * directory - imports of the files that copy pulls in then resolve normally,
 * from their own directories.
 */
async function bundle({ source, outfile, stubDir, workDir }) {
    const esbuild = require(esbuildPath);
    const sourceDir = path.dirname(source);
    // media.ts has a default export; a tiny re-export entry keeps the class
    // reachable as a named export from the CJS bundle. The import is absolute so
    // it is never confused with the relative-import rewrite below.
    const entry = path.join(workDir, "entry.js");
    fs.writeFileSync(
        entry,
        `import MediaSender from ${JSON.stringify(source)};\nexport { MediaSender };\n`
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
                        // Resolve through esbuild itself with the real
                        // directory as the base: extension-less imports,
                        // tsconfig paths and the rest must behave exactly as
                        // they do for the file in place.
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

/** Globals the bundle touches at import time and while syncing. */
function installGlobals() {
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
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    global.HTMLMediaElement = class HTMLMediaElement {};
}

function makeElement({ paused, currentTime = 0 }) {
    const calls = { play: 0, pause: 0 };
    const element = new global.HTMLMediaElement();
    element.paused = paused;
    element.currentTime = currentTime;
    element.muted = false;
    element.play = () => {
        calls.play++;
        element.paused = false;
        return Promise.resolve();
    };
    element.pause = () => {
        calls.pause++;
        element.paused = true;
    };
    element.addEventListener = () => {};
    element.removeEventListener = () => {};
    element.calls = calls;
    return element;
}

function makeMedia(playerState, estimatedTime) {
    return {
        playerState,
        idleReason: undefined,
        mediaSessionId: 1,
        currentTime: estimatedTime,
        getEstimatedTime: () => estimatedTime,
        addUpdateListener: () => {},
        removeUpdateListener: () => {}
    };
}

/** A sender wired so the captured interval callback drives the real sync. */
function makeSender(MediaSender, kind, opts = {}) {
    const element = makeElement({
        paused: opts.pagePaused ?? true,
        currentTime: opts.pageTime ?? 0
    });
    const remoteProxy =
        kind === KIND.CCTV ? { hlsLive: true } : { audioUrl: "https://example.invalid/audio.m4s" };
    const sender = new MediaSender({
        mediaUrl: undefined,
        mediaElement: element,
        mediaContentType: "video/mp4",
        remoteProxy,
        gestureGatedControls: true,
        debug: () => {}
    });
    // The flag is what a real session binds to: Bilibili on a Roku only.
    sender.setPreserveSourcePlayback(kind === KIND.BILIBILI_ROKU);
    const sent = [];
    sender.session = {
        receiver: {
            label: kind === KIND.BILIBILI_CHROMECAST ? "chromecast-test" : "roku-HARNESS0001"
        },
        media: [],
        addUpdateListener: () => {},
        removeUpdateListener: () => {},
        sendMessage: (...args) => sent.push(args)
    };
    global.__intervalCallback = undefined;
    sender.addMediaElementListeners(element);
    return {
        sender,
        element,
        sent,
        /** The 500ms reconciliation tick. */
        tick: () => global.__intervalCallback && global.__intervalCallback(),
        setReceiverState: (state, estimatedTime = 0) => {
            sender.session.media = [makeMedia(state, estimatedTime)];
        }
    };
}

function runMatrix(MediaSender) {
    const cases = [
        [KIND.BILIBILI_ROKU, PlayerState.PAUSED, false, 0, 1, "Bilibili on Roku: receiver PAUSED pauses the page"],
        [KIND.BILIBILI_ROKU, PlayerState.PLAYING, true, 1, 0, "Bilibili on Roku: receiver PLAYING resumes the page"],
        [KIND.BILIBILI_ROKU, PlayerState.BUFFERING, true, 1, 0, "Bilibili on Roku: receiver BUFFERING keeps the page playing (watermark)"],
        [KIND.BILIBILI_ROKU, PlayerState.IDLE, true, 1, 0, "Bilibili on Roku: receiver startup IDLE keeps the page playing (watermark)"],
        [KIND.CCTV, PlayerState.PAUSED, false, 0, 1, "CCTV: receiver PAUSED pauses the page"],
        [KIND.CCTV, PlayerState.PLAYING, true, 1, 0, "CCTV: receiver PLAYING resumes the page"],
        [KIND.CCTV, PlayerState.BUFFERING, true, 1, 0, "CCTV: receiver BUFFERING keeps the page playing (no regression)"],
        [KIND.BILIBILI_CHROMECAST, PlayerState.BUFFERING, false, 0, 1, "Bilibili on Chromecast: BUFFERING still pauses the page"],
        [KIND.BILIBILI_CHROMECAST, PlayerState.PAUSED, false, 0, 1, "Bilibili on Chromecast: PAUSED pauses the page"]
    ];
    for (const [kind, state, pagePaused, expectPlay, expectPause, name] of cases) {
        const sender = makeSender(MediaSender, kind, { pagePaused });
        sender.setReceiverState(state);
        sender.tick();
        check(
            name,
            sender.element.calls.play === expectPlay &&
                sender.element.calls.pause === expectPause,
            JSON.stringify({
                kind,
                state,
                calls: sender.element.calls,
                expected: { play: expectPlay, pause: expectPause }
            })
        );
    }
}

function runPositionAuthority(MediaSender) {
    {
        const sender = makeSender(MediaSender, KIND.BILIBILI_ROKU, {
            pageTime: 100,
            pagePaused: false
        });
        sender.setReceiverState(PlayerState.PLAYING, 130);
        sender.tick();
        check(
            "Bilibili on Roku: a 30s receiver drift does NOT move the page position (the page is the capture clock)",
            sender.element.currentTime === 100,
            JSON.stringify({ pageTime: sender.element.currentTime, receiverTime: 130 })
        );
    }
    {
        const sender = makeSender(MediaSender, KIND.BILIBILI_CHROMECAST, {
            pageTime: 100,
            pagePaused: false
        });
        sender.setReceiverState(PlayerState.PLAYING, 130);
        sender.tick();
        check(
            "Bilibili on Chromecast: the same drift IS corrected (position sync still active there)",
            sender.element.currentTime === 130,
            JSON.stringify({ pageTime: sender.element.currentTime, receiverTime: 130 })
        );
    }
}

/**
 * The supply keeps coming after a pause: nothing the pause leaves behind may
 * expire, and the resume must work every time - not just the first time.
 */
function runSupplyContinuity(MediaSender) {
    {
        const sender = makeSender(MediaSender, KIND.BILIBILI_ROKU, {
            pagePaused: false
        });
        sender.setReceiverState(PlayerState.PAUSED);
        sender.tick();
        check(
            "pause: the page is paused exactly once (no pause storm)",
            sender.element.paused === true && sender.element.calls.pause === 1,
            JSON.stringify(sender.element.calls)
        );

        // A long pause: 200 ticks is 100 seconds of the real 500ms interval.
        for (let i = 0; i < 200; i++) sender.tick();
        check(
            "long pause: nothing is armed that a resume would need, and no polling starts",
            sender.sender.dashSyncHold === false &&
                sender.sender.dashTightenSync === false &&
                sender.sent.length === 0,
            JSON.stringify({
                dashSyncHold: sender.sender.dashSyncHold,
                dashTightenSync: sender.sender.dashTightenSync,
                getStatusMessages: sender.sent.length
            })
        );
        check(
            "long pause: the page stays paused and its position is untouched",
            sender.element.paused === true &&
                sender.element.calls.play === 0 &&
                sender.element.calls.pause === 1,
            JSON.stringify({ paused: sender.element.paused, calls: sender.element.calls })
        );

        // Resume: the page must start producing again, once.
        sender.setReceiverState(PlayerState.PLAYING, 0);
        sender.tick();
        check(
            "resume after a long pause: the page plays again (the source keeps supplying)",
            sender.element.paused === false && sender.element.calls.play === 1,
            JSON.stringify(sender.element.calls)
        );
        for (let i = 0; i < 20; i++) sender.tick();
        check(
            "resume is not repeated: play() is called once, not on every tick",
            sender.element.calls.play === 1 && sender.element.calls.pause === 1,
            JSON.stringify(sender.element.calls)
        );

        // Cycled pauses and resumes: the state machine must not be one-shot.
        for (let cycle = 0; cycle < 3; cycle++) {
            sender.setReceiverState(PlayerState.PAUSED, 0);
            sender.tick();
            sender.setReceiverState(PlayerState.PLAYING, 0);
            sender.tick();
        }
        check(
            "three further pause/play cycles keep working (3 pauses + 4 plays total)",
            sender.element.calls.pause === 4 && sender.element.calls.play === 4,
            JSON.stringify(sender.element.calls)
        );
    }

    {
        // The watermark case: a receiver BUFFERING (or startup IDLE) must leave
        // the page playing across many ticks, so the relay keeps being fed.
        const sender = makeSender(MediaSender, KIND.BILIBILI_ROKU, {
            pagePaused: true
        });
        sender.setReceiverState(PlayerState.BUFFERING);
        sender.tick();
        for (let i = 0; i < 100; i++) sender.tick();
        check(
            "receiver BUFFERING for 50s: the page is kept playing and play() is called once, not per tick",
            sender.element.paused === false && sender.element.calls.play === 1 && sender.element.calls.pause === 0,
            JSON.stringify({ paused: sender.element.paused, calls: sender.element.calls })
        );
    }
}

/** The failures the pre-fix source is expected to produce, and nothing else. */
const PRE_FIX_EXPECTED_FAILURES = [
    "Bilibili on Roku: receiver PAUSED pauses the page",
    "Bilibili on Roku: receiver PLAYING resumes the page",
    "Bilibili on Roku: receiver BUFFERING keeps the page playing (watermark)",
    "Bilibili on Roku: receiver startup IDLE keeps the page playing (watermark)",
    "pause: the page is paused exactly once (no pause storm)",
    "long pause: the page stays paused and its position is untouched",
    "resume after a long pause: the page plays again (the source keeps supplying)",
    "resume is not repeated: play() is called once, not on every tick",
    "three further pause/play cycles keep working (3 pauses + 4 plays total)",
    "receiver BUFFERING for 50s: the page is kept playing and play() is called once, not per tick"
];

async function main() {
    // realpath: esbuild reports importers through their resolved path, so on
    // macOS a /var/folders temp dir would not match its own /private/var
    // spelling and the relative-import rewrite below would silently not apply.
    const workDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "fx-pause-sync-"))
    );
    const stubDir = path.join(workDir, "stub");
    writeStub(stubDir);

    let source = mediaSource;
    let label = "current source";
    if (preFix) {
        // HEAD^ is the parent of the commit that introduced this fix - i.e. the
        // behaviour the test exists to catch. Pass a revision explicitly when
        // that is no longer true.
        const rev = preFixRev || "HEAD^";
        const shown = spawnSync(
            "git",
            ["show", `${rev}:extension/src/cast/senders/media.ts`],
            { cwd: repoRoot, encoding: "utf8" }
        );
        if (shown.status !== 0) {
            throw new Error(
                `pauseSync: cannot read ${rev}:extension/src/cast/senders/media.ts: ${shown.stderr}`
            );
        }
        source = path.join(workDir, "media-prefix.ts");
        fs.writeFileSync(source, shown.stdout);
        label = `pre-fix source (${rev})`;
    }

    console.info("bundling", label, "with the cast SDK stubbed");
    const bundlePath = path.join(workDir, "media.js");
    await bundle({ source, outfile: bundlePath, stubDir, workDir });

    installGlobals();
    const { MediaSender } = require(bundlePath);
    if (typeof MediaSender !== "function") {
        throw new Error("pauseSync: the bundle did not export MediaSender");
    }

    runMatrix(MediaSender);
    runPositionAuthority(MediaSender);
    runSupplyContinuity(MediaSender);

    console.info("");
    let reproduced;
    if (preFix) {
        // Asserting the old behaviour is the point here: a green run against the
        // pre-fix source would mean this test cannot see the bug it exists for.
        const unexpectedPasses = PRE_FIX_EXPECTED_FAILURES.filter(
            name => !failures.includes(name)
        );
        const unexpectedFailures = failures.filter(
            name => !PRE_FIX_EXPECTED_FAILURES.includes(name)
        );
        reproduced =
            unexpectedPasses.length === 0 && unexpectedFailures.length === 0;
        check(
            "pre-fix source reproduces exactly the known failures (a green run here would mean this test cannot see the bug)",
            reproduced,
            JSON.stringify({ unexpectedPasses, unexpectedFailures })
        );
        console.info(
            `${pass}/${pass + fail} checks passed ` +
                `(${failures.length} pre-fix failures, of which ` +
                `${PRE_FIX_EXPECTED_FAILURES.length} are expected)`
        );
    } else {
        console.info(`${pass}/${pass + fail} checks passed`);
    }

    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
    // In pre-fix mode the point is that the OLD behaviour is reproduced, so the
    // expected failures are the success condition - which makes this usable as a
    // negative control in CI rather than a red build.
    process.exit(preFix ? (reproduced ? 0 : 1) : fail ? 1 : 0);
}

main().catch(err => {
    console.error("pauseSync ERROR", err);
    process.exit(1);
});
