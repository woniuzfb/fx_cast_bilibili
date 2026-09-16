"use strict";

/**
 * The invariants: what must be true of a run, whatever the sequence was.
 *
 * Each takes the run - `{ ops, trace, generations, startupPaddingEnabled }` -
 * and returns a list of violations (empty when it holds). They are written
 * against OBSERVABLES (the remux generations a run started, the LOADs it issued,
 * the receiver commands it sent, the page position it left) rather than against
 * the sender's internal state, so a violation is always something a user could
 * have seen, and a refactor that keeps the behaviour keeps the invariant.
 *
 * The model's role is only to say what the observables MUST be for the operation
 * that produced them (`expect`), which is where the single-meaning contract lives
 * (model.js). Nothing here reads the implementation's phases or flags.
 */

/** The receiver commands a step is credited with. */
function commandDelta(step) {
    const delta = {};
    for (const key of Object.keys(step.commandsAfter)) {
        const difference =
            (step.commandsAfter[key] ?? 0) - (step.commandsBefore[key] ?? 0);
        if (difference) delta[key] = difference;
    }
    return delta;
}

function describe(step) {
    return `${step.index}. ${step.op.id}${
        step.op.target !== undefined ? ` (${step.op.target})` : ""
    }${step.op.refused !== undefined ? ` (refused=${step.op.refused})` : ""}`;
}

/**
 * I1. An observation is not a command.
 *
 * A receiver report, and anything at all after a stop, must not command the
 * receiver or start a remux generation. This is the property the two "a status
 * report produced receiver commands" rows in the load matrix pin for one step; a
 * model-based run pins it for every step of every sequence.
 */
function observationIsNotACommand(run) {
    const violations = [];
    for (const step of run.trace) {
        if (step.expect.receiverCommands) continue;
        const delta = commandDelta(step);
        if (Object.keys(delta).length) {
            violations.push(
                `${describe(
                    step
                )}: a non-command produced receiver commands ${JSON.stringify(
                    delta
                )}`
            );
        }
        if (step.newGenerations.length) {
            violations.push(
                `${describe(step)}: a non-command started ${
                    step.newGenerations.length
                } generation(s) at ${JSON.stringify(
                    step.newGenerations.map(entry => entry.startTime)
                )}`
            );
        }
    }
    return violations;
}

/**
 * I2. A LOAD inherits the playback intent in force when it is issued.
 *
 * The reload is a position transaction, not a play/pause transaction: a paused
 * user must still be paused after it, and a playing one must not be paused by it.
 * `expect.autoplay` is the model's intent at that point in the sequence.
 */
function loadInheritsTheIntent(run) {
    const violations = [];
    for (const step of run.trace) {
        for (const load of step.newLoads) {
            const autoplay = load?.autoplay;
            if (autoplay !== step.expect.autoplay) {
                violations.push(
                    `${describe(step)}: LOAD autoplay ${JSON.stringify(
                        autoplay
                    )} (expected ${JSON.stringify(step.expect.autoplay)}: ${
                        step.expect.rule
                    })`
                );
            }
        }
    }
    return violations;
}

/**
 * I3. A seek is a position, never an edit of the play/pause intent.
 *
 * The model does not change `desiredPlayback` for a seek, so this is I2 restricted
 * to seek operations - kept separate because a failure here means "the position
 * transaction edited the intent", which is a different bug from "the LOAD read the
 * wrong intent" and should be reported as such.
 */
function seekDoesNotEditTheIntent(run) {
    const violations = [];
    for (const step of run.trace) {
        if (!/SEEK/.test(step.op.id)) continue;
        if (
            step.modelAfter.desiredPlayback !== step.modelBefore.desiredPlayback
        ) {
            violations.push(
                `${describe(step)}: the model's own rule edited the intent (${
                    step.modelBefore.desiredPlayback
                } -> ${step.modelAfter.desiredPlayback})`
            );
        }
        for (const load of step.newLoads) {
            const expected = step.modelBefore.desiredPlayback === "playing";
            const autoplay = load?.autoplay;
            if (autoplay !== expected) {
                violations.push(
                    `${describe(
                        step
                    )}: the reload after a seek used autoplay ${JSON.stringify(
                        autoplay
                    )} while the intent in force was ${
                        step.modelBefore.desiredPlayback
                    }`
                );
            }
        }
    }
    return violations;
}

/**
 * I4. A page seek cannot start a generation while the page controls are detached.
 *
 * During an item/quality change's load the sender detaches the page's own event
 * listeners, deliberately: the site's events must not steer the receiver while a
 * new item loads. So a page-origin seek in that window is not forwarded, and
 * nothing may be restarted by it. (A BLE or popup command in the same window is a
 * different matter - those are handled by their own routes and by I5/I6.)
 */
function detachedControlsStartNoGeneration(run) {
    const violations = [];
    for (const step of run.trace) {
        if (step.op.id !== "PAGE_SEEK") continue;
        if (step.modelBefore.pageControlsAttached) continue;
        if (step.newGenerations.length) {
            violations.push(
                `${describe(
                    step
                )}: a page seek with the page controls detached started a generation at ${JSON.stringify(
                    step.newGenerations.map(entry => entry.startTime)
                )}`
            );
        }
    }
    return violations;
}

