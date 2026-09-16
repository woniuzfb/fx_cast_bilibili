# Phase 3: the model-based interleavings

```
test/playbackModel/
    plan.js            the bridge's pad/timeline arithmetic, evaluated from mediaServer.ts
    senderHarness.js   DOM + cast-SDK stubs, fake clock, and the cast driver
    cases.js           the operation alphabet, the pairwise pairs, the seeded generator
    model.js           the reference model of the USER'S INTENT
    invariants.js      what must be true of any run
test/senders/
    playbackInterleavings.js   the runner (drives the real sender, judges each case)
```

## Why it exists

Every defect in this area has been an **interleaving**: a page seek during a
switch's load, a BLE skip racing a popup seek, a receiver report arriving while a
transaction held the page, a pause that a reload forgot. Hand-written scenario
tests (`dashLoadMatrix.js`) pin the interleavings somebody already thought of.
This runs seeded sequences over an alphabet of actions instead, and judges each
one against a reference model plus a list of invariants - so a failure PRINTS the
sequence that caused it, and that sequence is the reproduction.

## What is real, and what the model is not

|          |                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| real     | the bundled `MediaSender`; the bridge's plan arithmetic (`plan.js` reads `mediaServer.ts` and evaluates its expressions); a cast-SDK stub that records every receiver command; the page element's real event semantics (`seeking`/`seeked` only for a move that changed the position) |
| stubbed  | the cast SDK, the browser (`window`, `HTMLMediaElement`, a timer layer the test fires by hand) - the narrowest seams the sender has                                                                                                                                                   |
| modelled | only the USER'S INTENT: which play/pause state the next LOAD must inherit, which position the newest explicit seek asked for, which video the intent belongs to, whether the page's events can reach the sender, whether the cast is over                                             |

The model deliberately does **not** model transactions, debounce timers, priming
windows or coalescing mechanics: those are bounded by invariants, not predicted. A
model that predicted them would be a second implementation, and a disagreement
would say nothing about the real one.

## The alphabet names the SOURCE

`PAGE_PLAY`, `POPUP_PLAY`, `BLE_PLAY` and `RECEIVER_PLAYING` are four different
things, with four different owners, and the defects live at the boundaries between
them. One `PLAY` operation could not tell them apart. See `cases.js`.

## The invariants (`invariants.js`)

|     | property                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| I1  | an observation is not a command: a receiver report (and anything after a stop) starts no generation and commands no receiver |
| I2  | a LOAD inherits the playback intent in force when it is issued                                                               |
| I3  | a seek is a position: it never edits the play/pause intent                                                                   |
| I4  | a page seek cannot start a generation while the page's controls are detached                                                 |
| I5  | an explicit seek with the controls attached starts the position it asked for                                                 |
| I6  | nothing happens after a stop                                                                                                 |
| I7  | every generation carries the pad policy in force (bridge arithmetic)                                                         |
| I8  | a pending seek never crosses into another video                                                                              |

## Usage

```sh
node test/senders/playbackInterleavings.js --pairwise-only     # in npm run test:senders
node test/senders/playbackInterleavings.js --random 12 --length 5 --seed 42   # npm run test:interleavings
node test/senders/playbackInterleavings.js --random 60 --length 10 --seed 1000  # exploration
node test/senders/playbackInterleavings.js --verbose           # the operation-by-operation trace
```

`--verbose` prints, per operation, the generations it started, the page position,
the LOAD autoplay it submitted, and both intents (the sender's own and the model's)

-   the last pair is a diagnostic, never an assertion: it locates a divergence
    instead of leaving it to be inferred.

## Open finding (2026-09-17)

`npm run test:interleavings:explore` currently reports 3 of 77 cases, all one
shape, and the shortest reproduction is:

```sh
node test/senders/playbackInterleavings.js --random 1 --length 8 --seed 96028 --verbose
# ITEM_CHANGE(300) → SETTLE → BLE_PLAY → PAGE_PLAY → RECEIVER_PAUSED → …
```

The model says the `RECEIVER_PAUSED` (a settled state change on the session the
receiver has been reporting on) is the user's intent, so the following seeks must
reload paused; the implementation keeps `desiredPlayback = playing` and reloads
playing. The report is not dropped by the observation memory any more (that half
is fixed: see `noteReceiverReport`), so the remaining gate is inside the
adoption decision or upstream of it in the tick - **not yet located**, which is
why the exploration mode is documented as red rather than made green by choosing
seeds.

Until it is resolved, `npm run test:senders` runs the pairwise suite only (17/17)
and `npm run test:interleavings` the deterministic sweep that is green (29/29).
