import { createHash } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { Worker } from "worker_threads";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import stream from "stream";

import mime from "mime-types";

import type { Messenger } from "../messaging";
import { convertSrtToVtt } from "../lib/subtitles";
import type { CctvDecryptDiagnostics } from "./cctvDecrypt";

export let mediaServer: http.Server | undefined;
export let mediaServerRequestId: string | undefined;
let mediaServerStopPromise: Promise<void> | undefined;
let dashRemuxProcess: ChildProcess | undefined;
let dashTempDir: string | undefined;
let dashServerGeneration = 0;
const dashAuxProcesses = new Set<ChildProcess>();

/**
 * Live-relay continuation state: the seed playlist URL and the highest
 * upstream sequence whose bytes were successfully served to the receiver.
 * This follows slot remaps and concatenated ranges, so recovery resumes after
 * content already played rather than reusing a logical playlist sequence that
 * no longer identifies the cached upstream body. Deliberately module-level so
 * it survives relay stop/rebuild cycles.
 */
let liveRelayContinuation:
  | {
      seedUrl: string;
      lastConsumedUpstreamSequence?: number;
      /**
       * Sequence frontier of the FIRST bootstrap for this seed: the anchor of
       * the relay that last rebuilt the synthetic DVR from scratch. Recovery
       * relays inherit it so the historical/live ownership boundary below
       * stays sequence-based across rebuilds.
       */
      bootstrapThroughSequence?: number;
      /** Last wall-clock ms a relay under this seed served a segment. */
      lastServedAtMs?: number;
    }
  | undefined;

/**
 * Bounded age for continuation state. A recovery rebuild reaches the relay
 * within a couple of segment periods of the last serve; anything older is a
 * brand-new cast of the same seed (the page started over at the live edge),
 * which must re-bootstrap from scratch instead of resuming stale sequences
 * that neither the CDN nor the page capture can supply anymore.
 */
const LIVE_RELAY_CONTINUATION_MAX_AGE_MS = 10 * 60_000;

/**
 * Page-captured segment cache: TS bodies forwarded by the extension from the
 * live page player's own requests, keyed by upstream sequence. Past a relay's
 * bootstrap frontier these bytes are the pipeline's ONLY supply — the
 * CDN-future-fetch path is never used there. Module-level so a recovery
 * rebuild (whose prebuffer runs before its HTTP listener exists) reads what
 * the previous relay ingested. Cleared whenever a relay bootstraps fresh.
 */
let livePageCache = new Map<number, { url: string; body: Buffer }>();
let livePageCacheBytes = 0;
/** Highest sequence ingested (the page player's publication frontier). */
let livePageCacheFrontier = 0;
let livePageCacheIngestCount = 0;
/**
 * Wall-clock ms of the latest page download we heard about (any ingest
 * request, accepted or not). In cdnFutureMode this is the probe admission
 * bound: the page downloading up to now proves the CDN has published at
 * least that far, for every delivery tree.
 */
let livePageProgressMs = 0;

/** How long the pipeline may wait for the page to capture one segment. */
const PAGE_CACHE_WAIT_TIMEOUT_MS = 35_000;
/** Page cache byte cap (mirrors CACHE_BYTES_CAP). */
const PAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** Entries kept behind the pipeline assignment head (seek-back runway). */
const PAGE_CACHE_KEEP_BEHIND_SEQUENCES = 240;

/**
 * Bumped every time a live relay is built. Prefetch pools from a replaced
 * (or still-booting, server-less) relay watch this counter and park
 * themselves — stopMediaServer() alone cannot reach a pool whose HTTP
 * server was never created.
 */
let liveRelayGeneration = 0;

export async function startMediaServer(
  messaging: Messenger,
  requestId: string,
  filePath: string,
  port: number
) {
  if (mediaServer?.listening) {
    await stopMediaServer();
  }
  mediaServerRequestId = requestId;

  let fileDir: string;
  let fileName: string;
  let fileSize: number;

  try {
    const stat = await fs.promises.lstat(filePath);

    if (stat.isFile()) {
      fileDir = path.dirname(filePath);
      fileName = path.basename(filePath);
      fileSize = stat.size;
    } else {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: { requestId, message: "Media path is not a file." },
      });

      return;
    }
  } catch (err) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: "Failed to find media path." },
    });

    return;
  }

  const contentType = mime.lookup(filePath);
  if (!contentType) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: "Failed to find media type." },
    });

    return;
  }

  /**
   * Find any SubRip files within the same directory and
   * convert to WebVTT source.
   */
  const subtitles = new Map<string, string>();
  try {
    const dirEntries = await fs.promises.readdir(fileDir, {
      withFileTypes: true,
    });

    for (const dirEntry of dirEntries) {
      if (
        dirEntry.isFile() &&
        mime.lookup(dirEntry.name) === "application/x-subrip"
      ) {
        subtitles.set(
          dirEntry.name,
          await convertSrtToVtt(path.join(fileDir, dirEntry.name))
        );
      }
    }
  } catch (err) {
    console.error(`Error: Failed to find/convert subtitles (${filePath}).`);
  }

  mediaServer = http.createServer(async (req, res) => {
    if (!req.url) {
      return;
    }

    let decodedUrl = decodeURIComponent(req.url);
    // Drop leading slash
    if (decodedUrl.startsWith("/")) {
      decodedUrl = decodedUrl.slice(1);
    }

    switch (decodedUrl) {
      case fileName: {
        const { range } = req.headers;

        // Partial content HTTP 206
        if (range) {
          const bounds = range.substring(6).split("-");
          const start = parseInt(bounds[0]);
          const end = bounds[1] ? parseInt(bounds[1]) : fileSize - 1;

          res.writeHead(206, {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": end - start + 1,
            "Content-Type": contentType,
          });

          fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Length": fileSize,
            "Content-Type": contentType,
          });

          fs.createReadStream(filePath).pipe(res);
        }
        break;
      }

      default: {
        if (subtitles.has(req.url)) {
          const vttSource = subtitles.get(req.url)!;
          const vttStream = stream.Readable.from(vttSource);

          res.setHeader("Access-Control-Allow-Origin", "*");

          vttStream.pipe(res);
        }

        break;
      }
    }
  });

  mediaServer.on("close", () => {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerStopped",
      data: { requestId },
    });
  });
  mediaServer.on("error", (err) => {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: err.message },
    });
  });

  mediaServer.listen(port, () => {
    const localAddresses: string[] = [];
    for (const iface of Object.values(os.networkInterfaces())) {
      const matchingIface = iface?.find(
        (details) => details.family === "IPv4" && !details.internal
      );
      if (matchingIface) {
        localAddresses.push(matchingIface.address);
      }
    }

    if (!localAddresses.length) {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: { requestId, message: "Failed to get local address." },
      });
      stopMediaServer();
      return;
    }

    messaging.sendMessage({
      subject: "mediaCast:mediaServerStarted",
      data: {
        requestId,
        mediaPath: fileName,
        subtitlePaths: Array.from(subtitles.keys()),
        localAddress: localAddresses[0],
      },
    });
  });
}

function remoteHostAllowed(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    const suffixes = [
      "bilivideo.com",
      "bilivideo.cn",
      "bilivideo.tv",
      "hdslb.com",
      "akamaized.net",
      // NOTE: CCTV live CDNs are intentionally NOT listed here. Live HLS is
      // served from many rotating CDNs (volcfcdn / kcdnvip / wscdns /
      // myqcloud / …) that a static suffix list can never fully cover. The
      // live relay validates those per-session via LiveRelayTrust instead.
    ];
    return (
      protocol === "https:" &&
      suffixes.some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
      )
    );
  } catch {
    return false;
  }
}

function firstLocalAddress(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const address = addresses?.find(
      (value) => value.family === "IPv4" && !value.internal
    );
    if (address) return address.address;
  }
  return undefined;
}

async function fetchRemoteMedia(
  mediaUrl: string,
  init: RequestInit,
  isAllowed: (url: string) => boolean = remoteHostAllowed
): Promise<Response> {
  let currentUrl = mediaUrl;
  for (let count = 0; count <= 5; count++) {
    if (!isAllowed(currentUrl)) {
      throw new Error(`Host not allowlisted: ${new URL(currentUrl).hostname}`);
    }
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect has no Location header");
    currentUrl = new URL(location, currentUrl).href;
  }
  throw new Error("Too many upstream redirects");
}

async function startDashRemuxServer(
  messaging: Messenger,
  requestId: string,
  videoUrl: string,
  audioUrl: string,
  referer: string,
  port: number,
  startTime = 0
) {
  if (!remoteHostAllowed(videoUrl) || !remoteHostAllowed(audioUrl)) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: "DASH media host not allowlisted" },
    });
    return;
  }
  await stopMediaServer();
  mediaServerRequestId = requestId;
  const serverGeneration = ++dashServerGeneration;
  const normalizedStartTime =
    Number.isFinite(startTime) && startTime > 0 ? startTime : 0;
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "fx-cast-dash-")
  );
  dashTempDir = tempDir;
  const mediaPath = "index.m3u8";
  const playlistPath = path.join(tempDir, mediaPath);
  const padPath = path.join(tempDir, "pad.ts");
  // Segment URLs get a per-restart generation query so the receiver can never
  // serve a stale cached segment from before a seek restart (same filenames,
  // different content).
  const generation = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  // Pad entries cover [0, padBaseSeconds) so the receiver's playlist-derived
  // timeline matches the real video timeline: currentTime/duration displays
  // and seek math stay in absolute video time even though ffmpeg only
  // produces segments from startTime onward. Pads are never requested in
  // practice (playback always starts at startTime and every seek restarts
  // the remux), but a valid file must exist in case one is fetched.
  //
  // ffmpeg's input seek lands on the keyframe at/before startTime, so the
  // first real segment actually starts at that keyframe. Padding to the
  // keyframe (instead of startTime) lets the receiver seek INTO the first
  // segment and begin at exactly startTime, instead of replaying the
  // keyframe..startTime range with the clock already at startTime. The exact
  // keyframe position is probed with ffprobe below (padBaseSeconds falls
  // back to startTime when the probe fails).
  const padSegmentSeconds = 4;
  let padBaseSeconds = normalizedStartTime;
  // Always run the probe, even from time zero: it also supplies the optional
  // full source duration used when the page media element has no duration yet.
  let keyframeResolved = false;
  let probedDuration: number | undefined;
  const rewritePlaylist = (raw: string) => {
    const padCount = Math.floor(padBaseSeconds / padSegmentSeconds);
    const padRemainder = padBaseSeconds - padCount * padSegmentSeconds;
    let padsInserted = padCount <= 0 && padRemainder <= 0.05;
    return raw
      .split("\n")
      .flatMap((line) => {
        const out: string[] = [];
        if (!padsInserted && line.startsWith("#EXTINF:")) {
          for (let i = 0; i < padCount; i++) {
            out.push(`#EXTINF:${padSegmentSeconds.toFixed(6)},`);
            out.push(`pad.ts?g=${generation}`);
          }
          if (padRemainder > 0.05) {
            out.push(`#EXTINF:${padRemainder.toFixed(6)},`);
            out.push(`pad.ts?g=${generation}`);
          }
          padsInserted = true;
        }
        out.push(line.endsWith(".ts") ? `${line}?g=${generation}` : line);
        return out;
      })
      .join("\n");
  };
  const inputHeaders = `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0\r\n`;
  // Abort a half-open/stalled CDN read instead of leaving ffmpeg and the
  // receiver buffering forever. Value is microseconds.
  const networkTimeoutArgs = ["-rw_timeout", "30000000"];
  // ffmpeg remuxes the DASH sources strictly sequentially, so a receiver
  // seek can never be served from not-yet-downloaded segments. The extension
  // therefore restarts the remux at the seek target instead: input seeking
  // (-ss before -i) uses HTTP range requests on the DASH CDN and lands on
  // the preceding keyframe, making seeks (and mid-video cast starts) fast.
  const seekArgs = normalizedStartTime > 0 ? ["-ss", normalizedStartTime.toFixed(3)] : [];
  const args = [
    "-hide_banner", "-loglevel", "warning",
    ...networkTimeoutArgs, "-headers", inputHeaders, ...seekArgs, "-i", videoUrl,
    ...networkTimeoutArgs, "-headers", inputHeaders, ...seekArgs, "-i", audioUrl,
    "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
    // Default Media Receiver accepts traditional MPEG-TS HLS more reliably
    // than fragmented MP4 HLS on older Chromecast generations.
    "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
    "-hls_playlist_type", "event", "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(tempDir, "segment-%06d.ts"),
    playlistPath,
  ];
  const ffmpegPath = [
    process.env.FX_CAST_BILIBILI_FFMPEG,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ].find((candidate) => candidate && fs.existsSync(candidate)) ?? "ffmpeg";
  // Probe the exact keyframe ffmpeg's input seek will land on, so the
  // playlist can be padded to it (see above). ffprobe has no input -ss, so
  // read a packet window around startTime and take the last keyframe at or
  // before it. Runs in parallel with the remux; falls back to startTime on
  // any failure.
  if (!keyframeResolved) {
    const ffprobePath = ffmpegPath.replace(/ffmpeg$/, "ffprobe");
    let probeStdout = "";
    const probeProcess = spawn(ffprobePath, [
      "-v", "error",
      ...networkTimeoutArgs,
      "-headers", inputHeaders,
      "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,flags:format=duration",
      "-of", "json",
      "-read_intervals", `${Math.max(0, normalizedStartTime - 8).toFixed(3)}%+12`,
      videoUrl,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    dashAuxProcesses.add(probeProcess);
    const finishProbe = (keyframe?: number) => {
      dashAuxProcesses.delete(probeProcess);
      if (keyframeResolved) return;
      if (
        keyframe !== undefined &&
        Number.isFinite(keyframe) &&
        keyframe >= 0 &&
        keyframe <= normalizedStartTime
      ) {
        padBaseSeconds = keyframe;
      }
      keyframeResolved = true;
    };
    const probeTimeout = setTimeout(() => {
      probeProcess.kill("SIGKILL");
      finishProbe();
    }, 8000);
    probeProcess.stdout?.on("data", (chunk) => {
      probeStdout += String(chunk);
    });
    probeProcess.on("exit", () => {
      clearTimeout(probeTimeout);
      let keyframe: number | undefined;
      try {
        const probe = JSON.parse(probeStdout) as {
          packets?: Array<{ pts_time?: string; flags?: string }>;
          format?: { duration?: string };
        };
        const duration = Number.parseFloat(probe.format?.duration ?? "");
        if (Number.isFinite(duration) && duration > 0) {
          probedDuration = duration;
        }
        for (const packet of probe.packets ?? []) {
          const pts = Number.parseFloat(packet.pts_time ?? "");
          if (
            packet.flags?.includes("K") &&
            Number.isFinite(pts) &&
            pts <= normalizedStartTime + 0.001
          ) {
            keyframe = keyframe === undefined ? pts : Math.max(keyframe, pts);
          }
        }
      } catch {
        // Keep the existing startTime fallback when ffprobe output is absent
        // or malformed.
      }
      finishProbe(keyframe);
    });
    probeProcess.on("error", () => {
      clearTimeout(probeTimeout);
      finishProbe();
    });
  }
  // Generate the 4s black/silent pad segment in parallel. It backs the pad
  // playlist entries that cover [0, startTime) and is essentially never
  // fetched, so a tiny resolution keeps this cheap.
  let padReady: Promise<boolean> | undefined;
  let padReadyResult = normalizedStartTime <= 0.05;
  let padFailed = false;
  if (normalizedStartTime > 0.05) {
    padReady = new Promise<boolean>((resolve) => {
      const padProcess = spawn(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x180:r=5",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", String(padSegmentSeconds),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-g", "5", "-c:a", "aac", "-shortest",
        "-f", "mpegts", padPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      dashAuxProcesses.add(padProcess);
      let settled = false;
      const finishPad = (ready: boolean) => {
        if (settled) return;
        settled = true;
        dashAuxProcesses.delete(padProcess);
        padReadyResult = ready;
        padFailed = !ready;
        resolve(ready);
      };
      padProcess.on("exit", (code) =>
        finishPad(code === 0 && fs.existsSync(padPath))
      );
      padProcess.on("error", () => finishPad(false));
    });
  }
  const remuxProcess = spawn(ffmpegPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  dashRemuxProcess = remuxProcess;
  let stderr = "";
  remuxProcess.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8000);
  });
  remuxProcess.on("error", (err) => {
    if (dashRemuxProcess !== remuxProcess) return;
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: `Unable to start ffmpeg: ${err.message}` },
    });
  });
  remuxProcess.on("exit", (code) => {
    if (code && dashRemuxProcess === remuxProcess && mediaServer) {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: { requestId, message: `ffmpeg DASH remux failed (${code}): ${stderr}` },
      });
      // A failed remux cannot recover while the old HTTP server remains up.
      // Close it and remove the temp directory so the next cast starts clean.
      void stopMediaServer();
    }
  });
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent((req.url ?? "/").split("?", 1)[0]);
    const filename = path.basename(pathname);
    if (!filename || filename !== pathname.slice(1)) {
      res.writeHead(404).end();
      return;
    }
    // The playlist is rewritten on every request: pad entries for
    // [0, startTime) are injected and segment URLs get a cache-busting
    // generation query (see above).
    if (filename.endsWith(".m3u8")) {
      try {
        const raw = await fs.promises.readFile(
          path.join(tempDir, filename),
          "utf8"
        );
        const body = rewritePlaylist(raw);
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "Content-Type": "application/x-mpegURL",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    const filePath = path.join(tempDir, filename);
    try {
      if (filename === "pad.ts" && padReady) {
        // Pad generation runs in parallel with the remux; wait briefly if
        // the receiver somehow requests a pad before it is ready.
        const ready = await Promise.race([
          padReady,
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 5000)
          ),
        ]);
        if (!ready) {
          res.writeHead(503, { "Retry-After": "1" }).end();
          return;
        }
      }
      const stat = await fs.promises.stat(filePath);
      const type = filename.endsWith(".ts")
        ? "video/mp2t"
        : "application/octet-stream";
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Content-Type": type,
        "Content-Length": stat.size,
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  mediaServer = server;
  mediaServer.on("error", (err) =>
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: err.message },
    })
  );
  mediaServer.on("close", () =>
    messaging.sendMessage({
      subject: "mediaCast:mediaServerStopped",
      data: { requestId },
    })
  );
  mediaServer.listen(port, async () => {
    const address = firstLocalAddress();
    if (!address) {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: { requestId, message: "No local IPv4 address" },
      });
      void stopMediaServer();
      return;
    }
    // The remux now starts at the requested position (startTime), so the
    // receiver only needs the first couple of segments to begin playback.
    const minimumPlaylistDuration = 8;
    for (let attempt = 0; attempt < 900; attempt++) {
      if (serverGeneration !== dashServerGeneration || mediaServer !== server) {
        return;
      }
      if (padFailed) {
        messaging.sendMessage({
          subject: "mediaCast:mediaServerError",
          data: { requestId, message: "Unable to generate DASH timeline pad segment" },
        });
        void stopMediaServer();
        return;
      }
      try {
        const playlist = await fs.promises.readFile(playlistPath, "utf8");
        const playlistDuration = [...playlist.matchAll(/^#EXTINF:([0-9.]+)/gm)]
          .reduce((total, match) => total + Number(match[1]), 0);
        if (
          // Wait for the keyframe probe so the served playlist is padded to
          // the probed keyframe, not the rough startTime.
          keyframeResolved &&
          padReadyResult &&
          playlist.includes("segment-") &&
          playlist.includes(".ts") &&
          // A seek into the final seconds of the video yields a complete
          // but short playlist: ENDLIST marks readiness regardless of the
          // accumulated duration (which would never reach the minimum and
          // always end in the 90s poll timeout).
          (playlistDuration >= minimumPlaylistDuration ||
            playlist.includes("#EXT-X-ENDLIST"))
        ) {
          messaging.sendMessage({
            subject: "mediaCast:mediaServerStarted",
            data: {
              requestId,
              mediaPath,
              subtitlePaths: [],
              localAddress: address,
              mode: "dash-remux",
              startTime: normalizedStartTime,
              padBaseSeconds,
              ...(probedDuration !== undefined ? { pageDuration: probedDuration } : {}),
            },
          });
          return;
        }
      } catch {
        // Playlist not written yet; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: `Timed out preparing DASH stream through ${minimumPlaylistDuration}s: ${stderr}` },
    });
    void stopMediaServer();
  });
}

