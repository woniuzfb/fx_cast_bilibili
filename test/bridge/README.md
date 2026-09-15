# Bridge (DASH remux) tests

`node test/bridge/dashRemuxTimeline.js` (also `npm run test:bridge`)

This is the only harness that EXECUTES the bridge's DASH remux server. The rest
of the suite reasons about the bridge from the outside — `test/senders/*` bundles
the extension sender with the cast SDK stubbed, and the DASH timeline test there
reads `mediaServer.ts`'s expressions out of the file and evaluates them. That can
pin arithmetic, but it cannot see when a process is started, what the readiness
gate waits for, what the published playlist actually contains, or whether the pad
segment a playlist advertises can be served at all.

## Method

1. `bridge/src/bridge/components/mediaServer.ts` is bundled from source with
   **esbuild** (no stubs; the production module graph, including `mime-types`,
   is resolved from `bridge/node_modules`).
2. `startRemoteMediaServer` is called with a fixture URL on a host the process is
   allowed to serve, and the harness waits for the real
   `mediaCast:mediaServerStarted` message on a Messenger stub.
3. Two seams, both of which already existed in the shipped code:
    - `FX_CAST_BILIBILI_FFMPEG` — the app's ffmpeg override. The fake tools are
      one script with two personalities, selected by its own filename so the
      bridge's `ffmpegPath.replace(/ffmpeg$/, "ffprobe")` resolution finds
      `fake-ffprobe`. The fake ffprobe prints a packet window (the probed
      keyframes) after a configurable delay; the fake ffmpeg appends its spawn
      time plus whether it was the pad or the remux instance to `spawns.log`,
      then writes an HLS EVENT playlist and segment files.
    - `FX_CAST_BILIBILI_ALLOWED_HOSTS` — comma-separated extra DASH hosts for
      this process only. Unset in every normal run, so the static suffix
      allowlist is the whole policy; the harness needs it because it has no CDN.
4. The published playlist is fetched over HTTP from the bridge's own server, the
   way a receiver does, and the pad segment URL is fetched too.

## What it asserts

**Opening cast (2.864s, keyframe 0).** The SERVED playlist opens with `pad.ts`,
its leading pad count matches `padBaseSeconds / 4`, LOAD is shifted onto the
padded timeline (32 + 2.864), and `pad.ts` really is servable.

**Start at exactly 0.** Takes the SAME padded path (`padBaseSeconds === 32`,
`presentationStartTime === 32`). The page reporting 0 or 0.2s must not decide
between two different playlist shapes; that boundary was a startup race.

**The options switch (`chromecastDashStartupPadding`, default ON).** OFF must
restore the pre-compatibility timeline completely: no pad entries published, no
pad process spawned up front, `padBaseSeconds === 0`, LOAD at the requested
start; mid-video stays byte-identical either way; and the Roku path is asserted
from the source to ignore the flag (its pad base is the captured segment's own
start, and this harness has no capture input).

**Mid-video (health control).** Keyframe 1431 / start 1431.805 keeps
`padBaseSeconds === 1431`, `presentationStartTime === 1431.805` and reports
`probedKeyframeSeconds === 1431` — the values the working production path has.

**Probe failure.** A corrupt ffprobe payload must still reach readiness, must
fall back to the requested start, and must NOT claim a probed keyframe.

**Parallel startup.** With a 1200ms probe, the pad generator and the remux must
both be spawned before the probe exits, and readiness must still wait for the
probe: pad generation is not serialized behind ffprobe.

**Item change contracts.** Read out of the real sender sources, so the checks
cannot drift from the shipped code: `bilibili.ts` pauses the page ONLY under an
explicit condition that is false for every non-initial change (a Roku capture
source and a Chromecast mirror alike), it takes audio ownership of the updated
element unconditionally (`prepareUpdatedMediaElement`), and it opens the
transition window before the reload. `media.ts` mutes that element without ever
pausing it, ignores the old session's `PAUSED` while the window is open, and
closes the window on the new session's first real position.

## Controls

```sh
node test/bridge/dashRemuxTimeline.js                  # the contract
node test/bridge/dashRemuxTimeline.js --revert-timeline # negative control
node test/bridge/dashRemuxTimeline.js --rev <git-rev>   # another revision
```

`--revert-timeline` takes the CURRENT source and rewrites exactly two rules back
to their pre-fix form (pad base = keyframe; pad generation only from the probe
callback), then requires the opening-cast, zero-start and parallel-startup checks
to FAIL. The rewrite is verified to have applied — a control that silently tested
the fixed code would otherwise report green and mean nothing.

`--rev` runs the whole harness against another revision in a `git worktree`.
An older revision with no `FX_CAST_BILIBILI_ALLOWED_HOSTS` seam refuses the
fixture host, so every case reports "the bridge produced a stream to inspect" —
that mode documents a regression in the serve path, not the timeline.

## Boundary

Real bridge code, real ffmpeg command lines, real HTTP. But the "ffmpeg" is a
script: this says nothing about actual remuxing, codec handling, or what a
physical Chromecast does with the pad runway. A real receiver run is still the
only evidence for playback starting.

## What a failed handoff looks like now

Item/quality transitions are logged as a transaction, so a failure can be located
instead of inferred:

- `DASH item transition tick` — one line per CHANGED tick, with the previous and
  currently bound `mediaSessionId`, the player state, the receiver's raw position,
  whether this load's LOAD callback has resolved, and the elapsed time. A receiver
  that stops reporting shows up as the last tick before the silence.
- `item transition: LOAD callback resolved` — the callback's own
  `mediaSessionId`/state plus every id in `session.media`.
- `receiver media load rejected` — the SDK error with `code`/`description`,
  the active bridge `requestId`, whether a transition/priming was open, the LOAD
  position that was sent, and the session ids present at that moment.
- `DASH item transition window closed` — the reason: `new-media-position`,
  `load-rejected`, `new-load`, `deadline`, or `stopped`.
