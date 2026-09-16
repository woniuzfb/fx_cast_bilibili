#!/usr/bin/env node
"use strict";

/**
 * Phase 3: model-based interleavings.
 *
 * The load matrix (`test/senders/dashLoadMatrix.js`) pins SCENARIOS: hand-written
 * sequences, one per defect that has actually happened. This runs the other
 * direction - seeded sequences over an alphabet of user actions and receiver
 * reports - and judges each one against a reference model of the USER'S INTENT
 * (`playbackModel/model.js`) and a list of invariants (`playbackModel/invariants.js`).
 *
 * It exists because every defect in this area has been an INTERLEAVING: a page
 * seek during a switch's load, a BLE skip racing a popup seek, a receiver report
 * arriving while a transaction held the page. Scenario tests cover the
 * interleavings someone already thought of; a sequence generator covers the ones
 * nobody did, and a failure prints the operations that produced it, so the case IS
 * the reproduction.
 *
 * What is real, and what the model is not:
 *
 *   - real: the bundled `MediaSender`, the bridge's plan arithmetic
 *     (`playbackModel/plan.js`, evaluated from the bridge's own source), a cast
 *     SDK stub that records every receiver command, and a fake clock.
 *   - the model: an intent-level reference (which play/pause state the next LOAD
 *     must inherit, which position the newest explicit seek asked for, which video
 *     the intent belongs to, whether the page's controls are attached, whether the
 *     cast is over). It deliberately does NOT model transactions, debounce timers
 *     or coalescing mechanics: those are bounded by invariants, not predicted.
 *
 * Usage:
 *   node test/senders/playbackInterleavings.js                  # pairwise, deterministic
 *   node test/senders/playbackInterleavings.js --random 40      # + 40 seeded sequences
 *   node test/senders/playbackInterleavings.js --seed 7 --length 8 --random 20
 *   node test/senders/playbackInterleavings.js --verbose        # every operation
 *   node test/senders/playbackInterleavings.js --pairwise-only
 */

const path = require("path");

const {
    PlayerState,
    resolveSendersDir,
    buildSender,
    startCast,
    flush,
    installGlobals
} = require("../playbackModel/senderHarness");
const {
    pairwiseCases,
    randomCases,
    MID_POSITION
} = require("../playbackModel/cases");
const {
    createModel,
    applyToModel,
    observeWorldAdvance
} = require("../playbackModel/model");
const { checkInvariants } = require("../playbackModel/invariants");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== undefined
        ? argv[index + 1]
        : fallback;
};
const RANDOM_RUNS = Number(arg("--random", "0"));
const SEED = Number(arg("--seed", "1"));
const LENGTH = Number(arg("--length", "6"));
const VERBOSE = argv.includes("--verbose");
/** Random sweeps run with the startup-padding option as the product ships it. */
const PADDING_OFF = argv.includes("--padding-off");
const PAIRWISE_ONLY = argv.includes("--pairwise-only");
const PRE_FIX_INDEX = argv.indexOf("--pre-fix");
const PRE_FIX = PRE_FIX_INDEX >= 0;
const PRE_FIX_REV = PRE_FIX ? argv[PRE_FIX_INDEX + 1] ?? "HEAD" : undefined;

let pass = 0;
let fail = 0;
const failures = [];

const log = (...parts) => console.info(parts.join(" "));

/** The page position a run starts from: a live cast, mid-video. */
const START_PAGE_TIME = MID_POSITION;
const SKIP = 30;

/**
 * The operations that own the load lifecycle, for labelling a run's trace.
 *
 * NOT a scheduler: nothing about the runner's behaviour depends on this set any
 * more (an earlier version used it to decide which operations got an implicit
 * `settle()` first, which is exactly what hid the load-in-flight pairs).
 */
const LIFECYCLE_OPERATIONS = new Set([
    "ITEM_CHANGE",
    "QUALITY_CHANGE",
    "LOAD_RESOLVE",
    "SETTLE"
]);

/**
 * Perform one operation against the live cast.
 *
 * Every branch is a production entry point (or, for the receiver's own reports,
 * the delivery of a MEDIA_STATUS). Parameters a case omits are derived from the
 * CURRENT state, which is what makes a generated sequence meaningful: a skip that
 * would leave the media is a boundary, not an error.
 */
