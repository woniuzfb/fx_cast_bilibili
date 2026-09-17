"use strict";

/**
 * The operation alphabet, and where the sequences come from.
 *
 * ## Why the sources are tagged
 *
 * PLAY and PAUSE reach the sender through three different owners (the page's own
 * player events, the popup's control route, and the BLE remote's direct route),
 * and the receiver is a fourth thing entirely. They have different authority, and
 * the defects this stage exists to catch live exactly at the boundaries between
 * them: a page event that is not forwarded while controls are detached, a BLE
 * command that must not be dropped when they are, a receiver report that must not
 * become a command. One `PLAY` operation could not tell those apart, so the
 * alphabet names the source:
 *
 *     PAGE_PLAY / PAGE_PAUSE      the site's own player (a real gesture)
 *     POPUP_PLAY / POPUP_PAUSE    the popup's media controls, routed through the page
 *     BLE_PLAY / BLE_PAUSE        the physical remote, routed directly
 *     RECEIVER_PLAYING / RECEIVER_PAUSED   the receiver reporting its own state
 *
 * ## What the sequences are
 *
 *   - PAIRWISE: the ordered pairs that matter - the ones a fix for one entry
 *     point has already broken for another, plus the boundaries (a skip at 0:00,
 *     a play/pause while the page controls are detached, a stop around a load).
 *     Pairwise rather than exhaustive: the interesting failures in this area have
 *     all been two-action races.
 *   - RANDOM: seeded sequences over the same alphabet, so a failure is
 *     reproducible (`--seed`) instead of "sometimes".
 *
 * The alphabet is deliberately coarse: an operation is one user action or one
 * receiver report, never a combination, because a combination would hide which of
 * its parts produced the observed effect.
 */

/** A position that is not the beginning, so "0:00" rows mean something. */
const MID_POSITION = 300;
/** A BLE skip's step, in seconds. */
const SKIP_SECONDS = 30;

/**
 * Every operation the model knows, with the parameters a generated sequence may
 * vary. `target` is filled in by the generator from `TARGETS`.
 */
const TARGETS = [0, MID_POSITION];

const ALPHABET = [
    { id: "PAGE_PLAY", params: {} },
    { id: "PAGE_PAUSE", params: {} },
    { id: "POPUP_PLAY", params: {} },
    { id: "POPUP_PAUSE", params: {} },
    { id: "BLE_PLAY", params: {} },
    { id: "BLE_PAUSE", params: {} },
    { id: "PAGE_SEEK", params: { target: TARGETS } },
    { id: "POPUP_SEEK", params: { target: TARGETS } },
    { id: "BLE_SEEK_BACKWARD", params: { step: [SKIP_SECONDS] } },
    { id: "BLE_SEEK_FORWARD", params: { step: [SKIP_SECONDS] } },
    { id: "ITEM_CHANGE", params: { target: TARGETS } },
    { id: "QUALITY_CHANGE", params: {} },
    { id: "LOAD_RESOLVE", params: { refused: [true, false] } },
    { id: "RECEIVER_PLAYING", params: {} },
    { id: "RECEIVER_PAUSED", params: {} },
    /**
     * The receiver reporting the state the extension last COMMANDED - the echo of
     * our own play/pause, which for a DASH seek is a pause nobody asked for. It is
     * its own operation because it is its own event: not the user (it is the
     * extension's own command coming back) and not a command either.
     */
    { id: "RECEIVER_ECHO", params: {} },
    { id: "SETTLE", params: {} },
    { id: "STOP", params: {} },
    /**
     * The world's CLOCK moves. Not a user action and not a command: the sender's
     * windows are comparisons against `Date.now()`, and "past the confirmation
     * window a report is the user's" can only be tested by reaching the far side
     * of one.
     */
    { id: "ADVANCE_CLOCK", params: { ms: [15001] } },
    /**
     * The receiver's current media has no session id yet (a LOAD it accepted but
     * has not named - the relaunch window). Commands issued from here cannot be
     * attributed to a session, which the echo guard must treat as no evidence.
     */
    { id: "LOAD_RESOLVE_SESSIONLESS", params: {} },
    /**
     * The SDK's answer to a dispatch: the receiver REFUSED a play/pause. Not a
     * user action and not a report - the world telling us our command will never
     * be confirmed, which is why it cannot be reached from the user's operations.
     */
    { id: "COMMANDS_REFUSED", params: {} },
    { id: "COMMANDS_ACCEPTED", params: {} },
    { id: "ARM_COMMAND_FAILURE", params: {} },
    { id: "DELIVER_COMMAND_ERROR", params: {} }
];

