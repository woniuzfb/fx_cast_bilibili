import { Logger } from "../../lib/logger";
import MediaSender, { type MediaSenderOpts } from "./media";

declare global {
  interface Window {
    __fxCastBilibiliNavigationInterval?: number;
    __fxCastBilibili?: {
      reinject: () => { status: "started" | "debounced"; retryAfterMs?: number };
      isCasting: () => boolean;
      setQuality: (quality: number) => void;
      setDebug: (enabled: boolean) => void;
      /**
       * Popup-initiated seek for the DASH remux session. Returns true when a
       * cast is running and the seek was handled (so the background does not
       * forward a native seek to the receiver, which cannot seek the
       * sequentially-remuxed stream).
       */
      dashSeek: (time: number) => boolean;
      controlFromBleRemote: (
        action: "seek_backward" | "seek_forward" | "pause" | "play",
        seekBackwardSeconds: number,
        seekForwardSeconds: number
      ) => boolean;
    };
    __fxCastBilibiliInitialQuality?: number;
    __fxCastBilibiliInitialDebug?: boolean;
  }
}

// The background normally detects an existing injection (via the
// window.__fxCastBilibili marker) and re-opens the receiver selector instead
// of re-injecting. This guard is a defensive fallback for the rare case the
// script is injected twice anyway: trigger a re-cast and return WITHOUT
// throwing. Throwing would make browser.scripting.executeScript report an
// injection error, aborting the flow and leaving the popup stuck on
// "Preparing receiver selector...".
if (window.__fxCastBilibili) {
  window.__fxCastBilibili.reinject();
} else {
  initBilibiliSender();
}

function initBilibiliSender() {

const logger = new Logger("fx_cast_bilibili [sender]");
const MAX_DEBUG_LINES = 200;
const DEBUG_PANEL_ID = "fx-cast-bilibili-debug";
const lines: string[] = [];
let sender: MediaSender | undefined;
let debugEnabled = Boolean(window.__fxCastBilibiliInitialDebug);
let preferredQuality = Number(window.__fxCastBilibiliInitialQuality) || 0;
const QUALITY_ORDER = [112, 80, 64, 32, 16];

function ensureDebugPanel() {
  let panel = document.getElementById(DEBUG_PANEL_ID) as HTMLPreElement | null;
  if (panel) return panel;
  panel = document.createElement("pre");
  panel.id = DEBUG_PANEL_ID;
  panel.title = "Double-click to close";
  Object.assign(panel.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    maxWidth: "620px",
    maxHeight: "45vh",
    overflow: "auto",
    padding: "12px",
    margin: "0",
    background: "rgba(0, 0, 0, 0.92)",
    color: "#8ff",
    border: "1px solid #4af",
    font: "12px/1.5 monospace",
    whiteSpace: "pre-wrap",
  });
  panel.addEventListener("dblclick", () => panel?.remove());
  (document.body || document.documentElement).append(panel);
  return panel;
}
let activeKey = "";
let changeGeneration = 0;
/** Debounce timestamp so rapid/auto re-cast clicks don't fight each other. */
let lastReinjectAt = 0;

function debug(message: string, data?: unknown) {
  if (!debugEnabled) return;
  const suffix =
    data === undefined
      ? ""
      : ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
  const line = `[${new Date().toLocaleTimeString()}] ${message}${suffix}`;
  lines.push(line);
  if (lines.length > MAX_DEBUG_LINES) {
    lines.splice(0, lines.length - MAX_DEBUG_LINES);
  }
  console.info("[fx_cast_bilibili]", message, data ?? "");
  const panel = ensureDebugPanel();
  panel.textContent = `fx_cast_bilibili debug (double-click to close)\n${lines.join(
    "\n"
  )}`;
}

interface PageInfo {
  cid: number;
  page: number;
  part: string;
}
interface ResolvedMedia {
  key: string;
  mediaUrl: string;
  title: string;
  contentType: string;
  audioUrl?: string;
}

