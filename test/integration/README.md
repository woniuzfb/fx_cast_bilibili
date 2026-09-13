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