/**
 * The ordered sequences from the review that must hold, by hand.
 *
 * Each is written as the sequence it means, INCLUDING the world advancement it
 * needs: `SETTLE` / `LOAD_RESOLVE` are operations a case states on purpose, never
 * something the runner does behind its back. That split is the point of the list:
 *
 *   - a SETTLED pair (`ITEM_CHANGE → SETTLE → BLE_PAUSE`) proves the ordinary
 *     behaviour of a command after the world has caught up;
 *   - an IN-FLIGHT triple (`ITEM_CHANGE → BLE_PAUSE → LOAD_RESOLVE`) proves the
 *     same command while the load is still in flight and the page's controls are
 *     detached - the window where the real defects have lived, and the one an
 *     implicitly-settling runner can never reach.
 *
 * The model carries the expectation for both (`activeLoad`), so a case does not
 * say what should happen - only which interleaving to run.
 *
 * One sequence is deliberately MISSING, and the reason belongs here rather than
 * in a comment on a case that does not exist: `ITEM_CHANGE → RECEIVER_* →
 * LOAD_RESOLVE → PAGE_SEEK` is the one thing this fixture cannot drive yet.
 * Answering an item change's load with a bare `LOAD_RESOLVE` makes the sender's
 * load callback refuse it (`INVALID_REQUEST: INTERRUPTED`), so a case written
 * that way would assert the fixture's shortcut, not the contract; the matrix
 * drives an item change through its own helper, which is what this harness still
 * has to learn - see test/playbackModel/README.md ("What the harness cannot say
 * yet"). The rest of that window IS covered: the in-flight BLE triples below, the
 * detached page seek, the receiver echo, and the post-stop sequences.
 */
