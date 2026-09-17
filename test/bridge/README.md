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
restore the pre-compatibility timeline completely: no minimum-runway pad entries,
no pad process spawned for the minimum runway, `padBaseSeconds === 0` on an
opening cast (so the window has nothing to keep), LOAD at the requested start;
mid-video stays byte-identical either way; and the Roku path is asserted from the
source to ignore the flag (its pad base is the captured segment's own start, and
this harness has no capture input).

**The shared remux cut point.** Both inputs are seeked to `contentBaseSeconds`,
the probed video keyframe (`Math.min(padBaseSeconds, contentBaseSeconds)`), never
to the raw `startTime`: seeking video and audio to the same _wall-clock_ target
cuts them at DIFFERENT points (the video input resumes at its keyframe, the audio
input at the target), which makes the mpegts interleaver drop the first segment's
audio that precedes its first written video packet. `padBaseSeconds` is NOT the
cut point — it is the end of the playlist's synthetic runway and is larger than
the keyframe whenever the Chromecast minimum runway is active (keyframe 0,
padBase 32 on an opening cast). Measured on a real remux before the fix:
video 1.500s against audio 4.394s with 87 audio packets instead of 211; after it:
1.500/1.500 with 211. The source check here pins the expression, so a regression
to `-ss startTime` fails.

**Startup order.** Because the cut point is only known once the probe answers,
the remux now starts AFTER the probe has exited (bounded at 8s, falling back to
`startTime`), and pad generation starts with it. The checks assert that order
(probe first, then remux and pad together) instead of the previous parallel
startup, which is the trade this fix makes.

**Mid-video (health control).** Keyframe 1431 / start 1431.805 keeps
`padBaseSeconds === 1431`, `presentationStartTime === 1431.805` and reports
`probedKeyframeSeconds === 1431` — the values the working production path has.

**The window (`limitChromecastDashPlaylist`).** A no-ENDLIST EVENT playlist is
capped at its tail so the LOAD position always stays past the window's middle,
because a Chromecast joins at the middle and rejects a LOAD before the end of
the middle entry. With 40 segments advertised, the SERVED playlist must be
truncated, not whole; the window end must be the middle bound
`2 x (position + elapsed - targetDuration - 1)` (in that configuration the
Roku-style `position + 60s` runway bound is not the one that binds); exactly the
entries that fit inside the window end are advertised; and — read back off the
served playlist — the entry containing half the window ends at or before the
LOAD position. Deleting the cap makes those checks fail, which is what the
`--revert-timeline` control asserts.

**The window's drip anchor.** The drip clock starts at the receiver's FIRST
playlist fetch, not at the remux start: with 800s advertised at 50ms per segment
and a 2.5s fetch delay, the first fetch must still receive a window sized from
its own moment. That anchoring is the fix for the on-device mid-cast failure
where the app's 3-7s launch grew the list to 3345s and put the middle (1672)
past the position (1435).

**The pad discontinuity.** The pads are a different media timeline from the
remuxed segments, so the boundary is declared: `#EXT-X-DISCONTINUITY` must
appear exactly once, between the last `pad.ts` and the first real segment, and
never when no pad entries were emitted (padding omitted, or a zero pad base).
Without the tag a receiver is entitled to carry the pad's decode clock straight
into the real segment.

**Probe failure.** A corrupt ffprobe payload must still reach readiness, must
fall back to the requested start, and must NOT claim a probed keyframe. It also
keeps the remux's cut point equal to the requested start, since the fallback
keyframe is the start time: a failed probe degrades to the old behaviour instead
of cutting both inputs at a pad base that no keyframe backs.

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

`--revert-timeline` takes the CURRENT source and rewrites exactly three rules
back to their pre-fix form (pad base = keyframe; pad generation only from the
probe callback; no middle-bound cap on the advertised playlist), then requires
the opening-cast, zero-start, parallel-startup, window and pad-boundary checks to
FAIL. The rewrite is verified to have applied — a control that silently tested
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

-   `DASH item transition tick` — one line per CHANGED tick, with the previous and
    currently bound `mediaSessionId`, the player state, the receiver's raw position,
    whether this load's LOAD callback has resolved, and the elapsed time. A receiver
    that stops reporting shows up as the last tick before the silence.
-   `item transition: LOAD callback resolved` — the callback's own
    `mediaSessionId`/state plus every id in `session.media`.
-   `receiver media load rejected` — the SDK error with `code`/`description`,
    the active bridge `requestId`, whether a transition/priming was open, the LOAD
    position that was sent, and the session ids present at that moment.
-   `DASH item transition window closed` — the reason: `new-media-position`,
    `load-rejected`, `new-load`, `deadline`, or `stopped`.

## The capture input contract: `pageCaptureRemux.js`

`node test/bridge/pageCaptureRemux.js` (also in `npm run test:bridge`)

The replacement-handoff line (see `.workbuddy/memory/2026-09-16.md`,
"【推翻】6.32-6.35") was declared fixed on a harness whose success criterion was
"some bridge port received a payload with the expected marker". On the device
that criterion held while the remux still failed, because the bridge does not
need "a payload": per kind it needs a Range-0 init whose sidx declares a
fragment whose FULL byte range has been captured. Only then does it emit
`page-response-start-selected`, only that sets `keyframeResolved` /
`padReadyResult` for video, and only then does the readiness gate clear.

This harness runs that contract for real:

1. `mediaServer.ts` is bundled from source and `startRemoteMediaServer` is called
   with `rokuDashPrebuffer: true` — the Roku capture path, with its own
   `/ingest`, `/video` and `/audio` endpoints.
2. The fixture "page" POSTs synthetic-but-real DASH bytes (one shared layout:
   `test/fixtures/syntheticDash.js`) in exactly the ranges a page would: a
   Range-0 init (ftyp+moov+sidx) followed by whole sidx fragments. Synthetic
   rather than downloaded, because the point is to vary the RANGE SET and see
   what the bridge does with it.
3. The fake ffmpeg really opens both `-i` URLs over HTTP and drains them, so the
   bridge's per-kind input selection is entered the way production enters it; and
   it produces no output until BOTH inputs have yielded bytes, which is the
   faithful shape of `-map 0:v:0 -map 1:a:0` and is what makes "an audio input
   with nothing to read" mean "no playlist, no `mediaServerStarted`".

Cases: both kinds fed (both selected, gate clears, playlist advertises the
prebuffer and every advertised segment is servable); audio's covering fragment
missing; audio's Range-0 missing (both: video selects, audio NEVER does, the
audio input receives not one byte, no stream at all); and audio arriving late
(audio DOES select — the bridge waits, it does not fail, so a fix belongs
upstream in the capture). The last two cases are the local reproduction of the
on-device failure; the "missing" cases double as the negative control for the
"both kinds fed" rows.