/**
 * Live HLS relay (CCTV live). Chromecast devices hardcode public DNS and
 * can resolve Chinese CDN domains to slow/wrong edge nodes, which makes
 * direct playback of a small-window live playlist (3x4s segments) rebuffer
 * forever. The relay builds one synthetic DVR playlist from a single
 * upstream snapshot and NEVER changes the bytes it serves after that: a
 * worker pool prefetches, decrypts and ffmpeg-validates every sequence
 * ahead of the receiver, and /seg only ever reads that cache. Caching is
 * fully decoupled from playback — a deterministically bad upstream
 * sequence is absorbed by remapping its playlist slot to the next good
 * sequence, so the receiver never sees unvalidated bytes and the served
 * playlist is never rewritten.
 */
const LIVE_HLS_ENTRY_PATH = "index.m3u8";

function encodeRelayUrl(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

/**
 * Reject loopback / link-local / RFC1918 / ULA hosts so the relay can never
 * be coerced into fetching an internal address. Applies to both the seed
 * playlist URL and any URL that appears inside a relayed playlist.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 loopback / ULA / link-local.
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // fe80::/10
  // IPv4 (dotted-quad only; DNS names fall through to the DNS-based checks).
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  }
  return false;
}

/**
 * Per-session trust for the live relay. Instead of a hardcoded CDN suffix
 * allowlist (CCTV load-balances live HLS across many rotating CDNs —
 * volcfcdn / kcdnvip / wscdns / myqcloud / …, so any static list is
 * perpetually incomplete), the relay trusts URLs *transitively*:
 *   1. the seed playlist URL captured from the real tab traffic by the
 *      trusted background webRequest listener, and
 *   2. any absolute URL that appears inside a playlist we have already
 *      fetched from an allowed host.
 * Every candidate must still be https and resolve to a non-private host, so
 * this cannot be turned into an open proxy to arbitrary internal targets.
 */
class LiveRelayTrust {
  private readonly hosts = new Set<string>();

  seed(url: string): boolean {
    return this.admit(url);
  }

  /** Record + validate a URL; returns true if it may be relayed. */
  admit(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    if (isPrivateHost(parsed.hostname)) return false;
    this.hosts.add(parsed.hostname.toLowerCase());
    return true;
  }

  /** Validate a URL received back from the receiver (no new trust granted). */
  allows(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return (
      parsed.protocol === "https:" &&
      !isPrivateHost(parsed.hostname) &&
      this.hosts.has(parsed.hostname.toLowerCase())
    );
  }

  decode(value: string): string | undefined {
    try {
      const url = Buffer.from(value, "base64url").toString("utf8");
      return this.allows(url) ? url : undefined;
    } catch {
      return undefined;
    }
  }
}

interface HistoricalSegmentTemplate {
  prefix: string;
  suffix: string;
  sequence: number;
  /** Wall-clock milliseconds parsed from a Beijing-time URL stamp. */
  timestampMs?: number;
}

/** Already-broadcast content kept in front of the live edge (DVR lookback). */
const HISTORICAL_PLAYLIST_SECONDS = 120;
/** Decrypted history buffered before the receiver is told the relay is ready. */
const INITIAL_PREBUFFER_SECONDS = 60;
/**
 * Total length of the synthesized DVR window (history + future).
 *
 * Capped at 2h, NOT longer: the Default Media Receiver fetches and parses the
 * WHOLE playlist (observed: twice per load) before its first segment request.
 * At 12h this was 10 800 entries / 1.6 MB, and every observed session spent
 * ~4s between LOAD and the first segment request, flapped
 * BUFFERING<->PLAYING at sub-real-time progress, and then died with a fatal
 * IDLE/ERROR within seconds — on segments the relay served instantly. 2h of
 * 4s segments (~1 800 entries / ~260 KB) is the same order as the largest
 * known-good Bilibili remux playlists. Sessions longer than the tail simply
 * finish the frozen VOD (IDLE/FINISHED); auto-recovery then reloads a fresh
 * window and playback continues.
 */
const LIVE_PAGE_DURATION_SECONDS = 2 * 3600;

/**
 * CCTV CDN segment names end in a decimal sequence, optionally followed by a
 * compact wall-clock stamp. The delimiter before the sequence is CDN-specific
 * (`-`, `_`, or `/` are all in use), so preserve the complete prefix rather
 * than requiring one hard-coded separator. Query strings are preserved in the
 * suffix and therefore remain valid for synthesized historical/future URLs.
 */
function parseHistoricalSegmentTemplate(
  uri: string,
  playlistUrl: string
): HistoricalSegmentTemplate | undefined {
  let absolute: string;
  try {
    absolute = new URL(uri, playlistUrl).href;
  } catch {
    return undefined;
  }
  let match = absolute.match(/^(.*?)(\d+)-(\d{8}T\d{6})(\.ts(?:[?#].*)?)$/i);
  if (match) {
    const stamp = match[3]!;
    // CCTV compact URL timestamps are Asia/Shanghai (UTC+08:00).
    const timestampMs =
      Date.UTC(
        Number(stamp.slice(0, 4)),
        Number(stamp.slice(4, 6)) - 1,
        Number(stamp.slice(6, 8)),
        Number(stamp.slice(9, 11)),
        Number(stamp.slice(11, 13)),
        Number(stamp.slice(13, 15))
      ) -
      8 * 60 * 60 * 1000;
    if (Number.isFinite(timestampMs)) {
      return {
        prefix: match[1]!,
        sequence: Number(match[2]),
        timestampMs,
        suffix: match[4]!,
      };
    }
  }
  match = absolute.match(/^(.*?)(\d+)(\.ts(?:[?#].*)?)$/i);
  if (match) {
    return {
      prefix: match[1]!,
      sequence: Number(match[2]),
      suffix: match[3]!,
    };
  }
  return undefined;
}

function formatCompactBeijing(timestampMs: number): string {
  const iso = new Date(timestampMs + 8 * 60 * 60 * 1000).toISOString();
  return iso.slice(0, 10).replace(/-/g, "") + "T" +
    iso.slice(11, 19).replace(/:/g, "");
}

interface SyntheticDvrPlaylist {
  playlist: string;
  /** Measured seconds per segment (the upstream cadence). */
  stepSeconds: number;
  /** Total synthesized segments (history + future). */
  segmentCount: number;
  /** Total presentation duration in seconds. */
  totalDurationSeconds: number;
  /** Live-edge offset in the VOD timeline: end of the last real segment. */
  liveEdgeBaseSeconds: number;
  /** Wall-clock ms when the playlist was built; the live edge advances from here. */
  builtAtMs: number;
  /** Sequence number of the anchor (last real upstream) segment. */
  anchorSequence: number;
  /** Sequence number of the first entry in the served playlist. */
  firstSequence: number;
  /**
   * Extract the sequence number from a segment URL this playlist
   * references, or undefined for unrecognized URLs (keys, maps). Used by
   * /seg to tell future (not yet published) segments from past ones:
   * sequence ordering is wall-clock ordering on both known CDN patterns.
   */
  sequenceOf: (url: string) => number | undefined;
  /**
   * Synthesize the upstream URL for an arbitrary sequence number on the
   * anchor's pattern (the inverse of sequenceOf). The segment pipeline
   * uses it to advance a slot's mapping past a deterministically bad
   * sequence ("remap to the next segment") without touching the served
   * playlist.
   */
  urlOf: (sequence: number) => string;
}

/**
 * Build a frozen DVR presentation from ONE upstream playlist snapshot.
 * CCTV live segment URLs are strictly regular — sequence+1 maps to one
 * cadence step on every known CDN (volcfcdn ...-<seq>-<stamp>.ts and
 * myqcloud ...-<seq>.ts) — so a single fetch is enough to synthesize the
 * whole timeline: already-broadcast segments before the last fetched one
 * (HISTORICAL_PLAYLIST_SECONDS, or less when resuming after a previously
 * served sequence), plus future segments filling the window up to
 * LIVE_PAGE_DURATION_SECONDS. The result is a plain seekable VOD
 * (PLAYLIST-TYPE:VOD + ENDLIST). Future segments don't exist on the CDN yet;
 * /seg polls for them until they are published.
 */
function buildSyntheticDvrPlaylist(
  raw: string,
  playlistUrl: string,
  trust: LiveRelayTrust,
  resumeAfterSequence?: number
): SyntheticDvrPlaylist | undefined {
  const lines = raw.split("\n");
  const targetMatch = raw.match(/^#EXT-X-TARGETDURATION:\s*(\d+)/im);
  const targetDuration = Number(targetMatch?.[1]);
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) return undefined;

  // Pair #EXT-X-PROGRAM-DATE-TIME tags (timezone-aware wall clock) with the
  // media URI that follows them: the myqcloud pattern has no URL timestamp,
  // so PDT is the only cadence clock available there.
  const pdtBySegment: (number | undefined)[] = [];
  let pendingPdtMs: number | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    const pdtMatch = trimmed.match(/^#EXT-X-PROGRAM-DATE-TIME:\s*(.+)$/i);
    if (pdtMatch) {
      const parsed = Date.parse(pdtMatch[1]!.trim());
      pendingPdtMs = Number.isFinite(parsed) ? parsed : undefined;
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    pdtBySegment.push(pendingPdtMs);
    pendingPdtMs = undefined;
  }

  const segments = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((uri) => parseHistoricalSegmentTemplate(uri, playlistUrl));
  // Every URI must match a known CCTV pattern; anything else means an
  // unfamiliar playlist shape; the caller rejects unsupported relay input.
  if (segments.length === 0 || segments.some((s) => !s)) return undefined;
  const anchor = segments[segments.length - 1]!;

  // Measure the real cadence from adjacent segments rather than trusting
  // TARGETDURATION (an upper bound): a step that is off by even 1% would
  // drift the synthesized URLs by ~1 minute over the 2h window and every
  // future request would 404. Wall clock comes from PROGRAM-DATE-TIME when
  // present, else from the URL stamps (both are fine for RELATIVE deltas).
  const steps: number[] = [];
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!;
    const cur = segments[i]!;
    const seqDelta = cur.sequence - prev.sequence;
    if (seqDelta <= 0) return undefined;
    const clock = (s: HistoricalSegmentTemplate | undefined, pdt: number | undefined) =>
      pdt ?? s?.timestampMs;
    const prevClock = clock(prev, pdtBySegment[i - 1]);
    const curClock = clock(cur, pdtBySegment[i]);
    if (prevClock !== undefined && curClock !== undefined) {
      steps.push((curClock - prevClock) / 1000 / seqDelta);
    }
  }
  // EXTINF label of the anchor segment (its real duration tag).
  const extinfMatch = [...raw.matchAll(/^#EXTINF:([\d.]+)/gim)].pop();
  const extinfSeconds = extinfMatch ? Number(extinfMatch[1]) : undefined;
  const stepSeconds =
    steps.length > 0
      ? steps.reduce((a, b) => a + b, 0) / steps.length
      : extinfSeconds ?? targetDuration;
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) return undefined;
  // Irregular cadence (encoder restart, inserted segments): extrapolating
  // the window from it would misalign every URL after the first
  // discontinuity.
  if (steps.some((s) => Math.abs(s - stepSeconds) > 0.25)) return undefined;
  const extinf = extinfMatch?.[1] ?? stepSeconds.toFixed(3);

  const standardHistoryCount = Math.max(
    1,
    Math.round(HISTORICAL_PLAYLIST_SECONDS / stepSeconds)
  );
  // Recovery continuation is strict: start exactly after the actual target
  // last served by the previous relay, even when that puts part of the new
  // prebuffer beyond the current upstream anchor. Those unpublished entries
  // are polled in order instead of replaying or skipping receiver content.
  const firstSequence =
    resumeAfterSequence !== undefined
      ? resumeAfterSequence + 1
      : anchor.sequence - standardHistoryCount + 1;
  const historyCount = Math.max(0, anchor.sequence - firstSequence + 1);
  const totalCount = Math.max(
    historyCount + 1,
    Math.round(LIVE_PAGE_DURATION_SECONDS / stepSeconds)
  );

  const discontinuityMatch = raw.match(
    /^#EXT-X-DISCONTINUITY-SEQUENCE:\s*(\d+)/im
  );
  const out = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
  ];
  if (discontinuityMatch) {
    out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuityMatch[1]}`);
  }
  // Carry EXT-X-KEY / EXT-X-MAP through with the URI routed via the relay
  // (defensive only: no known CCTV live delivery ships them; if one ever
  // does, the receiver must fetch the key/init segment through us exactly
  // like a media segment).
  for (const line of lines) {
    const trimmed = line.trim();
    if (!/#EXT-X-KEY|#EXT-X-MAP/i.test(trimmed)) continue;
    out.push(
      trimmed.replace(/URI="([^"]+)"/i, (whole, uri: string) => {
        let absolute: string;
        try {
          absolute = new URL(uri, playlistUrl).href;
        } catch {
          return whole;
        }
        return trust.admit(absolute)
          ? `URI="/seg?u=${encodeRelayUrl(absolute)}"`
          : whole;
      })
    );
  }
  // Timestamped CDN names use Beijing local time. Parse and synthesize them
  // consistently as Asia/Shanghai (UTC+08:00); sequence-only names need no
  // timestamp handling.
  const urlOf = (sequence: number): string => {
    if (anchor.timestampMs !== undefined) {
      const timestamp = formatCompactBeijing(
        anchor.timestampMs + (sequence - anchor.sequence) * stepSeconds * 1000
      );
      return `${anchor.prefix}${sequence}-${timestamp}${anchor.suffix}`;
    }
    return `${anchor.prefix}${sequence}${anchor.suffix}`;
  };
  for (let offset = 0; offset < totalCount; offset++) {
    const sequence = firstSequence + offset;
    const upstreamUrl = urlOf(sequence);
    if (!trust.admit(upstreamUrl)) return undefined;
    out.push(`#EXTINF:${extinf},`);
    out.push(`/seg?u=${encodeRelayUrl(upstreamUrl)}`);
  }
  out.push("#EXT-X-ENDLIST");
  return {
    playlist: out.join("\n") + "\n",
    stepSeconds,
    segmentCount: totalCount,
    totalDurationSeconds: totalCount * stepSeconds,
    liveEdgeBaseSeconds: historyCount * stepSeconds,
    builtAtMs: Date.now(),
    anchorSequence: anchor.sequence,
    firstSequence,
    urlOf,
    sequenceOf: (url: string): number | undefined => {
      if (!url.startsWith(anchor.prefix) || !url.endsWith(anchor.suffix)) {
        return undefined;
      }
      const middle = url.slice(
        anchor.prefix.length,
        url.length - anchor.suffix.length
      );
      if (anchor.timestampMs !== undefined) {
        // <seq>-<stamp>
        const seqMatch = middle.match(/^(\d+)-\d{8}T\d{6}$/);
        return seqMatch ? Number(seqMatch[1]) : undefined;
      }
      return /^\d+$/.test(middle) ? Number(middle) : undefined;
    },
  };
}

/** Result of one pipeline fetch + decrypt + validate pass. */
interface PipelineFetchResult {
  /** Decrypted body; present only when standalone decrypt+validation succeeded. */
  body?: Buffer;
  contentType: string;
  /**
   * ffmpeg-measured standalone decode duration. A LOWER BOUND only: CNTV
   * fragments whose PES frames continue into the next physical segment
   * measure below their real content — the slot keeps the measured value
   * either way.
   */
  durationSeconds?: number;
  /** Encrypted bytes as fetched; retained for the backfill path. */
  encryptedBody: Buffer;
  /** The segment failed standalone decrypt/validation and is discarded. */
  standaloneFailed?: boolean;
}

/** Per-slot state of the live relay's segment pipeline. */
interface SlotState {
  /** First upstream sequence represented by this slot. */
  targetSequence: number;
  /** Last upstream sequence scanned while forming this slot. */
  consumedThroughSequence: number;
  /** Member sequences of this slot (one per slot since spans were removed). */
  memberSequences?: number[];
  targetUrl: string;
  /** Validated body; evicted by the cache sweep, refilled via backfill. */
  body?: Buffer;
  contentType?: string;
  /** ffmpeg-measured duration of the cached body (liveness credit). */
  durationSeconds?: number;
  /** Backfill/direct fill in progress (dedupes concurrent /seg requests). */
  fill?: Promise<void>;
  /** Terminal fill failure — the slot serves 503 until the relay rebuilds. */
  failedReason?: string;
}

interface IsolatedCctvDecryptResult {
  body: Buffer;
  diagnostics: CctvDecryptDiagnostics;
}

const CCTV_DECRYPT_WORKER_SOURCE = `
const { parentPort, workerData } = require("worker_threads");
(async () => {
  const decryptor = require(workerData.modulePath);
  let diagnostics;
  const body = decryptor.decryptCctvSegment(
    Buffer.from(workerData.body),
    (value) => { diagnostics = value; }
  );
  parentPort.postMessage({ body, diagnostics });
})().catch((error) => {
  parentPort.postMessage({
    error: error && (error.stack || error.message) || String(error),
  });
});
`;

/**
 * Run the synchronous decryptor in a disposable worker. The transform is
 * pure JS now (the third-party WASM is no longer involved), but keeping the
 * ~1 MB per-segment work off the bridge event loop preserves timers,
 * retries, error messages, and server startup responsiveness. The returned
 * body may be longer than the input (decrypted PES frames are re-packetized
 * with inserted TS packets); callers must use result.body.length.
 */
function decryptCctvSegmentIsolated(
  input: Buffer,
  timeoutMs: number
): Promise<IsolatedCctvDecryptResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CCTV_DECRYPT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        modulePath: path.join(__dirname, "cctvDecrypt.js"),
        body: Buffer.from(input),
      },
    });
    let settled = false;
    const finish = (error?: Error, value?: IsolatedCctvDecryptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const timeout = setTimeout(
      () => finish(new Error(`CCTV decrypt timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timeout.unref?.();
    worker.once("message", (message) => {
      if (message?.error) {
        finish(new Error(String(message.error)));
        return;
      }
      if (!message?.body || !message?.diagnostics) {
        finish(new Error("CCTV decrypt worker returned an invalid result"));
        return;
      }
      finish(undefined, {
        body: Buffer.from(message.body),
        diagnostics: message.diagnostics as CctvDecryptDiagnostics,
      });
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`CCTV decrypt worker exited with code ${code}`));
      }
    });
  });
}

/**
 * Resolve the system ffmpeg binary (dash remux + segment validation). Unlike
 * the dash-remux resolution there is deliberately NO bare-"ffmpeg" PATH
 * fallback here: validation must know for certain whether ffmpeg exists, so
 * "not installed" can disable validation instead of failing every segment.
 */
let resolvedFfmpegPath: string | undefined | null = null;
function resolveFfmpegPath(): string | undefined {
  if (resolvedFfmpegPath === null) {
    resolvedFfmpegPath = [
      process.env.FX_CAST_BILIBILI_FFMPEG,
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg",
    ].find((candidate) => candidate && fs.existsSync(candidate));
  }
  return resolvedFfmpegPath;
}

/** Bound the full-decode validation of one ~1 MB segment. */
const FFMPEG_VALIDATE_TIMEOUT_MS = 5_000;
/** Multi-segment validations (prebuffer chain, backfill) need more headroom. */
const FFMPEG_AGGREGATE_VALIDATE_TIMEOUT_MS = 15_000;

/**
 * Full-decode-validate a decrypted CCTV segment BEFORE it may be served to
 * the receiver: pipe it through `ffmpeg -xerror`, which turns ANY decoder
 * error into a nonzero exit. This is the hard gate that keeps a segment the
 * decrypt diagnostics still accept (right PIDs, right PES counts) but whose
 * H.264 payload is undecodable — corrupt upstream bytes, truncated CDN read,
 * transform mismatch — from reaching the receiver, where one bad segment
 * fataly ends the media session (observed: receiver aborts its in-flight
 * request, goes IDLE, and the cast dies).
 *
 * Measured on real CCTV cctv5 segments: a healthy decrypted segment decodes
 * in ~70 ms with a silent stderr and exit 0; encrypted or corrupted data
 * exits nonzero with H.264 errors within the first frames. Deterministically
 * bad segments DO occur on the CDN (re-download returns identical bytes), so
 * callers must drop the segment, not retry it forever.
 *
 * Returns:
 *   { ok: true }            — decodes cleanly (exit 0, empty error stderr)
 *   { ok: false, detail }   — decode errors detected (or timeout → invalid);
 *                             detail is the first ffmpeg error line
 *   undefined               — ffmpeg unavailable; validation is hardening,
 *                             not a hard requirement, so callers serve on
 *                             decrypt diagnostics alone (the behavior before
 *                             this gate existed).
 */
function ffmpegSegmentDecodesCleanly(
  body: Buffer,
  timeoutMs = FFMPEG_VALIDATE_TIMEOUT_MS
): Promise<
  { ok: boolean; detail?: string; durationSeconds?: number } | undefined
> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      // MPEG-TS is self-describing, so the segment can be probed straight
      // from stdin — no temp file per segment.
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        "pipe:0",
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-8000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, detail: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    const finish = (result: {
      ok: boolean;
      detail?: string;
      durationSeconds?: number;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.on("error", (err) => finish({ ok: false, detail: err.message }));
    child.on("close", (code) => {
      if (code === 0 && stderr.trim() === "") {
        const durationValues = Array.from(
          stdout.matchAll(/^out_time_(?:us|ms)=(\d+)$/gm)
        )
          .map((match) => Number(match[1]))
          .filter(Number.isFinite);
        const durationMicros = durationValues[durationValues.length - 1];
        finish({
          ok: true,
          durationSeconds:
            durationMicros === undefined ? undefined : durationMicros / 1_000_000,
        });
        return;
      }
      finish({
        ok: false,
        detail:
          stderr.split("\n").find((line) => line.trim())?.slice(0, 200) ??
          `ffmpeg exit ${code}`,
      });
    });
    // A failing validation makes ffmpeg exit BEFORE consuming all of stdin;
    // the pending write then fails with EPIPE. Without a listener that error
    // surfaces as an uncaught exception and takes the whole bridge process
    // down. The verdict comes from the exit code and stderr, so swallow it.
    child.stdin?.on("error", () => {
      // EPIPE when the worker exits early — the exit code carries the verdict.
    });
    child.stdin?.end(body);
  });
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function countChangedBytes(before: Buffer, after: Buffer): number {
  const length = Math.min(before.length, after.length);
  let changed = Math.abs(before.length - after.length);
  for (let i = 0; i < length; i++) {
    if (before[i] !== after[i]) changed++;
  }
  return changed;
}

/** Park/probe cadence while waiting on the page download watermark. */
const PAGE_WATERMARK_POLL_INTERVAL_MS = 2000;
/**
 * A future segment may return HTTP 200 while the CDN is still appending bytes
 * (cdnFutureMode only). Do not accept it until after its predicted publish
 * time plus this margin, then require two consecutive identical downloads.
 */
const FUTURE_SEGMENT_SETTLE_MARGIN_MS = 1000;
const FUTURE_SEGMENT_STABILITY_INTERVAL_MS = 1000;
/** Segment pipeline: prefetch workers, retry budgets, cache caps. */
const PIPELINE_WORKERS = 4;
const PIPELINE_FETCH_TIMEOUT_MS = 15_000;
const PIPELINE_FETCH_ATTEMPTS = 3;
const PIPELINE_DECRYPT_TIMEOUT_MS = 10_000;
/** How long a receiver /seg request may wait for its slot to fill. */
const PIPELINE_SLOT_SERVE_WAIT_MS = 60_000;
/**
 * Advance cap for one direct fill past its identity sequence. Generous on
 * purpose: a head of ~0.2s short fragments needs ~20 members to mature into
 * one slot; a tighter cap permanently 503s those slots.
 */
const PIPELINE_DIRECT_FILL_MAX_ADVANCE = 32;
/** Unusable-sequence streak that pauses the pool (CDN-wide breakage). */
const PIPELINE_SKIP_STREAK = 8;
const PIPELINE_SKIP_PAUSE_MS = 15_000;
/** Slot bodies kept behind the receiver (seek-back runway), in slots. */
const CACHE_KEEP_BEHIND_SLOTS = 120;
const CACHE_SWEEP_INTERVAL_MS = 30_000;
const CACHE_BYTES_CAP = 256 * 1024 * 1024;
/** Bounded FIFO size for non-slot URIs (EXT-X-KEY / EXT-X-MAP bytes). */
const PASSTHROUGH_CACHE_ENTRIES = 32;

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function startLiveHlsRelayServer(
  messaging: Messenger,
  requestId: string,
  playlistUrl: string,
  referer: string,
  port: number,
  userAgent?: string,
  cctvDebugEnabled = false
) {
  // CCTV live CDNs (kcdnvip / volcfcdn) enforce anti-hotlink referer
  // checking: playlist/segment requests without a tv.cctv.com Referer are
  // rejected (or stalled), which makes the receiver buffer forever. Mirror
  // the browser's request headers on every upstream fetch. The User-Agent is
  // the real Chrome UA resolved by the extension from docs/ua.json (some
  // CDNs throttle/serve degraded edges to an unrecognized UA); fall back to a
  // generic token only if the extension didn't supply one.
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": userAgent || "Mozilla/5.0",
  };
  // Relay messages always travel to the extension because selected events
  // drive liveness and recovery. Verbose bridge stderr is independently gated.
  const relayLog = (event: string, data: Record<string, unknown> = {}) => {
    if (cctvDebugEnabled) {
      console.error(`[fx_cast_bilibili] ${event}`, { requestId, ...data });
    }
    messaging.sendMessage({
      subject: "mediaCast:relayDebug",
      data: { requestId, event, ...data },
    });
  };
  relayLog("live relay starting", {
    seedHost: (() => {
      try {
        return new URL(playlistUrl).hostname;
      } catch {
        return "invalid";
      }
    })(),
    referer,
    userAgent: upstreamHeaders["User-Agent"],
    port,
  });
  // Invalidate any previous relay's prefetch pool (see liveRelayGeneration).
  const relayGeneration = ++liveRelayGeneration;
  if (referer) {
    upstreamHeaders.Referer = referer;
    try {
      upstreamHeaders.Origin = new URL(referer).origin;
    } catch {
      /* referer not a valid URL: send Referer only */
    }
  }
  // Per-session transitive trust, seeded with the captured playlist URL. No
  // hardcoded CDN suffix list: CCTV rotates live HLS across many CDNs, so we
  // trust the seed (captured from real tab traffic) plus whatever hosts its
  // playlists reference. Seed must be https + non-private.
  const trust = new LiveRelayTrust();
  if (!trust.seed(playlistUrl)) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: {
        requestId,
        message: `Refusing to relay live URL: ${playlistUrl}`,
      },
    });
    return;
  }
  // Cleanly disconnect any previous media server BEFORE preparing the new
  // relay — the same first-action ordering as the DASH remux path
  // (startDashRemuxServer) and the Bilibili channel-change flow. A recovery
  // rebuild must not keep the old relay (and its segment cache) alive while
  // the new one is prepared, and an early failure (playlist fetch / DVR
  // build / prebuffer) must not leave the old server orphaned: the next
  // start then begins from a guaranteed-clean slate.
  await stopMediaServer();
  mediaServerRequestId = requestId;
  let initialPlaylist: Response;
  try {
    initialPlaylist = await fetchRemoteMedia(
      playlistUrl,
      { cache: "no-store", headers: upstreamHeaders },
      (u) => trust.allows(u)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    relayLog("initial CCTV playlist fetch FAILED", {
      host: new URL(playlistUrl).hostname,
      error: message,
    });
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: `CCTV playlist fetch failed: ${message}` },
    });
    return;
  }
  relayLog("initial CCTV playlist response", {
    host: new URL(initialPlaylist.url || playlistUrl).hostname,
    status: initialPlaylist.status,
  });
  if (!initialPlaylist.ok) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: `CCTV playlist HTTP ${initialPlaylist.status}` },
    });
    return;
  }
  relayLog("debug before initial playlist body read", {
    contentLength: initialPlaylist.headers.get("content-length"),
    contentType: initialPlaylist.headers.get("content-type"),
    contentEncoding: initialPlaylist.headers.get("content-encoding"),
  });

  let lastUpstreamPlaylist: string;
  try {
    lastUpstreamPlaylist = await initialPlaylist.text();
  } catch (err) {
    relayLog("debug initial playlist body read FAILED", {
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    });
    throw err;
  }

  relayLog("debug after initial playlist body read", {
    chars: lastUpstreamPlaylist.length,
    bytes: Buffer.byteLength(lastUpstreamPlaylist),
    startsWithExtm3u: lastUpstreamPlaylist.trimStart().startsWith("#EXTM3U"),
    lineCount: lastUpstreamPlaylist.split("\n").length,
  });

  relayLog("debug before synthetic DVR build");
  // Recovery continuation: if a previous relay for this same stream already
  // served segments, the new window (and its prebuffer) starts right after
  // the last served sequence. First cast: no continuation, full lookback.
  // Stale continuation (nothing served within the max age) is a brand-new
  // cast of the same seed and re-bootstraps instead of resuming.
  const previousContinuation = liveRelayContinuation;
  const continuationAlive =
    previousContinuation?.seedUrl === playlistUrl &&
    previousContinuation.bootstrapThroughSequence !== undefined &&
    previousContinuation.lastConsumedUpstreamSequence !== undefined &&
    (previousContinuation.lastServedAtMs ?? 0) >=
      Date.now() - LIVE_RELAY_CONTINUATION_MAX_AGE_MS;
  const resumeAfterSequence = continuationAlive
    ? previousContinuation!.lastConsumedUpstreamSequence
    : undefined;
  // Computed here (not at its later first use) because the near-edge resume
  // rewind below depends on it: only cdnFutureMode relays poll the CDN for
  // unpublished future segments, and that polling is exactly what stalls a
  // near-edge recovery prebuffer past the sender's start timeout.
  const cdnFutureMode = /cdrmld/i.test(playlistUrl);
  if (resumeAfterSequence !== undefined) {
    relayLog("CCTV relay continuation: resuming after served segment", {
      resumeAfterSequence,
      bootstrapThroughSequence: previousContinuation!.bootstrapThroughSequence,
    });
  } else if (previousContinuation?.seedUrl === playlistUrl) {
    relayLog("CCTV relay continuation stale; bootstrapping fresh", {
      lastServedAtMs: previousContinuation.lastServedAtMs,
    });
  }
  const buildDvr = (resumeAfter: number | undefined) => {
    try {
      return buildSyntheticDvrPlaylist(
        lastUpstreamPlaylist,
        playlistUrl,
        trust,
        resumeAfter
      );
    } catch (err) {
      relayLog("debug synthetic DVR build FAILED", {
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      throw err;
    }
  };
  // The resume point actually used. A cdnFutureMode continuation that lands
  // at/near the live edge is REWOUND (below) by just enough to fill the boot
  // prebuffer, so this can end up earlier than the last-served sequence.
  let effectiveResumeAfter = resumeAfterSequence;
  let dvr: SyntheticDvrPlaylist | undefined = buildDvr(effectiveResumeAfter);
  // ---- near-live-edge resume rewind (root-cause fix) ----
  // In cdnFutureMode a continuation window starts right after the last served
  // sequence. If the previous relay served up to (or near) the live edge, the
  // resume point leaves too few ALREADY-PUBLISHED segments to fill the boot
  // prebuffer, so its head slots are future segments the pipeline can only get
  // by polling the CDN one publish-cadence at a time. Filling ~60s of prebuffer
  // that way runs past the sender's waitForMediaServer timeout ("Timed out
  // waiting for the Cast bridge media server") and the cast dies.
  //
  // Rather than discarding the continuation and rebuilding the whole ~120s
  // historical window (which replays far more already-seen content than
  // needed), rewind the resume point by EXACTLY the prebuffer deficit: move it
  // back to anchor - prebufferNeed so the prebuffer sits entirely on published
  // segments (fills from the CDN immediately, no future polling) while
  // replaying the minimum number of segments. This stays a continuation — the
  // page-capture cache, supply boundary and continuation freshness are all
  // preserved; only the resume cursor slides back a few segments.
  if (
    dvr &&
    continuationAlive &&
    cdnFutureMode &&
    effectiveResumeAfter !== undefined
  ) {
    const prebufferNeed = Math.max(
      1,
      Math.round(INITIAL_PREBUFFER_SECONDS / dvr.stepSeconds)
    );
    // Already-published segments available after the resume point.
    const publishedHistory = dvr.anchorSequence - dvr.firstSequence + 1;
    if (publishedHistory < prebufferNeed) {
      // Slide the resume cursor back just enough that prebufferNeed published
      // segments precede the live edge. This is strictly a rewind: since
      // publishedHistory < prebufferNeed we have
      // anchor - prebufferNeed < resumeAfter, so it never advances. And
      // prebufferNeed (60s) <= the historical window (120s), so the rewound
      // point stays within the lookback a fresh cast would use.
      const rewoundResumeAfter = dvr.anchorSequence - prebufferNeed;
      const rewound = buildDvr(rewoundResumeAfter);
      if (rewound) {
        relayLog(
          "CCTV relay continuation near live edge; rewinding resume to fill prebuffer",
          {
            originalResumeAfter: effectiveResumeAfter,
            rewoundResumeAfter,
            replayedSegments: effectiveResumeAfter - rewoundResumeAfter,
            anchorSequence: dvr.anchorSequence,
            publishedHistoryBefore: publishedHistory,
            prebufferNeed,
            stepSeconds: dvr.stepSeconds,
          }
        );
        dvr = rewound;
        effectiveResumeAfter = rewoundResumeAfter;
      }
    }
  }
  relayLog("debug after synthetic DVR build", {
    synthetic: Boolean(dvr),
    segmentCount: dvr?.segmentCount,
    stepSeconds: dvr?.stepSeconds,
  });
  if (!dvr) {
    const message =
      "CCTV synthetic DVR synthesis failed: unsupported or irregular segment sequence";
    relayLog("synthetic DVR playlist construction FAILED", {
      playlistHost: new URL(playlistUrl).hostname,
      upstreamBytes: Buffer.byteLength(lastUpstreamPlaylist),
      segmentUris: lastUpstreamPlaylist
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .slice(0, 8),
    });
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message },
    });
    throw new Error(message);
  }
  // This relay now owns the continuation state for this seed; successful /seg
  // responses advance the actual upstream cursor from the resume point. A
  // fresh bootstrap resets the page capture cache: its contents belonged to
  // the previous cast's window, and the new frontier starts at this relay's
  // own anchor.
  const bootstrapThroughSequence = continuationAlive
    ? previousContinuation!.bootstrapThroughSequence!
    : dvr.anchorSequence;
  if (!continuationAlive) {
    livePageCache = new Map();
    livePageCacheBytes = 0;
    livePageCacheFrontier = 0;
    livePageCacheIngestCount = 0;
  }
  relayLog("CCTV relay supply boundary", {
    bootstrapThroughSequence,
    resumed: effectiveResumeAfter !== undefined,
    resumeRewound:
      effectiveResumeAfter !== undefined &&
      effectiveResumeAfter !== resumeAfterSequence,
    pageCacheSequences: livePageCache.size,
  });
  liveRelayContinuation = {
    seedUrl: playlistUrl,
    lastConsumedUpstreamSequence: effectiveResumeAfter,
    bootstrapThroughSequence,
    lastServedAtMs: continuationAlive
      ? previousContinuation!.lastServedAtMs
      : undefined,
  };

  // The served playlist is IMMUTABLE from here on: the receiver's timeline
  // is derived from these exact bytes, and every upstream failure
  // (unfetchable, undecryptable, ffmpeg-invalid sequence) is absorbed by
  // the slot mapping layer below instead of a playlist rewrite.
  let servedPlaylist = dvr.playlist;
  const lastServedPlaylist = servedPlaylist;
  relayLog("synthetic DVR playlist constructed", {
    synthetic: true,
    upstreamBytes: Buffer.byteLength(lastUpstreamPlaylist),
    servedBytes: Buffer.byteLength(servedPlaylist),
    mediaSequence: servedPlaylist.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1],
    segmentCount: dvr?.segmentCount,
    stepSeconds: dvr?.stepSeconds,
    historySeconds: dvr?.liveEdgeBaseSeconds,
    totalDurationSeconds: dvr?.totalDurationSeconds,
    liveEdgeBaseSeconds: dvr?.liveEdgeBaseSeconds,
    head: servedPlaylist.split("\n").slice(0, 12).join("\n"),
    tail: servedPlaylist.split("\n").slice(-8).join("\n"),
  });

  // ---- Segment pipeline: caching decoupled from playback ----
  //
  // The receiver is only ever served bytes that already sit in the slot
  // cache: fetched, decrypted and ffmpeg-validated BEFORE its request
  // arrives. Supply is watermark-gated: the pool probes the synthesized
  // window sequence by sequence, but past the bootstrap frontier nothing is
  // probed beyond the page player's download watermark, and those bytes come
  // from the page capture cache instead of the CDN. Every standalone-valid
  // sequence occupies exactly one slot in order; a decrypt-invalid sequence
  // is discarded and its slot maps to the next good sequence. That is the
  // frozen-playlist equivalent of the old "drop the entry" window
  // adjustment: the receiver's timeline is untouched, content skips forward
  // past the bad seconds, and the served playlist never changes.
  const prebufferStartedAt = Date.now();
  // `dvr` is a `let` narrowed by the guard above; closures below cannot
  // keep that narrowing, so bind it once.
  const plan = dvr;
  const totalSlots = plan.segmentCount;
  let windowEndSequence = plan.firstSequence + totalSlots;
  /** Slots the boot prebuffer must fill before the relay advertises ready. */
  const requestedPrebufferSlotCount = Math.max(
    1,
    Math.round(INITIAL_PREBUFFER_SECONDS / plan.stepSeconds)
  );
  // `let`, not `const`: in cdnFutureMode the boot prebuffer never fetches past
  // the live edge, so if bad published segments leave the runway short it is
  // finalized (below) at the number of slots actually filled from published
  // history rather than chasing incomplete future segments.
  let prebufferSlotCount = Math.min(
    requestedPrebufferSlotCount,
    effectiveResumeAfter !== undefined
      ? totalSlots
      : plan.anchorSequence - plan.firstSequence + 1
  );
  const slots: Array<SlotState | undefined> = new Array(totalSlots);
  /** Fetched sequences awaiting in-order slot assignment. */
  const settled = new Map<
    number,
    PipelineFetchResult | { error: string }
  >();
  let nextSequence = plan.firstSequence;
  let nextAssignSequence = plan.firstSequence;
  let nextSlot = 0;
  let consecutiveUnusable = 0;
  let cacheBytes = 0;
  /** Highest slot index actually served to the receiver (eviction anchor). */
  let receiverSlot = -1;
  /** Actual target sequence served after the receiver has left prebuffer. */
  let lastSteadyStateServedSequence: number | undefined;
  let pipelineStopped = false;
  // Wakes every parked sleepAbortable() the instant this relay is torn down or
  // replaced. Without it those sleeps only notice teardown AFTER napping the
  // full poll/stability interval (then re-checking pipelineAlive()), so a
  // recovery rebuild / channel or quality switch / stop leaves up to ~2s of
  // dead waits and can fire one more upstream CDN fetch per parked worker.
  const pipelineAbort = new AbortController();
  const pipelineAlive = () =>
    !pipelineStopped && relayGeneration === liveRelayGeneration;
  /** Mark the pipeline stopped AND wake every abortable sleep at once. */
  const stopPipeline = () => {
    pipelineStopped = true;
    if (!pipelineAbort.signal.aborted) pipelineAbort.abort();
  };

  /**
   * cdrmld-seeded relays serve channels whose page playback uses the enc1/AV1
   * tree, so page captures never match the relay's variant and there is no
   * page supply: future sequences are fetched from the CDN with publish-time
   * polling (the legacy behavior). Same-tree channels use the page-capture
   * watermark instead. (cdnFutureMode is computed earlier — before the DVR
   * build — because the near-live-edge resume rewind needs it.)
   */

  /**
   * Probe admission — NOTHING past the page's download progress is ever
   * probed (a segment the page has not reached yet is not necessarily
   * finished on the CDN, and fetching it half-written is exactly the
   * future-segment corruption this pipeline exists to avoid).
   *
   * - Same-tree channels: the page downloads the relay's own variant, so the
   *   highest accepted ingest sequence is the watermark.
   * - cdrmld-seeded channels (page plays the enc1/AV1 tree): the trees
   *   differ, so the bound is wall-clock — a sequence is probeable once its
   *   publish window has fully passed the latest page download time.
   * - Sequences at or before the bootstrap frontier are published history
   *   (the page played them long before capture started): always probeable
   *   from the CDN.
   */
  const pageAdmitsSequence = (sequence: number): boolean => {
    if (sequence <= bootstrapThroughSequence) return true;
    if (cdnFutureMode) {
      return (
        plan.builtAtMs +
          (sequence - plan.anchorSequence + 1) * plan.stepSeconds * 1000 <=
        livePageProgressMs
      );
    }
    return sequence <= livePageCacheFrontier;
  };

  const fetchWithTimeout = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PIPELINE_FETCH_TIMEOUT_MS
    );
    timeout.unref?.();
    try {
      return await fetchRemoteMedia(
        url,
        {
          cache: "no-store",
          headers: upstreamHeaders,
          signal: controller.signal,
        },
        (u) => trust.allows(u)
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  /**
   * Page-captured supply: past the bootstrap frontier the pipeline's ONLY
   * source is the extension's page TS capture (the page player's own bytes,
   * complete by construction — no publish polling, no stability probing).
   * The wait is bounded; a timeout surfaces as a fetch error and the sequence
   * is skipped by the same discard path as a corrupt segment. There is
   * deliberately no CDN fallback here: silently re-entering the suspect
   * future-fetch path would defeat the whole boundary.
   */
  const waitForPageCapturedSegment = async (
    sequence: number
  ): Promise<{ body: Buffer; contentType: string }> => {
    const deadlineMs = Date.now() + PAGE_CACHE_WAIT_TIMEOUT_MS;
    let loggedWait = false;
    while (pipelineAlive()) {
      const captured = livePageCache.get(sequence);
      if (captured) {
        if (loggedWait) {
          relayLog("pipeline page cache hit after wait", {
            sequence,
            bytes: captured.body.length,
            elapsedMs: PAGE_CACHE_WAIT_TIMEOUT_MS - (deadlineMs - Date.now()),
          });
        }
        return { body: captured.body, contentType: "video/mp2t" };
      }
      if (!loggedWait) {
        loggedWait = true;
        relayLog("pipeline waiting for page capture", {
          sequence,
          url: plan.urlOf(sequence),
          pageCacheFrontier: livePageCacheFrontier,
          ingestCount: livePageCacheIngestCount,
        });
      }
      if (Date.now() >= deadlineMs) break;
      await sleepAbortable(
        PAGE_WATERMARK_POLL_INTERVAL_MS,
        pipelineAbort.signal
      );
    }
    if (!pipelineAlive()) throw new Error("relay replaced");
    throw new Error(
      `page capture did not supply sequence ${sequence} within ${PAGE_CACHE_WAIT_TIMEOUT_MS}ms`
    );
  };

  /**
   * Download one upstream sequence (network path). Transient errors get
   * bounded retries.
   *
   * Ownership boundary (sequence-based, set by the FIRST DVR build of the
   * cast and inherited by recovery relays): sequences at or before the
   * bootstrap frontier are published history and come from the network; every
   * sequence past it must come from the page capture cache (the page-download
   * watermark admits nothing else). `historical` forces the network path for
   * already-published sequences whose cache entry is gone (seek-back
   * backfill) — it never serves the live frontier.
   */
  const fetchStableSegment = async (
    sequence: number,
    historical = false
  ): Promise<{ body: Buffer; contentType: string }> => {
    if (!historical && !cdnFutureMode && sequence > bootstrapThroughSequence) {
      return await waitForPageCapturedSegment(sequence);
    }
    const url = plan.urlOf(sequence);
    // Publish-time polling only exists in cdnFutureMode: without page supply,
    // future sequences must be waited out on the CDN (an HTTP 200 there does
    // not mean the object is complete).
    const isFuture = cdnFutureMode && sequence > plan.anchorSequence;
    const expectedPublishMs = isFuture
      ? plan.builtAtMs +
        (sequence - plan.anchorSequence) * plan.stepSeconds * 1000
      : 0;
    const stableAfterMs = expectedPublishMs + FUTURE_SEGMENT_SETTLE_MARGIN_MS;
    let lastError = "";
    for (let attempt = 1; attempt <= PIPELINE_FETCH_ATTEMPTS; attempt++) {
      try {
        let response = await fetchWithTimeout(url);
        if (isFuture) {
          let previousBody: Buffer | undefined;
          let previousHash = "";
          let pollingLogged = false;
          while (pipelineAlive()) {
            if (response.status === 404 || response.status === 403) {
              if (!pollingLogged) {
                relayLog("pipeline future segment polling", {
                  sequence,
                  status: response.status,
                  publishInMs: Math.round(expectedPublishMs - Date.now()),
                });
                pollingLogged = true;
              }
              void response.body?.cancel().catch(() => undefined);
              await sleepAbortable(
                PAGE_WATERMARK_POLL_INTERVAL_MS,
                pipelineAbort.signal
              );
              if (!pipelineAlive()) break;
              response = await fetchWithTimeout(url);
              continue;
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (Date.now() < stableAfterMs) {
              void response.body?.cancel().catch(() => undefined);
              await sleepAbortable(
                Math.min(
                  PAGE_WATERMARK_POLL_INTERVAL_MS,
                  Math.max(1, stableAfterMs - Date.now())
                ),
                pipelineAbort.signal
              );
              if (!pipelineAlive()) break;
              response = await fetchWithTimeout(url);
              continue;
            }
            const body = Buffer.from(await response.arrayBuffer());
            if (body.length < 188) {
              throw new Error(`short body: ${body.length} bytes`);
            }
            const bodyHash = sha256(body);
            if (
              previousBody &&
              previousBody.length === body.length &&
              previousHash === bodyHash
            ) {
              return {
                body,
                contentType:
                  response.headers.get("content-type") || "video/mp2t",
              };
            }
            relayLog("pipeline future segment stabilizing", {
              sequence,
              bytes: body.length,
              changed: previousBody !== undefined,
            });
            previousBody = body;
            previousHash = bodyHash;
            await sleepAbortable(
              FUTURE_SEGMENT_STABILITY_INTERVAL_MS,
              pipelineAbort.signal
            );
            if (!pipelineAlive()) break;
            response = await fetchWithTimeout(url);
          }
          throw new Error("relay replaced");
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length < 188) {
          throw new Error(`short body: ${body.length} bytes`);
        }
        return {
          body,
          contentType: response.headers.get("content-type") || "video/mp2t",
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // A replaced relay may still have an in-flight fetch complete. Drop it
        // silently: it must not pollute the active relay's diagnostics/state.
        if (!pipelineAlive()) break;
        relayLog("pipeline fetch attempt failed", {
          sequence,
          attempt,
          error: lastError,
        });
        if (!pipelineAlive()) break;
        if (attempt < PIPELINE_FETCH_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    throw new Error(lastError || "fetch failed");
  };

  /**
   * Record a segment URL only when its stable content is actually discarded.
   */
  const logFailedSegmentUrl = (sequence: number): void => {
    relayLog("pipeline failed segment URL", {
      sequence,
      url: plan.urlOf(sequence),
    });
  };

  /** Decrypt and validate one already-stable segment exactly once. */
  const classifyStableSegment = async (
    sequence: number,
    fetched: { body: Buffer; contentType: string }
  ): Promise<PipelineFetchResult> => {
    const encryptedSnapshot = Buffer.from(fetched.body);
    const startedAt = Date.now();
    try {
      const result = await decryptCctvSegmentIsolated(
        encryptedSnapshot,
        PIPELINE_DECRYPT_TIMEOUT_MS
      );
      const changedBytes = countChangedBytes(encryptedSnapshot, result.body);
      // No known CCTV live delivery ships EXT-X-KEY/EXT-X-MAP (AES-128 HLS):
      // every relayed URI is a CNTV-transform segment, so anything the
      // decryptor cannot transform — no video PID, no decryptable slices, no
      // changed bytes — is a failed segment: the slot mapping simply skips
      // it.
      if (
        result.diagnostics.videoPid < 0 ||
        result.diagnostics.sliceNalCount <= 0 ||
        result.diagnostics.transformedPesCount <= 0 ||
        changedBytes <= 0
      ) {
        throw new Error(
          `invalid decrypt result: videoPid=${result.diagnostics.videoPid}, slices=${result.diagnostics.sliceNalCount}, transformedPES=${result.diagnostics.transformedPesCount}, changed=${changedBytes}`
        );
      }
      // Hard gate before the bytes may enter the slot cache: a full
      // ffmpeg decode must be error-free (see ffmpegSegmentDecodesCleanly).
      // A diagnostics-valid but undecodable segment is exactly what
      // fatally kills the receiver's media session mid-playback.
      const validation = await ffmpegSegmentDecodesCleanly(result.body);
      if (validation && !validation.ok) {
        throw new Error(
          `ffmpeg decode validation failed: ${validation.detail ?? "unknown"}`
        );
      }
      if (!pipelineAlive()) throw new Error("relay replaced");
      relayLog("pipeline segment ready", {
        sequence,
        bytes: result.body.length,
        changedBytes,
        videoPid: result.diagnostics.videoPid,
        pesCount: result.diagnostics.pesCount,
        transformedPesCount: result.diagnostics.transformedPesCount,
        skippedIncompletePesCount: result.diagnostics.skippedIncompletePesCount,
        sliceNalCount: result.diagnostics.sliceNalCount,
        idrNalCount: result.diagnostics.idrNalCount,
        ffmpegValidated: validation?.ok === true,
        decodedDurationSeconds: validation?.durationSeconds,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        body: result.body,
        contentType: fetched.contentType,
        durationSeconds: validation?.durationSeconds,
        encryptedBody: encryptedSnapshot,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      relayLog("pipeline standalone segment failed", {
        sequence,
        error: message,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        contentType: fetched.contentType,
        encryptedBody: encryptedSnapshot,
        standaloneFailed: true,
      };
    }
  };

  /**
   * Run the stable-fetch stage once, then classify its immutable result.
   * `historical` forces the network path (see fetchStableSegment) — used only
   * by the backfill of already-played slots whose page-captured bytes were
   * evicted; never by the live production path.
   */
  const fetchClassifiedSequence = async (
    sequence: number,
    historical = false
  ): Promise<
    PipelineFetchResult | { error: string }
  > => {
    try {
      const stable = await fetchStableSegment(sequence, historical);
      return await classifyStableSegment(sequence, stable);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `fetch failed: ${message}` };
    }
  };

  const storeSlotBody = (
    slotIndex: number,
    sequence: number,
    body: Buffer,
    contentType: string,
    options: {
      durationSeconds?: number;
      consumedThroughSequence?: number;
      memberSequences?: number[];
    } = {}
  ) => {
    const {
      durationSeconds,
      consumedThroughSequence = sequence,
      memberSequences = [sequence],
    } = options;
    const slot =
      slots[slotIndex] ??
      (slots[slotIndex] = {
        targetSequence: sequence,
        consumedThroughSequence,
        targetUrl: plan.urlOf(sequence),
      });
    if (slot.body) cacheBytes -= slot.body.length;
    // Preserve object identity: ensureSlot waiters hold this SlotState while a
    // direct fill/backfill runs. Replacing slots[slotIndex] would leave those
    // waiters looking at a body-less placeholder even though the canonical
    // slot became ready, causing a false 503 exactly when the fill completed.
    slot.targetSequence = sequence;
    slot.consumedThroughSequence = consumedThroughSequence;
    slot.memberSequences = memberSequences;
    slot.targetUrl = plan.urlOf(sequence);
    slot.body = body;
    slot.contentType = contentType;
    slot.durationSeconds = durationSeconds;
    slot.failedReason = undefined;
    cacheBytes += body.length;
  };

  /** A sequence whose standalone decrypt + ffmpeg validation both passed. */
  const isSingleValid = (result: PipelineFetchResult): boolean =>
    result.standaloneFailed !== true && result.body !== undefined;

  /**
   * Commit policy (simplified experiment): a standalone-valid sequence
   * occupies exactly one slot; a standalone-invalid sequence is discarded and
   * the slot mapping skips its content (the served playlist is frozen — a
   * discard is a content jump, never a rewrite). Deliberately NO aggregation,
   * NO lookahead and NO span absorption: invalid bytes are dropped outright,
   * the receiver's continuous decode tolerates the resulting jumps, and the
   * skip rate itself is the experiment signal.
   */
  const commitOrDiscardSettled = (
    sequence: number,
    result: PipelineFetchResult
  ): void => {
    if (isSingleValid(result)) {
      storeSlotBody(
        nextSlot++,
        sequence,
        result.body!,
        result.contentType,
        {
          durationSeconds: result.durationSeconds,
          consumedThroughSequence: sequence,
          memberSequences: [sequence],
        }
      );
      relayLog("pipeline slot committed", {
        slot: nextSlot - 1,
        firstSequence: sequence,
        lastSequence: sequence,
        memberSequences: [sequence],
        segmentCount: 1,
        decryptMode: "standalone",
        decodedDurationSeconds: result.durationSeconds,
        bytes: result.body!.length,
      });
      return;
    }
    windowEndSequence++;
    logFailedSegmentUrl(sequence);
    relayLog("pipeline standalone-invalid sequence discarded", {
      sequence,
      slot: nextSlot,
    });
  };

  /**
   * Pop settled results in sequence order and run the commit pass. Passes
   * are serialized through flushChain: callers either schedule one
   * fire-and-forget (pool workers) or await their own pass (receiver lane,
   * direct fills, prebuffer wait).
   */
  const runFlushPass = async (): Promise<void> => {
    if (!pipelineAlive()) return;
    for (const pending of settled.keys()) {
      if (pending < nextAssignSequence) settled.delete(pending);
    }
    while (pipelineAlive()) {
      const settledResult = settled.get(nextAssignSequence);
      if (!settledResult) break;
      settled.delete(nextAssignSequence);
      const sequence = nextAssignSequence++;
      if ("error" in settledResult) {
        consecutiveUnusable++;
        windowEndSequence++;
        logFailedSegmentUrl(sequence);
        relayLog("pipeline sequence discarded; fetching one replacement", {
          sequence,
          slot: nextSlot,
          consecutiveUnusable,
          error: settledResult.error,
        });
        continue;
      }
      consecutiveUnusable = 0;
      commitOrDiscardSettled(sequence, settledResult);
    }
  };

  let flushChain: Promise<void> = Promise.resolve();
  const flushSettled = (): Promise<void> => {
    flushChain = flushChain.then(runFlushPass).catch((error) => {
      relayLog("pipeline flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return flushChain;
  };
  const scheduleFlush = (): void => {
    void flushSettled();
  };

  /**
   * Safety valve for the fetch frontier. The immutable playlist promises
   * totalSlots cached slots, and every upstream sequence consumed without
   * producing one — a discard — must be replaced by one more upstream
   * sequence. This valve covers anything the discard paths miss, so the
   * pool can never dead-end at the old frontier while slots are still owed.
   */
  const advanceFetchFrontier = (): void => {
    if (nextSequence >= windowEndSequence && nextSlot < totalSlots) {
      windowEndSequence++;
      relayLog("pipeline fetch window stretched", {
        windowEndSequence,
        nextSequence,
        nextSlot,
        totalSlots,
      });
    }
  };

  // Receiver-priority lane. Normal workers may finish later sequences while
  // ordered assignment waits on one head sequence. A receiver request inside
  // already-assigned pool coverage drives that head independently instead of
  // launching an out-of-order direct fill or permanently poisoning the slot.
  let receiverPriorityLane: Promise<void> | undefined;
  const driveReceiverPriorityLane = (requestedSlot: number): Promise<void> => {
    if (receiverPriorityLane) return receiverPriorityLane;
    receiverPriorityLane = (async () => {
      relayLog("receiver priority lane starting", {
        requestedSlot,
        nextSlot,
        nextAssignSequence,
        nextSequence,
        settledSequences: [...settled.keys()].sort((a, b) => a - b),
      });
      while (pipelineAlive() && !slots[requestedSlot]?.body) {
        // A normal worker may have completed the head while this lane was
        // scheduled. Commit it first and only duplicate work when still blocked.
        await flushSettled();
        if (slots[requestedSlot]) break;
        const sequence = nextAssignSequence;
        advanceFetchFrontier();
        if (sequence >= windowEndSequence) break;
        if (!pageAdmitsSequence(sequence)) {
          // Beyond the page download watermark: yield — the pool fills this
          // slot once the page advances, and the receiver request 503s until
          // then.
          break;
        }
        const result = await fetchClassifiedSequence(sequence);
        if (!pipelineAlive()) break;
        // Do not overwrite a worker result that won the race.
        if (!settled.has(sequence)) settled.set(sequence, result);
      }
      relayLog("receiver priority lane finished", {
        requestedSlot,
        slotReady: Boolean(slots[requestedSlot]?.body),
        slotFailed: slots[requestedSlot]?.failedReason,
        nextSlot,
        nextAssignSequence,
        nextSequence,
      });
    })()
      .catch((error) => {
        // The lane is best-effort: a crash here must degrade to the caller's
        // not-ready placeholder (503) — never surface as an unhandled
        // rejection that would take the whole bridge process down.
        relayLog("receiver priority lane crashed", {
          requestedSlot,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        receiverPriorityLane = undefined;
      });
    return receiverPriorityLane;
  };

  const poolWorker = async (worker: number) => {
    while (pipelineAlive()) {
      if (consecutiveUnusable >= PIPELINE_SKIP_STREAK) {
        consecutiveUnusable = 0;
        relayLog("pipeline pausing after unusable streak", { worker });
        await sleepAbortable(
          PIPELINE_SKIP_PAUSE_MS,
          pipelineAbort.signal
        );
        if (!pipelineAlive()) return;
      }
      advanceFetchFrontier();
      const sequence = nextSequence;
      if (sequence >= windowEndSequence) return;
      // Boot prebuffer in cdnFutureMode must build the runway from ALREADY
      // PUBLISHED history only. A discarded (corrupt) published segment would
      // otherwise push this frontier past the live edge, where segments are
      // frequently still being written on the CDN — polling them stalls the
      // prebuffer and often returns more corrupt bytes (the exact "keeps
      // downloading bad segs at the edge" failure). Park until the relay is
      // ready instead of fetching forward into the edge; the boot wait below
      // finalizes the runway from whatever published history filled, and THIS
      // same worker resumes fetching the live edge once relayReady flips.
      if (!relayReady && cdnFutureMode && sequence > plan.anchorSequence) {
        await sleepAbortable(
          PAGE_WATERMARK_POLL_INTERVAL_MS,
          pipelineAbort.signal
        );
        continue;
      }
      if (!pageAdmitsSequence(sequence)) {
        // Beyond the page download progress: park — probing now would fetch
        // a half-written segment. The page advances the bound every time it
        // downloads its next live segment.
        await sleepAbortable(
          PAGE_WATERMARK_POLL_INTERVAL_MS,
          pipelineAbort.signal
        );
        continue;
      }
      nextSequence++;
      const result = await fetchClassifiedSequence(sequence);
      if (!pipelineAlive()) return;
      settled.set(sequence, result);
      scheduleFlush();
    }
  };

  /**
   * Directly fill an unassigned slot whose content the receiver wants NOW
   * (it jumped past the pool — e.g. a forward seek to the fetch frontier).
   * Same policy as the ordered pass: the first standalone-valid sequence
   * fills the slot; standalone-invalid sequences are skipped (content jump)
   * and fetch errors advance the probe — bounded by
   * PIPELINE_DIRECT_FILL_MAX_ADVANCE.
   */
  const fillUnassignedSlot = async (slotIndex: number, slot: SlotState) => {
    let sequence = plan.firstSequence + slotIndex;
    for (
      let advance = 0;
      advance <= PIPELINE_DIRECT_FILL_MAX_ADVANCE;
      advance++, sequence++
    ) {
      if (!pageAdmitsSequence(sequence)) {
        // Beyond the page download watermark: never probe. Drop the
        // placeholder so a later receiver retry re-probes after the page has
        // advanced the watermark.
        if (slots[slotIndex] === slot) slots[slotIndex] = undefined;
        relayLog("slot direct fill held behind page capture watermark", {
          slot: slotIndex,
          sequence,
          pageCacheFrontier: livePageCacheFrontier,
        });
        return;
      }
      const result = await fetchClassifiedSequence(sequence);
      if ("error" in result) {
        logFailedSegmentUrl(sequence);
        relayLog("slot direct fill attempt failed", {
          slot: slotIndex,
          sequence,
          advance,
          error: result.error,
        });
        continue;
      }
      if (!isSingleValid(result)) {
        logFailedSegmentUrl(sequence);
        relayLog("slot direct fill skipped standalone-invalid sequence", {
          slot: slotIndex,
          sequence,
          advance,
        });
        continue;
      }
      storeSlotBody(
        slotIndex,
        sequence,
        result.body!,
        result.contentType,
        {
          durationSeconds: result.durationSeconds,
          consumedThroughSequence: sequence,
          memberSequences: [sequence],
        }
      );
      relayLog("slot direct fill ready", {
        slot: slotIndex,
        firstSequence: sequence,
        lastSequence: sequence,
        memberSequences: [sequence],
        segmentCount: 1,
        decryptMode: "standalone",
        decodedDurationSeconds: result.durationSeconds,
        bytes: result.body!.length,
      });
      // Leap the fetch cursor past the consumed sequence (the for-loop
      // post-statement adds one more before its next iteration).
      sequence = sequence + 1;
      break;
    }
    if (!slot.body) {
      slot.failedReason = `no mature segment within +${PIPELINE_DIRECT_FILL_MAX_ADVANCE} sequences`;
      relayLog("slot direct fill gave up", {
        slot: slotIndex,
        reason: slot.failedReason,
      });
      return;
    }
    if (slotIndex >= nextSlot) {
      // Leap the pool past this slot. Commit whatever is already settled in
      // order first; the remainder — including any pending candidate — is
      // dropped: the jump skipped that content by definition.
      await flushSettled();
      nextAssignSequence = Math.max(nextAssignSequence, sequence);
      nextSequence = Math.max(nextSequence, sequence);
      nextSlot = Math.max(nextSlot, slotIndex + 1);
    }
  };

  /**
   * Refill an assigned slot whose body was evicted (seek back). The slot is
   * rebuilt from its recorded member sequence — re-fetching the stable
   * encrypted bytes over the network historical path, then decrypting and
   * re-validating. A committed slot's content is immutable: it is never
   * silently shortened or remapped.
   */
  const backfillSlot = async (slotIndex: number, slot: SlotState) => {
    const members = slot.memberSequences ?? [slot.targetSequence];
    const parts: Buffer[] = [];
    let contentType = "video/mp2t";
    for (const sequence of members) {
      // Backfill serves a sequence the receiver already played: published,
      // stable history. The page capture cache may have evicted it, so the
      // network historical path is used explicitly (it can never supply the
      // unpublished live frontier the pipeline consumes from page capture).
      const result = await fetchClassifiedSequence(sequence, true);
      if ("error" in result) {
        logFailedSegmentUrl(sequence);
        slot.failedReason = `slot backfill failed at sequence ${sequence}`;
        relayLog("slot backfill failed", {
          slot: slotIndex,
          memberSequences: members,
          failedSequence: sequence,
          error: result.error,
        });
        return;
      }
      parts.push(result.encryptedBody);
      contentType = result.contentType;
    }
    let body: Buffer;
    try {
      const decrypted = await decryptCctvSegmentIsolated(
        Buffer.concat(parts),
        PIPELINE_DECRYPT_TIMEOUT_MS
      );
      body = decrypted.body;
    } catch (error) {
      slot.failedReason = `slot backfill decrypt failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      relayLog("slot backfill failed", {
        slot: slotIndex,
        memberSequences: members,
        error: slot.failedReason,
      });
      return;
    }
    const validation = await ffmpegSegmentDecodesCleanly(
      body,
      FFMPEG_AGGREGATE_VALIDATE_TIMEOUT_MS
    );
    if (validation && !validation.ok) {
      slot.failedReason = `slot backfill validation failed: ${validation.detail ?? "unknown"}`;
      relayLog("slot backfill failed", {
        slot: slotIndex,
        memberSequences: members,
        error: slot.failedReason,
      });
      return;
    }
    storeSlotBody(slotIndex, slot.targetSequence, body, contentType, {
      durationSeconds: validation?.durationSeconds,
      consumedThroughSequence: slot.consumedThroughSequence,
      memberSequences: members,
    });
    relayLog("slot backfilled", {
      slot: slotIndex,
      memberSequences: members,
      segmentCount: parts.length,
      decodedDurationSeconds: validation?.durationSeconds,
      bytes: body.length,
    });
  };

  /**
   * Resolve a slot for serving: cache hit, in-flight fill, backfill of an
   * evicted body, or a direct fill when the receiver jumped past the pool.
   * NEVER proxies upstream bytes straight to the receiver.
   */
  const ensureSlot = (slotIndex: number): Promise<SlotState> => {
    const existing = slots[slotIndex];
    if (existing) {
      if (existing.body) return Promise.resolve(existing);
      if (!existing.fill && !existing.failedReason) {
        existing.fill = backfillSlot(slotIndex, existing).finally(() => {
          existing.fill = undefined;
        });
      }
      return (existing.fill ?? Promise.resolve()).then(
        () => slots[slotIndex] ?? existing
      );
    }
    const initialSequence = plan.firstSequence + slotIndex;
    // If workers have already claimed this sequence, the missing slot is an
    // ordered-commit backlog, not a seek outside pool coverage. Keep it on a
    // separate receiver-priority lane that advances the head in order.
    if (initialSequence < nextSequence) {
      return driveReceiverPriorityLane(slotIndex).then(() => {
        const ready = slots[slotIndex];
        if (ready) return ready;
        return {
          targetSequence: initialSequence,
          consumedThroughSequence: initialSequence,
          targetUrl: plan.urlOf(initialSequence),
          failedReason: "receiver priority lane ended before slot became ready",
        };
      });
    }
    const slot: SlotState = {
      targetSequence: initialSequence,
      consumedThroughSequence: initialSequence,
      targetUrl: plan.urlOf(initialSequence),
    };
    slots[slotIndex] = slot;
    slot.fill = fillUnassignedSlot(slotIndex, slot).finally(() => {
      slot.fill = undefined;
    });
    return slot.fill.then(() => slots[slotIndex] ?? slot);
  };

  /**
   * Bounded FIFO cache for non-slot URIs (EXT-X-KEY / EXT-X-MAP bytes).
   * Opaque content: fetched and served as-is, never decrypted or validated.
   */
  const passthroughCache = new Map<
    string,
    { body: Buffer; contentType: string }
  >();
  const servePassthrough = async (
    url: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    if (!passthroughCache.has(url)) {
      try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        passthroughCache.set(url, {
          body,
          contentType:
            response.headers.get("content-type") || "application/octet-stream",
        });
        if (passthroughCache.size > PASSTHROUGH_CACHE_ENTRIES) {
          const oldest = passthroughCache.keys().next().value;
          if (oldest !== undefined) passthroughCache.delete(oldest);
        }
        relayLog("relay passthrough fetched", {
          url,
          status: response.status,
          bytes: body.length,
        });
      } catch (error) {
        relayLog("relay passthrough fetch FAILED", {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(502);
        res.end();
        return;
      }
    }
    const entry = passthroughCache.get(url)!;
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": entry.contentType,
      "Content-Length": entry.body.length,
    });
    if (req.method === "HEAD") res.end();
    else res.end(entry.body);
  };

  // Eviction: drop bodies far behind the receiver first, then — only while
  // over the byte cap — the oldest remaining ones. Mapping metadata
  // (targetSequence) is kept forever so a later seek back refills the SAME
  // content through the backfill path.
  const sweepCache = () => {
    const keepFrom = Math.max(0, receiverSlot - CACHE_KEEP_BEHIND_SLOTS);
    for (let i = 0; i < Math.min(keepFrom, slots.length); i++) {
      const slot = slots[i];
      if (slot?.body) {
        cacheBytes -= slot.body.length;
        slot.body = undefined;
      }
    }
    let evictedForCap = false;
    for (let i = 0; i < slots.length && cacheBytes > CACHE_BYTES_CAP; i++) {
      const slot = slots[i];
      if (slot?.body) {
        cacheBytes -= slot.body.length;
        slot.body = undefined;
        evictedForCap = true;
      }
    }
    if (evictedForCap) {
      relayLog("pipeline cache cap eviction", { cacheBytes });
    }
  };
  const cacheSweep = setInterval(() => {
    if (!pipelineAlive()) {
      clearInterval(cacheSweep);
      return;
    }
    sweepCache();
  }, CACHE_SWEEP_INTERVAL_MS);
  cacheSweep.unref?.();
  // Clear on teardown at once rather than lingering until the next 30s tick's
  // pipelineAlive() check (same unified pipelineAbort path as upstreamMonitor).
  pipelineAbort.signal.addEventListener(
    "abort",
    () => clearInterval(cacheSweep),
    { once: true }
  );
  // ---- Page-captured segment ingest ----
  //
  // The extension's page TS capture POSTs every segment the page player
  // fetches to this endpoint (rid-authenticated). Past the bootstrap frontier
  // these bytes are the pipeline's only supply, so a capture outage starves
  // visibly here instead of silently degrading into the suspect CDN
  // future-fetch path.
  //
  // URL -> sequence matching reuses the DVR builder's own template parser (all
  // known CCTV patterns: <seq>-<stamp>.ts, <seq>.ts, <name>-<epoch>.ts …),
  // validated against the anchor's shape. The page player may land on a
  // different CDN edge host and may carry rotated query tokens, so the
  // comparison covers the path prefix, the bare ".ts" suffix and the
  // timestamped/plain shape — a quality/variant switch changes the path and
  // is still rejected. Every ingested body additionally passes the full
  // decrypt + ffmpeg validation gate before it can occupy a slot.
  const anchorTemplate = parseHistoricalSegmentTemplate(
    plan.urlOf(plan.anchorSequence),
    playlistUrl
  );
  const pathOf = (url: string): string => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  };
  const bareSuffix = (suffix: string): string =>
    suffix.split(/[?#]/, 1)[0] ?? ".ts";
  const parseCapturedSegmentSequence = (
    rawUrl: string
  ): number | undefined => {
    if (!anchorTemplate) return undefined;
    const parsed = parseHistoricalSegmentTemplate(rawUrl, playlistUrl);
    if (!parsed) return undefined;
    if (
      Boolean(parsed.timestampMs) !== Boolean(anchorTemplate.timestampMs) ||
      pathOf(parsed.prefix) !== pathOf(anchorTemplate.prefix) ||
      bareSuffix(parsed.suffix) !== bareSuffix(anchorTemplate.suffix)
    ) {
      return undefined;
    }
    return parsed.sequence;
  };
  const ingestPageCapturedSegment = (
    sequence: number,
    url: string,
    body: Buffer
  ) => {
    const existing = livePageCache.get(sequence);
    if (existing && existing.body.length === body.length) {
      // Duplicate capture of the same object (filter tee + XHR fallback).
      return;
    }
    if (existing) livePageCacheBytes -= existing.body.length;
    livePageCache.set(sequence, { url, body });
    livePageCacheBytes += body.length;
    if (sequence > livePageCacheFrontier) livePageCacheFrontier = sequence;
    livePageCacheIngestCount++;
    // Evict: sequences the pipeline can no longer consume (below the seek-back
    // runway — already refetchable via historical backfill), then the lowest
    // sequences while over the byte cap. The floor anchors on the RECEIVER's
    // position (not the pool head) so the window a future recovery would
    // resume from — right after the last served sequence — is never the first
    // thing evicted.
    const floor = Math.max(
      plan.firstSequence,
      (lastSteadyStateServedSequence ?? nextAssignSequence) -
        PAGE_CACHE_KEEP_BEHIND_SEQUENCES
    );
    const keys = [...livePageCache.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      if (key >= floor && livePageCacheBytes <= PAGE_CACHE_MAX_BYTES) break;
      const entry = livePageCache.get(key);
      if (!entry) continue;
      livePageCacheBytes -= entry.body.length;
      livePageCache.delete(key);
    }
    relayLog("page capture ingested", {
      sequence,
      bytes: body.length,
      frontier: livePageCacheFrontier,
      cached: livePageCache.size,
      cacheBytes: livePageCacheBytes,
    });
  };
  const readRequestBody = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  // The relay listens BEFORE the prebuffer completes: the recovery
  // prebuffer consumes page-captured segments that are still arriving
  // past the cached frontier, so the extension's buffered captures need
  // a live endpoint to flush into. /live.m3u8 and /seg answer 503 until
  // the playlist is finalized and relayReady flips.
  let relayReady = false;

  const server = http.createServer(async (req, res) => {
    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url ?? "/", "http://relay.local");
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (reqUrl.pathname === "/cctv-page-capture") {
      if (
        req.method !== "POST" ||
        reqUrl.searchParams.get("rid") !== requestId
      ) {
        res.writeHead(403).end();
        return;
      }
      // Page download progress heartbeat: even when the bytes are rejected
      // (the page may play a different delivery tree than the relay serves),
      // this request proves the page has downloaded content up to NOW — the
      // probe admission bound for cdnFutureMode relays.
      livePageProgressMs = Date.now();
      // Heartbeat-only captures (cdrmld seeds) carry no bytes: the page plays
      // a different delivery tree, so only the progress stamp matters.
      if (reqUrl.searchParams.get("hb") === "1") {
        res.writeHead(204).end();
        return;
      }
      const capturedUrl = reqUrl.searchParams.get("u") ?? "";
      const sequence = parseCapturedSegmentSequence(capturedUrl);
      if (sequence === undefined) {
        relayLog("page capture rejected URL", { url: capturedUrl });
        res.writeHead(422).end();
        return;
      }
      try {
        const body = await readRequestBody(req);
        if (body.length === 0) {
          res.writeHead(400).end();
          return;
        }
        ingestPageCapturedSegment(sequence, capturedUrl, body);
        res.writeHead(204).end();
      } catch (error) {
        relayLog("page capture read FAILED", {
          sequence,
          error: error instanceof Error ? error.message : String(error),
        });
        res.writeHead(400).end();
      }
      return;
    }

    if (!relayReady && reqUrl.pathname !== "/cctv-page-capture") {
      res.writeHead(503, { "Retry-After": "1" }).end();
      return;
    }

    if (cctvDebugEnabled && reqUrl.pathname === "/debug/upstream.m3u8") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "application/x-mpegURL; charset=utf-8",
        "Content-Length": Buffer.byteLength(lastUpstreamPlaylist),
      });
      res.end(lastUpstreamPlaylist);
      return;
    }
    if (cctvDebugEnabled && reqUrl.pathname === "/debug/served.m3u8") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "application/x-mpegURL; charset=utf-8",
        "Content-Length": Buffer.byteLength(lastServedPlaylist),
      });
      res.end(lastServedPlaylist);
      return;
    }
    // Log every request the receiver makes to the relay. If segments never
    // appear here (only /live.m3u8), the receiver is either stuck loading a
    // master-of-master or requesting an un-rewritten path (see 404 below).
    relayLog("relay request", {
      method: req.method,
      path: reqUrl.pathname,
      range: req.headers.range,
    });

    if (reqUrl.pathname === `/${LIVE_HLS_ENTRY_PATH}`) {
      relayLog("synthetic DVR playlist served", {
        bytes: Buffer.byteLength(servedPlaylist),
      });
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "application/x-mpegURL",
        "Content-Length": Buffer.byteLength(servedPlaylist),
      });
      if (req.method === "HEAD") res.end();
      else res.end(servedPlaylist);
      return;
    }

    // Segment/key/map bytes. Slot URLs (the synthesized /seg?u= entries of
    // the immutable served playlist) resolve through the pipeline cache
    // ONLY — the receiver can never trigger a synchronous upstream fetch.
    // Any other URI the playlist routes here (EXT-X-KEY / EXT-X-MAP) is
    // opaque passthrough bytes: fetched, cached, served undecrypted.
    if (reqUrl.pathname === "/seg") {
      const requestedUrl = trust.decode(reqUrl.searchParams.get("u") ?? "");
      if (!requestedUrl) {
        res.writeHead(403).end();
        return;
      }
      const sequence = plan.sequenceOf(requestedUrl);
      if (sequence === undefined) {
        await servePassthrough(requestedUrl, req, res);
        return;
      }
      const slotIndex = sequence - plan.firstSequence;
      let slot: SlotState | undefined;
      try {
        slot = await Promise.race([
          ensureSlot(slotIndex),
          new Promise<undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), PIPELINE_SLOT_SERVE_WAIT_MS);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        relayLog("receiver segment fill FAILED", {
          slotIndex,
          sequence,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!slot?.body) {
        relayLog("receiver segment unavailable", {
          slotIndex,
          sequence,
          reason:
            slot?.failedReason ??
            `not ready within ${PIPELINE_SLOT_SERVE_WAIT_MS}ms`,
        });
        res
          .writeHead(503, {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "Retry-After": "1",
          })
          .end();
        return;
      }
      receiverSlot = Math.max(receiverSlot, slotIndex);
      // Advance recovery only after a body is successfully served. Use the
      // actual upstream range represented by the slot so remaps and
      // concatenated parts are never replayed by the next relay.
      if (
        liveRelayContinuation?.seedUrl === playlistUrl &&
        (liveRelayContinuation.lastConsumedUpstreamSequence === undefined ||
          slot.consumedThroughSequence >
            liveRelayContinuation.lastConsumedUpstreamSequence)
      ) {
        liveRelayContinuation.lastConsumedUpstreamSequence =
          slot.consumedThroughSequence;
      }
      // Freshness for the continuation max-age gate (see
      // LIVE_RELAY_CONTINUATION_MAX_AGE_MS): any successful serve proves the
      // seed is still this cast's live session.
      if (liveRelayContinuation?.seedUrl === playlistUrl) {
        liveRelayContinuation.lastServedAtMs = Date.now();
      }
      const remapped = slot.targetSequence !== sequence;
      if (slotIndex >= prebufferSlotCount) {
        lastSteadyStateServedSequence = Math.max(
          lastSteadyStateServedSequence ?? slot.targetSequence,
          slot.targetSequence
        );
        // Liveness feed: the background forwards this event to the page
        // sender (auto-recovery keys receiver death detection on it). It
        // fires only once the slot actually resolved, and carries the slot's
        // measured duration so the sender's liveness credit matches the
        // content really served. The first
        // prebufferSlotCount serves are deliberately reported under a
        // different event: the initial cached window may be drained at any
        // speed (or the session may die before reaching it), so the clock
        // must only START once the receiver has moved past it.
        relayLog("receiver segment served", {
          slotIndex,
          sequence,
          targetSequence: slot.targetSequence,
          remapped,
          durationSeconds: slot.durationSeconds,
          bytes: slot.body.length,
        });
      } else {
        relayLog("receiver prebuffer segment served", {
          slotIndex,
          sequence,
          targetSequence: slot.targetSequence,
          remapped,
        });
      }
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": slot.contentType ?? "video/mp2t",
        "Content-Length": slot.body.length,
      });
      if (req.method === "HEAD") res.end();
      else res.end(slot.body);
      return;
    }

    // Unrecognized path. If the receiver lands here, its playlist contained a
    // URI that was NOT rewritten to /live.m3u8 or /seg (e.g. an EXT-X-KEY
    // URI, an unusual segment form, or an absolute path the rewriter missed),
    // so it is fetching that path off the relay origin and getting nothing —
    // exactly the "reaches PLAYING then buffers forever, no /seg" symptom.
    relayLog("relay 404 (UNREWRITTEN path)", {
      method: req.method,
      path: reqUrl.pathname,
      query: reqUrl.search,
    });
    res.writeHead(404).end();
  });
  mediaServer = server;
  mediaServer.on("error", (err) =>
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: err.message },
    })
  );
  mediaServer.on("close", () => {
    // Deterministic pipeline shutdown: stopMediaServer() alone cannot reach
    // the pool (it bumps no generation), so park it here — otherwise parked
    // watermark waits and the cache sweep would outlive the relay until the
    // next relay start. stopPipeline() also aborts every in-flight abortable
    // sleep so parked workers wake immediately instead of napping out their
    // poll interval first.
    stopPipeline();
    // The page-capture cache is module-level so a recovery rebuild can reuse
    // it; after the LAST relay under this generation is gone, drop it on a
    // delay (recovery restarts within seconds and re-arms before the timer).
    const generationAtClose = relayGeneration;
    setTimeout(() => {
      if (liveRelayGeneration === generationAtClose) {
        livePageCache = new Map();
        livePageCacheBytes = 0;
        livePageCacheFrontier = 0;
        livePageCacheIngestCount = 0;
      }
    }, 120_000).unref?.();
    messaging.sendMessage({
      subject: "mediaCast:mediaServerStopped",
      data: { requestId },
    });
  });

  // ---- Upstream playlist drift monitor (diagnostics only) ----
  // The synthetic DVR extrapolates sequence numbers and the live edge from
  // ONE snapshot (anchor + cadence). If the CDN's real playlist later
  // deviates — cadence change, encoder restart renumbering, inserted or
  // removed segments, discontinuities, URL pattern/query rotation — the
  // synthesized future URLs stop resolving and playback starves at the live
  // edge, while /seg logs only show 404s (the symptom, not the cause).
  // Re-fetch the tiny upstream playlist periodically and log every
  // deviation (and the return to a clean state) so the cause is visible.
  const UPSTREAM_MONITOR_INTERVAL_MS = 30_000;
  /** Live-edge sequences of tolerance before a gap counts as a jump. */
  const SEQUENCE_JUMP_TOLERANCE = 3;
  /** Same cadence tolerance the DVR builder uses for irregularity. */
  const CADENCE_TOLERANCE_SECONDS = 0.25;
  /**
   * Cadence is measured against a baseline sample at least this old. A
   * single 30s interval only resolves the live edge to ±1 sequence number,
   * which is up to ±0.5s/segment of rounding noise — observed as a
   * every-other-run cadenceDrift flip-flop on a perfectly healthy 4s
   * stream. Over a 120s baseline the same ±1 sequence costs ~0.03s/segment.
   */
  const CADENCE_BASELINE_MIN_AGE_MS = 120_000;
  /** Edge samples older than this are pruned (bounded memory). */
  const CADENCE_SAMPLE_RETENTION_MS = 10 * 60_000;
  // dvr is a narrowed `let` — capture the fields now so the interval closure
  // below sees them without re-checking for undefined.
  const dvrAnchor = {
    sequenceOf: dvr.sequenceOf,
    anchorSequence: dvr.anchorSequence,
    stepSeconds: dvr.stepSeconds,
    builtAtMs: dvr.builtAtMs,
  };
  const edgeSamples: { sequence: number; atMs: number }[] = [];
  let lastDeviationSignature = "";

  const upstreamMonitor = setInterval(async () => {
    if (!pipelineAlive()) {
      // This relay was stopped or replaced; stop monitoring with it. Use the
      // same teardown predicate as the rest of the pipeline (pipelineAbort
      // also clears this interval immediately; this guard covers a tick that
      // was already scheduled when the abort fired).
      clearInterval(upstreamMonitor);
      return;
    }
    const deviations: Record<string, unknown> = {};
    let uris: string[] = [];
    try {
      const response = await fetchRemoteMedia(
        playlistUrl,
        { cache: "no-store", headers: upstreamHeaders },
        (u) => trust.allows(u)
      );
      if (!response.ok) {
        deviations.httpStatus = response.status;
      } else {
        const raw = await response.text();
        const lines = raw.split("\n").map((line) => line.trim());
        uris = lines.filter((line) => line && !line.startsWith("#"));
        const sequences: number[] = [];
        for (const uri of uris) {
          let absolute: string;
          try {
            absolute = new URL(uri, playlistUrl).href;
          } catch {
            absolute = uri;
          }
          const sequence = dvrAnchor.sequenceOf(absolute);
          if (sequence === undefined) {
            // URI no longer matches the anchor's prefix/suffix pattern:
            // the CDN rotated paths/hosts or query requirements, so every
            // synthesized future URL of the old shape would 404.
            deviations.patternChange ??= [];
            (deviations.patternChange as string[]).push(uri);
          } else {
            sequences.push(sequence);
          }
        }
        if (sequences.length) {
          // Consecutive entries must step by exactly one sequence number;
          // gaps or overlaps mean segments were inserted or removed.
          const gaps = sequences
            .slice(1)
            .map((seq, i) => seq - sequences[i]!)
            .filter((delta) => delta !== 1);
          if (gaps.length) {
            deviations.sequenceGaps = gaps;
          }
          // The published live edge must track the extrapolated edge.
          const edge = Math.max(...sequences);
          const expectedEdge =
            dvrAnchor.anchorSequence +
            (Date.now() - dvrAnchor.builtAtMs) / 1000 / dvrAnchor.stepSeconds;
          if (Math.abs(edge - expectedEdge) > SEQUENCE_JUMP_TOLERANCE) {
            deviations.sequenceJump = {
              edge,
              expectedEdge: Math.round(expectedEdge * 10) / 10,
            };
          }
          // Cadence across monitor runs: wall clock per published segment,
          // measured against a ≥120s-old baseline sample (see
          // CADENCE_BASELINE_MIN_AGE_MS for why one interval is too noisy).
          const atMs = Date.now();
          edgeSamples.push({ sequence: edge, atMs });
          while (
            edgeSamples.length > 1 &&
            atMs - edgeSamples[0]!.atMs > CADENCE_SAMPLE_RETENTION_MS
          ) {
            edgeSamples.shift();
          }
          let baseline: { sequence: number; atMs: number } | undefined;
          for (let i = edgeSamples.length - 1; i >= 0; i--) {
            const sample = edgeSamples[i]!;
            if (atMs - sample.atMs >= CADENCE_BASELINE_MIN_AGE_MS) {
              baseline = sample;
              break;
            }
          }
          if (baseline && edge > baseline.sequence) {
            const measuredStep =
              (atMs - baseline.atMs) / 1000 / (edge - baseline.sequence);
            if (
              Math.abs(measuredStep - dvrAnchor.stepSeconds) >
              CADENCE_TOLERANCE_SECONDS
            ) {
              deviations.cadenceDrift = {
                measuredStepSeconds: Math.round(measuredStep * 100) / 100,
                synthesizedStepSeconds: dvrAnchor.stepSeconds,
                baselineAgeMs: atMs - baseline.atMs,
              };
            }
          }
        }
        if (
          lines.some(
            (line) =>
              line.startsWith("#EXT-X-DISCONTINUITY") &&
              !line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE")
          )
        ) {
          deviations.discontinuity = true;
        }
        // Upstream EXTINF durations must still match the synthesized
        // cadence; a change here breaks sequence-based extrapolation even
        // before the cross-run cadence check can see it.
        const extinfSeconds = [...raw.matchAll(/^#EXTINF:([\d.]+)/gm)].map(
          (match) => Number(match[1])
        );
        if (extinfSeconds.length) {
          const averageExtinf =
            extinfSeconds.reduce((total, value) => total + value, 0) /
            extinfSeconds.length;
          if (
            Math.abs(averageExtinf - dvrAnchor.stepSeconds) >
            CADENCE_TOLERANCE_SECONDS
          ) {
            deviations.extinfDrift = {
              upstreamExtinfSeconds: Math.round(averageExtinf * 100) / 100,
              synthesizedStepSeconds: dvrAnchor.stepSeconds,
            };
          }
        }
      }
    } catch (err) {
      deviations.fetchError = err instanceof Error ? err.message : String(err);
    }
    // Only log when the deviation SET changes, so a persisting condition
    // doesn't repeat every interval.
    const signature = Object.keys(deviations).sort().join(",");
    if (signature === lastDeviationSignature) return;
    lastDeviationSignature = signature;
    if (!signature) {
      relayLog("upstream playlist monitor: deviations resolved", {});
      return;
    }
    relayLog("upstream playlist monitor: unexpected change", {
      ...deviations,
      segmentUris: uris,
    });
  }, UPSTREAM_MONITOR_INTERVAL_MS);
  upstreamMonitor.unref?.();
  // Stop the moment this relay is torn down instead of on the next 30s tick
  // (which would also fire one more upstream playlist fetch first).
  pipelineAbort.signal.addEventListener(
    "abort",
    () => clearInterval(upstreamMonitor),
    { once: true }
  );

  // Captured at listen; the ready block below reports it to the sender.
  let listenAddress: string | undefined;
  mediaServer.listen(port, async () => {
    const address = firstLocalAddress();
    if (!address) {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: { requestId, message: "No local IPv4 address" },
      });
      stopPipeline();
      void stopMediaServer();
      return;
    }
    listenAddress = address;
    // Listening precedes readiness; see the relayReady note above.
    relayLog("live relay listening; prebuffering", {
      mediaPath: LIVE_HLS_ENTRY_PATH,
      localAddress: address,
    });
  });

  // Boot prebuffer: fill the head of the window before advertising the
  // relay, so playback from startTime=0 is served from memory while the
  // receiver builds its first A/V buffer. The pool keeps running toward
  // the live edge once this completes.
  relayLog("CCTV initial prebuffer starting", {
    prebufferSlots: prebufferSlotCount,
    stepSeconds: plan.stepSeconds,
  });
  for (
    let worker = 0;
    worker < Math.min(PIPELINE_WORKERS, totalSlots);
    worker++
  ) {
    void poolWorker(worker + 1).catch((error) => {
      relayLog("pipeline worker crashed", {
        worker: worker + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  // Boot has no wall-clock deadline. The pool already applies the steady-state
  // polling/remap rules: unavailable or invalid sequences consume no slot and
  // later usable sequences keep filling the immutable prebuffer window. Wait
  // until every advertised prebuffer slot has a validated cached body. A
  // replaced/stopped relay is the only condition that interrupts this wait.
  while (nextSlot < prebufferSlotCount) {
    if (!pipelineAlive()) {
      // An interrupted boot must not leave this relay's early listener
      // orphaned on the port.
      if (mediaServer === server) {
        void stopMediaServer();
      }
      throw new Error("CCTV prebuffer interrupted because the relay was replaced");
    }
    // cdnFutureMode: once every published segment (<= anchor) has been assigned
    // and the runway is still short, the missing slots could only come from the
    // live edge. Do NOT chase the edge — finalize the runway from published
    // history. The unfilled tail slots fill on-demand later, by which time
    // those segments have matured on the CDN.
    if (cdnFutureMode && nextAssignSequence > plan.anchorSequence) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (nextSlot < prebufferSlotCount) {
    if (nextSlot === 0) {
      // No usable published segment before the live edge at all — nothing safe
      // to serve as a runway. Fail this start so the sender's auto-recovery
      // retries once the edge (or a fresh capture) matures.
      const message =
        "CCTV prebuffer found no valid published segment before the live edge";
      relayLog("CCTV prebuffer found no valid published history", {
        anchorSequence: plan.anchorSequence,
        firstSequence: plan.firstSequence,
      });
      if (mediaServer === server) {
        void stopMediaServer();
      }
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: { requestId, message },
      });
      throw new Error(message);
    }
    relayLog("CCTV prebuffer capped to published history (avoided live edge)", {
      filledSlots: nextSlot,
      requestedPrebufferSlots: prebufferSlotCount,
      anchorSequence: plan.anchorSequence,
      stepSeconds: plan.stepSeconds,
    });
    // The runway is whatever published history filled; slots beyond it are the
    // live pipeline (they fill on-demand as the receiver reaches them).
    prebufferSlotCount = nextSlot;
  }
  // The served playlist head is always a cached segment after the window
  // adjustment, so the receiver starts at the very first cached segment.
  const startTime = 0;
  relayLog("CCTV initial prebuffer ready", {
    segmentCount: nextSlot,
    prebufferSlots: prebufferSlotCount,
    skippedSequences: nextAssignSequence - plan.firstSequence - nextSlot,
    startTime,
    bytes: cacheBytes,
    elapsedMs: Date.now() - prebufferStartedAt,
  });

  // The synthetic DVR is built before prebuffer, so its EXTINF values only
  // know the nominal upstream cadence. Once the first slots are materialized,
  // publish their ffmpeg-measured durations to the receiver. Future slots stay
  // on the nominal cadence because their bodies do not exist yet. Keep the
  // original segment URLs intact: /seg already maps playlist sequence -> slot.
  const materializePrebufferDurations = (playlist: string): string => {
    const knownDurations = Array.from(
      { length: Math.min(prebufferSlotCount, slots.length) },
      (_, slotIndex) => slots[slotIndex]?.durationSeconds
    );
    const finiteKnownDurations = knownDurations.filter(
      (duration): duration is number =>
        typeof duration === "number" && Number.isFinite(duration)
    );
    const maxKnownDuration = Math.max(
      plan.stepSeconds,
      ...finiteKnownDurations
    );
    const targetDuration = Math.max(
      1,
      Math.ceil(plan.stepSeconds),
      Math.ceil(maxKnownDuration)
    );
    let extinfIndex = 0;
    const lines = playlist.split("\n").map((line) => {
      if (/^#EXT-X-TARGETDURATION:/i.test(line)) {
        return `#EXT-X-TARGETDURATION:${targetDuration}`;
      }
      if (!/^#EXTINF:/i.test(line)) return line;
      const duration = knownDurations[extinfIndex++];
      return duration !== undefined && Number.isFinite(duration)
        ? `#EXTINF:${duration.toFixed(6)},`
        : line;
    });
    relayLog("synthetic DVR playlist finalized with prebuffer durations", {
      prebufferSlots: prebufferSlotCount,
      measuredDurations: knownDurations,
      targetDuration,
      futureDurationSeconds: plan.stepSeconds,
    });
    return lines.join("\n");
  };
  servedPlaylist = materializePrebufferDurations(servedPlaylist);

  // Ready: the served playlist is finalized (prebuffer EXTINF durations
  // published). /live.m3u8 and /seg start answering and the sender may
  // load the receiver.
  relayReady = true;
  if (!listenAddress) {
    // The listen callback already reported the error and stopped the relay.
    return;
  }
  // Start at the head of the synthesized DVR (t=0), the full 120s lookback
  // behind the live edge. Starting near the edge makes the receiver's
  // read-ahead collide with the live edge — future segments only appear
  // on the CDN as they're published, so playback degrades into lockstep
  // with the publication cadence (plays ~1s, buffers ~3s with 4s
  // segments). The head start keeps the receiver's buffer window inside
  // already-published segments; it trails the edge by a constant offset
  // for the whole session.
  // Real synthesized duration (history + future). On the plain-rewrite
  // fallback there is no finite duration to report — leave it unset so the
  // sender doesn't advertise a fabricated one.
  const pageDuration = dvr?.totalDurationSeconds;
  relayLog("live relay ready", {
    mediaPath: LIVE_HLS_ENTRY_PATH,
    localAddress: listenAddress,
    startTime,
    pageDuration,
    liveEdgeBaseSeconds: dvr?.liveEdgeBaseSeconds,
    builtAtMs: dvr?.builtAtMs,
  });
  messaging.sendMessage({
    subject: "mediaCast:mediaServerStarted",
    data: {
      requestId,
      mediaPath: LIVE_HLS_ENTRY_PATH,
      subtitlePaths: [],
      localAddress: listenAddress,
      // Mode "dash-remux" keeps the sender on the seekable-VOD handling
      // path (finite duration, BUFFERED stream type) shared with the
      // Bilibili remux. startTime is 0: the head of the DVR history, a
      // full lookback behind the live edge (see above) — the sender
      // loads the receiver there directly.
      mode: "dash-remux",
      startTime,
      pageDuration,
      // DVR live edge for the sender: the edge sits at liveEdgeBaseSeconds
      // in the VOD timeline at builtAtMs and advances with wall clock. Used
      // to clamp forward seeks so they never target unpublished segments.
      liveEdgeBaseSeconds: dvr?.liveEdgeBaseSeconds,
      builtAtMs: dvr?.builtAtMs,
      // Segment cadence: the receiver fetches one segment per stepSeconds
      // while alive. The sender keys its liveness timeout on this (2x).
      stepSeconds: dvr?.stepSeconds,
    },
  });
}

export async function startRemoteMediaServer(
  messaging: Messenger,
  requestId: string,
  mediaUrl: string,
  referer: string,
  contentType: string,
  port: number,
  audioUrl?: string,
  startTime = 0,
  hlsLive = false,
  userAgent?: string,
  cctvDebugEnabled = false
) {
  if (hlsLive) {
    await startLiveHlsRelayServer(
      messaging,
      requestId,
      mediaUrl,
      referer,
      port,
      userAgent,
      cctvDebugEnabled
    );
    return;
  }
  if (audioUrl) {
    await startDashRemuxServer(
      messaging,
      requestId,
      mediaUrl,
      audioUrl,
      referer,
      port,
      startTime
    );
    return;
  }
  const host = (() => {
    try {
      return new URL(mediaUrl).hostname;
    } catch {
      return "invalid";
    }
  })();
  console.error("[fx_cast_bilibili] validating", { host, port });
  if (!remoteHostAllowed(mediaUrl)) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: `Host not allowlisted: ${host}` },
    });
    return;
  }

  await stopMediaServer();
  mediaServerRequestId = requestId;
  const mediaPath = "bilibili-media";
  mediaServer = http.createServer(async (req, res) => {
    console.error("[fx_cast_bilibili] receiver request", {
      method: req.method,
      url: req.url,
      range: req.headers.range,
    });
    if (
      !req.url ||
      decodeURIComponent(req.url).split("?", 1)[0] !== `/${mediaPath}`
    ) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = {
      Referer: referer,
      "User-Agent": "Mozilla/5.0",
    };
    if (req.headers.range) headers.Range = req.headers.range;
    try {
      const upstream = await fetchRemoteMedia(mediaUrl, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers,
      });
      console.error("[fx_cast_bilibili] upstream", {
        status: upstream.status,
        type: upstream.headers.get("content-type"),
      });
      const output: Record<string, string> = {
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
        "Content-Type":
          upstream.headers.get("content-type") ||
          contentType ||
          "application/octet-stream",
      };
      for (const name of ["content-length", "content-range"]) {
        const value = upstream.headers.get(name);
        if (value) output[name] = value;
      }
      res.writeHead(upstream.status, output);
      if (req.method === "HEAD" || !upstream.body) {
        res.end();
        return;
      }
      stream.Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (err) {
      console.error("[fx_cast_bilibili] proxy failed", err);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  mediaServer.on("error", (err) =>
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: { requestId, message: err.message },
    })
  );
  mediaServer.on("close", () =>
    messaging.sendMessage({
      subject: "mediaCast:mediaServerStopped",
      data: { requestId },
    })
  );
  mediaServer.listen(port, () => {
    const address = firstLocalAddress();
    console.error("[fx_cast_bilibili] listening", { address, port });
    if (!address) {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: { requestId, message: "No local IPv4 address" },
      });
      void stopMediaServer();
      return;
    }
    messaging.sendMessage({
      subject: "mediaCast:mediaServerStarted",
      data: {
        requestId,
        mediaPath,
        subtitlePaths: [],
        localAddress: address,
        mode: "proxy",
      },
    });
  });
}