async function json<T>(url: URL): Promise<T> {
  debug("fetch", url.pathname);
  const response = await fetch(url.href, {
    credentials: "include",
    referrer: location.href,
  });
  debug("response", { status: response.status, path: url.pathname });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function pageIdentity(url = new URL(location.href)) {
  const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  if (!match) throw new Error("Unsupported Bilibili URL");
  const bvid = match[1];
  const page = Math.max(1, Number(url.searchParams.get("p")) || 1);
  return { bvid, page, key: `${bvid}:${page}` };
}

async function resolveMedia(): Promise<ResolvedMedia> {
  const { bvid, page: requested, key } = pageIdentity();
  debug("parsed", { bvid, requested, key });
  const pageUrl = new URL("https://api.bilibili.com/x/player/pagelist");
  pageUrl.searchParams.set("bvid", bvid);
  pageUrl.searchParams.set("jsonp", "jsonp");
  const pages = await json<{
    code: number;
    message?: string;
    data?: PageInfo[];
  }>(pageUrl);
  const page = pages.data?.find((item) => item.page === requested);
  debug("pagelist", {
    code: pages.code,
    count: pages.data?.length ?? 0,
    cid: page?.cid,
  });
  if (pages.code !== 0 || !page)
    throw new Error(pages.message || "CID unavailable");

  const playUrl = new URL("https://api.bilibili.com/x/player/playurl");
  for (const [name, value] of Object.entries({
    bvid,
    cid: String(page.cid),
    qn: String(preferredQuality || 112),
    fnval: "16",
    fnver: "0",
    fourk: "0",
    try_look: "1",
  }))
    playUrl.searchParams.set(name, value);
  interface DashStream {
    id: number;
    baseUrl?: string;
    base_url?: string;
    bandwidth?: number;
    codecs?: string;
    mimeType?: string;
    mime_type?: string;
    width?: number;
    height?: number;
    frameRate?: string;
    frame_rate?: string;
  }
  const play = await json<{
    code: number;
    message?: string;
    data?: {
      quality?: number;
      accept_quality?: number[];
      accept_description?: string[];
      dash?: { video?: DashStream[]; audio?: DashStream[] };
    };
  }>(playUrl);
  const videos = play.data?.dash?.video ?? [];
  const audios = play.data?.dash?.audio ?? [];
  const streamUrl = (stream?: DashStream) => stream?.baseUrl ?? stream?.base_url;
  const avcVideos = videos.filter((stream) =>
    (stream.codecs ?? "").toLowerCase().startsWith("avc")
  );
  const candidates = avcVideos.length ? avcVideos : videos;
  const targetQuality = preferredQuality || QUALITY_ORDER.find((quality) =>
    candidates.some((stream) => stream.id === quality)
  );
  const fallbackOrder = preferredQuality
    ? QUALITY_ORDER.filter((quality) => quality <= preferredQuality)
    : QUALITY_ORDER;
  const selectedQuality =
    (targetQuality && candidates.some((stream) => stream.id === targetQuality)
      ? targetQuality
      : fallbackOrder.find((quality) =>
          candidates.some((stream) => stream.id === quality)
        )) ?? candidates[0]?.id;
  const video = [...candidates]
    .filter((stream) => stream.id === selectedQuality)
    .sort(
      (left, right) =>
        (right.bandwidth ?? 0) - (left.bandwidth ?? 0) ||
        (right.height ?? 0) - (left.height ?? 0)
    )[0] ?? candidates[0];
  const audio = [...audios].sort(
    (left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
  )[0];
  const mediaUrl = streamUrl(video);
  const audioUrl = streamUrl(audio);
  debug("playurl DASH", {
    code: play.code,
    requestedQuality: preferredQuality || "auto",
    actualQuality: video?.id ?? play.data?.quality,
    acceptedQualities: play.data?.accept_quality,
    acceptedDescriptions: play.data?.accept_description,
    video: video
      ? {
          id: video.id,
          width: video.width,
          height: video.height,
          bandwidth: video.bandwidth,
          codecs: video.codecs,
          frameRate: video.frameRate ?? video.frame_rate,
        }
      : undefined,
    audio: audio
      ? { id: audio.id, bandwidth: audio.bandwidth, codecs: audio.codecs }
      : undefined,
  });
  if (play.code !== 0 || !mediaUrl || !audioUrl) {
    throw new Error(play.message || "No playable DASH video/audio pair");
  }
  return {
    key,
    mediaUrl,
    audioUrl,
    title: page.part || document.title,
    contentType: "application/x-mpegURL",
  };
}

async function waitForVideo(generation: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (generation !== changeGeneration) return undefined;
    const video = document.querySelector("video");
    if (video instanceof HTMLVideoElement && video.readyState > 0) return video;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const video = document.querySelector("video");
  return video instanceof HTMLVideoElement ? video : undefined;
}

async function loadCurrentItem(isInitial: boolean) {
  const generation = ++changeGeneration;
  if (!isInitial) sender?.suspendMediaElementSync();
  let mediaElement =
    document.querySelector<HTMLVideoElement>("video") ?? undefined;
  if (mediaElement instanceof HTMLVideoElement) {
    mediaElement.pause();
    debug("source paused while Cast prepares", {
      currentTime: mediaElement.currentTime,
    });
  } else {
    mediaElement = undefined;
  }
  const media = await resolveMedia();
  const currentVideo = document.querySelector<HTMLVideoElement>("video");
  mediaElement =
    currentVideo instanceof HTMLVideoElement
      ? currentVideo
      : mediaElement instanceof HTMLVideoElement
      ? mediaElement
      : await waitForVideo(generation);
  if (generation !== changeGeneration) return;
  if (mediaElement instanceof HTMLVideoElement) {
    mediaElement.pause();
    mediaElement.muted = true;
  }
  const opts: MediaSenderOpts = {
    mediaUrl: media.mediaUrl,
    mediaTitle: media.title,
    mediaContentType: media.contentType,
    mediaElement,
    isVideo: true,
    remoteProxy: { referer: location.href, audioUrl: media.audioUrl },
    // Let the page's own player controls (play/pause button, progress bar)
    // drive the receiver, but gate on real user gestures so Bilibili's
    // autonomous events (autoplay, buffering, quality switches) can't hijack
    // the receiver.
    forwardPageControls: true,
    gestureGatedControls: true,
    // Stop (from the popup) tears down the Cast session. Reset local state so
    // the next Cast click starts a fresh session instead of reusing a stopped
    // one (which left the popup stuck on "casting...").
    onStopped: () => {
      debug("cast stopped; ready to re-cast");
      // Pause the page's own <video> so it doesn't keep playing (or resume
      // via the site's autoplay) now that the receiver has stopped.
      const localVideo =
        document.querySelector<HTMLVideoElement>("video") ?? undefined;
      if (localVideo instanceof HTMLVideoElement && !localVideo.paused) {
        localVideo.pause();
      }
      sender = undefined;
      activeKey = "";
    },
    debug,
  };
  debug(isInitial ? "creating sender" : "playlist item changed", {
    key: media.key,
    title: media.title,
    hasVideoElement: Boolean(mediaElement),
    currentTime: mediaElement?.currentTime,
  });
  activeKey = media.key;
  if (!sender) sender = new MediaSender(opts);
  else await sender.updateMedia(opts);
}

// Re-cast entry point for subsequent extension clicks / script injections
// (see the guard at the top of this file). Every click on the extension for
// an already-injected tab lands here. We ALWAYS start a fresh cast: if a cast
// is already running we tear it down first, then re-run resolve +
// requestSession. This guarantees the receiver selector opens with real
// castable media (a Cast button) instead of the empty device-only view the
// generic background path produces for Bilibili.
window.__fxCastBilibili = {
  isCasting: () => Boolean(sender),
  dashSeek: (time: number) => {
    if (!sender || !Number.isFinite(time) || time < 0) return false;
    debug("popup seek routed to page sender", { time });
    sender.seekDashRemux(time);
    return true;
  },
  controlFromBleRemote: (
    action,
    seekBackwardSeconds,
    seekForwardSeconds
  ) => {
    if (!sender) return false;
    debug("BLE remote routed through page synchronization", {
      action,
      seekBackwardSeconds,
      seekForwardSeconds,
    });
    return sender.controlFromBleRemote(
      action,
      seekBackwardSeconds,
      seekForwardSeconds
    );
  },
  setDebug: (enabled: boolean) => {
    debugEnabled = Boolean(enabled);
    if (!debugEnabled) document.getElementById(DEBUG_PANEL_ID)?.remove();
    debug("debug logging enabled");
  },
  setQuality: (quality: number) => {
    const normalized = QUALITY_ORDER.includes(quality) ? quality : 0;
    if (preferredQuality === normalized) return;
    preferredQuality = normalized;
    debug("quality preference changed", {
      preferredQuality: preferredQuality || "auto",
      isCasting: Boolean(sender),
    });
    if (sender) {
      void loadCurrentItem(false).catch((err) => {
        debug(
          "quality reload failed",
          err instanceof Error ? err.message : String(err)
        );
        logger.error("Failed to reload Bilibili quality", err);
      });
    }
  },
  reinject: () => {
    // Popup auto-cast (onMount) plus a manual click can fire this twice in
    // quick succession; debounce so the second call doesn't stop the cast the
    // first one just started.
    const now = Date.now();
    debug("reinject() called", {
      hasSender: Boolean(sender),
      sinceLastReinjectMs: now - lastReinjectAt,
      willDebounce: now - lastReinjectAt < 1200,
    });
    if (now - lastReinjectAt < 1200) {
      const retryAfterMs = 1200 - (now - lastReinjectAt);
      debug("re-cast ignored; debounced", { retryAfterMs });
      return { status: "debounced", retryAfterMs };
    }
    lastReinjectAt = now;

    if (sender) {
      // Tear down the current cast before starting a fresh one so we don't
      // leave an orphaned receiver session and so requestSession opens a clean
      // selector. stop() invokes onStopped which resets these, but be
      // defensive in case it doesn't fire.
      debug("re-cast: stopping current cast first");
      try {
        sender.stop();
      } catch (err) {
        debug(
          "re-cast stop failed",
          err instanceof Error ? err.message : String(err)
        );
      }
      sender = undefined;
      activeKey = "";
    }

    debug("re-cast requested");
    void loadCurrentItem(true).catch((err) => {
      debug(
        "re-cast FAILED",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      );
      logger.error("Bilibili re-cast failed", err);
    });
    return { status: "started" };
  },
};

debug("module loaded");
void loadCurrentItem(true).catch((err) => {
  debug(
    "FAILED",
    err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  );
  logger.error("Bilibili sender failed", err);
});

// Bilibili changes BV/p inside a SPA. Reload the receiver only when the media
// identity changes; ordinary seeks keep controlling the existing Cast item.
if (window.__fxCastBilibiliNavigationInterval !== undefined) {
  window.clearInterval(window.__fxCastBilibiliNavigationInterval);
}
window.__fxCastBilibiliNavigationInterval = window.setInterval(() => {
  try {
    const nextKey = pageIdentity().key;
    if (activeKey && nextKey !== activeKey) {
      debug("detected playlist navigation", { from: activeKey, to: nextKey });
      void loadCurrentItem(false).catch((err) => {
        debug(
          "playlist reload failed",
          err instanceof Error ? err.message : String(err)
        );
        logger.error("Failed to reload Bilibili playlist item", err);
      });
    }
  } catch {
    // Ignore temporary non-video URLs during SPA transitions.
  }
}, 750);
window.addEventListener(
  "pagehide",
  () => {
    if (window.__fxCastBilibiliNavigationInterval !== undefined) {
      window.clearInterval(window.__fxCastBilibiliNavigationInterval);
      window.__fxCastBilibiliNavigationInterval = undefined;
    }
  },
  { once: true }
);
}
