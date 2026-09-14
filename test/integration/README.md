# Cross-process integration harness

This directory tests the one thing the per-module probes cannot: **two real
`connectNative` connections, the real extension relaying between them, over real
sockets.** It exists because `deviceManager` ↔ session host ↔ discovery host is
otherwise only verified by reading code — the session-media mirror and the LOAD
generation replay both cross that boundary, and a module-level probe cannot see
it (each `connectNative` spawns its own OS process with its own module state;
that is precisely the bug class this whole area exists for).

Nothing here changes production code. The harness only observes.

## Why this shape

| Piece | Why it is real and not simulated |
| --- | --- |
| Firefox Developer Edition + the built extension | The relay logic under test (`deviceManager.syncRokuSessionMediaToBridge`, `replayRokuLoadGenerations`, the message handlers) is extension code. Simulating the relay is exactly the shortcut that would bypass the bug. |
| Two native hosts | `bridge.connect()` calls `connectNative()`, so two connections ARE two processes. The harness proves it from PIDs rather than assuming it. |
| `hostWrapper.js` | Firefox points at one executable per manifest, so the manifest points at a transparent wrapper that execs the real dev build. It forwards bytes verbatim and parses only a copy, so the harness can never become the protocol. |
| `fakeRoku.js` | SSDP + ECP are production discovery paths; a stub inside the bridge would skip them. |
| The dev build (`dist/bridge/…`) | Built from the working tree by `npm run build:bridge`, so the harness tests the current source, not an installed binary. |

## Isolation: the harness never touches your build, your bridge or your browser

The harness is designed to run *while* you keep using the extension normally:

| Resource | What the harness does |
| --- | --- |
| `dist/` (your build + packaging output) | Never read, never written. The harness builds its OWN copies into its temp dir: `extension/bin/build.js --out-dir …` and `bridge/bin/build.js --out-dir …`. Defaults are unchanged, so your `npm run build:*` behaves exactly as before. |
| Native messaging manifest | Installs `fx_cast_bilibili_bridge_harness.json` - its own name - so your `fx_cast_bilibili_bridge.json` (system-level from the .pkg, or your own user-level one) is never shadowed and never modified. Restored/removed on every exit path. |
| Extension it tests | A private build that requests that harness host name, loaded into its own temporary Firefox profile. Your installed extension and profile are untouched. |
| The installed bridge binary | Never exec'd and never replaced: the wrapper execs the harness's private bridge build. |
| Device discovery (SSDP) | The harness's private bridge searches on port **19009** and its fake Roku advertises there, so your bridge (1900) can never discover "Harness Roku" - and a real Roku on your LAN is never confused with it. |

Verified end to end: `dist/` is byte-identical before and after a run, the
real-name manifest count stays 0, the harness-name manifest is installed for the
run and removed afterwards, and `--auto-cast-fixed` still passes 57/57. The
manifests are also covered by a fake-HOME test for all three cases (nothing
before / a user manifest before / a harness leftover before), and
`selfTest.js` asserts that a private `--out-dir` bridge build is self-contained -
its manifest points at the launcher inside that directory, not back into `dist/`.

Limits of this isolation, stated rather than implied:

- **One harness run at a time.** The fake Roku's ECP port (8060, on 127.0.0.1) and
  the isolated SSDP port (19009) are fixed, so two concurrent runs would fight
  over them. Isolation here means harness vs. production, not harness vs. harness.
- The wrapper's pass-through (a leftover manifest, no harness run active) knows
  only the macOS install layout `/Library/Application Support/fx_cast_bilibili/`.
  On other platforms it finds no bridge, which is harmless: production never asks
  for the harness host name.
### What a harness run cleans up, and what it does not

| | Behaviour |
| --- | --- |
| `dist/`, your build | Never read, never written (private builds in the harness dir). |
| Real native host name, installed bridge | Never touched: the harness asks for `<name>_harness` and execs its own bridge build. |
| Harness manifest (`…_harness.json`) | Removed on normal exit, on `--phase-a-only` bail-out, on a thrown assertion, on `main().catch()`, and on SIGINT/SIGTERM/SIGHUP; a leftover from a previous killed run is deleted rather than restored. |
| Firefox profile | Removed by default (`--keep-profile` keeps it on purpose). |
| Children the script owns (Firefox, fake Roku, geckodriver) | Registered on spawn and killed on exit, so an early throw cannot leave a browser or a fake Roku holding port 8060. `runFirefox.js` uses the same ownership model; `--simulate-early-failure` exercises it (verified: exit 1, no fake Roku, 8060 free, no new profile). |
| Harness working directory (`/tmp/fx-harness-*`: private builds, traces, browser and fake-Roku logs) | **Kept on purpose**, for auditing a failed run; the path is printed at startup. Delete it yourself or let your tmp cleanup policy do it. |
| `kill -9` of the harness process | Cannot run any JavaScript cleanup. The isolated host name still protects normal usage, but orphan children, the harness manifest, the profile and the working directory can be left behind; the next run removes a leftover manifest it recognises as its own. |

