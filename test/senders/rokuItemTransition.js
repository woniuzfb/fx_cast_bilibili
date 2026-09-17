#!/usr/bin/env node
"use strict";

/**
 * The Roku item transition: who is allowed to reload the receiver, and when.
 *
 * On the device one part switch produced THREE overlapping relay generations in
 * one second (measured: generation 6 -> 8 -> 10, all inside 550ms). Three
 * sources each started a reload of their own — the capture's per-kind
 * representation commits, the 750ms SPA navigation poll, and the relay verdict
 * that followed each failure — and every generation tore the previous one down
 * before it could become ready. None of them ever reached
 * `mediaServerStarted`, so the Roku never received a LOAD.
 *
 * This test drives the REAL bundled `bilibili.ts` with `MediaSender` stubbed
 * (the same scaffolding `pageTransition.js` uses) and reports only two things:
 *
 *   - how many `updateMedia` calls a burst of facts produces, and
 *   - whether the capture's pair was COMPLETE when the load was started.
 *
 * The second is the reason the first cannot simply be "one per fact": starting
 * a relay on a half-captured pair is a doomed relay, and a doomed relay is what
 * used to trigger the next one.
 *
 * Usage:
 *   node test/senders/rokuItemTransition.js
 *   node test/senders/rokuItemTransition.js --pre-fix            # control
 *   node test/senders/rokuItemTransition.js --pre-fix --rev 30a2173
 *
 * The control runs the same facts against the pre-fix source and requires the
 * "one relay per burst" row to FAIL there — otherwise the row proves nothing
 * about the code under test.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const sendersDir = path.join(repoRoot, "extension/src/cast/senders");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

const argv = process.argv.slice(2);
const PRE_FIX = argv.includes("--pre-fix");
const VERBOSE = argv.includes("--verbose");
/**
 * `--regress undefined-is-changed` rewrites the CURRENT source's settle
 * comparison back to `now !== transition.loadedPairVersion` — the shape the
 * device falsified — and requires the "undefined pair" row to fail. Without it,
 * that row could pass because the harness never drives an undefined answer.
 */
const REGRESS = argv.includes("--regress");
const revIndex = argv.indexOf("--rev");
const REV =
    revIndex >= 0 && argv[revIndex + 1] ? argv[revIndex + 1] : "30a2173";

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

function resolveSourceRoot() {
    if (!PRE_FIX) return sendersDir;
    const worktree = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cast-item-rev-")
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
    return path.join(worktree, "extension/src/cast/senders");
}

// ---------------------------------------------------------------------------
// Harness state the stubs read
// ---------------------------------------------------------------------------

const world = {
    /** What `bilibili:getCapturedMedia` answers. */
    capturePair: undefined,
    /**
     * When set, the pair query answers `undefined` even though a pair is loaded.
     * That is the device's shape while the capture cannot form a pair — and it
     * must read as "no evidence", never as "the pair changed".
     */
    hideCapturePair: false,
    /** Every media server load the sender started (one per relay generation). */
    loads: [],
    /** Every `getCapturedMedia` the sender asked, with the item it named. */
    pairQueries: [],
    /** Set to make the next load fail the way a starving relay does. */
    failNextLoad: false,
    /** How long a load takes, so facts can be injected while it is in flight. */
    loadDelayMs: 0,
    /** Flip `hideCapturePair` once a load's resolver has run: the pair was
     *  resolvable when the relay started and is not afterwards. */
    hidePairAfterResolve: false,
    /** Milliseconds added to `Date.now()`, so a bounded wait can expire without
     *  the harness sleeping for it (the device's second transition sat in the
     *  8s pair wait before it fell back and tore the relay down). */
    clockOffset: 0,
    timers: [],
    intervalCallbacks: [],
    location: "https://www.bilibili.com/video/BVtest?p=1"
};

