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

## The world does not advance by itself

An operation runs in exactly the state the previous one left. The bridge and the
receiver answer only when a case says so:

```text
ITEM_CHANGE / QUALITY_CHANGE   start a load; it stays in flight (page controls detached)
LOAD_RESOLVE                   resolve or refuse that load
SETTLE                         let everything outstanding run to completion
```

The model tracks that as `activeLoad`, and every case states its own world
advancement - which is the whole difference between the two kinds of pair:

```text
ITEM_CHANGE → SETTLE → BLE_PAUSE        the command on a settled cast
ITEM_CHANGE → BLE_PAUSE → LOAD_RESOLVE  the command INSIDE the window
```

An earlier version of the runner settled outstanding loads before every
non-lifecycle operation. That turned the second kind into the first, so the
pairwise suite went green without ever being inside the window - the interleavings
this stage exists for were scheduled away. The pairwise list now covers
load-in-flight triples explicitly, and half of every generated sequence leaves the
world in flight while the other half advances it.

Two model simplifications are named rather than hidden:

-   `pageControlsAttached` says the page's controls were detached by an item/quality
    change and came back when the world advanced. It does NOT predict the moment the
    implementation re-attaches them mid-window (a superseding transaction does that),
    which is why I4 is asserted for the operation that follows the change - the case
    the load matrix's flow N pins - and not for the whole window.
-   Whether a seek opens a new transaction or coalesces onto the load in flight is
    the coordinator's decision. The model states the input (`activeLoad`) and lets the
    invariants bound the answer, instead of predicting it.

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

### Found again when the scheduler stopped settling

Removing the implicit settle (above) put the pairwise suite inside the windows it
claimed to test, and three more things surfaced:

4. An item change's identity was a fixed placeholder, so the model saw the second
   change as "the same video" while the fixture adopted a new page key. Every item
   change now gets a unique identity, and each step records the page key a
   generation was started under.
5. I2/I3 compared a LOAD against the intent from _before_ the operation. An
   operation that ADOPTS a receiver's play/pause changes the intent while a load
   may already be in flight, so a LOAD may legitimately carry either; the invariant
   now accepts the intent on either side of the operation and still fails a stale
   one.
6. The model's "session we are watching" went stale: the world advancing (a load
   answered, a new session up) is a MEMORY, not a user action, and the model now
   receives it through `observeWorldAdvance` - without it, an explicit receiver
   report on the current session looked like a new session to the model while the
   implementation adopted it.

## Usage

```sh
node test/senders/playbackInterleavings.js --pairwise-only   # in npm run test:senders
node test/senders/playbackInterleavings.js --random 20 --length 8 --seed 1000   # npm run test:interleavings
node test/senders/playbackInterleavings.js --random 60 --length 10 --seed 1000  # npm run test:interleavings:explore
node test/senders/playbackInterleavings.js --verbose         # the operation-by-operation trace
```

`--verbose` prints, per operation, the generations it started, the page position,
the LOAD autoplay it submitted, and both intents (the sender's own and the model's)
— the last pair is a diagnostic, never an assertion: it locates a divergence
instead of leaving it to be inferred.

## What the generator has already found

Recorded because the failures are the point of the stage: the first sweep was red,
and each mismatch was either a real defect or a place where the model had to be
made precise.

Fixed in the sender (all three found by `--random 60 --length 10 --seed 1000`, then
`--random 1 --length 8 --seed 96028` as the shortest reproduction):

1. **A suppressed report was not REMEMBERED.** The tick's windows (an item
   transition's PAUSED, a seek transaction's stale state, the generic hold) return
   before the receiver-state handling, so a report they suppressed was also absent
   from the memory the NEXT report is compared against - which made that next one
   read as "a session we have never seen" and lost the user's play/pause twice
   over. `noteReceiverReport` now records at the tick's entry, before every
   suppression: an action may be refused by a window, the memory may not.
2. **The intent was adopted inside the page MIRROR path.** Mirroring is
   suppressible by design (a hold, an item transition, the gesture window after a
   real interaction), and the adoption inherited all of it: a remote pause pressed
   a second after an item change was dropped. The adoption now runs at the tick's
   entry, next to the recording, with its own guards.
3. **The adoption's hold guard was redundant and harmful.** A state we caused
   arrives on a session the tick has not seen before (a LOAD creates its session),
   so the same-session rule already refuses it; the hold guard only added the
   refusal of real user actions that arrived while our own load settled. Removed.

Model corrections (the other direction - the implementation was right):

-   a page `play`/`pause` is a TRANSITION: the browser fires no event for a page
    already in that state, so a `PAGE_PLAY` on a playing page changes nothing;
-   a new item brings a new page element that the site's player starts playing, so
    `pagePlaying` becomes true on `ITEM_CHANGE` (a `QUALITY_CHANGE` keeps the element);
-   while the page's controls are detached neither the page's own events nor the
    popup's page route are delivered (the production fallback to the bridge route is
    the background's layer, covered by the load matrix).