One harness run at a time: the fake Roku's ECP port (8060 on 127.0.0.1) and the
isolated SSDP port are fixed, and the harness manifest name is shared, so two
concurrent runs would fight over all three. Isolation here means harness vs.
production, not harness vs. harness.

- Historically the harness used the REAL host name and had to restore the
  user-level manifest afterwards, because a left-over one shadowed a system-level
  bridge install and broke normal usage. That shadowing is now impossible by
  construction (own host name); the snapshot/restore stays so no test artifact is
  left behind and so a user's own manifest under the harness name is preserved.

## The harness must not break normal usage

The harness installs a per-user native-messaging manifest, because that is the
only way to make Firefox spawn the WRAPPER (and therefore see both connections).
That directory is read by the user's normal browser too, and a manifest left
there shadows a system-level bridge install - which is exactly what broke a real
bridge install once. Three things keep that from happening again:

1. `sessionHarness.js` snapshots the user-level manifest BEFORE installing and
   restores it on every exit path: the run's `finally`, `process.on("exit")`, and
   SIGINT/SIGTERM/SIGHUP. The restore puts the user's own manifest back verbatim,
   or removes the file if there was nothing there before - and a leftover HARNESS
   manifest counts as "nothing", so a previous killed run cannot keep shadowing.
2. A SIGKILL cannot run any of that, so `hostWrapper.js` passes straight through
   to the INSTALLED bridge when `FX_HARNESS_DIR` is not set (no tracing, no
   files, inherited stdio). A stale manifest is therefore harmless: the browser
   still gets the real bridge.
3. `node test/integration/installManifest.js --remove` remains the manual
   cleanup, and it no longer needs the dev build to exist (the host name falls
   back to `bridge/config.json`), because `npm run package:bridge` replaces
   `dist/bridge` with just the packaged artifact.