async function perform(cast, op) {
    const h = cast.h;
    switch (op.id) {
        case "PAGE_PLAY":
            // A page play/pause is only the USER's if a real interaction just
            // happened: the sender's gesture gate exists to ignore the site's own
            // autonomous events (autoplay, buffering recovery, a quality switch),
            // and an operation that skips the gesture would be modelling those
            // instead. The first version of this runner did, and the model then
            // (correctly) disagreed with an implementation that had ignored an
            // autonomous event.
            global.__dispatchGesture();
            h.element.placeAt(h.element.currentTime);
            void h.element.play();
            await flush();
            return;
        case "PAGE_PAUSE":
            global.__dispatchGesture();
            h.element.pause();
            await flush();
            return;
        case "POPUP_PLAY":
            await cast.play();
            return;
        case "POPUP_PAUSE":
            await cast.pause();
            return;
        case "BLE_PLAY":
            await cast.ble("play");
            return;
        case "BLE_PAUSE":
            await cast.ble("pause");
            return;
        case "PAGE_SEEK":
            await cast.pageSeek(op.target);
            return;
        case "POPUP_SEEK":
            await cast.popupSeek(op.target);
            return;
        case "BLE_SEEK_BACKWARD": {
            // The page sits one step AHEAD of where the skip lands, which is what
            // a backward skip from a playing page looks like.
            const target = Math.max(
                0,
                Math.round(h.element.currentTime) - SKIP
            );
            await cast.ble("seek_backward", { target, step: op.step ?? SKIP });
            return;
        }
        case "BLE_SEEK_FORWARD": {
            const target = Math.min(
                h.element.duration || Number.MAX_SAFE_INTEGER,
                Math.round(h.element.currentTime) + SKIP
            );
            await cast.ble("seek_forward", { target, step: op.step ?? SKIP });
            return;
        }
        case "ITEM_CHANGE":
            await cast.switchVideo(op.target);
            return;
        case "QUALITY_CHANGE":
            await cast.qualityChange(h.element.currentTime);
            return;
        case "LOAD_RESOLVE":
            // ONE generation: the active load. A successful load can serve a pending
            // seek, which starts the NEXT generation - and that one must stay in
            // flight for the sequence to see it (`LOAD_RESOLVE → the pending seek
            // starts a generation → STOP`). Draining the whole chain here hid those.
            // `SETTLE` is the operation that drains everything.
            if (op.refused) {
                await cast.answerAndRefuseNewest();
            } else {
                await cast.answerNewest();
            }
            return;
        case "RECEIVER_ECHO": {
            // The receiver reports what the extension last told it to be. Nothing
            // else: the state comes from the fixture's record of OUR command.
            const commanded = h.lastCommandedReceiverState();
            await cast.report(
                commanded ?? PlayerState.PLAYING,
                h.element.currentTime,
                cast.receiverSessionId()
            );
            return;
        }
        case "RECEIVER_PLAYING":
        case "RECEIVER_PAUSED": {
            // The receiver reports a settled state. The session is the one the
            // model has already seen, so this is "the session moved" - the
            // physical remote's shape.
            const session = cast.receiverSessionId();
            await cast.report(
                op.id === "RECEIVER_PLAYING"
                    ? PlayerState.PLAYING
                    : PlayerState.PAUSED,
                h.element.currentTime,
                session
            );
            return;
        }
        case "SETTLE":
            await cast.settle();
            return;
        case "STOP":
            cast.h.sender.stop();
            await flush();
            return;
        default:
            throw new Error(
                `playbackInterleavings: unknown operation ${op.id}`
            );
    }
}

/**
 * The generations the sender has STARTED, with the plan/LOAD of the ones the
 * bridge and receiver have since answered.
 *
 * Two sources on purpose: a generation exists the moment the sender asks the
 * bridge for a remux (that is the restart a user sees), while its plan and LOAD
 * only exist once it is answered. An operation that starts a generation and one
 * that merely serves it are different events, and the invariants need both.
 */
function snapshotGenerations(cast) {
    const answered = new Map(
        cast.generations.map(entry => [entry.requestId, entry])
    );
    return cast.h.started.map(entry => {
        const served = answered.get(entry.requestId);
        return {
            requestId: entry.requestId,
            startTime: entry.startTime,
            answered: served !== undefined,
            plan: served?.plan,
            load: served?.load
        };
    });
}

/**
 * Run one case and judge it.
 *
 * The trace records, per operation, the model's expectation and what the
 * implementation actually did, which is also what a failure report prints.
 */
