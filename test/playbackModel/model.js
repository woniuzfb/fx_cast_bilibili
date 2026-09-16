"use strict";

/**
 * The reference model: what the USER's intent is, at every point of a sequence of
 * interleaved actions.
 *
 * It is deliberately NOT a model of the sender's implementation - no phases, no
 * transactions, no timers. What it tracks is only what the implementation is
 * supposed to be answerable to:
 *
 *     desiredPlayback          which play/pause state the next LOAD must inherit
 *     desiredPageTime          the position the newest explicit seek asked for
 *     mediaIdentity            which video the intent belongs to
 *     pendingSeek              a seek that is waiting for a load to serve it
 *     pageControlsAttached     whether the page's own events can reach the sender
 *     stopped                  whether the cast is over
 *     generatedTargets         the positions generations have been started for
 *
 * Everything the implementation does that is NOT in here (coalescing mechanics,
 * debounce timers, priming windows, remux restarts) is bounded by the invariants
 * instead of predicted: an over-specified model would just be a second
 * implementation to keep in sync, and its disagreements would say nothing about
 * the real one.
 *
 * ## The rules, and where each comes from
 *
 * 1. A PLAY/PAUSE from any CONTROL source is the user's intent:
 *
 *        PAGE_* / POPUP_* / BLE_*  ->  desiredPlayback follows it
 *
 *    "Receiver authoritative" is what makes the page and the sender follow the
 *    receiver, but it does not make the RECEIVER a source of intent by itself:
 *    see rule 4.
 *
 * 2. A SEEK changes the position only. It never edits `desiredPlayback`: a
 *    position transaction that silently edited the play/pause intent would undo
 *    whatever the user last asked for, which is the defect the load matrix's S
 *    flow pins (`autoplay` must survive a seek).
 *
 * 3. An explicit seek also becomes `pendingSeek` while no load can serve it yet.
 *    `desiredPageTime` records the newest one, so "newest explicit intent wins"
 *    is decidable without knowing how the implementation coalesces.
 *
 * 4. A RECEIVER observation is the user's intent ONLY when it is a settled state
 *    on a session the model has already seen (the physical remote, the receiver's
 *    own UI, another controller). It is never a command, and a state on a NEWER
 *    session is the receiver starting the session WE loaded - on a Roku that
 *    relaunch plays regardless of `autoplay`, so adopting it would overwrite the
 *    pause the user did ask for. This mirrors `adoptReceiverPlaybackIntent`.
 *
 * 5. An ITEM_CHANGE (a new video) adopts a new `mediaIdentity`: intent that was
 *    asked for on the previous video does not transfer, so `pendingSeek` is
 *    dropped unless the change is the one that CREATED it (a seek recorded while
 *    the new item was already current stays). A QUALITY_CHANGE is the same media,
 *    so the intent survives untouched.
 *
 * 6. While a load is in flight for an item/quality change, the page's own events
 *    are NOT forwarded (the sender detaches them deliberately: the site's events
 *    must not steer the receiver while a new item loads). The model records that
 *    as `pageControlsAttached: false`, which is what makes rule 7 checkable.
 *
 * 7. STOP ends the cast: no later action may start a generation or command the
 *    receiver. The model keeps the intent (the popup may show it) but nothing it
 *    records afterwards is an instruction.
 */

/** The states a receiver reports that ARE a settled user-visible state. */
const SETTLED = new Set(["PLAYING", "PAUSED"]);

const DEFAULT_STATE = {
    pageTime: 0,
    pagePlaying: true,
    desiredPlayback: "playing",
    desiredPageTime: 0,
    mediaIdentity: "video-a",
    pendingSeek: undefined,
    pageControlsAttached: true,
    stopped: false,
    /** Positions a generation has been started for, in order. */
    generatedTargets: [],
    /** The session the last receiver report came from (see rule 4). */
    lastReceiverSession: undefined,
    lastReceiverState: undefined,
    /** The identity each recorded generation belonged to. */
    generationIdentities: []
};

function createModel(overrides = {}) {
    return { ...DEFAULT_STATE, ...overrides };
}