function writeStub(stubDir) {
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(
        path.join(stubDir, "mediaStub.js"),
        `"use strict";
const world = globalThis.__world;
class MediaSender {
    constructor(opts) {
        this.opts = opts;
        this.roku = true;
        globalThis.__opts.push(opts);
    }
    isRokuReceiver() { return this.roku; }
    beginDashItemTransition() {}
    prepareUpdatedMediaElement() {}
    suspendMediaElementSync() {}
    isCurrentMediaServerRequest() { return true; }
    primeCaptureSource() {}
    seekDashRemux() {}
    stop() {}
    controlPlayback() { return false; }
    controlFromBleRemote() { return false; }
    updateMedia(opts) {
        world.loads.push({ key: opts.mediaIdentity, pair: world.capturePair });
        // The receiver-facing half resolves the captured pair through the
        // sender's own resolver; the harness records what that query named so
        // "the load and the gate asked the same question" is checkable.
        const resolver = opts.rokuMediaResolver;
        return Promise.resolve()
            .then(() => (resolver ? resolver() : undefined))
            // The device's order: the pair was still resolvable when the relay
            // started, and stopped being resolvable while it was coming up.
            .then(() => {
                if (world.hidePairAfterResolve) world.hideCapturePair = true;
            })
            .then(
                () =>
                    new Promise(resolve =>
                        world.loadDelayMs
                            ? setTimeout(resolve, world.loadDelayMs)
                            : resolve()
                    )
            )
            .then(() => {
                if (world.failNextLoad) {
                    world.failNextLoad = false;
                    throw new Error(
                        "Media server stopped before becoming ready"
                    );
                }
            });
    }
}
module.exports = MediaSender;
module.exports.default = MediaSender;
`
    );
}

function regressedSource(sourcePath) {
    const original = fs.readFileSync(sourcePath, "utf8");
    const pattern =
        /const changed =\s*now !== undefined &&\s*transition\.loadedPairVersion !== undefined &&\s*now !== transition\.loadedPairVersion;/;
    const rewritten = original.replace(
        pattern,
        "const changed = now !== transition.loadedPairVersion;"
    );
    if (rewritten === original || rewritten.includes("now !== undefined")) {
        throw new Error(
            "--regress undefined-is-changed could not rewrite the settle comparison; the pattern no longer matches the source"
        );
    }
    // Written NEXT TO the original: the file's relative imports must resolve.
    const target = path.join(
        path.dirname(sourcePath),
        "bilibili.regressControl.ts"
    );
    fs.writeFileSync(target, rewritten);
    process.on("exit", () => {
        try {
            fs.rmSync(target, { force: true });
        } catch {
            // A leftover file in the tree must not change the test result.
        }
    });
    return target;
}

async function bundle(sourceDir, workDir, stubDir) {
    const entry = path.join(workDir, "entry.js");
    const outfile = path.join(workDir, "sender.cjs");
    const senderPath = path.join(sourceDir, "bilibili.ts");
    fs.writeFileSync(
        entry,
        `import ${JSON.stringify(
            REGRESS ? regressedSource(senderPath) : senderPath
        )};\nexport const senderLoaded = true;\n`
    );
    const esbuild = require(esbuildPath);
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        nodePaths: [path.join(repoRoot, "extension/node_modules")],
        plugins: [
            {
                name: "stub-media-sender",
                setup(build) {
                    // Only the sender under test is real: MediaSender (the
                    // receiver-facing machinery, with its own suites) is
                    // replaced, so what is measured is the page sender's policy.
                    build.onResolve({ filter: /(^|\/)media$/ }, args => {
                        if (
                            !/bilibili(\.regressControl)?\.ts$/.test(
                                args.importer
                            )
                        )
                            return undefined;
                        return { path: path.join(stubDir, "mediaStub.js") };
                    });
                }
            }
        ]
    });
    return outfile;
}