const PAIRWISE = [
    // ---- in-flight: the command arrives while our own load is unresolved -------
    {
        name: "ITEM_CHANGE → BLE_PAUSE (load in flight)",
        ids: ["ITEM_CHANGE", "BLE_PAUSE", "LOAD_RESOLVE"]
    },
    {
        name: "ITEM_CHANGE → BLE_PLAY (load in flight)",
        ids: ["ITEM_CHANGE", "BLE_PLAY", "LOAD_RESOLVE"]
    },
    {
        name: "ITEM_CHANGE → BLE_SEEK (load in flight)",
        ids: ["ITEM_CHANGE", "BLE_SEEK_BACKWARD", "LOAD_RESOLVE"]
    },
    // ---- settled: the same commands once the world has caught up ---------------
    {
        name: "ITEM_CHANGE → SETTLE → BLE_PAUSE",
        ids: ["ITEM_CHANGE", "SETTLE", "BLE_PAUSE"]
    },
    { name: "BLE_PAUSE → ITEM_CHANGE", ids: ["BLE_PAUSE", "ITEM_CHANGE"] },
    { name: "POPUP_PAUSE → PAGE_SEEK", ids: ["POPUP_PAUSE", "PAGE_SEEK"] },
    { name: "PAGE_SEEK → POPUP_PAUSE", ids: ["PAGE_SEEK", "POPUP_PAUSE"] },
    { name: "LOAD_REJECT → ITEM_CHANGE", ids: ["LOAD_RESOLVE", "ITEM_CHANGE"] },
    { name: "STOP → LOAD_RESOLVE", ids: ["STOP", "LOAD_RESOLVE"] },
    { name: "LOAD_RESOLVE → STOP", ids: ["LOAD_RESOLVE", "STOP"] },
    {
        name: "POPUP_SEEK → POPUP_SEEK (coalescing)",
        ids: ["POPUP_SEEK", "POPUP_SEEK", "SETTLE"]
    },
    { name: "PAGE_SEEK → ITEM_CHANGE", ids: ["PAGE_SEEK", "ITEM_CHANGE"] },
    { name: "BLE_PLAY → BLE_PAUSE", ids: ["BLE_PLAY", "BLE_PAUSE"] },
    {
        name: "RECEIVER_PAUSED → PAGE_SEEK",
        ids: ["RECEIVER_PAUSED", "PAGE_SEEK"]
    },
    // The regression this stage was extended for: a popup seek pauses the RECEIVER
    // (the hold), the receiver reports that pause back, and the reload that follows
    // must still carry the USER's intent - not the hold's.
    {
        // The second seek is what OBSERVES the wrong intent: its LOAD is submitted
        // when the flow answers it, and a hold's echo that was adopted as intent
        // makes that LOAD `autoplay: false` - a seek that silently pauses playback,
        // and the page follows the receiver down.
        name: "POPUP_SEEK → RECEIVER_ECHO → PAGE_SEEK → SETTLE (a hold's echo is not an intent)",
        ids: ["POPUP_SEEK", "RECEIVER_ECHO", "PAGE_SEEK", "SETTLE"]
    },
    // ---- continuous windows: four operations, no `SETTLE` in between ----------
    // The sequences above are two or three operations; these are the longer windows
    // where the receiver and the user disagree while a load is still unresolved.
    {
        // The user pauses; the receiver then claims to be PLAYING (the physical
        // remote, or a stale report). The receiver is a report, not an order - the
        // load that follows must carry the user's pause, not the receiver's claim.
        name: "POPUP_SEEK → POPUP_PAUSE → RECEIVER_PLAYING → LOAD_RESOLVE",
        ids: ["POPUP_SEEK", "POPUP_PAUSE", "RECEIVER_PLAYING", "LOAD_RESOLVE"]
    },
    {
        // A stop during the seek's own reload: the resolution must not resurrect the
        // generation the user just cancelled.
        name: "POPUP_SEEK → STOP → LOAD_RESOLVE (nothing after stop)",
        ids: ["POPUP_SEEK", "STOP", "LOAD_RESOLVE"]
    },
    {
        // Two reports around one resolution: the receiver's session moves while the
        // load is resolving, and the second report must be judged against the state
        // the first one left - not against the pre-load state.
        name: "LOAD_RESOLVE → RECEIVER_PAUSED → RECEIVER_PLAYING",
        ids: ["LOAD_RESOLVE", "RECEIVER_PAUSED", "RECEIVER_PLAYING"]
    },
    // ---- an echo is confirmed ONCE, not forever ------------------------------
    // The review's sequence, and the reason "the state we last commanded" is not
    // the same question as "a command is waiting to be confirmed": the echo of our
    // PLAY is answered, the user then PAUSES and PLAYS the receiver with the
    // physical remote, and that second PLAY happens to equal the state we once
    // commanded. A sticky memory refuses it as an echo, so the intent stays paused
    // and the seek that follows reloads `autoplay: false` - the same symptom the
    // echo guard exists to prevent, in the opposite direction.
    {
        // The leading PAUSE->PLAY pair is what makes this case about an echo at
        // all: a PAGE_PLAY on a page that is already playing fires no event and
        // issues no command (the model says so too), so a case that starts there
        // has nothing pending for the receiver to confirm.
        name: "PAGE_PAUSE → PAGE_PLAY → RECEIVER_ECHO → RECEIVER_PAUSED → RECEIVER_PLAYING → PAGE_SEEK (an echo is consumed once)",
        ids: [
            "PAGE_PAUSE",
            "PAGE_PLAY",
            "RECEIVER_ECHO",
            "RECEIVER_PAUSED",
            "RECEIVER_PLAYING",
            "PAGE_SEEK",
            "SETTLE"
        ]
    },
    {
        // ...and the mirror image, so the guard cannot be "fixed" by simply never
        // refusing anything: our PAUSE is echoed, the user then PLAYS and PAUSES,
        // and the final pause is the user's - the seek must reload paused.
        name: "PAGE_PAUSE → RECEIVER_ECHO → RECEIVER_PLAYING → RECEIVER_PAUSED → PAGE_SEEK (the mirror image)",
        ids: [
            "PAGE_PAUSE",
            "RECEIVER_ECHO",
            "RECEIVER_PLAYING",
            "RECEIVER_PAUSED",
            "PAGE_SEEK",
            "SETTLE"
        ]
    },
    {
        // The echo is only the echo while the confirmation window is open. Past it
        // the same state is the USER's, and the seek that follows must reload with
        // the intent the user actually asked for - the window is what keeps "we
        // asked for this at some point" from becoming a reason to ignore them. The
        // seek's hold is the command here because its pause does NOT change the
        // intent: refusing the report keeps the intent playing, adopting it pauses.
        name: "POPUP_SEEK → ADVANCE_CLOCK(15001) → RECEIVER_PAUSED → PAGE_SEEK (the confirmation window ends)",
        ids: [
            "POPUP_SEEK",
            "ADVANCE_CLOCK",
            "RECEIVER_PAUSED",
            "PAGE_SEEK",
            "SETTLE"
        ]
    },
    {
        // A command issued while the receiver has not named its session cannot be
        // attributed to one, and an unattributable command must not swallow a real
        // action: the report is the user's. (Treating an unknown session as a
        // wildcard would let it match whatever session reports next.) The leading
        // PLAYING is what makes the PAUSED adoptable at all - the first report of a
        // session is never a user move, it is the receiver naming itself - so the
        // case isolates the echo rule instead of the same-session rule.
        name: "POPUP_SEEK → LOAD_RESOLVE_SESSIONLESS → POPUP_SEEK → RECEIVER_PLAYING → RECEIVER_PAUSED → PAGE_SEEK (an unattributable command is not an echo)",
        ids: [
            "POPUP_SEEK",
            "LOAD_RESOLVE_SESSIONLESS",
            "POPUP_SEEK",
            "RECEIVER_PLAYING",
            "RECEIVER_PAUSED",
            "PAGE_SEEK",
            "SETTLE"
        ]
    },
    {
        // A refused command is not one we are waiting to see confirmed: the echo
        // that will never come must not stay armed for the whole window, or the
        // user pressing the same state on the physical remote is dismissed as the
        // echo of a command the receiver never accepted. The seek's hold is the
        // command here, because its pause does not change the intent.
        name: "COMMANDS_REFUSED → POPUP_SEEK → RECEIVER_PAUSED → PAGE_SEEK (a refused command is not awaited)",
        ids: [
            "COMMANDS_REFUSED",
            "POPUP_SEEK",
            "RECEIVER_PAUSED",
            "PAGE_SEEK",
            "SETTLE"
        ]
    },
    {
        // ...and the revocation is by COMMAND INSTANCE: the SDK reports failures
        // asynchronously, so an error for a command a later one replaced must not
        // disarm the successor - the receiver is confirming THAT one now. Here the
        // PAUSED report is the hold's echo (the intent stays playing); disarming it
        // would adopt the report as a user pause, and the seek would reload paused.
        name: "PAGE_PAUSE → ARM_COMMAND_FAILURE → PAGE_PLAY → POPUP_SEEK → DELIVER_COMMAND_ERROR → RECEIVER_PAUSED → PAGE_SEEK (a late refusal cannot revoke its successor)",
        ids: [
            "PAGE_PAUSE",
            "ARM_COMMAND_FAILURE",
            "PAGE_PLAY",
            "POPUP_SEEK",
            "DELIVER_COMMAND_ERROR",
            "RECEIVER_PAUSED",
            "PAGE_SEEK",
            "SETTLE"
        ]
    },
    {
        // A command belongs to the SESSION it was sent to. The item change replaces
        // the session, so the reports of the new one are the user moving THAT
        // session - the previous session's command cannot dominate them.
        name: "PAGE_PLAY → ITEM_CHANGE → RECEIVER_PAUSED → RECEIVER_PLAYING → PAGE_SEEK (another session's command)",
        ids: [
            "PAGE_PLAY",
            "SETTLE",
            "ITEM_CHANGE",
            "SETTLE",
            "RECEIVER_PAUSED",
            "RECEIVER_PLAYING",
            "PAGE_SEEK",
            "SETTLE"
        ]
    }
];

