import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import stream from "stream";

import mime from "mime-types";

import type { Messenger } from "../messaging";
import { convertSrtToVtt } from "../lib/subtitles";

export let mediaServer: http.Server | undefined;
let mediaServerStopPromise: Promise<void> | undefined;
let dashRemuxProcess: ChildProcess | undefined;
let dashTempDir: string | undefined;
let dashServerGeneration = 0;
const dashAuxProcesses = new Set<ChildProcess>();

export async function startMediaServer(
  messaging: Messenger,
  filePath: string,
  port: number
) {
  if (mediaServer?.listening) {
    await stopMediaServer();
  }

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
        data: "Media path is not a file.",
      });

      return;
    }
  } catch (err) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: "Failed to find media path.",
    });

    return;
  }

  const contentType = mime.lookup(filePath);
  if (!contentType) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: "Failed to find media type.",
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
    });
  });
  mediaServer.on("error", (err) => {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: err.message,
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
        data: "Failed to get local address.",
      });
      stopMediaServer();
      return;
    }

    messaging.sendMessage({
      subject: "mediaCast:mediaServerStarted",
      data: {
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
  init: RequestInit
): Promise<Response> {
  let currentUrl = mediaUrl;
  for (let count = 0; count <= 5; count++) {
    if (!remoteHostAllowed(currentUrl)) {
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
  videoUrl: string,
  audioUrl: string,
  referer: string,
  port: number,
  startTime = 0
) {
  if (!remoteHostAllowed(videoUrl) || !remoteHostAllowed(audioUrl)) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: "DASH media host not allowlisted",
    });
    return;
  }
  await stopMediaServer();
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
  let keyframeResolved = !(normalizedStartTime > 0.05);
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
    process.env.FX_CAST_FFMPEG,
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
      "-show_entries", "packet=pts_time,flags",
      "-of", "csv=p=0",
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
      for (const line of probeStdout.split("\n")) {
        const [ptsText, flags] = line.trim().split(",");
        const pts = Number.parseFloat(ptsText);
        if (
          flags?.includes("K") &&
          Number.isFinite(pts) &&
          pts <= normalizedStartTime + 0.001
        ) {
          keyframe = keyframe === undefined ? pts : Math.max(keyframe, pts);
        }
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
      data: `Unable to start ffmpeg: ${err.message}`,
    });
  });
  remuxProcess.on("exit", (code) => {
    if (code && dashRemuxProcess === remuxProcess && mediaServer) {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: `ffmpeg DASH remux failed (${code}): ${stderr}`,
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
    messaging.sendMessage({ subject: "mediaCast:mediaServerError", data: err.message })
  );
  mediaServer.on("close", () =>
    messaging.sendMessage({ subject: "mediaCast:mediaServerStopped" })
  );
  mediaServer.listen(port, async () => {
    const address = firstLocalAddress();
    if (!address) {
      messaging.sendMessage({ subject: "mediaCast:mediaServerError", data: "No local IPv4 address" });
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
          data: "Unable to generate DASH timeline pad segment",
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
              mediaPath,
              subtitlePaths: [],
              localAddress: address,
              mode: "dash-remux",
              startTime: normalizedStartTime,
              padBaseSeconds,
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
      data: `Timed out preparing DASH stream through ${minimumPlaylistDuration}s: ${stderr}`,
    });
    void stopMediaServer();
  });
}

export async function startRemoteMediaServer(
  messaging: Messenger,
  mediaUrl: string,
  referer: string,
  contentType: string,
  port: number,
  audioUrl?: string,
  startTime = 0
) {
  if (audioUrl) {
    await startDashRemuxServer(
      messaging,
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
  console.error("[fx_cast Bilibili] validating", { host, port });
  if (!remoteHostAllowed(mediaUrl)) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: `Host not allowlisted: ${host}`,
    });
    return;
  }

  await stopMediaServer();
  const mediaPath = "bilibili-media";
  mediaServer = http.createServer(async (req, res) => {
    console.error("[fx_cast Bilibili] receiver request", {
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
      console.error("[fx_cast Bilibili] upstream", {
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
      console.error("[fx_cast Bilibili] proxy failed", err);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  mediaServer.on("error", (err) =>
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: err.message,
    })
  );
  mediaServer.on("close", () =>
    messaging.sendMessage({
      subject: "mediaCast:mediaServerStopped",
    })
  );
  mediaServer.listen(port, () => {
    const address = firstLocalAddress();
    console.error("[fx_cast Bilibili] listening", { address, port });
    if (!address) {
      messaging.sendMessage({
        subject: "mediaCast:mediaServerError",
        data: "No local IPv4 address",
      });
      void stopMediaServer();
      return;
    }
    messaging.sendMessage({
      subject: "mediaCast:mediaServerStarted",
      data: {
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