function installGlobals() {
    const listeners = { runtime: [] };
    // Both the sender and the stubs read this clock, so a wait that measures
    // elapsed time behaves exactly as it would in a session that ran longer.
    const realNow = Date.now;
    Date.now = () => realNow() + world.clockOffset;
    global.__world = world;
    global.__opts = [];
    global.__intervalCallback = undefined;
    global.requestAnimationFrame = () => 0;

    const video = {
        currentTime: 0,
        paused: false,
        muted: false,
        isConnected: true,
        readyState: 4,
        playbackRate: 1,
        paused_: false,
        pause() {
            this.paused = true;
        },
        play: () => Promise.resolve(),
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    };
    global.__video = video;

    global.document = {
        title: "第三季",
        body: { appendChild: () => undefined },
        documentElement: { appendChild: () => undefined },
        getElementById: () => null,
        createElement: () => ({
            style: {},
            addEventListener: () => undefined,
            remove: () => undefined,
            remove: () => undefined
        }),
        querySelector: selector => (selector === "video" ? video : null)
    };
    global.location = {
        get href() {
            return world.location;
        },
        get pathname() {
            return new URL(world.location).pathname;
        },
        set href(value) {
            world.location = value;
        }
    };
    global.HTMLVideoElement = function HTMLVideoElement() {};
    Object.setPrototypeOf(video, global.HTMLVideoElement.prototype);

    global.window = {
        get location() {
            return global.location;
        },
        get __fxCastBilibiliInitialQuality() {
            return 0;
        },
        get __fxCastBilibiliInitialDebug() {
            return Boolean(VERBOSE);
        },
        setInterval: fn => {
            world.intervalCallbacks.push(fn);
            return world.intervalCallbacks.length;
        },
        clearInterval: () => undefined,
        setTimeout: (fn, ms) => {
            world.timers.push({ fn, ms });
            return world.timers.length;
        },
        clearTimeout: id => {
            if (typeof id === "number" && world.timers[id - 1])
                world.timers[id - 1] = undefined;
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    };
    global.fetch = async url => {
        const parsed = new URL(url);
        const payload = parsed.pathname.includes("pagelist")
            ? {
                  code: 0,
                  data: [
                      { page: 1, cid: 1001, part: "第一季" },
                      { page: 2, cid: 1002, part: "第二季" },
                      { page: 3, cid: 1003, part: "第三季" }
                  ]
              }
            : {
                  code: 0,
                  data: {
                      quality: 80,
                      dash: {
                          video: [
                              {
                                  id: 80,
                                  baseUrl: "https://upos.bilivideo.com/a.m4s",
                                  bandwidth: 1
                              }
                          ],
                          audio: [
                              {
                                  id: 30280,
                                  baseUrl: "https://upos.bilivideo.com/b.m4s",
                                  bandwidth: 1
                              }
                          ]
                      },
                      accept_quality: [80],
                      accept_description: ["高清 1080P"]
                  }
              };
        return {
            ok: true,
            status: 200,
            json: async () => payload,
            text: async () => JSON.stringify(payload)
        };
    };
    global.browser = {
        runtime: {
            onMessage: {
                addListener: fn => listeners.runtime.push(fn),
                removeListener: () => undefined
            },
            sendMessage: async message => {
                if (message?.subject === "bilibili:getCapturedMedia") {
                    world.pairQueries.push({
                        item: message.data?.item,
                        probe: message.data?.probe === true
                    });
                    return world.hideCapturePair
                        ? undefined
                        : world.capturePair;
                }
                if (message?.subject === "bilibili:pageSeekStarted")
                    return undefined;
                return undefined;
            }
        },
        tabs: {
            query: async () => [],
            sendMessage: async () => undefined,
            onUpdated: { addListener: () => undefined },
            onRemoved: { addListener: () => undefined }
        }
    };
    if (VERBOSE) console.info("  (verbose) timers captured");
    return listeners;
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Run every timer the sender has queued, including ones queued while running. */
async function fireTimers(rounds = 6) {
    for (let round = 0; round < rounds; round++) {
        const queued = world.timers.splice(0).filter(Boolean);
        if (!queued.length) return;
        for (const timer of queued) timer.fn();
        await tick();
        await tick();
    }
}

/**
 * Let the sender reach a quiescent state: alternate fired timers with real
 * turns of the event loop, so an async transition that queues its next timer
 * after an await is still observed. Without the alternation the harness would
 * sample a half-finished chain and blame the code for it.
 */
async function drain(rounds = 8) {
    for (let round = 0; round < rounds; round++) {
        await fireTimers(2);
        await sleep(5);
    }
}

function fireNavigationPoll() {
    if (VERBOSE)
        console.info(
            `  (verbose) poll: ${world.intervalCallbacks.length} interval callback(s), location ${world.location}, ${world.loads.length} load(s)`
        );
    for (const callback of world.intervalCallbacks) {
        try {
            callback();
        } catch {
            // The poll wraps its own errors; a throw here is the poll's problem.
        }
    }
}

function notify(listeners, message) {
    for (const fn of listeners.runtime) {
        try {
            fn(message, {});
        } catch {
            // Reported through the rows, not as a crash.
        }
    }
    if (VERBOSE)
        console.info(
            `  (verbose) fact ${message.subject}:${
                message.data?.kind ?? "-"
            } -> ${world.timers.length} queued timer(s), ${
                world.loads.length
            } load(s)`
        );
}

/**
 * The initial cast's load, so `activeKey` exists for the navigation poll.
 *
 * Waiting on `isCasting()` — not on a load — is what makes the poll a real
 * input: `activeKey` is set on the way to `sender`, so an earlier start would
 * leave the poll with nothing to compare against and every "the poll reported a
 * fact" row would silently measure only the message-driven ones.
 */
async function startCast() {
    const casting = () => {
        try {
            return global.window.__fxCastBilibili?.isCasting?.() === true;
        } catch {
            return false;
        }
    };
    for (let attempt = 0; attempt < 400 && !casting(); attempt++) await tick();
    const opts = global.__opts[global.__opts.length - 1];
    check(
        "setup: the initial cast created a sender",
        Boolean(opts) && casting(),
        JSON.stringify({ opts: Boolean(opts), casting: casting() })
    );
    // The SDK's receiver selection is what marks the cast as Roku; the receiver
    // side of it is not this harness's subject.
    opts?.onReceiverSelected?.(true);
    await tick();
    world.loads.length = 0;
    return opts;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function caseBurstStartsOneRelay(listeners, page) {
    // The page switched part: both kinds committed and the navigation poll
    // noticed, all inside the same beat — the measured burst.
    world.capturePair = {
        captureGeneration: 7,
        videoUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-100026.m4s",
        audioUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-30280.m4s"
    };
    world.location = "https://www.bilibili.com/video/BVtest?p=2";
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "video", path: "/x/1002-1-100026.m4s" }
    });
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "audio", path: "/x/1002-1-30280.m4s" }
    });
    fireNavigationPoll();
    await drain();
    check(
        "burst: three facts of one item switch start exactly ONE relay",
        world.loads.length === 1,
        `loads=${world.loads.length} ${JSON.stringify(world.loads)}`
    );
    check(
        "burst: the relay was started with the capture's pair already complete",
        world.loads[0]?.pair?.captureGeneration === 7,
        JSON.stringify(world.loads[0] ?? {})
    );
}

