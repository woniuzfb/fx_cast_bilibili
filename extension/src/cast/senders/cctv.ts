import { Logger } from "../../lib/logger";
import MediaSender, { type MediaSenderOpts } from "./media";

declare global {
  interface Window {
    __fxCastCctv?: {
      reinject: () => { status: "started" | "debounced"; retryAfterMs?: number };
      isCasting: () => boolean;
      /**
       * Resolution preference changed from the popup while casting: reload
       * the media on the SAME cast session (the fresh resolve picks the new
       * variant and the bridge rebuilds its relay).
       */
      setQuality: () => void;
    };
  }
}

// See the equivalent guard in bilibili.ts: a second injection should trigger
// a re-cast and return without throwing, so executeScript doesn't report an
// injection error and leave the popup stuck.
if (window.__fxCastCctv) {
  window.__fxCastCctv.reinject();
} else {
  initCctvSender();
}

function initCctvSender() {
  const logger = new Logger("fx_cast_bilibili [cctv sender]");
  let sender: MediaSender | undefined;
  /** Debounce timestamp so rapid re-cast clicks don't fight each other. */
  let lastReinjectAt = 0;

  interface ResolveResponse {
    mediaUrl?: string;
    /** Real Chrome UA (from docs/ua.json) for the bridge's upstream fetches. */
    userAgent?: string;
    error?: string;
  }

  /**
   * The background captures the live playlist URL off this tab's network
   * traffic (the vdn.live.cntv.cn API that produces it requires an auth-key
   * computed by the site's obfuscated player JS, so we can't call it
   * directly). The player re-requests the playlist every few seconds, so
   * this resolves quickly whenever the live stream is actually playing.
   */
  async function resolveStream(): Promise<{
    mediaUrl: string;
    userAgent?: string;
  }> {
    const response = (await browser.runtime.sendMessage({
      subject: "cctv:resolveStreamUrl",
      data: {},
    })) as ResolveResponse | undefined;
    if (!response?.mediaUrl) {
      throw new Error(response?.error || "Live stream URL unavailable");
    }
    return { mediaUrl: response.mediaUrl, userAgent: response.userAgent };
  }

  function pageVideo(): HTMLVideoElement | undefined {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement ? video : undefined;
  }

  function buildSenderOpts(
    streamReady: Promise<{ mediaUrl: string; userAgent?: string }>
  ): MediaSenderOpts {
    const mediaElement = pageVideo();
    return {
      // loadMedia consumes mediaUrlResolver before parsing this placeholder.
      mediaUrl: location.href,
      mediaUrlResolver: async () => {
        const resolved = await streamReady;
        // Once capture has completed, the relay no longer depends on the page
        // player continuing to refresh its short live playlist.
        mediaElement?.pause();
        logger.info("CCTV live stream ready for cast", {
          mediaUrl: resolved.mediaUrl,
        });
        return resolved;
      },
      mediaElement,
      // Blank on purpose: the receiver's on-screen title and the popup's
      // media title come from this field (the m3u8 itself carries no title),
      // and CCTV page titles are long SEO strings. Empty string (not a
      // space) keeps both blank — the popup's {#if mediaTitle} hides the
      // whole block, and the nullish fallback at loadMedia never fires
      // because "" is not nullish.
      mediaTitle: "",
      mediaContentType: "application/x-mpegURL",
      isVideo: true,
      // The page live player and synthetic VOD use unrelated clocks. Let the
      // receiver drive page play/pause, but never copy currentTime or seeks.
      forwardPageControls: true,
      gestureGatedControls: true,
      syncMediaPosition: false,
      // Deliberately NOT isLive: true. The bridge serves a frozen synthetic
      // DVR playlist (60s history + future segments up to 2h) as a plain
      // VOD, so the receiver plays it as a seekable VOD (starts at t=0,
      // buffers ahead, seek-back through the DVR window). streamType= LIVE
      // would instead make the receiver chase the live edge and starve its
      // buffer (the PLAYING<->BUFFERING flap). Leaving isLive unset keeps
      // streamType at its BUFFERED default, exactly like the working
      // Bilibili path. Forward seeks are clamped behind the live edge by the
      // background (see castManager onMediaMessage); backward seeks are
      // native receiver seeks.
      // Route the stream through the bridge's live HLS relay: Chromecast
      // devices hardcode public DNS and may resolve the Chinese CDNs to
      // slow edge nodes (endless rebuffering on a 3-segment live window),
      // while this machine resolves and downloads them fine. Pass the real
      // Chrome UA (docs/ua.json) so the CDN doesn't throttle the relay.
      remoteProxy: { referer: location.href, hlsLive: true },
      // The CNTV CDN intermittently serves corrupted segments that fatally
      // unload the receiver's media (a desktop player only glitches). Reload
      // automatically at the last position when that happens.
      autoRecoverOnIdle: true,
      onStopped: () => {
        sender = undefined;
      },
    };
  }

  async function startCast() {
    const mediaElement = pageVideo();
    // A paused page player stops refreshing its live playlist. Nudge it to play
    // before capture starts, then leave it running until streamReady resolves.
    // Capture now runs in parallel with receiver selection instead of blocking
    // MediaSender construction and the selector UI.
    void mediaElement?.play().catch(() => undefined);
    const streamReady = resolveStream();
    logger.info("casting CCTV live; stream capture pending");
    sender = new MediaSender(buildSenderOpts(streamReady));
  }

  window.__fxCastCctv = {
    isCasting: () => Boolean(sender),
    setQuality: () => {
      if (!sender) return;
      // Mirror startCast's play nudge: the re-resolve may need to capture the
      // page player's live playlist again, and a paused player stops
      // refreshing it.
      void pageVideo()?.play().catch(() => undefined);
      const streamReady = resolveStream();
      logger.info("CCTV quality changed; reloading media in-session");
      void sender.updateMedia(buildSenderOpts(streamReady)).catch((err) => {
        logger.error("CCTV quality reload failed", err);
      });
    },
    reinject: () => {
      const now = Date.now();
      if (now - lastReinjectAt < 1200) {
        return { status: "debounced", retryAfterMs: 1200 - (now - lastReinjectAt) };
      }
      lastReinjectAt = now;

      if (sender) {
        try {
          sender.stop();
        } catch (err) {
          logger.error("CCTV re-cast stop failed", err);
        }
        sender = undefined;
      }

      void startCast().catch((err) => {
        logger.error("CCTV re-cast failed", err);
      });
      return { status: "started" };
    },
  };

  void startCast().catch((err) => {
    logger.error("CCTV sender failed", err);
  });
}
