# Page-sender behaviour tests

`node test/senders/pauseSync.js`

These tests cover the part of the sender that has no browser-free alternative and
no cross-process harness: the receiver -> page reconciliation inside
`MediaSender#addMediaElementListeners`.

## Method (and why it is shaped like this)

The reconciliation lives in a closure that is only reachable by calling
`addMediaElementListeners(mediaElement)`, so the test

1. bundles `extension/src/cast/senders/media.ts` with **esbuild** (the same
   bundler the extension build uses), stubbing only the cast SDK entry point
   (`../export`) and defining the three build constants the extension build
   injects (`BRIDGE_NAME`, `BRIDGE_VERSION`, `MIRRORING_APP_ID`);
2. installs the two globals the module touches (`window`, `HTMLMediaElement`) and
   a stub `window.setInterval` that **captures** the 500ms callback;
3. constructs a real `MediaSender` per sender kind - the kinds are driven through
   `remoteProxy`, which is what the production code itself switches on
   (`remoteProxy.hlsLive` -> CCTV HLS DVR, `remoteProxy.audioUrl` -> Bilibili DASH
   remux) - plus `setPreserveSourcePlayback()`, the same call a real session makes;
4. fires that captured callback directly and asserts what happened to the page
   player, the session's messages and the sender's sync state.

It is not a mock of the logic under test: the code that decides to pause or play
is the shipped code, bundled from source.

## What each group asserts

**Receiver state -> page player, per sender kind.** Bilibili on Roku must pause
the page when the receiver pauses, resume it when the receiver plays, and keep it
playing through receiver `BUFFERING`/startup `IDLE` (the page is what produces the
capture watermark). CCTV must do the same (its `BUFFERING` behaviour is the
original, and the test guards it). Bilibili on a Chromecast must keep the old
behaviour, where `BUFFERING` does pause the page.

**Position authority stays with the page where it belongs.** With the page at 100s
and the receiver reporting 130s, the Bilibili-on-Roku page must NOT be moved (the
page is the capture clock), while the same drift on a Chromecast IS corrected -
i.e. the fix decoupled play/pause from position instead of disabling both.

**A pause must not consume anything the resume needs.** After a pause, 200 further
ticks (100s of the real interval) must leave no seek/load transaction armed, must
start no `GET_STATUS` polling, must not move the page's position, and must not
call `play()`; then switching the receiver to `PLAYING` must resume the page
(exactly one `play()`), repeatedly across further pause/play cycles. That is the
"pausing and resuming does not break the supply" property: nothing the page needs
in order to keep feeding the relay expires while it is paused.

## Negative control: `--pre-fix`

```sh
node test/senders/pauseSync.js --pre-fix            # HEAD^ = before the fix
node test/senders/pauseSync.js --pre-fix <git-rev>
```

This builds the same file from another revision and requires **exactly** the known
pre-fix failures - 10 of them, the Bilibili-on-Roku rows plus every supply
continuity check - and nothing else. A green run in this mode means the test
cannot see the bug it exists for, so it fails. The mode exits 0 when the old
behaviour is reproduced, which makes it usable as a negative control rather than a
red build.

Measured: current source 18/18; `--pre-fix` 9/19 with the 10 expected failures.

## Boundary

This is decision-level evidence. It does not run a real Bilibili page, a real
receiver or a real CDN, so it cannot observe DASH segment requests, and it says
nothing about the bridge's relay (`mediaServer.ts`). Claims about the real page
keeping the capture supplied still need a page-driven integration run; what is
proven here is which branch the sender takes and what it does to the page player.

## DASH seek source priming: `dashSeekSync.js`

```sh
node test/senders/dashSeekSync.js --fixed     # the contract (wired into test:senders)
node test/senders/dashSeekSync.js             # pre-fix Gap: negative control
```

The default mode asserts the behaviour of the source as it was BEFORE the fix, so it
is the reproduction (it fails on `B` and is expected to); `--fixed` is the contract
that `test:senders` runs. Measured against the fixed source: `--fixed` 20/20;
default 14/15 with exactly the `B` gap assertion failing and `G` skipped.

Same method as `pauseSync.js` (real bundled `media.ts`, cast SDK stubbed, the
500ms tick fired directly), plus two additions it needs:

