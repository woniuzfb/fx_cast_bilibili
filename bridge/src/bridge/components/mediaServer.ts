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
  requiredDuration = 0
) {
  if (!remoteHostAllowed(videoUrl) || !remoteHostAllowed(audioUrl)) {
    messaging.sendMessage({
      subject: "mediaCast:mediaServerError",
      data: "DASH media host not allowlisted",
    });
    return;
  }
  await stopMediaServer();
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "fx-cast-dash-")
  );
  dashTempDir = tempDir;
  const mediaPath = "index.m3u8";
  const playlistPath = path.join(tempDir, mediaPath);
  const inputHeaders = `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0\r\n`;
  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-headers", inputHeaders, "-i", videoUrl,
    "-headers", inputHeaders, "-i", audioUrl,
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
    }
  });
  mediaServer = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent((req.url ?? "/").split("?", 1)[0]);
    const filename = path.basename(pathname);
    if (!filename || filename !== pathname.slice(1)) {
      res.writeHead(404).end();
      return;
    }
    const filePath = path.join(tempDir, filename);
    try {
      const stat = await fs.promises.stat(filePath);
      const type = filename.endsWith(".m3u8")
        ? "application/x-mpegURL"
        : filename.endsWith(".ts")
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
    const minimumPlaylistDuration = Math.max(4, requiredDuration + 8);
    for (let attempt = 0; attempt < 900; attempt++) {
      try {
        const playlist = await fs.promises.readFile(playlistPath, "utf8");
        const playlistDuration = [...playlist.matchAll(/^#EXTINF:([0-9.]+)/gm)]
          .reduce((total, match) => total + Number(match[1]), 0);
        if (
          playlist.includes("segment-") &&
          playlist.includes(".ts") &&
          playlistDuration >= minimumPlaylistDuration
        ) {
          messaging.sendMessage({
            subject: "mediaCast:mediaServerStarted",
            data: {
              mediaPath,
              subtitlePaths: [],
              localAddress: address,
              mode: "dash-remux",
            },
          });
          return;
        }
      } catch {}
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
  requiredDuration = 0
) {
  if (audioUrl) {
    await startDashRemuxServer(
      messaging,
      mediaUrl,
      audioUrl,
      referer,
      port,
      requiredDuration
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

  const server = mediaServer;
  const remuxProcess = dashRemuxProcess;
  const tempDir = dashTempDir;
  mediaServer = undefined;
  dashRemuxProcess = undefined;
  dashTempDir = undefined;

  mediaServerStopPromise = (async () => {
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
        server.close((err) => {
          if (
            err &&
            (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ) {
            reject(err);
          } else {
            resolve();
          }
        });
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