/**
 * Fold one operation into the model.
 *
 * Returns `{ state, expect }`:
 *   - `state` is the model after the operation;
 *   - `expect` states what the implementation must be OBSERVED to do for this
 *     operation, in the terms the invariants check:
 *
 *       startsGeneration   whether a remux generation may be started at all
 *       generationTarget   the position it must be started for (when exactly one
 *                          position is defensible: an explicit seek)
 *       autoplay           what a LOAD started now must inherit
 *       receiverCommands   whether receiver-side commands are allowed at all
 *       servesPending      whether this operation is what serves a pending seek
 */
function applyToModel(state, op) {
    const next = { ...state };
    const expect = {
        startsGeneration: false,
        generationTarget: undefined,
        autoplay: next.desiredPlayback === "playing",
        receiverCommands: true,
        servesPending: false,
        /** Why the expectation is what it is, for a failure message. */
        rule: undefined
    };

    if (next.stopped) {
        // Rule 7: nothing is an instruction after a stop.
        expect.startsGeneration = false;
        expect.receiverCommands = false;
        expect.rule = "after-stop";
        return {
            state: { ...next, pageTime: op.pageTime ?? next.pageTime },
            expect
        };
    }

    switch (op.id) {
        case "PAGE_PLAY":
        case "POPUP_PLAY":
        case "PAGE_PAUSE":
        case "POPUP_PAUSE": {
            // Rule 6: while the page's events cannot reach the sender, neither
            // route delivers anything - the page's own event is not forwarded, and
            // the popup's page route answers "sender controls are not ready". (In
            // production the BACKGROUND then falls back to the bridge route for a
            // popup command; that layer is not this harness, and the load matrix's
            // popup flow covers the popup route with the controls attached.)
            if (!next.pageControlsAttached) {
                expect.rule = "controls-detached-not-delivered";
                break;
            }
            const wantsPlaying = /PLAY$/.test(op.id);
            const pageOrigin = op.id.startsWith("PAGE_");
            // A PAGE event only exists when the element MOVES: the browser fires
            // `play`/`pause` on a transition, so a page that is already in that
            // state produces no event and no intent. The popup's route does not
            // depend on the transition: it drives the element and dispatches to the
            // receiver either way, so the intent follows the command.
            if (pageOrigin && next.pagePlaying === wantsPlaying) {
                expect.rule = "page-is-already-in-that-state";
                break;
            }
            next.desiredPlayback = wantsPlaying ? "playing" : "paused";
            next.pagePlaying = wantsPlaying;
            expect.autoplay = wantsPlaying;
            expect.rule = pageOrigin
                ? "page-transition-is-intent"
                : "popup-command-is-intent";
            break;
        }
        case "BLE_PLAY":
        case "BLE_PAUSE": {
            // The BLE route exists precisely so this works while the page's
            // controls are detached: it reaches the receiver directly.
            if (op.id === "BLE_PLAY") {
                next.desiredPlayback = "playing";
                next.pagePlaying = true;
                expect.autoplay = true;
                expect.rule = "ble-play-is-intent";
            } else {
                next.desiredPlayback = "paused";
                next.pagePlaying = false;
                expect.autoplay = false;
                expect.rule = "ble-pause-is-intent";
            }
            break;
        }
        case "PAGE_SEEK":
        case "POPUP_SEEK":
        case "BLE_SEEK_BACKWARD":
        case "BLE_SEEK_FORWARD": {
            // Rule 2 + 3: position only, never the play/pause intent.
            const target = op.target;
            next.desiredPageTime = target;
            next.pageTime = target;
            next.pendingSeek = { target, mediaIdentity: next.mediaIdentity };
            // Whether a request restarts a generation is the coordinator's
            // decision, and it restarts unless a load is already in flight
            // (coalescing) or the page's events cannot reach it. The model states
            // the INPUT to that decision, and the invariants bound the answer - a
            // model that also predicted coalescing would be a second
            // implementation of it.
            expect.startsGeneration = next.pageControlsAttached;
            expect.generationTarget = next.pageControlsAttached
                ? target
                : undefined;
            expect.rule = next.pageControlsAttached
                ? "seek-is-an-explicit-position"
                : "seek-while-controls-detached";
            // A position never sends a receiver play/pause; a positioned reload
            // carries the intent instead.
            break;
        }
        case "ITEM_CHANGE": {
            // Rule 5 + 6: a new video, and the page's events are detached until
            // its load resolves.
            next.mediaIdentity = op.mediaIdentity;
            next.pendingSeek = undefined;
            next.pageTime = op.target;
            next.desiredPageTime = op.target;
            next.pageControlsAttached = false;
            // A new item means a new page element, and the site's player starts it
            // playing (it is what the remux is captured from). So the page is no
            // longer paused, and a PAGE_PLAY after this is not a transition: the
            // browser fires no `play` event for a page that is already playing, and
            // the sender therefore sees nothing to forward. A QUALITY_CHANGE keeps
            // the same element, so it leaves this alone.
            next.pagePlaying = true;
            expect.startsGeneration = true;
            expect.generationTarget = op.target;
            expect.rule = "item-change-loads-the-requested-position";
            break;
        }
        case "QUALITY_CHANGE": {
            // Same media: the intent survives, the page is detached while it
            // reloads.
            next.pageControlsAttached = false;
            expect.startsGeneration = true;
            expect.rule = "quality-change-reloads-the-same-intent";
            break;
        }
        case "LOAD_RESOLVE": {
            next.pageControlsAttached = true;
            if (op.refused === true) {
                // The load was rejected: the pending seek is KEPT (the load
                // matrix's R flow pins that) and will be served by the next
                // successful load.
                expect.rule = "refused-load-keeps-the-intent";
            } else {
                next.pendingSeek = undefined;
                expect.servesPending = true;
                expect.rule = "resolved-load-serves-the-pending-seek";
            }
            break;
        }
        case "RECEIVER_PLAYING":
        case "RECEIVER_PAUSED": {
            // Rule 4.
            const observingPlaying = op.id === "RECEIVER_PLAYING";
            const sameSession =
                op.mediaSessionId !== undefined &&
                next.lastReceiverSession !== undefined &&
                op.mediaSessionId === next.lastReceiverSession;
            const changed =
                next.lastReceiverState !== undefined &&
                next.lastReceiverState !==
                    (observingPlaying ? "PLAYING" : "PAUSED");
            const settled = SETTLED.has(
                observingPlaying ? "PLAYING" : "PAUSED"
            );
            next.lastReceiverSession = op.mediaSessionId;
            next.lastReceiverState = observingPlaying ? "PLAYING" : "PAUSED";
            if (
                settled &&
                sameSession &&
                changed &&
                next.pageControlsAttached
            ) {
                next.desiredPlayback = observingPlaying ? "playing" : "paused";
                next.pagePlaying = observingPlaying;
                expect.rule = "receiver-moved-the-session-the-user-has";
            } else {
                expect.rule = !sameSession
                    ? "new-session-is-our-own-load"
                    : !next.pageControlsAttached
                    ? "our-transaction-owns-the-page"
                    : "no-change-to-adopt";
            }
            // An observation is never a command and never a generation.
            expect.startsGeneration = false;
            expect.receiverCommands = false;
            break;
        }
        case "STOP": {
            next.stopped = true;
            next.pageControlsAttached = false;
            expect.startsGeneration = false;
            expect.receiverCommands = false;
            expect.rule = "stop-ends-the-cast";
            break;
        }
        case "SETTLE": {
            // "Let the receiver answer": whatever load is outstanding resolves.
            next.pageControlsAttached = true;
            next.pendingSeek = undefined;
            expect.servesPending = true;
            expect.rule = "settle-lets-the-load-resolve";
            break;
        }
        default:
            throw new Error(`model: unknown operation ${op.id}`);
    }

    // A load that is now allowed to start is a generation for the position in
    // force; recording it makes "the position a generation was started for" a
    // property of the sequence, not of one observation.
    if (expect.startsGeneration) {
        const target = expect.generationTarget ?? next.desiredPageTime;
        next.generatedTargets = [...next.generatedTargets, target];
        next.generationIdentities = [
            ...next.generationIdentities,
            next.mediaIdentity
        ];
    }
    return { state: next, expect };
}

module.exports = { createModel, applyToModel, SETTLED, DEFAULT_STATE };