/** A deterministic PRNG (mulberry32), so a seed reproduces a failure exactly. */
function makeRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Materialize an operation from the alphabet, with concrete parameters. */
function materialize(id, random) {
    const entry = ALPHABET.find(candidate => candidate.id === id);
    if (!entry) throw new Error(`cases: ${id} is not in the alphabet`);
    const op = { id };
    for (const [name, values] of Object.entries(entry.params)) {
        op[name] = values[Math.floor(random() * values.length)];
    }
    return op;
}

/** A case is a named sequence of operations. */
function caseOf(name, ops) {
    return { name, ops };
}

/**
 * The hand-written pairs. Targets are fixed per pair so the pair means one thing:
 * the first operation lands on a position, the second is applied to the state it
 * created.
 */
function pairwiseCases() {
    return PAIRWISE.map((entry, index) => {
        const random = makeRandom(0x9e37 + index);
        return caseOf(
            entry.name,
            entry.ids.map(id => materialize(id, random))
        );
    });
}

/**
 * Seeded random sequences.
 *
 * `length` counts operations, and every sequence starts from the same place (a
 * live cast at MID_POSITION) so a failure report can be read without replaying
 * anything: the operations ARE the reproduction.
 */
function randomCases({ seed = 1, runs = 12, length = 6 } = {}) {
    const cases = [];
    // ITEM_CHANGE is EXCLUDED from generated sequences, and the reason is the
    // fixture, not the model: an item change's own load cannot be resolved through
    // the generic answer path yet (`LOAD_RESOLVE` / `SETTLE` make the sender's
    // load callback refuse it - `INVALID_REQUEST: INTERRUPTED`), so a sequence that
    // contains one leaves the sender with a transaction the fixture cannot finish
    // and every later step is then judged against a world that no longer matches.
    // The hand-written cases above still drive ITEM_CHANGE, each with the exact
    // advance it needs. See README ("What the harness cannot say yet").
    const GENERATED = ALPHABET.filter(entry => entry.id !== "ITEM_CHANGE");
    for (let run = 0; run < runs; run++) {
        const random = makeRandom(seed + run * 7919);
        const ops = [];
        for (let i = 0; i < length; i++) {
            const entry = GENERATED[Math.floor(random() * GENERATED.length)];
            ops.push(materialize(entry.id, random));
            // Whether the world catches up between two operations is part of the
            // SEQUENCE, not of the runner: half the runs advance it explicitly (a
            // load resolves, the page's controls come back) and half leave it in
            // flight, so both worlds are explored without either being assumed.
            if (random() < 0.5) {
                ops.push(materialize("SETTLE", random));
            }
        }
        cases.push(
            caseOf(
                `seed ${seed + run * 7919}: ${ops.map(o => o.id).join(" → ")}`,
                ops
            )
        );
    }
    return cases;
}

module.exports = {
    ALPHABET,
    PAIRWISE,
    TARGETS,
    MID_POSITION,
    SKIP_SECONDS,
    makeRandom,
    materialize,
    pairwiseCases,
    randomCases
};
