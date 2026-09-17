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
 *     activeLoad               the load we started that nothing has resolved yet
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
    /**
     * The load WE started and have not seen resolve.
     *
     * The model needs it because the world does NOT advance by itself: an
     * operation runs in whatever state the previous one left, and only an explicit
     * `LOAD_RESOLVE` or `SETTLE` clears this. An earlier version of the runner
     * settled outstanding loads before every non-lifecycle operation, which quietly
     * turned "a BLE pause while an item change's load is in flight" into "a BLE
     * pause on a settled cast" - the interleavings this stage exists for were
     * scheduled away before they could happen.
     */
    activeLoad: undefined,
    pageControlsAttached: true,
    stopped: false,
    /** Positions a generation has been started for, in order. */
    generatedTargets: [],
    /** The session the last receiver report came from (see rule 4). */
    lastReceiverSession: undefined,
    lastReceiverState: undefined,
    /**
     * The play/pause command still WAITING to be confirmed, with the session it
     * was sent to: `{ playerState, mediaSessionId }`.
     *
     * A DASH seek pauses the receiver to hold the frame while the remux rebuilds -
     * a command nobody asked for - so `desiredPlayback` deliberately stays where
     * the user left it while this records PAUSED. The report that command produces
     * must not be read as a user action: it is our echo.
     *
     * It is a PENDING command, not a memory of the last one. The two are different
     * questions, and answering the second is how a real remote action gets lost:
     * the expiry of our PLAY is confirmed, the user pauses and plays the remote,
     * and that later PLAY equals what we once commanded. Consumed on its echo,
     * replaced by the next command, and dropped when a settled report on the same
     * session does NOT match it (that report settles what the receiver is showing
     * us, and it is not our command).
     */
    pendingEcho: undefined,
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
    // `op.playerState` is stamped by the caller for the observation operations
    // (RECEIVER_ECHO carries exactly the state the extension last commanded).
    const next = { ...state };
    if (op.pagePaused !== undefined) {
        // The page's real state, supplied by the runner before every operation.
        // The model's own `pagePlaying` is a BELIEF: it does not know that a DASH
        // seek's hold freezes the element, nor that a mirror write pauses it, and
        // the browser only fires `play`/`pause` on a real transition. Taking the
        // truth here keeps the "already in that state" rule about the element
        // instead of about the model's guess.
        next.pagePlaying = !op.pagePaused;
    }
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
            // Both routes end in a receiver play/pause command, and the echo is
            // looked for on the session that command was sent to.
            next.pendingEcho = {
                playerState: wantsPlaying ? "PLAYING" : "PAUSED",
                mediaSessionId: op.currentMediaSessionId,
                issuedAt: op.now
            };
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
                next.pendingEcho = {
                    playerState: "PLAYING",
                    mediaSessionId: op.currentMediaSessionId,
                    issuedAt: op.now
                };
                expect.autoplay = true;
                expect.rule = "ble-play-is-intent";
            } else {
                next.desiredPlayback = "paused";
                next.pagePlaying = false;
                next.pendingEcho = {
                    playerState: "PAUSED",
                    mediaSessionId: op.currentMediaSessionId,
                    issuedAt: op.now
                };
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
            // A seek while a load we started is still in flight does NOT open a
            // second transaction: the coordinator coalesces it and the running one
            // retargets, so the position a generation ends up at is the newest
            // request's - which is exactly what the load matrix's "newest explicit
            // intent wins" rows pin. The model therefore states "a generation is
            // due" without pinning it to this operation's target in that case.
            expect.startsGeneration = next.pageControlsAttached;
            expect.generationTarget =
                next.pageControlsAttached && next.activeLoad === undefined
                    ? target
                    : undefined;
            expect.rule = !next.pageControlsAttached
                ? "seek-while-controls-detached"
                : next.activeLoad !== undefined
                ? "seek-coalesces-onto-the-load-in-flight"
                : "seek-is-an-explicit-position";
            // The seek pauses the RECEIVER to hold the frame while the remux is
            // rebuilt (onDashSeekStart). That is a command, not an intent: the
            // intent is untouched, and the receiver's report of it is the echo.
            if (expect.startsGeneration || next.pageControlsAttached) {
                next.pendingEcho = {
                    playerState: "PAUSED",
                    mediaSessionId: op.currentMediaSessionId,
                    issuedAt: op.now
                };
            }
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
            next.activeLoad = {
                target: op.target,
                mediaIdentity: op.mediaIdentity
            };
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
            next.activeLoad = {
                target: next.desiredPageTime,
                mediaIdentity: next.mediaIdentity
            };
            expect.startsGeneration = true;
            expect.rule = "quality-change-reloads-the-same-intent";
            break;
        }
        case "LOAD_RESOLVE": {
            next.pageControlsAttached = true;
            next.activeLoad = undefined;
            if (op.refused === true) {
                // The load was rejected: the pending seek is KEPT (the load
                // matrix's R flow pins that) and will be served by the next
                // successful load.
                expect.rule = "refused-load-keeps-the-intent";
            } else {
                // Serving a pending seek means starting a generation for it: the
                // load that just resolved is not the end of the chain, so a load is
                // in flight again - which is why a seek arriving now COALESCES onto
                // it instead of opening its own transaction.
                if (next.pendingSeek !== undefined) {
                    next.activeLoad = {
                        target: next.pendingSeek.target,
                        mediaIdentity: next.pendingSeek.mediaIdentity
                    };
                }
                next.pendingSeek = undefined;
                expect.servesPending = true;
                expect.rule = "resolved-load-serves-the-pending-seek";
            }
            break;
        }
        case "RECEIVER_PLAYING":
        case "RECEIVER_PAUSED":
        case "RECEIVER_ECHO": {
            // Rule 4.
            const observed =
                op.playerState ??
                (op.id === "RECEIVER_PLAYING"
                    ? "PLAYING"
                    : op.id === "RECEIVER_PAUSED"
                    ? "PAUSED"
                    : undefined);
            if (observed === undefined) {
                throw new Error(
                    `model: ${op.id} needs the state it carries (op.playerState)`
                );
            }
            const observingPlaying = observed === "PLAYING";
            const sameSession =
                op.mediaSessionId !== undefined &&
                next.lastReceiverSession !== undefined &&
                op.mediaSessionId === next.lastReceiverSession;
            const changed =
                next.lastReceiverState !== undefined &&
                next.lastReceiverState !==
                    (observingPlaying ? "PLAYING" : "PAUSED");
            const settled = SETTLED.has(observed);
            next.lastReceiverSession = op.mediaSessionId;
            next.lastReceiverState = observed;
            // The three conditions are the WHOLE contract. `pageControlsAttached`
            // deliberately does not appear: mirroring the receiver onto the page is
            // suppressible (a hold, an item transition, the gesture window), but
            // adopting the user's intent is not - `noteReceiverReport` records every
            // report, and the same-session rule already refuses our own load's first
            // state, which is the only echo that could be mistaken for the user.
            if (settled && sameSession && changed) {
                // An observation that matches a PENDING command on this session is
                // that command's echo, not the user - and for a seek it is a hold
                // the user never asked for. Either way this report SETTLES the
                // question: the echo is confirmed (and consumed), or the receiver
                // is showing a state our command does not explain, which is the
                // user moving it.
                const pending = next.pendingEcho;
                // The session must be KNOWN and EQUAL on both sides: an unknown
                // session is not evidence that this report is ours, and a report
                // past the confirmation window is the user's by definition. Both
                // rules are the implementation's (see adoptReceiverPlaybackIntent);
                // the window itself is read from its source, not restated here.
                const isEcho =
                    pending !== undefined &&
                    pending.playerState === observed &&
                    pending.mediaSessionId !== undefined &&
                    op.mediaSessionId !== undefined &&
                    pending.mediaSessionId === op.mediaSessionId &&
                    (op.echoWindowMs === undefined ||
                        op.now === undefined ||
                        pending.issuedAt === undefined ||
                        op.now - pending.issuedAt <= op.echoWindowMs);
                next.pendingEcho = undefined;
                if (isEcho) {
                    expect.rule = "the-echo-of-our-own-command";
                } else {
                    next.desiredPlayback = observingPlaying
                        ? "playing"
                        : "paused";
                    next.pagePlaying = observingPlaying;
                    expect.rule = "receiver-moved-the-session-the-user-has";
                }
            } else {
                expect.rule = !sameSession
                    ? "new-session-is-our-own-load"
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
        case "ADVANCE_CLOCK": {
            // The world's clock moves. Nothing about the cast changes: this is how
            // a case reaches the far side of the sender's confirmation window.
            expect.rule = "the-clock-moves";
            break;
        }
        case "LOAD_RESOLVE_SESSIONLESS": {
            // A generation resolves, exactly as LOAD_RESOLVE does. What differs is
            // the world's answer (no session id yet), which the runner feeds to the
            // model through observeCommandSession when a command follows.
            if (next.pendingSeek !== undefined) {
                next.activeLoad = {
                    target: next.pendingSeek.target,
                    mediaIdentity: next.pendingSeek.mediaIdentity
                };
            }
            next.pendingSeek = undefined;
            expect.servesPending = true;
            expect.rule = "resolved-load-serves-the-pending-seek";
            break;
        }
        case "MEDIA_WITHOUT_SESSION": {
            // The receiver's current media has no session id yet. The cast is
            // otherwise unchanged - what changes is that a command issued from here
            // cannot be attributed to a session (see observeCommandSession, which
            // the runner feeds from the fixture's record of where the command went).
            expect.rule = "the-media-has-no-session-yet";
            break;
        }
        case "SETTLE": {
            // "Let the receiver answer": whatever load is outstanding resolves.
            next.pageControlsAttached = true;
            next.activeLoad = undefined;
            next.pendingSeek = undefined;
            expect.servesPending = true;
            expect.rule = "settle-lets-the-load-resolve";
            break;
        }
        default:
            throw new Error(`model: unknown operation ${op.id}`);
    }

    // The intent the operation LEFT in force. A LOAD issued during the operation
    // may legitimately carry either this or the one it started with: an operation
    // that adopts a receiver's play/pause changes the intent WHILE a load of ours
    // may be in flight, and the step boundary cannot say which side of that change
    // a given LOAD fell on. Both are intents the user really expressed, so both are
    // accepted; an intent from an earlier operation still fails.
    expect.autoplayAfter = next.desiredPlayback === "playing";

    // A load that is now allowed to start is a generation for the position in
    // force; recording it makes "the position a generation was started for" a
    // property of the sequence, not of one observation.
    if (expect.startsGeneration) {
        const target = expect.generationTarget ?? next.desiredPageTime;
        // Starting a generation means asking the bridge for a remux, so a load is
        // in flight from that moment until something resolves it.
        next.activeLoad = { target, mediaIdentity: next.mediaIdentity };
        next.generatedTargets = [...next.generatedTargets, target];
        next.generationIdentities = [
            ...next.generationIdentities,
            next.mediaIdentity
        ];
    }
    // Diagnostic only: the echo record AFTER this operation, so a trace can show
    // which session the model believes our command reached.
    expect.pendingEchoAfter = next.pendingEcho
        ? { ...next.pendingEcho }
        : undefined;
    return { state: next, expect };
}