-   **a live CastPort**: the SDK stub's `ensureInit()` hands the sender a port whose
    `postMessage` is observable and whose listeners can be dispatched to, so the
    test runs the production request identity chain end to end - it captures the
    `bridge:startRemoteMediaServer` `requestId`, answers with
    `mediaCast:mediaServerStarted` for the SAME id, and only then calls
    `primeCaptureSource(requestId)` (what `bilibili:pageCaptureReady` does in a
    real page). No private field is written to create state and the source is never
    patched or copied;
-   **a controllable clock** (`Date.now`) and captured timers, so the 800ms seek
    debounce can be fired and a deadline can be crossed without asserting a
    millisecond constant.

Cases: `A` seek start pauses the receiver and only the next tick pauses the page;
`B` the core gap - after priming, the OLD receiver session's `PAUSED` either
stops the page again (default, today) or no longer does (`--fixed`); `C`
`BUFFERING` still resumes a stalled page; `D` a new `mediaSessionId` reporting
`PLAYING` ends the transaction and an external `PAUSED` pauses the page again;
`E` the deadline contract as behaviour (before it the receiver's `PAUSED` is held
off, at it the same tick applies ordinary reconciliation) - no product
millisecond value is asserted; `F` a normal load (no explicit seek) never creates
the seek-scoped priming state, and `PAUSED` still reaches the page; `G`
(`--fixed` only) ownership - a superseded seek's late capture-ready and late
bridge response neither arm nor disturb the newer transaction's priming.

Boundary, additionally: capture backlog, `bilibili:captureOverflow` and whether
the receiver ends up ahead of the page after a real seek are NOT observable here
(the fixture never runs the bridge or the page). Those need a real session run
with the metrics listed in the plan.

## Opening-cast presentation offset: `dashCastOffset.js`

```sh
node test/senders/dashCastOffset.js            # the contract (wired into test:senders)
node test/senders/dashCastOffset.js --pre-fix  # negative control, from --rev (HEAD^)
```

A Chromecast cast that starts a couple of seconds into a video whose first
keyframe is at 0 used to be padded to that keyframe - i.e. to no pads at all - so
the receiver was loaded straight onto `segment-000000.ts` with no bootstrap
runway and never started. The bridge now gives that cast the same timeline shape
the working mid-video case has: a minimum pad runway (8 x 4s) in front of the
real segments, plus a LOAD position shifted onto that padded timeline. EVERY
opening cast takes that path, a start of exactly 0 included - whether the page
reports 0 or 0.2s must not decide between two different playlist shapes. The whole
mechanism is behind the options-page switch `chromecastDashStartupPadding`
(default on; see `test/bridge/README.md` for the OFF contract).

The test pins both halves of that contract:

