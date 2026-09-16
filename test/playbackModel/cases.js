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
    { id: "SETTLE", params: {} },
    { id: "STOP", params: {} }
];

/**
 * The ordered pairs from the review that must hold, by hand.
 *
 * Each is two operations; the runner extends it with the model's own expectation,
 * so the list is only about WHICH interleavings are worth running, not about what
 * should happen - that lives in model.js and invariants.js.
 */
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
    // The one that proves the production fix: mirroring may be suppressed, the
    // user's intent may not - and the reload after it inherits that intent.
    {
        name: "ITEM_CHANGE → RECEIVER_PAUSED → LOAD_RESOLVE → PAGE_SEEK",
        ids: ["ITEM_CHANGE", "RECEIVER_PAUSED", "LOAD_RESOLVE", "PAGE_SEEK"]
    },
    {
        name: "ITEM_CHANGE → PAGE_SEEK (detached page) → LOAD_RESOLVE",
        ids: ["ITEM_CHANGE", "PAGE_SEEK", "LOAD_RESOLVE"]
    },
    {
        name: "QUALITY_CHANGE → BLE_PAUSE (load in flight)",
        ids: ["QUALITY_CHANGE", "BLE_PAUSE", "LOAD_RESOLVE"]
    },
    {
        name: "ITEM_CHANGE → RECEIVER_PLAYING → LOAD_RESOLVE → PAGE_SEEK",
        ids: ["ITEM_CHANGE", "RECEIVER_PLAYING", "LOAD_RESOLVE", "PAGE_SEEK"]
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
    for (let run = 0; run < runs; run++) {
        const random = makeRandom(seed + run * 7919);
        const ops = [];
        for (let i = 0; i < length; i++) {
            const entry = ALPHABET[Math.floor(random() * ALPHABET.length)];
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