## What the long sweep found (RESOLVED: a fixture artifact)

The first 60x10 sweep had one red, and it was written down here rather than tuned
away:

```sh
node test/senders/playbackInterleavings.js --random 1 --length 10 --seed 222732
# explicitSeekStartsItsOwnTarget: 12. PAGE_SEEK (0): no generation was started
```

The sequence reached step 12 with everything the fixture knew drained, the page
at 330s, and the user's page seek to 0:00 folded into a transaction that had
nothing in flight (`dash seek coalesced onto the running transaction`): the page
moved, the receiver was never reloaded. There were two candidate readings - a
sender transaction outliving its loads, or the fixture never finishing a
generation the sender believes is loading - and the coalescing branch now prints
the state its answer is made of (`dashSeekState()`), which decided it in one run:

```text
"coordinator": {"phase":"seeking","loadInFlight":false, ...},
"dashSeekRunning": true, "dashLoadId": 3
```

A seek transaction WAS running, and it was still inside `loadMedia` for a bridge
request the fixture had started but never answered - the run answers the NEWEST
generation, and the older request had been superseded by the quality change in
between. So the sender's `startRemoteMediaServer` promise never settled and
`runDashSeek` never reached its `finally`. In production that cannot wedge: the
bridge replies to every request it receives (the sender then discards the reply
whose load a newer one replaced), and a request that is never answered rejects on
its own timeout.

The fixture now answers superseded requests too, with the plan for their OWN start
time and their own requestId (`supersededGenerations` lists them, so they can
never be read as progress), and the sweep is green. The lesson is the same one
this stage keeps teaching: a harness that answers only the newest generation is
not "the same, but simpler" - it is a different world, and the sender's promise
chain is what notices.

## What the harness cannot say yet

Named rather than hidden, because a silent gap is how a suite comes to look
stronger than it is:

1. **An item change's own load cannot be resolved by a bare `LOAD_RESOLVE`.** The
   sequences that would need it (`ITEM_CHANGE → RECEIVER_* → LOAD_RESOLVE →
PAGE_SEEK`) make the sender's load callback refuse the load
   (`INVALID_REQUEST: INTERRUPTED`), so a case written that way would assert the
   fixture's shortcut instead of the contract. The matrix drives an item change
   through its own helper; this harness still has to learn it. What IS covered in
   that window: the in-flight triples (`ITEM_CHANGE → BLE_* → LOAD_RESOLVE`), the
   detached page seek, and the receiver echo below.
2. **The page's own state and the intent are not modelled separately.** A PAGE
   pause on a page the mirror has already paused (no event fires, because the page
   is already in that state) is not expressed: the model tracks the intent, which
   is what the invariants are about. The case that needed the distinction was
   removed rather than pretended.
3. **Mirroring is observed, not predicted.** A case states the world advancement
   it means (`SETTLE`, `LOAD_RESOLVE`), and I4 is scoped to the operation AFTER an
   item/quality change; when the implementation re-attaches the page controls
   inside that window is not something the model predicts.

The sequences the stage exists for, and what each one pins:

-   `POPUP_SEEK → RECEIVER_ECHO → PAGE_SEEK → SETTLE` — a hold's pause is our own
    command coming back: it may be mirrored never, and adopted as the user's intent
    never. With the guard disabled the case fails with "the reload after a seek used
    autoplay false while the intent in force was playing".
-   `POPUP_SEEK → POPUP_PAUSE → RECEIVER_PLAYING → LOAD_RESOLVE` — the user pauses,
    the receiver claims to be playing: a report is not an order, so the load that
    follows carries the user's pause.
-   `POPUP_SEEK → STOP → LOAD_RESOLVE` — the resolution must not resurrect the
    generation the user just cancelled (I6).
-   `LOAD_RESOLVE → RECEIVER_PAUSED → RECEIVER_PLAYING` — the second report is
    judged against the state the first one left, not the pre-load state.
-   `PAGE_PAUSE → PAGE_PLAY → RECEIVER_ECHO → RECEIVER_PAUSED →
RECEIVER_PLAYING → PAGE_SEEK` — our PLAY is confirmed, the user then pauses
    and plays the physical remote, and that later PLAY happens to equal what we
    once commanded. An echo is CONSUMED, not remembered: the pending command has
    a session, a time and one confirmation, and a settled report that does not
    match it settles the question (with the sticky version the user's play is
    refused and the seek reloads `autoplay: false`).
-   `PAGE_PAUSE → RECEIVER_ECHO → RECEIVER_PLAYING → RECEIVER_PAUSED →
PAGE_SEEK` — the mirror image, so the guard cannot be "fixed" by refusing
    nothing.
-   `PAGE_PLAY → ITEM_CHANGE → RECEIVER_PAUSED → RECEIVER_PLAYING → PAGE_SEEK` —
    a command belongs to the session it was sent to: the new session's reports
    are the user's, not the previous session's echo.