export function stopMediaServer() {
  if (mediaServerStopPromise) return mediaServerStopPromise;

  dashServerGeneration++;
  const auxiliaryProcesses = [...dashAuxProcesses];
  dashAuxProcesses.clear();
  const server = mediaServer;
  const remuxProcess = dashRemuxProcess;
  const tempDir = dashTempDir;
  mediaServer = undefined;
  mediaServerRequestId = undefined;
  dashRemuxProcess = undefined;
  dashTempDir = undefined;

  mediaServerStopPromise = (async () => {
    for (const process of auxiliaryProcesses) {
      if (process.exitCode === null) process.kill("SIGKILL");
    }
    if (remuxProcess && remuxProcess.exitCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceKillTimeout);
          clearTimeout(finalTimeout);
          resolve();
        };
        const forceKillTimeout = setTimeout(() => {
          remuxProcess.kill("SIGKILL");
        }, 3000);
        const finalTimeout = setTimeout(finish, 5000);
        remuxProcess.once("exit", finish);
        remuxProcess.kill("SIGTERM");
      });
    }

    if (server) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(closeTimeout);
          if (
            err &&
            (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ) reject(err);
          else resolve();
        };
        // Node 22 (the packaged target) supports closeAllConnections, but keep
        // a deadline for source builds running older Node or broken sockets.
        const closeTimeout = setTimeout(() => finish(), 5000);
        server.close(err => finish(err));
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
      });
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  })().finally(() => {
    mediaServerStopPromise = undefined;
  });

  return mediaServerStopPromise;
}