-   **the bridge's arithmetic**, read out of `bridge/src/bridge/components/
mediaServer.ts` (the `CHROMECAST_MIN_PAD_SECONDS` constant and the
    `presentationStartTime` expression are extracted and evaluated, not restated,
    so the numbers cannot drift away from the implementation). The mid-video row
    is a health control: keyframe 1431 / start 1431.805 must keep pad base 1431
    and a presentation start of exactly 1431.805, i.e. no offset at all; the
    zero-start and 0.001s rows must produce the SAME pad base (no discontinuity);
-   **the sender's use of it**, through the real bundled sender: the LOAD request
    the receiver receives must carry the presentation position, the media's
    `customData` must carry the offset (for receivers that echo it back), the
    page element must stay on page time (the post-load Chromecast tighten must not
    drag it forward by the runway), and a bridge reply without a presentation
    position must fall back to the page time.

`--pre-fix` builds the sender from another revision in a `git worktree` (a lone
copied `media.ts` cannot resolve its imports) and requires the LOAD/sync checks
to fail there - that is the whole point of the mode, so it exits 0 when they do.

Boundary: this is timeline arithmetic plus decision-level sender evidence. It
does not run ffmpeg or the bridge's HTTP server, so it cannot observe the served
playlist or the order in which the bridge starts its processes - that is
`test/bridge/dashRemuxTimeline.js`, which executes the real bridge. Neither can
observe a physical receiver, so whether Chromecast actually walks the pads into
the real media still needs a real cast session.

## One plan for every entry point: `dashLoadMatrix.js`

```sh
node test/senders/dashLoadMatrix.js            # the CONTRACT (what test:senders runs)
node test/senders/dashLoadMatrix.js --legacy   # the pre-fix facts: they must FAIL now
node test/senders/dashLoadMatrix.js --pre-fix [rev]   # contract vs. an older checkout
```

Every other file above pins ONE mechanism. This one pins the property that the
mechanisms kept breaking, and it is NOT "seeking to 0:00" - the timeline decision
is a function of the timeline's own inputs, never of who asked for it:

    pageStart           the page position the remux is generated from
    contentBase         where the real content begins in PAGE time (the keyframe)
    padBase             how far the pads cover in PRESENTATION time
    padDuration         the pad MEDIA the playlist carries = padBase, because the
                        pads are [0, padBase)
    presentationOffset  padBase - contentBase: the CLOCK SHIFT
                        (receiverTime = pageTime + offset). NOT the pad duration.
    receiverStart       padBase + (pageStart - contentBase): the LOAD position
    offset              receiverStart - pageStart: what the media states

Those three quantities are asserted separately, and conflating the first two is
the mistake an earlier version of this file made: it computed `padBase -
contentBase` and called it a runway, which made a mid-video restart at page
581.605 (581 SECONDS of pads, offset 0) look like "no runway". Pad sufficiency is
a question about media, not about clocks:

    padsSufficient = padDuration >= requiredPadDuration

and the target is not part of that question either: a target of 32 with the
video's first keyframe at 0 carries the whole runway, while a target of 36 with
keyframe 4 carries 32s of pads and an offset of 28. The plan reports both facts as
`padRunway` (`full-`/`short-`/`no-pad-runway`) and `clock` (`shifted`/
`no-offset`), so "full pads AND no offset" is a legal, named state rather than a
contradiction.

The tuple is asserted whole: the bridge request's `startTime`, the LOAD
`currentTime` and `autoplay`, the media's `dashStart` and
`presentationOffsetSeconds`, the page element's own position, the pad duration,
the pad count and the playlist's first entry, plus "exactly one generation and one
LOAD per action".

Method - three layers, ONE case matrix:

-   **the bridge's arithmetic** is lifted out of `mediaServer.ts` (the constant and
    the `presentationStartTime` expression are evaluated, never restated), and the
    SAME plan function answers the sender's `mediaServerStarted`, so a row reads as
    "the sender asked for X, the bridge's own rule turned X into Y, and the sender
    LOADed at Y";
-   **the real bundled sender** is driven through seven entry points - `loadMedia`
    (initial cast and an unconditioned reload), `beginDashItemTransition` +
    `updateMedia` (a new video, and a quality change), `seekDashRemux` (popup),
    `controlFromBleRemote` (BLE skip), and the element's own gesture-gated
    `seeking`/`seeked` (the page's progress bar) - over twenty targets in TWO
    option states. With startup padding ON, every one of them is
    `full-pad-runway` and the rows differ only in the CLOCK: `0`, `0.001`, `0.2`,
    `2.864`, `8`, `25.5`, `28`, `32` (keyframe 0, offset 32), `36/4` (offset 28),
    `40/40` (offset 0, the mid-video health control), `44/16`, `60/28`, `64/32`,
    `581.605/581`, `1431.805/1431`. With startup padding OFF the pads are the
    keyframe, so the rows are the ones where pads are actually insufficient:
    `0/0` and `2.864/0` carry NO pads at all - the historical Chromecast failure
    the option exists to fix - `36/4` carries 4s of them, and `581.605/581` still
    carries 581s. Each row's expectation is written by hand (the plan's numbers
    come from the bridge's source, so a mismatch is a finding, not a tautology),
    and for each target all seven entry points must produce the identical tuple;
-   **equivalence** is that second half of every row, so giving one entry point a
    private special case fails immediately, with the offending origins named.

Then the flows, run CONTINUOUSLY. Each flow is ONE live cast with NOTHING reset
between steps - one sender, one cast session, the receiver's sessions evolving,
the steps laid on top of each other exactly as a viewer produces them - and a step
is judged by its PLAN and the page position it leaves, never by whether its target
happens to be the start of the video. Where a step's plan has the same inputs as
the first opening cast (page 0, keyframe 0), its tuple is compared against that
cast's, measured from a real run and printed at the top. The LOAD's `autoplay` is
asserted too, because it is where the user's play/pause intent has to survive.

The flows: the page's progress bar to 0:00 (plus status reports, plus a repeat);
the popup's seek to 0:00 (plus the write's echo); popup to 5:00 then back to 0:00
in ONE debounce window (a fast drag); the same with the first generation already
in flight; a switch to a new video that starts at 0:00 (plus the player's own seek
to 0 on the new element); a switch followed by the popup, and by the page's
progress bar; a popup seek during the switch's load; page seek to 0:00 then a
quality change with the page at 0:00; page 0:00 -> popup 5:00 -> page 0:00; a BLE
skip to 0:00; the player's own ungestured seek; a page seek during the switch's
load; a switch whose load races a popup seek against a BLE skip; a switch whose load has
the page controls detached while BLE pause / play / boundary skips arrive; a single
popup seek whose page seek has NOT arrived yet (opening range and mid-video), and
the same seek once it has; the old
and new sessions' status reports interleaved around a page seek to 0:00 (asserting
that an observation produces no receiver command); a popup pause followed by a page
seek, and a second seek after it (the pause has to survive both); a switch whose
LOAD is refused with a seek pending, and the next successful load that serves it; a
seek left over from video B after the page has moved to video C; and a stop after a
seek.

Measured: **93/93 in the contract** (the default); `--legacy` **86/93**, with
exactly the seven rows below failing - the control that those behaviours are gone.
Three of the 91 are STATIC AUDITS of `media.ts` (source shape, not behaviour),
because the correctness of the pending-seek service point is a property of WHERE
it is called from and a behaviour test can only catch a regression there by luck.

### The defects it measured, and the fixes

Each was reachable as a user action, not as a synthetic call, which is why they
are flows with names. `--legacy` still asserts the old facts; they fail.

-   **a seek left the page paused at the OLD position until the receiver played**
    (flow `V.1`). The page player fetches and decodes the target range only while
    it is PLAYING, so `onDashSeekStart`'s original order - pause the element, THEN
    write `currentTime` - was a position that never arrived on its own: the element
    reported `seeking` and sat on the old position until the receiver's PLAYING
    resumed the page (`resumePage`), which is exactly "the page jumps to the start
    only after the cast starts". The hold is about where the page ENDS UP, not
    about freezing it before it can get there, so the order is now write-then-freeze
    (the freeze waits for the element's own `seeked`). The fixture models the real
    rule - a seek requested while the element is PAUSED does not land until it is
    played again (`pausedPlayerModel`) - and `V.1` samples the position at the
    moment the seek returns, before the runner's settle delivers the receiver's
    PLAYING; with the old order it reports `the page was at 300 ... not 10`.
-   **an earlier attempt gated the bridge/LOAD on the page's arrival** (removed).
    Waiting for the page BEFORE touching the bridge turned "the page is late" into
    "the cast never restarts" (the page player may not answer at all until it
    plays), which is worse than the late arrival it was meant to fix. The restart
    and the page's own arrival are independent; only the page's freeze waits.
-   **the seek's arrival is not the bridge's gate.** An earlier attempt made
    `runDashSeek` wait for the page's `seeked` before it restarted the remux. That
    turned "the page is late" into "the cast never restarts" - the page player may
    not answer at all until it plays - so it was removed. The two are independent:
    the generation starts on its own schedule, and only the page's FREEZE waits for
    the page to arrive.
-   **a BLE play/pause became a forward skip** (flow `T.1`). The direct path taken
    while a reload has the page controls detached fed EVERY action into the skip
    arithmetic, whose delta only branches on `seek_backward` - so play and pause
    both landed in the forward case, moved the page, and could restart the remux
    during the window. Fixed by branching play/pause off first (recording the
    user's intent, then driving the receiver, which is what the closure's
    receiver-only path does) and by narrowing `bleSeekTarget`'s parameter to the
    seek actions so the compiler refuses the mistake. The row is a real guard: with
    the branch removed it reports `generations +2`, `page 30`, and a pause with no
    play.
-   **a seek could be applied to a DIFFERENT video** (flow `U.2`). A seek that an
    item load coalesced is kept until the item's media is live - but nothing said
    WHICH media it was for, so a load rejected on video B and followed by a switch
    to video C served B's 2:00 on C. Fixed by carrying the page's own key with the
    intent (`mediaIdentity`, set from `media.key` in bilibili.ts), dropping intents
    that name an older key when a generation adopts a new one
    (`adoptMediaIdentity` -> `noteMediaIdentity`), and keeping intents that name the
    same key - which is why a quality change still lets a pending seek through.
-   **G1 - the gesture gate on `seeked` did not apply** (flows `E.2`, `L.1`).
    `onSeeked` consumed the arm and then tested
    `if (!fromBleRemote && !seekArmed && !fromGesture())` - but `fromBleRemote` was
    the `{ ble, page }` RECORD `consumeBleArm` returns, always truthy, so the guard
    was dead and EVERY page `seeked` (the site's own buffering, quality and
    SPA-navigation seeks included) restarted the remux with origin `ble`. A
    spurious generation also stops the bridge server the receiver was just loaded
    on. Fixed by reading `.ble`; the gate is now exactly BLE-skip or the arm a
    gesture-adjacent `seeking` installs, and a bare pointerdown is deliberately not
    a third source (it would re-open the gate for whatever the page does next).
-   **G2 - a popup seek during a switch's load was swallowed** (flow `H.1`). The
    item change holds the load, so `requestSeek` coalesced the seek instead of
    restarting - and `markItemSettled` then cleared the intent, so nothing ever
    applied it. Fixed by keeping the intent and serving it once the item's own
    media is live (`serveSeekPendingFromItemChange`). Its ONLY caller is the end of
    the LOAD success callback, after the page controls are re-attached: a rejected
    item load keeps the intent for a later successful load instead of running it
    without page controls (flow `R`, which asserts both halves).
-   **G3 - a burst of seeks ended on the OLDEST of the burst** (flow `C.1`).
    Fixed by making the newest intent SUPERSEDE the older unserved ones, so only
    the newest is ever served.
-   **G4 - a retargeted generation did not re-park the page** (flow `D.1`). The
    hold is now applied per served generation (`onDashSeekStart` inside the
    transaction loop), not once per accepted click.
-   **a BLE skip during a switch's load was dropped** (flow `Q.1`). It reached the
    receiver through the page-event closure, which `loadCurrentItem` detaches for
    the reload - so of two racing explicit intents the OLDER one won because the
    newer one never became an intent. Fixed by giving `controlFromBleRemote` a
    direct path for a DASH remux: `bleSeekTarget` computes the target from the
    element's position (one implementation, shared with the closure) and
    `seekDashRemux(target, "ble")` enters the coordinator like any other intent.
-   **a seek forced playback back on** (flow `S.2`). `loadRequest.autoplay` was a
    hard `true`, so a seek while the popup held a pause started playback nobody
    asked for: the position transaction was editing the playback intent that
    another owner holds. Fixed with `desiredPlayback`, written only where a user
    intent is known (a dispatched receiver play/pause, or a gesture-gated page
    play/pause) and never by a receiver report or by the seek hold; the LOAD now
    inherits it. The harness models the consequence too: a LOAD with
    `autoplay: false` loads the receiver PAUSED, so "the pause survived" and "the
    pause was overwritten" are distinguishable.
-   **`clearDashItemTransition` could serve a pending seek too early**. It runs
    from `deadline`, `load-rejected` and a session report as well as from a
    successful load, and only the last is a point where the page controls are
    known to be attached; serving from the others could start a generation whose
    hold was silently dropped. The call is gone from there, and the rejected-load
    contract is its own flow (flow `R`).

Two rows remain FACTS in both modes:

-   **flow `N.1`** - a page seek while a switch is loading is not forwarded at
    all, because `loadCurrentItem(false)` detaches the element's listeners for the
    reload and only the LOAD callback re-attaches them. "Drag the progress bar
    while switching videos" is still lost on the page route (it is no longer lost
    on the popup route - that was G2 - nor on the BLE route, which was `Q.1`).
-   **flow `A.3`** - a repeat seek to the target the page is already at still
    starts a generation. `PlaybackRequestResult` has an `already-there` reason that
    is never returned, and refusing it would be defensible on plan grounds - but a
    repeat seek is also the user's only "rebuild this, it is stuck" gesture in the
    popup, so the row asserts the fact and leaves the decision open.

### What this file does NOT model (the open runway question)

With the startup-padding option ON the bridge is `padBase = max(keyframe,
required)`, so `padsSufficient` is always true and the harness says so; the pads
can only be insufficient with the option OFF, which is the group above. What the
code still has no INPUT for is whether a given generation REQUIRES a bootstrap
runway at all (`requiresBootstrapRunway`: a fresh receiver media start, a replaced
media, a new content identity, a recovery rebuild), and which mid-video
continuations may safely go without one. Until that exists, the harness measures
the arithmetic and the option's two states rather than enforcing a policy the
product has not adopted.

Boundary, additionally: no real browser, ffmpeg, bridge server or receiver, so this
cannot see the served playlist rows or which segment the receiver fetches, and it
says nothing about Roku (page-clock-master) capture, CCTV's synthetic DVR or the
seek-scoped capture priming - those are `dashSeekSync.js`,
`playbackIntentOwnership.js` and the bridge suites. `--pre-fix <rev>` needs a
revision that already carries this refactor's API, so it becomes usable once the
fixes are committed.

## Seek ownership: `playbackIntentOwnership.js`

```sh
node test/senders/playbackIntentOwnership.js   # wired into test:senders
```

The rest of these files each pin one mechanism. This one pins the property that
made the mechanisms fail together: **who is allowed to restart the DASH remux.**

Two clocks could each decide a position was wrong and restart the remux - the
page's own timeline and the receiver's presentation clock (page time plus the pad
runway). The loop was closed: a receiver position was converted, handed to the
page, written onto the media element, reported back by the element as a `seeked`
event, read as "the user asked to seek here", and restarted the remux, which
produced a fresh receiver position. Every movement multiplied into extra reloads,
and play/pause could pick up a stale position on its way past and restart the
video.

The fix is structural rather than another guard:

-   `cast/senders/playbackCoordinator.ts` is the single owner of DASH **seek
    intent and media-generation transactions inside the sender** — deliberately
    NOT of all playback state. Play/pause has its own owner:
    `background/playbackCommand.ts` holds the command lifecycle (dispatch phase,
    observation classification, watchdog, `device.playbackCommand`) and
    `playbackView.ts` derives the affordance from it. The split is by transaction
    scope, and it is the reason a receiver status cannot become a seek. Every seek
    enters through one `requestSeek(origin, pageSeconds)` call, which refuses any
    origin that is not an explicit intent (`receiver-status`, `sync-write`,
    `page-autonomous`), holds exactly one phase, and coalesces requests that
    arrive while a restart is in flight;
-   `cast/dashPresentation.ts` is the single crossing between the clocks: an
    adapter per media generation whose **time mapping is immutable** while its
    media-identity bindings are learned once, from that generation's own LOAD. It
    answers only for the media it was built for, so a stale shift can only be
    refused, never applied;
-   the sender's own page writes are registered with the coordinator, so the
    `seeked` they cause is attributed to the write instead of to the user;
-   Bilibili DASH never mirrors the receiver's position onto the page at all: the
    page owns position, and the receiver's position is recorded as an
    observation for the trace and the popup.

The assertions, driven through the real bundled sender (a remux restart is
observed as a new `bridge:startRemoteMediaServer` post, which nothing else can
produce):

-   **status never seeks**: receiver reports in every player state, at the padded
    position, at the transient reset, and from stale sessions - 0 restarts, and the
    page position is untouched;
-   **a programmatic write never seeks**: the page write followed by its own
    `seeked` event produces 0 restarts;
-   **pause never seeks**: the popup's pause route (the same page-route command the
    real popup sends) restarts nothing and moves nothing;
-   **one intent, one restart**: a popup seek produces exactly one restart at the
    requested page position, and seeks that arrive while that restart is in flight
    start no second one;
-   **the user's own page seek still works**: the gesture-adjacent
    `seeking`/`seeked` pair still restarts the remux exactly once, at the page's
    position - and the GESTURE is part of the case, because the arm that
    authorizes a `seeked` is installed by `onSeeking`, which refuses without one;
-   **the page's own seek is refused**: the same event pair with no gesture behind
    it (the player buffering, switching quality, or the SPA taking over a new
    video) restarts nothing. This is the row that was red until the `seeked` gate
    stopped testing the `{ble, page}` record it gets back as if it were a flag;
-   **the coordinator's contract directly**: a non-intent origin is refused, an
    observation during a transaction does not retarget it, a newer intent
    SUPERSEDES an older unserved one (so a burst cannot end on an older target),
    an item change keeps the intent it coalesced instead of dropping it, and after
    the item change settles a new seek restarts again.

## Presentation time ownership: `test/playback/dashPresentationTime.js`

```sh
node test/playback/dashPresentationTime.js   # wired into test:playback
```

The mapping between the two clocks is `cast/dashPresentation.ts`, and it is an
adapter per media generation — an **immutable time mapping** plus
generation-scoped identity bindings — rather than a mutable number:

-   `receiverToPage` / `pageToReceiver` are the only crossing, and a shift that
    would move the receiver's content backwards (the two values came from
    different loads) is refused rather than applied;
-   a media with no runway gets a real adapter too (`identityPresentation`), so
    every consumer has ONE code path and no "offset unknown" branch to get wrong;
-   the adapter answers only for the media it was built for. A report about any
    other media is **refused**, which is why a stale 32s runway can no longer be
    subtracted from the next remux's position.

It also covers the popup's half: the timeline must receive PAGE time and store it
unchanged. The defect that froze is the popup converting a second time, which put
its seek bar 32s behind playback — and, because every control reads that timeline,
turned a pause click into a seek that restarted the remux. The popup component is
asserted to contain no conversion at all, so the ownership cannot drift back.

## The status pipeline: `test/playback/dashStatusPipeline.js`

```sh
node test/playback/dashStatusPipeline.js   # wired into test:playback
node test/playback/dashStatusPipeline.js --pre-fix   # negative control
```

The conversion from the receiver's clock to page time has to run for EVERY device
family, and it lives in the background's status handler. That is the part the
unit tests above could not see: the helper was green and the popup was checked for
a second conversion while the Chromecast never went through the handler branch at
all (it was nested inside the Roku session-media merge), so the popup showed the
padded clock — a whole pad runway ahead of the page — and every control derived
from that position disagreed with the receiver.

This test bundles the real `deviceManager` with the native-messaging transport
stubbed (the narrowest seam), registers a device, sends the bridge ready message
and a raw MEDIA_STATUS, and asserts what the device publishes:

-   Chromecast, offset 32, receiver at 36.389605 → **published 4.389605** (page
    time; the runway removed, and `dashStart` NOT added on top — it is already
    inside the receiver's number);
-   a **bare-media report** (the periodic MEDIA_STATUS shape, which carries the
    stream's media object and NOT the LOAD customData) is still mapped, because the
    conversion runs on the merged status: converting the incoming one skipped every
    report after the first few seconds, and the popup jumped a whole pad runway
    forward once playback started;
-   a media stating offset 0 is not remapped by an earlier generation's 32 — the
    shift is remembered against the MEDIA it was stated for (its `mediaSessionId`
    and its base `contentId`), never against the device, so a generation loaded
    without a runway cannot inherit one;
-   a report about an **unknown media generation** is left unconverted rather than
    guessed at: leaving it alone is the only answer that cannot be wrong;
-   mid-video (offset 0) passes through unchanged;
-   Roku (offset 0 by construction) is the identity.

Against the pre-fix background the first two Chromecast rows fail (36.389605
published verbatim), which is the control that the test measures the fix.

## Play/pause affordance ownership: `test/playback/coordinatorObservation.js`

```sh
node test/playback/coordinatorObservation.js --fixed   # wired into test:playback
node test/playback/coordinatorObservation.js            # the gap, as facts
```

THIS FILE IS IN THE DEFAULT SUITE, and that is the point of documenting it here.
It spent a while measuring a real defect while sitting outside every test script,
so `npm run test:playback` was green with a red test in the tree. A known failure
that no script runs is not a known failure; it is an unmeasured one.

It covers the other half of the control 面 from `playbackIntentOwnership.js`: not
who may seek, but who owns the play/pause AFFORDANCE when the pending command and
the receiver disagree.

-   `background/playbackCommand.ts` keeps a command ACTIVE on an `opposite`
    sample (it only publishes it, so its own deadline can still conclude the
    command), and
-   `playbackView.ts` derives the popup's button from that command view.

Measured on a real session: PAUSE pending + a press of PLAY on the physical Roku
remote left the popup offering PLAY for several seconds — the pending intent kept
owning the button while the device was already playing.

The contract (`--fixed`) is that the affordance follows the OBSERVED state as soon
as an observation contradicts the pending command, and that a pending receiver
dispatch does not change that answer (`receiverPending` is published separately
and is what the pending indicator renders). The default run asserts the GAP, so
the file is a control as well: it fails when the fix is absent and passes when it
is present.