/**
 * I5. An explicit seek with the controls attached starts the position it asked
 * for: the newest explicit intent wins, and it wins by being the newest.
 */
function explicitSeekStartsItsOwnTarget(run) {
    const violations = [];
    for (const step of run.trace) {
        // A seek that changes nothing must not restart anything either: the
        // request is "already there".
        if (step.expect.redundantSeek && step.newGenerations.length) {
            violations.push(
                `${describe(
                    step
                )}: a seek to the position already in force started a generation at ${JSON.stringify(
                    step.newGenerations.map(entry => entry.startTime)
                )}`
            );
        }
        if (!step.expect.startsGeneration) continue;
        if (step.expect.generationTarget === undefined) continue;
        const targets = step.newGenerations.map(entry => entry.startTime);
        if (!targets.length) {
            violations.push(
                `${describe(
                    step
                )}: no generation was started (expected one at ${
                    step.expect.generationTarget
                }: ${step.expect.rule})`
            );
            continue;
        }
        for (const target of targets) {
            if (Math.abs(target - step.expect.generationTarget) > 1e-6) {
                violations.push(
                    `${describe(
                        step
                    )}: a generation was started at ${target}s, not at the requested ${
                        step.expect.generationTarget
                    }s (${step.expect.rule})`
                );
            }
        }
    }
    return violations;
}

/**
 * I6. Nothing happens after a stop.
 *
 * The operations after STOP may not start a generation or command the receiver:
 * the cast is over, and a late load resolving or a receiver report arriving must
 * not bring it back.
 */
function nothingHappensAfterStop(run) {
    const violations = [];
    let stopped = false;
    for (const step of run.trace) {
        if (step.op.id === "STOP") {
            stopped = true;
            continue;
        }
        if (!stopped) continue;
        const delta = commandDelta(step);
        if (Object.keys(delta).length) {
            violations.push(
                `${describe(
                    step
                )}: commanded the receiver after a stop ${JSON.stringify(
                    delta
                )}`
            );
        }
        if (step.newGenerations.length) {
            violations.push(
                `${describe(
                    step
                )}: started a generation after a stop at ${JSON.stringify(
                    step.newGenerations.map(entry => entry.startTime)
                )}`
            );
        }
    }
    return violations;
}

/**
 * I7. Every generation carries the pad policy in force.
 *
 * With the startup-padding option on, the bridge pads every Chromecast DASH
 * generation's playlist to at least the required runway; with it off, the pads are
 * exactly the keyframe. Both are the BRIDGE's arithmetic (see plan.js), so this
 * checks the plan the harness answered with, not a restatement of it.
 */
function padPolicyHolds(run) {
    const violations = [];
    for (const generation of run.generations) {
        const plan = generation.plan;
        if (!plan) continue;
        if (run.startupPaddingEnabled) {
            if (plan.padDuration < plan.requiredPadDuration) {
                violations.push(
                    `generation ${generation.requestId} carries ${plan.padDuration}s of pads, below the required ${plan.requiredPadDuration}s`
                );
            }
        } else if (plan.padDuration !== plan.contentBase) {
            violations.push(
                `generation ${generation.requestId} carries ${plan.padDuration}s of pads with the option OFF (expected the keyframe's ${plan.contentBase}s)`
            );
        }
    }
    return violations;
}

/**
 * I8. A pending seek never crosses into another video.
 *
 * After an item change, the next generation must be for the position the change
 * asked for unless an explicit seek came after it: the seek the user made in the
 * PREVIOUS video must not be applied to this one. The model drops the pending seek
 * on a new identity, and this is the observable consequence.
 */
function pendingSeekNeverCrossesMedia(run) {
    const violations = [];
    let pendingFromAnotherIdentity;
    for (const step of run.trace) {
        if (step.op.id === "ITEM_CHANGE") {
            pendingFromAnotherIdentity = step.modelBefore.pendingSeek?.target;
            continue;
        }
        if (pendingFromAnotherIdentity === undefined) continue;
        if (/SEEK/.test(step.op.id)) {
            // An explicit seek after the change re-aims it: not a violation.
            pendingFromAnotherIdentity = undefined;
            continue;
        }
        for (const generation of step.newGenerations) {
            if (
                Math.abs(generation.startTime - pendingFromAnotherIdentity) <
                1e-6
            ) {
                violations.push(
                    `${describe(
                        step
                    )}: served the previous video's pending seek (${pendingFromAnotherIdentity}s) on the new one`
                );
            }
        }
        if (step.newGenerations.length) pendingFromAnotherIdentity = undefined;
    }
    return violations;
}

const INVARIANTS = [
    observationIsNotACommand,
    loadInheritsTheIntent,
    seekDoesNotEditTheIntent,
    detachedControlsStartNoGeneration,
    explicitSeekStartsItsOwnTarget,
    nothingHappensAfterStop,
    padPolicyHolds,
    pendingSeekNeverCrossesMedia
];

/** Run every invariant; returns `[{ invariant, violations }]` for the failures. */
function checkInvariants(run) {
    const failures = [];
    for (const invariant of INVARIANTS) {
        const violations = invariant(run) ?? [];
        if (violations.length) {
            failures.push({ invariant: invariant.name, violations });
        }
    }
    return failures;
}

module.exports = { INVARIANTS, checkInvariants };
