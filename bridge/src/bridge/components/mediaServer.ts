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

export async function startRemoteMediaServer(
  messaging: Messenger,
  mediaUrl: string,
  referer: string,
  contentType: string,
  port: number
) {
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
      data: { mediaPath, subtitlePaths: [], localAddress: address },
    });
  });
}

export function stopMediaServer() {
  if (mediaServerStopPromise) return mediaServerStopPromise;
  const server = mediaServer;
  if (!server) return Promise.resolve();

  mediaServerStopPromise = new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      if (mediaServer === server) mediaServer = undefined;
      mediaServerStopPromise = undefined;
      if (
        err &&
        (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(err);
      } else {
        resolve();
      }
    };

    server.close((err) => finish(err ?? undefined));
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  });
  return mediaServerStopPromise;
}