async function caseNoRelayBeforeThePairIsComplete(listeners) {
    world.loads.length = 0;
    world.location = "https://www.bilibili.com/video/BVtest?p=1";
    // The capture has committed one kind only: a relay started now would be fed
    // a pair it cannot complete, which is exactly the doomed generation.
    world.capturePair = undefined;
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "video", path: "/x/1002-1-100026.m4s" }
    });
    await drain(4);
    check(
        "pair gate: no relay is started while the capture has no complete pair",
        world.loads.length === 0,
        `loads=${world.loads.length}`
    );
    // The other kind commits (or the poll reports again): the pair is complete.
    world.capturePair = {
        captureGeneration: 8,
        videoUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-100026.m4s",
        audioUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-30280.m4s"
    };
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "audio", path: "/x/1002-1-30280.m4s" }
    });
    await drain();
    check(
        "pair gate: the relay starts as soon as the pair is complete",
        world.loads.length === 1,
        `loads=${world.loads.length}`
    );
}

/**
 * The device's black screen, reduced to its decision: a load that SUCCEEDED with
 * a captured pair, a pending fact from the same burst (the 750ms navigation poll
 * re-reporting the switch until `activeKey` caught up), and then a pair query
 * that answers `undefined` because the capture cannot form a pair right now.
 *
 * `undefined !== 4` read that as "the pair changed" and started a second relay
 * eight seconds later — which tore down the relay that was playing. The contract
 * is that "no evidence" is not "changed", so the relay count must stay 1.
 */
async function caseNoSecondRelayOnAnUndefinedPair(listeners) {
    world.loads.length = 0;
    world.pairQueries.length = 0;
    world.hideCapturePair = false;
    world.hidePairAfterResolve = false;
    // A DIFFERENT item from the previous case: the navigation poll only reports
    // a fact when the page key moves, so reusing the same one would make this
    // case drive nothing.
    world.location = "https://www.bilibili.com/video/BVtest?p=3";
    world.capturePair = {
        captureGeneration: 4,
        videoUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-100026.m4s",
        audioUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-30280.m4s"
    };
    // The device's burst, in the order the capture produced it: the video commit
    // starts the settle window, the audio commit lands inside that window (that
    // pending fact is what made the settle step re-decide later), and by the time
    // the relay is coming up the capture cannot form a pair any more.
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "video", path: "/x/1003-1-100026.m4s" }
    });
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "audio", path: "/x/1003-1-30280.m4s" }
    });
    world.hidePairAfterResolve = true;
    await drain();
    const afterLoad = world.loads.length;
    // Past the pair wait. Without the three-valued comparison the settle step
    // reads `undefined !== 4` as "the pair changed", starts a second transition,
    // times out here and reloads — which tears down the relay that is playing.
    for (let round = 0; round < 8; round++) {
        world.clockOffset += 1500;
        await drain(1);
    }
    await sleep(20);
    await drain(4);
    world.clockOffset = 0;
    check(
        "undefined pair: the load that succeeded is not followed by a second relay",
        afterLoad === 1 && world.loads.length === 1,
        `afterLoad=${afterLoad} total=${world.loads.length}`
    );
    check(
        "undefined pair: the load's own pair query names the target item",
        world.pairQueries.some(query => query.item === "1003"),
        JSON.stringify(world.pairQueries)
    );
    check(
        "undefined pair: the internal readiness polls are marked as probes",
        world.pairQueries.some(query => query.probe === true),
        JSON.stringify(world.pairQueries)
    );
    world.hideCapturePair = false;
    world.hidePairAfterResolve = false;
    world.loadDelayMs = 0;
}

