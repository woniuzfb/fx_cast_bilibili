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
const { createModel, applyToModel } = require("../playbackModel/model");
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
 * The operations that own the load lifecycle: their point is a load still in
 * flight (an item/quality change holds it) or one being resolved or refused, so
 * the runner does not drain them before they run.
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
            if (op.refused) {
                await cast.answerAndRefuseNewest();
            } else {
                await cast.answerNewest();
                await cast.settle();
            }
            return;
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
    /** Generations the bridge/receiver have already answered in this run. */
    let answeredSoFar = generationsBeforeRun;

    for (const [index, op] of testCase.ops.entries()) {
        // Let the world catch up BEFORE this operation is measured.
        //
        // The bridge and the receiver keep up with what was ASKED for: a
        // generation an earlier intent started is answered here, and the receiver
        // reports where it landed. Doing it after the operation would credit this
        // operation with a LOAD that an earlier one caused - the first version of
        // this runner did exactly that, and reported "a popup pause reloaded with
        // autoplay true" for a load the item change before it had asked for.
        //
        // The operations that OWN the load lifecycle are excluded: their whole
        // point is a load still in flight (an item or quality change holds it), or
        // one that is being resolved or refused.
        if (!LIFECYCLE_OPERATIONS.has(op.id)) {
            const outstanding = cast.h.started.length > answeredSoFar;
            if (outstanding) {
                await cast.settle();
                answeredSoFar = cast.h.started.length;
                model = applyToModel(model, {
                    id: "LOAD_RESOLVE",
                    refused: false
                }).state;
                // Answering that load brought the receiver up on a NEW session, and
                // its state is the one the LOAD asked for. The model has to know,
                // or the next receiver report would read as "a new session" (the
                // shape of our own load, which must NOT be adopted as intent)
                // instead of "the session the user is on".
                const answeredLoad = cast.generations.at(-1)?.load?.request;
                model = {
                    ...model,
                    lastReceiverSession: cast.receiverSessionId(),
                    lastReceiverState:
                        answeredLoad?.autoplay === false ? "PAUSED" : "PLAYING"
                };
            }
        }
        // Parameters that describe the live cast are read HERE rather than in the
        // case: a receiver report comes from the session the receiver is on, and an
        // item change is "a video that is not this one".
        if (op.id === "RECEIVER_PLAYING" || op.id === "RECEIVER_PAUSED") {
            op.mediaSessionId = cast.receiverSessionId();
        }
        if (op.id === "ITEM_CHANGE") {
            op.mediaIdentity = "video-next";
        }
        const generationsBefore = snapshotGenerations(cast);
        const loadsBefore = cast.h.loadRequests.length;
        const commandsBefore = cast.h.receiverCommandTotals();
        const pageBefore = {
            currentTime: cast.h.element.currentTime,
            paused: cast.h.element.paused
        };
        const modelBefore = model;
        const { state: modelAfter, expect } = applyToModel(model, op);
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
            if (
                ![
                    "ITEM_CHANGE",
                    "QUALITY_CHANGE",
                    "LOAD_RESOLVE",
                    "SETTLE"
                ].includes(op.id)
            ) {
                await cast.settle();
            }
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
        if (VERBOSE) {
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

    const cases = pairwiseCases();
    if (!PAIRWISE_ONLY && RANDOM_RUNS > 0) {
        cases.push(
            ...randomCases({ seed: SEED, runs: RANDOM_RUNS, length: LENGTH })
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
        const { failures: caseFailures } = await runCase(MediaSender, testCase);
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