async function runCase(
    MediaSender,
    testCase,
    { startupPaddingEnabled = true } = {}
) {
    const cast = await startCast(MediaSender, {
        pageTime: START_PAGE_TIME,
        startupPadding: startupPaddingEnabled
    });
    await cast.boot();
    /** Which video the model is on, for the identities its item changes adopt. */
    let modelIdentityGeneration = 0;

    // Primed from the LIVE cast: the initial load has already reported its own
    // state on a session, so the model must know which session that was and that
    // it was playing - otherwise its first receiver report would look like "a new
    // session" (the shape of our own load) rather than "the session the user has".
    let model = createModel({
        pageTime: START_PAGE_TIME,
        desiredPageTime: START_PAGE_TIME,
        startupPaddingEnabled,
        lastReceiverSession: cast.receiverSessionId(),
        lastReceiverState: "PLAYING"
    });
    const trace = [];
    const generationsBeforeRun = snapshotGenerations(cast).length;

    for (const [index, op] of testCase.ops.entries()) {
        // Parameters that describe the LIVE cast are read here, not in the case
        // data: a receiver report comes from the session the receiver is on, and
        // an item change is "a video this one is not".
        if (
            op.id === "RECEIVER_PLAYING" ||
            op.id === "RECEIVER_PAUSED" ||
            op.id === "RECEIVER_ECHO"
        ) {
            op.mediaSessionId = cast.receiverSessionId();
        }
        if (op.id === "RECEIVER_ECHO") {
            // Which state the echo carries is the fixture's record of our own last
            // command - the model is told it, it does not guess.
            op.playerState =
                cast.h.lastCommandedReceiverState() ?? PlayerState.PLAYING;
        }
        if (op.id === "ITEM_CHANGE") {
            // A UNIQUE identity per item change: reusing one placeholder made the
            // model see the second change as "the same video" while the fixture
            // adopted a different page key, so the two disagreed about which video
            // an intent belonged to.
            op.mediaIdentity = `video-${++modelIdentityGeneration}`;
        }
        // NO implicit world advancement.
        //
        // The bridge and the receiver do not answer by themselves: an operation runs
        // in exactly the state the previous one left. The first version of this
        // runner settled any outstanding load before every non-lifecycle operation,
        // which turned "a BLE pause while an item change's load is in flight" into
        // "a BLE pause on a settled cast" - the very interleavings this stage exists
        // for were scheduled away, and the pairwise suite went green without ever
        // being inside the window.
        //
        // A case that wants a settled starting point says so explicitly (`SETTLE`,
        // `LOAD_RESOLVE`); a case that wants the race leaves the load in flight.
        const generationsBefore = snapshotGenerations(cast);
        const loadsBefore = cast.h.loadRequests.length;
        const commandsBefore = cast.h.receiverCommandTotals();
        const pageBefore = {
            currentTime: cast.h.element.currentTime,
            paused: cast.h.element.paused
        };
        const modelBefore = model;
        const { state: modelAfter, expect } = applyToModel(model, {
            ...op,
            // The page's REAL play/pause state goes in as an input, because the
            // model cannot predict it: a DASH seek's hold pauses the ELEMENT
            // without touching the intent, and a page op on an element that is
            // already in the requested state fires no event at all - so "the user
            // pressed page pause" is only an intent when the element actually
            // moved. Assuming the model's own belief here made the generator
            // report a pause the sender never saw (it is the mirror's own freeze,
            // not the user's gesture).
            pagePaused: pageBefore.paused
        });
        model = modelAfter;

        let thrown;
        try {
            await perform(cast, op);
            // The bridge and the receiver KEEP UP: a generation the sender asked
            // for is answered with the plan for the position it asked for, and the
            // receiver then reports where it landed. Without this, a later
            // operation would be judged against a cast that is still waiting for a
            // bridge reply that nobody owes it - and every sequence would fail for
            // the same uninteresting reason.
            //
            // The three operations that OWN the load lifecycle are excluded: their
            // whole point is a load that is still in flight (an item/quality change
            // holds it) or one that is being resolved or refused.
        } catch (err) {
            thrown = err instanceof Error ? err.message : String(err);
        }

        const generationsAfter = snapshotGenerations(cast);
        // The LOADs this operation SUBMITTED, taken from the sender's own calls
        // rather than from the ones the receiver has answered: the playlist a
        // reload asks for exists the moment it is submitted, and an item change
        // holds its load in flight on purpose.
        const newLoads = cast.h.loadRequests
            .slice(loadsBefore)
            .map(entry => entry.request);
        const commandsAfter = cast.h.receiverCommandTotals();
        const step = {
            index: index + 1,
            op,
            expect,
            modelBefore,
            modelAfter: model,
            newGenerations: generationsAfter.slice(generationsBefore.length),
            // The page key in force during this operation: a generation belongs to
            // the video that was current when it started, which is the only identity
            // observable the harness has (the bridge request itself carries none).
            mediaIdentity: cast.h.mediaIdentity(),
            newLoads,
            commandsBefore,
            commandsAfter,
            pageBefore,
            pageAfter: {
                currentTime: cast.h.element.currentTime,
                paused: cast.h.element.paused
            },
            thrown
        };
        trace.push(step);
        // The world may have moved during this operation (a load of ours was
        // answered, a session came up). The model is told what the receiver is
        // reporting so its "session we are watching" stays current - a memory, not
        // a decision: adopting a state still needs an explicit report on that
        // session, exactly as the implementation requires.
        model = observeWorldAdvance(model, {
            mediaSessionId: cast.receiverSessionId(),
            playerState: cast.h.sender.session?.media?.at(-1)?.playerState
        });
        if (VERBOSE) {
            log(
                `         model: rule=${expect.rule} session=${
                    op.mediaSessionId ?? "-"
                } seen=${model.lastReceiverSession ?? "-"}/${
                    model.lastReceiverState ?? "-"
                } load=${model.activeLoad ? "in-flight" : "none"} attached=${
                    model.pageControlsAttached
                }`
            );
            log(
                `      ${step.index}. ${op.id}${
                    op.target !== undefined ? `(${op.target})` : ""
                }: gens +${step.newGenerations.length}` +
                    ` ${JSON.stringify(
                        step.newGenerations.map(entry => entry.startTime)
                    )} page ${step.pageAfter.currentTime.toFixed(2)}` +
                    ` loads ${JSON.stringify(
                        newLoads.map(load => load?.autoplay)
                    )}` +
                    // Diagnostic only (never asserted on): the sender's own view
                    // of the intent, so a divergence can be located instead of
                    // inferred.
                    ` commanded=${cast.h.lastCommandedReceiverState() ?? "-"}` +
                    ` intent(impl)=${cast.h.sender.desiredPlayback} intent(model)=${model.desiredPlayback}` +
                    (thrown ? ` THREW ${thrown}` : "")
            );
        }
    }

    const run = {
        ops: testCase.ops,
        trace,
        generations: snapshotGenerations(cast),
        generationsBeforeRun,
        startupPaddingEnabled
    };
    const failures = checkInvariants(run);
    return { run, failures };
}