async function caseFailureIsNotARetryLoop(listeners) {
    world.loads.length = 0;
    world.capturePair = {
        captureGeneration: 9,
        videoUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-100026.m4s",
        audioUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-30280.m4s"
    };
    world.failNextLoad = true;
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "video", path: "/x/1002-1-100026.m4s" }
    });
    await drain();
    const afterFailure = world.loads.length;
    // More facts about the SAME pair, right after the failure: rebuilding on
    // each one is what turned one failure into a chain of them.
    for (let i = 0; i < 3; i++) {
        notify(listeners, {
            subject: "bilibili:capturedRepresentationChanged",
            data: { kind: "video", path: "/x/1002-1-100026.m4s" }
        });
        await drain(4);
    }
    check(
        "failure: the first attempt happened, then the same pair was not retried",
        afterFailure === 1 && world.loads.length === 1,
        `afterFailure=${afterFailure} total=${world.loads.length}`
    );
    // A pair that really changed is new information: exactly one more attempt.
    world.capturePair = {
        captureGeneration: 10,
        videoUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-100026.m4s",
        audioUrl:
            "https://upos.bilivideo.com/upgcxcode/26/32/1001/1001-1-30280.m4s"
    };
    notify(listeners, {
        subject: "bilibili:capturedRepresentationChanged",
        data: { kind: "audio", path: "/x/1002-1-30280.m4s" }
    });
    await drain();
    check(
        "failure: a changed pair earns exactly one more relay",
        world.loads.length === 2,
        `loads=${world.loads.length}`
    );
}

// ---------------------------------------------------------------------------

async function main() {
    const sourceDir = resolveSourceRoot();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-item-"));
    const stubDir = path.join(workDir, "stubs");
    writeStub(stubDir);
    const listeners = installGlobals();
    const outfile = await bundle(sourceDir, workDir, stubDir);
    require(outfile);
    await tick();

    console.info(
        `roku item transition harness (${
            REGRESS
                ? "regressed settle comparison"
                : PRE_FIX
                ? `revision ${REV}`
                : "working tree"
        })`
    );
    console.info("case: a burst of facts");
    const opts = await startCast();
    await caseBurstStartsOneRelay(listeners, opts);
    console.info("case: an undefined pair after a successful load");
    await caseNoSecondRelayOnAnUndefinedPair(listeners);
    console.info("case: the pair gate");
    await caseNoRelayBeforeThePairIsComplete(listeners);
    console.info("case: a failed relay");
    await caseFailureIsNotARetryLoop(listeners);

    console.info("");
    if (REGRESS) {
        const expected = failures.filter(name =>
            /undefined pair: the load that succeeded is not followed by a second relay/.test(
                name
            )
        );
        if (expected.length !== 1) {
            console.error(
                `rokuItemTransition: --regress expected the undefined-pair row to fail, saw ${expected.length}` +
                    (failures.length ? ` (${failures.join("; ")})` : "")
            );
            process.exitCode = 1;
        } else {
            console.info(
                `regress control: the undefined-pair row failed as required (${fail} check(s) total)`
            );
            for (const name of failures) console.info("  - " + name);
            process.exitCode = 0;
        }
    } else if (PRE_FIX) {
        // The control: before this change the three facts start three relays
        // (each failure re-arming the next), and nothing waits for a complete
        // pair.
        const expected = failures.filter(name =>
            /three facts of one item switch start exactly ONE relay/.test(name)
        );
        if (expected.length !== 1) {
            console.error(
                `rokuItemTransition: --pre-fix expected the churn row to fail, saw ${expected.length}` +
                    (failures.length ? ` (${failures.join("; ")})` : "")
            );
            process.exitCode = 1;
        } else {
            console.info(
                `pre-fix control: ${fail} check(s) failed, including the expected churn row`
            );
            for (const name of failures) console.info("  - " + name);
            process.exitCode = 0;
        }
    } else {
        console.info(`${pass}/${pass + fail} checks passed`);
        if (fail) for (const name of failures) console.info("  - " + name);
        process.exitCode = fail ? 1 : 0;
    }
    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
}

main().catch(error => {
    console.error("rokuItemTransition ERROR", error);
    process.exitCode = 1;
});
