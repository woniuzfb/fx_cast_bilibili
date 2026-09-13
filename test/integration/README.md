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
  start releases its own.
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
  covered.

### Page settlement: who settled the page, and how often

`--request-source selector|queued` chooses which caller drives the session start.
`queued` keeps the auto-cast provocation (a replacement selector owns the session,
so `loadSender` does); `selector` keeps the popup mounting early so the click
resolves the requestSession selector and the main handler owns it. Combined with
`--fail-stage`, each caller can be asked at each checkpoint what the PAGE saw:

- the SDK callback timeline (`sessionCallbacks`, with each callback's type and error
  code) and `requestSessionCalls` / `successCount` / `errorCount` / `settleCount` /
  `settleType`;
- how many times the background posted `cast:sessionRequestCancelled`, counted at
  every post site (located by brace matching, so a differently indented site cannot
  slip past and make a double settlement look like a single one).

Measured at p0 and p2, identical for both callers: one `requestSession` call, zero
successes, one error callback with code `cancel`, `settleCount` 1, no session id,
exactly one background cancel - no double settlement and no hang. Worth knowing:
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
session to exist, which in production is created by a page-driven cast
(`chrome.cast.requestSession` → receiver selector → `castManager.startSession`).
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