async function main() {
    const sendersDir = resolveSendersDir({
        preFix: PRE_FIX,
        rev: PRE_FIX_REV
    });
    const { outfile } = await buildSender(sendersDir);
    // The bundle reads the browser globals at import time, so the fixture has to
    // exist before it is loaded.
    installGlobals();
    const { MediaSender } = require(outfile);
    if (typeof MediaSender !== "function") {
        throw new Error(
            "playbackInterleavings: the bundle did not export MediaSender"
        );
    }

    // The hand-written pairs run under BOTH startup-padding policies: the option
    // changes what the bridge puts in a playlist (and therefore every LOAD
    // position the flow computes), and a contract that only holds with padding on
    // would be a contract about one configuration. The random sweeps stay on the
    // shipped default so the exploration budget is not spent twice.
    const cases = [];
    {
        const pairs = pairwiseCases();
        for (const startupPaddingEnabled of [true, false]) {
            for (const testCase of pairs) {
                cases.push({
                    ...testCase,
                    startupPaddingEnabled,
                    name: `${testCase.name}${
                        startupPaddingEnabled ? "" : " [padding OFF]"
                    }`
                });
            }
        }
    }
    if (!PAIRWISE_ONLY && RANDOM_RUNS > 0) {
        cases.push(
            ...randomCases({
                seed: SEED,
                runs: RANDOM_RUNS,
                length: LENGTH
            }).map(testCase => ({
                ...testCase,
                startupPaddingEnabled: !PADDING_OFF
            }))
        );
    }
    log(
        `model-based interleavings: ${cases.length} case(s)` +
            ` (${PAIRWISE_ONLY ? "pairwise only" : "pairwise + random"},` +
            ` seed ${SEED}, length ${LENGTH}, source ${
                PRE_FIX ? PRE_FIX_REV : "working tree"
            })`
    );

    for (const testCase of cases) {
        log(`\n  -- ${testCase.name} --`);
        const { failures: caseFailures } = await runCase(
            MediaSender,
            testCase,
            {
                startupPaddingEnabled: testCase.startupPaddingEnabled !== false
            }
        );
        if (!caseFailures.length) {
            pass++;
            continue;
        }
        fail++;
        failures.push(testCase.name);
        for (const failure of caseFailures) {
            for (const violation of failure.violations) {
                log(`  FAIL ${failure.invariant}: ${violation}`);
            }
        }
    }

    log("");
    log(`${pass}/${pass + fail} cases passed`);
    if (failures.length) {
        log("failed cases:");
        for (const name of failures) log(`  - ${name}`);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(`playbackInterleavings ERROR ${err && err.stack}`);
    process.exitCode = 1;
});
