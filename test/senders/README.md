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