/**
 * The world states which media session the command this step dispatched reached
 * (and whether it reached one at all).
 *
 * The model cannot derive it: a command is issued INSIDE an operation - the seek
 * hold fires when the generation starts, which is after a SETTLE answered the
 * loads - so the session a step began with is not the session the command went
 * to. The fixture knows (it is the media object the sender commanded), and the
 * echo's identity is exactly what decides whether a later report belongs to our
 * command or to a session the user has since moved.
 */
function observeCommandSession(state, command) {
    if (state.pendingEcho === undefined) return state;
    if (!command || command.issued !== true) return state;
    // `mediaSessionId` may be undefined here, and that is information: it means the
    // command could not be attributed to a session at all (the receiver had not
    // named one yet), which the echo guard must treat as "no evidence" rather than
    // as a licence to match whatever session reports next.
    return {
        ...state,
        pendingEcho: {
            ...state.pendingEcho,
            mediaSessionId: command.mediaSessionId
        }
    };
}

/**
 * Tell the model what the receiver is doing now, WITHOUT treating it as a user
 * action.
 *
 * The world advances when a load of ours is answered: the receiver comes up on a
 * new session and reports the state that LOAD asked for. That is the model's
 * equivalent of the implementation's `noteReceiverReport` - a memory, not a
 * decision - and without it the model's "the session we have been watching" goes
 * stale, so an explicit receiver report on the CURRENT session looks like a new
 * session to the model while the implementation (which does record every tick)
 * adopts it. The two then disagree about which play/pause intent the next LOAD
 * should inherit.
 *
 * The caller supplies what the receiver reported (the harness knows: it is the
 * media the sender is bound to), never a decision.
 */
function observeWorldAdvance(model, { mediaSessionId, playerState }) {
    if (mediaSessionId === undefined || typeof playerState !== "string") {
        return model;
    }
    if (
        model.lastReceiverSession === mediaSessionId &&
        model.lastReceiverState === playerState
    ) {
        return model;
    }
    return {
        ...model,
        lastReceiverSession: mediaSessionId,
        lastReceiverState: playerState
    };
}

module.exports = {
    observeCommandSession,
    createModel,
    applyToModel,
    observeWorldAdvance,
    SETTLED,
    DEFAULT_STATE
};