Verified without Firefox: snapshot/restore in a fake HOME for the three cases
(nothing before, a user manifest before, a harness leftover before), and the
wrapper both ways - transparent (no trace files, child is
`/Library/Application Support/fx_cast_bilibili/fx_cast_bilibili_bridge`) and
under a harness run (traces written, dev build exec'd).

## Reconnaissance findings (what this environment supports)

1. **Firefox**: Developer Edition is installed and is required — Release ignores
   `xpinstall.signatures.required`, so an unsigned sideload would not load.
2. **Native manifest**: this machine also has a **root-owned system manifest**
   (`/Library/Application Support/Mozilla/NativeMessagingHosts/…`) pointing at an
   installed standalone binary built from an older commit. The harness therefore
   installs a per-user manifest (`installManifest.js`), which needs no
   privileges. **Verified empirically**: the wrapper is spawned, so the user-level
   manifest wins. `installManifest.js` warns when a same-named system manifest
   exists, and `spawns.ndjson` records the manifest path Firefox passed, which is
   how the precedence is confirmed rather than assumed.
3. **Observability**: the host's stdout is the protocol channel, so logs go to
   stderr (tee'd per connection), and the extension's own console output reaches
   the harness stdout through `devtools.console.stdout.chrome`/`.content`.
4. **ECP control**: `fakeRoku.js` answers `/query/device-info`,
   `/query/media-player`, `/query/active-app`, `/apps`, `/keypress/*`,
   `/launch/*`, and is scriptable at runtime through a control HTTP server.
5. **Reconnect**: killing a connection's process is enough — the extension sees
   `onDisconnect` and `refresh()` replays generations and session media.
6. **Sandbox caveat**: Firefox cannot initialize its own macOS sandbox under a
   restricted file sandbox (`sandbox_init() failed`), so a harness run needs
   normal process/file access. It also writes outside the working tree (browser
   profile, caches), by nature.

## Running

```sh
npm run build:bridge          # the harness tests dist/bridge, so build first
node test/integration/selfTest.js          # plumbing only, no browser
node test/integration/installManifest.js   # one-off, per-user native manifest
node test/integration/runFirefox.js --seconds 30 --settle 15
```

`selfTest.js` is not decoration: an earlier differential harness in this repo
compared two **empty** traces and reported "equivalence", and an isolation
control cannot catch that (two empty traces are trivially equal). So the harness
proves its own instrument first — bytes forwarded, both directions traced,
traces non-empty, two connections = two PIDs, and no host child left orphaned.

`runFirefox.js` exits non-zero unless the extension loaded, a host was spawned
through the wrapper, **and the fake device was discovered and polled**. A real
Roku on the LAN being found instead does not count: the harness must control the
device it asserts about. Devices discovered are printed, so the difference is
visible.

## The two Stage 2 gates

```sh
node test/integration/sessionHarness.js                    # fast (default), ~45s
node test/integration/sessionHarness.js --startup-synthesis # slow, ~2min
```

**Fast (default).** The fake device starts idle, the page LOADs HLS DVR media, and
the harness then advances the device to `buffer` so the post-launch ECP evidence
releases the deferred-consume gate within a poll - no 60s fallback wait. It
asserts: the SDK chain and session creation (Stage 1 gate), the LOAD reaching the
session host, `main:rokuSessionMedia`, the extension relaying both
`bridge:rokuSetLoadGeneration` and `bridge:rokuSetSessionMedia` to a discovery
connection with agreeing device/generation/owner/media, the page's `loadMedia`
settling, and a post-LOAD raw `ecp-poll` observation. Measured: 38/38 in ~45s.

**`--startup-synthesis`.** The device stays pinned at IDLE, so only
`DEFERRED_CONSUME_FALLBACK_MS` (60s) can release the gate; this mode asserts the
startup synthesis itself (`startup-synthetic` BUFFERING carrying the session
metadata) together with the raw `ecp-poll` IDLE observation. Run it when touching
the synthesis, deferred consume, session-metadata composition or observation
isolation - not on every iteration.

**Two hard gates, because a click can take a path that creates the session without
creating a load generation.** Gate A asserts the click-time selector state
(`hasSelectorContext`, `selectionRequiresRefresh`, `mediaType`, target device) from
the popup's own debug channel; Gate B asserts that `beginRokuMediaLoad` created a
generation for the device. If either fails, the harness reports that the click used
the generic path and skips the Stage 2 assertions - otherwise a missing generation
looks exactly like a relay failure, which is how it was mis-read twice.

### The queued-selection gap (`--auto-cast-gap`, `--auto-cast-fixed`)

Gate B exists because a session can be created without a load generation. These two
modes pin that defect (and its fix) at the root-cause boundary instead of letting it
show up as a Stage 2 cascade:

```sh
node test/integration/sessionHarness.js --auto-cast-gap     # pre-fix control, ~90s
node test/integration/sessionHarness.js --auto-cast-fixed   # post-fix check, ~90s
```

Both provoke the same production sequence: the popup's own auto-cast timer fires
because the selector's `popup:init` never reached the popup (the failure the popup's
watchdog exists for), so `castCurrentTab()` -> `action:castCurrentTab` ->
`triggerCast()` -> `getReceiverSelection()` **closes the `requestSession` selector and
opens its own** ("getReceiverSelection: closing selector for the same tab before
replacement" in the background console). The click that follows therefore resolves a
replacement selector owned by `triggerCast`, whose session is created by
`loadSender()`'s App branch - the path that used to skip `beginRokuMediaLoad()`
entirely.

To make that an order rather than a race, the modes (a) navigate the popup tab only
*after* a run-bound marker says a selector opened, and (b) suppress the FIRST
`popup:init` post of the run once, through a run-bound storage flag. Both are
test-copy-only edits of the instrumented copy; the popup's timers, the init data and
every other mode are untouched.

Asserted by BOTH modes (the session-creation evidence a fix must not change): the
popup's auto-cast log and `action:castCurrentTab`, the requestSession selector having
opened and then been replaced on the same tab, the suppressed first init, the page's
`requestSession` success callback, a session host with its own PID, and
`bridge:createCastSession` on it.

`--auto-cast-gap` additionally asserts the defect: no marker before the production
Roku branch, no `__fxHarnessLoadGenerationBegan`, and **zero**
`bridge:rokuSetLoadGeneration` for the device on every discovery connection. It
reports `queued Roku App session was created without establishing a load generation`.

`--auto-cast-fixed` asserts the fix: exactly ONE generation for the session start
(not "at least one" - a second advance would retire the media the session is about
to publish), that generation on a discovery connection, and the session media
carrying that same generation.

### The pending gate on a failed session start

```sh
node test/integration/sessionHarness.js --create-failure-gap    # pre-fix control
node test/integration/sessionHarness.js --create-failure-fixed  # post-fix check
node test/integration/sessionHarness.js --interleave-gap        # pre-fix control
node test/integration/sessionHarness.js --interleave-fixed      # post-fix check
```

`createCastSession()` is injected to fail (or to be held and then fail) for a
run-bound call index, at a point where the caller has ALREADY announced its load
generation. What is under test is not the generation - it is monotonic by design and
the previous load's media was retired at discovery when the new generation was
relayed, so nothing here rolls back, and the wire is asserted to carry no lower
generation. What is under test is the LOCAL pending-media gate the announcement
opened: while it is set, `deviceManager` drops that device's ECP media status
(`Roku media trace [...] remote-status-blocked`), and only a release - or a real
session media - clears it. A gate left set means the device's media status is
filtered until some later successful load, a device-down or a bridge reconnect.

- `--create-failure-*`: the queued-selection start (the auto-cast provocation above)
  announces and then fails. Pre-fix nothing releases the gate; post-fix the failing
  start releases its own. `--request-source selector` moves the same failure to the
  `main:requestSession` handler's caller instead: the popup still mounts late (that
  is what makes the route deterministic), but nothing suppresses `popup:init`, so
  its port matches the selector `requestSession` already opened, its auto-cast
  timer is cleared, and the outer handler - not `triggerCast` - consumes the error.
- `--interleave-*`: the `requestSession` start announces and is held, then a second
  start (the popup's own `action:castCurrentTab`, sent from the popup page with the
  popup's window focused - what a real click there does) announces a newer
  generation, and only then does the OLDER start fail. Its release must be refused,
  because the gate now belongs to the newer start.

Both modes then drive the fake Roku to a KNOWN sample (PLAYING at 30s,
`harness-stale-sample`) and assert, as deltas against a baseline taken after the
failure and before the drive:

- the driven sample reached the extension on the wire (`PLAYING`, `currentTime` 30,
  after the drive) - i.e. the drive is real;
- the branch `deviceManager` took FOR THAT SAMPLE: `remote-status-input` when the
  gate is open, `remote-status-blocked` when it is closed (both traces carry the
  driven input state, so a pre-existing line cannot satisfy them);
Measured and NOT usable as evidence: the popup's receiver row shows the driven
title even while the gate blocks that device's media status (the row's
now-playing line does not come from `main:receiverDeviceMediaStatusUpdated`, so
it is not gated). The popup text is therefore printed as a diagnostic only; an
earlier version of this mode asserted on it and was wrong in both directions.

What these modes do NOT cover, and must not be read as closed:

- the trusted-sender bypass: its Roku branch is **unreachable through the current
  UI**, so it has no real-entry dynamic test. The wiring is statically correct -
  `beginRokuSessionLoad()` plus `commit()`/`release()` and the partial-session
  cleanup all apply to it - but nothing in the product can produce that message for
  a Roku today: (1) the only caller that passes a `receiverDevice` to `ensureInit()`
  is the mirroring sender (`cast/senders/mirroring.ts`), while the
  media/bilibili/CCTV senders call `ensureInit()` without one; (2) the selector
  refuses Screen/mirroring for Roku devices (`device.deviceType !== "roku"` in the
  popup - "Roku devices have no mirroring channel"); and (3) a page that puts
  `receiverDevice` into the message itself is rejected as untrusted. Re-open this
  when a trusted sender starts passing a Roku receiver device, or when the UI lets
  Roku into a direct-connect path: it then needs the full success /
  session-start-failure / interleave ownership matrix - not a message constructed
  from an extension page;
- how a failed `requestSession` is settled towards the page beyond the counts
  measured below: the harness now records the SDK callback timeline and the number
  of background cancellations, but nothing asserts an exact settlement contract
  (error code set, exactly-once as a requirement, promise rejection);
- failures AFTER `createCastSession` has partly run (bridge connected,
  `instance.session` set, the `bridge:createCastSession` post throwing): the
  injection point is the top of `createCastSession`, so nothing past that is
  covered. What IS covered past it is the reverse case - a cleanup step throwing
  while the p2 failure is being handled (`--cleanup-fault`, below).

### When the cleanup itself fails (`--cleanup-fault`)

```sh
node test/integration/sessionHarness.js --create-failure-fixed --fail-stage p2 \
    --request-source queued --cleanup-fault removeListener
node test/integration/sessionHarness.js --create-failure-fixed --fail-stage p2 \
    --request-source selector --cleanup-fault actionState
```

`--fail-stage p2` fails the start AFTER the bridge port exists and after
`instance.session` and both listeners were installed, so the failure reaches the
cleanup that removes the partial session. That cleanup is best-effort by
construction - each step has its own `catch`, and the two steps that close the
port sit in a `finally` - and the question this mode asks is whether a cleanup
step that THROWS changes either of the two things that matter:

1. the half-created port is still closed (so no idle native host survives), and
2. the error that reaches the caller is still the ORIGINAL failure.

`--cleanup-fault` injects a throw into one cleanup step, on top of the original
p2 failure. The values are the two steps that have their own `catch`:

| value | the injected step | what the fault proves |
| --- | --- | --- |
| `removeListener` | `onMessage.removeListener` for the partial session's message listener | the `try` that removes the message listener exited immediately (the action-state reset in the SAME `try` was never reached), and the `finally` still closed the port |
| `actionState` | `updateActionState(Default, tabId)` | the message listener WAS removed first, and that step's own `catch` kept the cleanup going to the `finally` |

The cleanup is deliberately meant to fail without replacing the original error,
which is why "the page saw one error" cannot be the evidence: BOTH errors would
end up in the same outer `catch`. So the injected error and the original one
carry different stable identifiers, and the instrumented copy records the
message that the outer handler ACTUALLY caught. Which handler that is depends on
the caller, because the two callers consume the error in different code:

- `--request-source selector`: the `main:requestSession` handler logs it and
  posts `cast:sessionRequestCancelled` to the page;
- `--request-source queued`: `triggerCast()` catches what `loadSender()`
  rethrows and only logs (asserted on its own handler marker).

The label is asserted, not trusted, at two strengths. A run checks the marker
written immediately before the production Roku branch of `main:requestSession`
(`selector` requires it, `queued` requires its absence) - supporting evidence
only, because its absence is a bounded "not seen" observation. The authoritative
checks read what each caller's own `catch` received: the labelled caller's handler
must hold the ORIGINAL failure and the other route's handler must not. They run for
every `--create-failure-*` run (both labels, every stage) and, with the cleanup
error identifier added, for `--cleanup-fault`.

Both caller assertions - the authoritative one above and the supporting
Roku-branch one - run only in the single-caller failure matrix
(`--create-failure-*`, with or without `--cleanup-fault`), which is the only place
where `--request-source` is a caller-ownership claim. `--interleave-*` starts both
callers in one run on purpose: its requestSession start walks the Roku branch, so a
single-caller "the marker must be absent" demand would fail the harness's own
assumption instead of the product (interleave asserts its own two-start facts:
which start announced, whose release was refused). The success modes
(`--auto-cast-*`, `--media-before-generation`, `--generation-advance`,
`--startup-synthesis`, the default run) never claimed single-caller ownership, so
the default `queued` label must not impose it on them either.

The late mount is shared by every failure/gap mode and both labels
(`deferPopup = gapMode || failureMode`). For `--interleave-*` (default `queued`) the
flag's value and the code it guards are unchanged, so the previously measured
interleave runs are not affected; `--interleave-* --request-source selector` is a
new combination and has not been run.

This is not decoration - before it existed, 3 of 4 runs labelled `selector` were
in fact served by the popup's auto-cast: the popup was mounted EARLY, so its port
connected before `requestSession` had a selector, its auto-cast replaced the
selector, and the click resolved the replacement. Every one of those runs then
failed the outer-handler assertion for a reason that had nothing to do with the
cleanup. The fix for that is the LATE mount above, not the choice of handle: at
click time there is exactly ONE `/ui/popup/` handle (the sender page is served
over http by this harness, so it cannot collide with the UI's URL), and the run
asserts that count instead of assuming it. An attempt to identify the handle by
the tab id recorded in `__fxHarnessSelectorOpened` was wrong and is documented in
the harness: that id is the tab the selection is FOR (the sender), not the tab
hosting the UI, so it matched nothing and the run collapsed without a click.

Only `--fail-stage p2` reaches the two cleanup steps instrumented here, so any
other combination is rejected at argument-parsing time instead of arming a fault
that can never fire and then reading its absence as "the cleanup was not
reached".

The stage distinction is narrower than "p0/p1 never reach the cleanup": `p1` and
`p2` enter `createCastSession`'s internal `catch`/`finally` and close the port they
own. `p0` fires before `bridge.connect()` and before that internal `try` exists, so
it never enters it, owns no port, and propagates directly to its caller (which is
where the announcement is released and the page is settled). What `p0` and `p1`
both fail to reach is the pair of steps instrumented below, because both sit inside
`if (opts.instance.session === session)`: at `p0` no session object exists at all,
and at `p1` the assignment `opts.instance.session = session` has not run yet, so
the identity guard is false.

How the injection is wired: each cleanup step is preceded by an awaited gate
(`await __fxHarnessCleanupGate(id, message, site)`) INSIDE the same `try` block
as the step it replaces, so the throw lands in exactly the `catch` that the
production code has for that step. The gate reads the run-bound control straight
out of storage on every call and returns unless both the run id and the step id
match, so an unarmed run - and the OTHER step of an armed one - executes the
production call unchanged. The gate's placement is deliberate: a gate injected
before a synchronous call is equivalent to the call itself throwing, which is why
no `storage.onChanged` cache is involved (an earlier version cached the control
in the background global and deadlocked, because the cached event never arrived).

Two consequences are asserted rather than assumed: the armed step's entry marker
is written (and awaited) BEFORE the gate throws - so "the step was reached" is
positive evidence, not something inferred from a missing fault marker - and the
step that was NOT armed still ran to its own entry marker in the same run, which
is what proves the run did not simply fail earlier.

A non-cleanup `--create-failure-*` run carries the same route assertions (two
checks: the labelled caller's handler received the injected failure, the other
route's handler did not), which is what makes the settlement numbers quoted per
`--request-source` trustworthy.

Measured, both faults and both callers (each cleanup run is the p2 matrix plus
seven checks): the injected error was raised at its site and caught by that step's
own handler, the other cleanup step was still reached, the half-created port
existed and left no idle native host behind, the next cast built its own session
host, the load generation stayed monotonic, the pending gate was still released,
and the labelled caller - and only it - received the ORIGINAL failure. The two
callers differ exactly where they should: the queued route fills
`caught: ["loadSender", "triggerCast"]` with `requestSessionHandler` empty, the
selector route fills `caught: ["requestSessionHandler"]` with `triggerCast` empty.

Two layers of evidence are kept apart on purpose, because they prove different
things:

- "the other cleanup step was still reached" proves the identity-guarded cleanup
  sequence continued past the fault that the step's own production `catch`
  absorbed. It says nothing about the `finally`;
- "the half-created port existed and its idle host exited" proves the `finally`
  really closed the port, and that the port-closing steps did not run earlier by
  accident.

Which caller ran is likewise asserted in two strengths. The Roku-branch marker of
`main:requestSession` is supporting evidence (its presence is positive proof of
the selector route; its absence is a bounded "not seen" observation). The
authoritative evidence is the outer `catch` markers: the labelled caller's handler
must hold the ORIGINAL error, and the other route's handler must not hold it. The
queued route legitimately fills BOTH `loadSender` and `triggerCast` (the former
rethrows into the latter), so `loadSender` is deliberately unconstrained.

### The page settlement contract (`--request-settlement-gap` / `-fixed`)

One `requestSession()` call settles **exactly once** - `success(session)` or
`error(CastError)` - and once it has reached that terminal state neither of its
callbacks may run again. A session the EXTENSION created (the queued/auto-cast
route) is therefore not a settlement of an already-cancelled request: the SDK
documents that it belongs to `ApiConfig`'s `sessionListener`.

```sh
node test/integration/sessionHarness.js --request-settlement-gap        # pre-fix facts
node test/integration/sessionHarness.js --request-settlement-fixed      # post-fix expectation
node test/integration/sessionHarness.js --request-settlement-reentrant  # the clear-then-call order
```

The route decides who owns the session, and the run derives that from ONE place
(`pageSessionOwnership`), because "the cast succeeded" is not one fact:

| route | who settles the request | who delivers the session |
| --- | --- | --- |
| `selector` (the page clicked its own selector) | one `success` callback | the page's own `requestSession` (the page holds `sessionId`) |
| `queued` (the popup's auto-cast replaced the selector) | one `error` with code `cancel` | `ApiConfig`'s `sessionListener`, which the page adopts for LOAD |

That distinction is not cosmetic. On the queued route the page's request really is
cancelled, so `requestSessionSucceeded` is FALSE - and the earlier shared
assertions that demanded it were green only because of the double settlement this
contract exists to remove. The auto-cast modes therefore assert "the queued cast
still delivered the extension-created session to the page" instead, while the
load-generation expectations they carry keep flipping as before.

`--request-settlement-reentrant` pins the ORDER inside the SDK's cancel branch,
which is the difference between a working reissue and a rejected one. The page
starts a second `requestSession` SYNCHRONOUSLY from the first one's error callback,
and each attempt is tagged with its own `requestId` - without that attribution
"error then success" cannot be told apart from a double settlement. Measured on the
fixed build:

| attempt | settlement |
| --- | --- |
| A (the cancelled one) | exactly one `error(cancel)`, no session |
| B (started inside A's error callback) | exactly once, `success`, with a non-empty session id |

and `sessionListenerCalls` is 0, because a request that is still pending owns the
session. Counter-control (a build that calls the callback BEFORE clearing the
fields): the reissued request comes back immediately as `invalid_parameter`
("Session request already in progress") and the check goes red - so the order is a
requirement the harness can demonstrate, not an implementation preference.

Not covered, deliberately: `cast:sessionRequestCancelled` carries no request
identity, so a LATE cancel belonging to an already-settled request cannot be
attributed to it. Correlating cancels with requests is a separate protocol change
and outside this fix.

They are their own pair on purpose: `--auto-cast-*` already carries the
load-generation sense of "gap", and one mode must not mean two defects. They are
also mutually exclusive at argument-parsing time: accepting both would silently run
the gap expectation and report green for an unfixed build. They drive
the same queued route (the popup's auto-cast owns the session, so the PAGE's own
request is the one that gets cancelled) and assert nothing about load generations.
Both collect exactly the same facts - the request callback timeline, the
`sessionListener` timeline, and which background cancel site posted - so only the
expectation flips and there is one reader to trust.

Measured pre-fix (2/2 runs, plus 3/3 on `--auto-cast-fixed`):

| fact | value |
| --- | --- |
| `requestSessionCalls` | 1 |
| request callbacks | `[error(cancel), success]` - `sessionCallbacks.length` 2 |
| `successCount` / `errorCount` / `settleType` | 1 / 1 / `error` |
| background cancel | site 1 (`if (!selection)`, the replaced selector) |
| `sessionListenerCalls` | **0** |
| session id | non-empty (the session really was created) |

Both modes also require that the session really reached the page, and they accept
EITHER ownership channel, because which one is legitimate depends on the build: the
stale request success callback (pre-fix, which also sets the page's top-level
`sessionId`) or the `sessionListener` (fixed, where the page's `sessionId` stays
empty on purpose - the listener records the session without adopting it). Requiring
a non-empty `sessionId` would raise a third, unrelated red against a correct fix.

So the page's request is cancelled **and then** settled again by the session the
extension created, and that session never reaches the page through the listener it
belongs to. The `sessionListener` timeline exists precisely so the fixed
expectation cannot be satisfied by swallowing the session: "the stale success
callback did not run" is only meaningful together with "the session still reached
the page". On the unfixed build `--request-settlement-fixed` is therefore red on
exactly those two checks and nothing else (`50/52`), which is what makes it a
usable red/green pair.

### Owner-aware session-media clear (`--owner-aware-clear`)

```sh
node test/integration/sessionHarness.js --owner-aware-clear
```

A session registers its LOAD media under an owner (the session id) for the current
load generation, and a CLEAR from that owner removes it. A clear from an owner that
has since been replaced must not: the extension keeps the current owner's media and
does not mirror the clear to the discovery host, and the discovery host has its own
guard on top of that.

Injection boundary: this case enters at `deviceManager.setRokuSessionMedia()` - the
function that holds the whole owner-aware decision - and the `main:rokuSessionMedia`
handler only forwards `deviceId`/`sessionId`/`media` into it. Everything downstream
is real (`syncRokuSessionMediaToBridge` -> discovery host -> `RokuSessionMediaSync`
-> `main:receiverDeviceMediaStatusUpdated`). What it does NOT cover is that
handler's field forwarding. It deliberately does not advance the generation,
reconnect, or touch a startup deadline.

Four phases, all inside ONE load generation (asserted: no new generation
announcement for the whole sequence):

| phase | action | asserted |
| --- | --- | --- |
| A | owner A publishes media (marker `owner-clear-A`) | adopted locally, mirrored once under generation N, and VISIBLE downstream in a fresh status |
| B | owner B publishes media (marker `owner-clear-B`) | replaces A, mirrored once; B's visibility is the new baseline |
| C | owner A sends a LATE clear | exactly one `ignored` outcome naming A as caller and B as current owner, zero `applied`, zero mirror clears, zero clear messages on the wire - and B's media still visible in a status published AFTER the clear |
| D | the CURRENT owner (B) clears | exactly one `applied`, one mirror, one wire clear whose deviceId/ownerId/generation match, and no later status sample carrying B's media |

Both C and D use a real refresh (`ECP /state`) before reading the downstream status,
so "B is still visible" cannot be satisfied by a stale DOM reading taken before the
clear, and "B is gone" cannot be satisfied by "nothing was published".

The evidence is deliberately three-layered: local adoption (`__fxHarnessClearOutcome_*`),
the extension -> discovery boundary (`__fxHarnessMirror_*` plus the real
`bridge:rokuSetSessionMedia` messages on the wire), and downstream consumption
(`main:receiverDeviceMediaStatusUpdated`).

Counter-control (a build whose registry lookup is replaced by a stand-in whose
`ownerId` IS the caller's, so the guard always matches - never committed): the
headline check "the retired owner's late clear did not cross the local or wire
boundary" goes red with `ignored: []`, `applied: 1`, `mirrorClears: 1`,
`wireClears: 1`, and nothing else fails.

Worth knowing, and measured rather than assumed: the downstream "B is still
visible" check does NOT discriminate the extension-side guard, because the
discovery host runs its OWN owner-aware guard and refused the stale clear even in
the counter-control. The discriminating evidence for the extension side is the
local outcome marker and the wire crossing - which is exactly what the headline
check reads. Two layers, two guards, one of which can mask the other.

### Page settlement: who settled the page, and how often

`--request-source selector|queued` chooses which caller drives the session start.
`queued` keeps the auto-cast provocation - the popup mounts late AND its first
`popup:init` is suppressed, so a replacement selector owns the session and
`loadSender` does; `selector` mounts the popup equally late but suppresses nothing,
so the popup binds to the selector `requestSession` already opened and the main
handler owns the session. Combined with
`--fail-stage`, each caller can be asked at each checkpoint what the PAGE saw:

- the SDK callback timeline (`sessionCallbacks`, with each callback's type and error
  code) plus `requestSessionCalls`, `successCount`, `errorCount` and `settleType`
  (the FIRST settlement's type). The number of settlements is
  `sessionCallbacks.length` - deliberately not a counter, since one that counted only
  callbacks matching the first type would read 1 for an error-then-success double
  settlement;
- how many times the background posted `cast:sessionRequestCancelled`, counted at
  every post site (located by brace matching, so a differently indented site cannot
  slip past and make a double settlement look like a single one) - and WHICH site
  posted. Each marker carries the post ordinal, the site index, a snippet of that
  site's own source context, and (where a `catch` binding is in scope) the error it
  was handling, because a bare count cannot tell "the page was settled by its own
  failed start" from "by the selector that replaced it". Measured: selector failures
  settle through the `catch` site carrying the original error, queued failures
  through `if (!selection)` with no error at all.

Measured at p0 and p2, identical for both callers: one `requestSession` call, zero
successes, one error callback with code `cancel` (`sessionCallbacks.length` 1), no
session id, and exactly one background cancel - counted as the largest count among
this run's cancel markers, so a second settlement could not hide behind the first
key. Worth knowing:
the queued caller's page-visible cancel is the REPLACED selector's; the failed
session start itself produces no page event on that path (loadSender only rethrows
to triggerCast, which logs).

## Status

Validated end to end (real processes, real sockets):

- extension loads unsigned from a sideloaded XPI, bridge handshake completes
  (`checking for bridge...` → `bridge compatible!`),
- three connections appear with distinct PIDs: two version probes (`bridge:/getInfo`)
  and the persistent discovery connection (`bridge:startDiscovery`),
- the discovery process discovers the fake Roku over SSDP, polls it over ECP
  (`/query/device-info`, then `/query/media-player` + `/query/active-app`), and
  emits `main:deviceUp`, `main:receiverDeviceStatusUpdated`,
  `main:rokuPlaybackObservation`, `main:receiverDeviceMediaStatusUpdated` back
  through the connection — i.e. the whole discovery side runs through the real
  relay.

Not yet implemented: **the session half**. The red/green test the harness is for
(session media crossing session host → extension → discovery host) needs a
session to exist, which in production is created by a page-driven cast (`chrome.cast.requestSession` → receiver selector → `castManager.startSession`).
That requires page automation (Selenium; `selenium-webdriver` is installed,
geckodriver is not but Selenium Manager can fetch it, and network is available).
Two candidate drivers, to be chosen deliberately:

1. **Page + cast SDK** (most faithful, matches `test/spec/*`): a test page loads
   the Cast SDK URL, which the extension's `webRequest` listener redirects to its
   own `cast/content.js`; the page calls `requestSession`; the receiver selector
   then has to be driven to pick the fake device.
2. **Extension page as the sender**: drive `moz-extension://<uuid>/ui/…` and post
   the same message the sender's content port posts, skipping the page half. The
   page-sender hop is already covered by the repo's own specs; the relay and both
   native connections stay real either way. This is a deliberate boundary, and it
   must be labelled as such wherever it is used.

Planned assertions for the session half (from the review):

1. session media reaches the discovery connection (`bridge:rokuSetSessionMedia`),
2. generation before media, and media before generation,
3. a generation advance retires the previous load's media at the discovery side,
4. an owner-aware clear does not delete a newer owner's media,
5. after a forced reconnect both generation and session media are replayed,
6. HLS DVR metadata reaches the remote's synthesised output
   (`startup-synthetic` BUFFERING),
7. the raw observation keeps `ecp-poll` while the synthetic UI status keeps
   `startup-synthetic`.

## Files

- `nativeProtocol.js` — framing (4-byte LE + JSON), used only to parse a copy.
- `hostWrapper.js` — transparent wrapper, per-connection traces, reaps its child.
- `installManifest.js` — per-user native manifest install/remove (idempotent).
- `fakeRoku.js` — SSDP responder + ECP server + control endpoint.
- `selfTest.js` — plumbing self-proof (no browser).
- `runFirefox.js` — launches Firefox with the built extension and reports.

## Traces

Every run writes to a fresh temp directory (printed at startup):

- `spawns.ndjson` — wrapper PIDs, child PIDs, argv (manifest path), PATH,
  signals, child exits,
- `conn-<pid>-in.ndjson` / `conn-<pid>-out.ndjson` — every message in both
  directions, per connection,
- `conn-<pid>-err.log` — that host's stderr,
- `firefox-stdout.log` — browser + extension console,
- `fake-roku/` — M-SEARCH seen, ECP requests by path, keypresses, launches.
