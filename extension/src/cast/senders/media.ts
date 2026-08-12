import { Logger } from "../../lib/logger";
import defaultOptions, { type Options } from "../../defaultOptions";

import type { Message } from "../../messaging";

// Cast types
import { AutoJoinPolicy, ReceiverAvailability } from "../sdk/enums";
import type Session from "../sdk/Session";
import type Media from "../sdk/media/Media";

import cast, { ensureInit, type CastPort } from "../export";

const logger = new Logger("fx_cast [media sender]");

/**
 * Read options directly in an injected sender. The shared options singleton
 * extends EventTarget; Firefox isolated worlds do not reliably expose its
 * prototype methods to dynamically injected scripts.
 */
async function getOption<K extends keyof Options>(
  name: K
): Promise<Options[K]> {
  const result = (await browser.storage.sync.get("options")) as {
    options?: Partial<Options>;
  };
  return result.options?.[name] ?? defaultOptions[name];
}

export interface MediaSenderOpts {
  mediaUrl: string;
  mediaElement?: HTMLMediaElement;
  mediaTitle?: string;
  mediaContentType?: string;
  isVideo?: boolean;
  remoteProxy?: { referer: string; audioUrl?: string };
  /**
   * Forward the local media element's play/pause/seek events to the
   * receiver. Disable for sites (e.g. Bilibili) whose own player script
   * autonomously drives the <video> element, which would otherwise hijack
   * the receiver's playback state.
   */
  forwardPageControls?: boolean;
  /**
   * When true, only forward page play/pause/seek events that happen shortly
   * after a real user gesture (pointerdown/keydown). This lets the site's own
   * player controls drive the receiver while ignoring the player script's
   * autonomous events (autoplay, buffering, quality switches).
   */
  gestureGatedControls?: boolean;
  /** Invoked after the Cast session is stopped (e.g. the popup Stop button). */
  onStopped?: () => void;
  debug?: (message: string, data?: unknown) => void;
}

export default class MediaSender {
  private port?: CastPort;

  private mediaUrl: string;
  private mediaTitle?: string;
  private mediaContentType = "";
  private isVideo = false;
  private remoteProxy?: { referer: string; audioUrl?: string };
  private forwardPageControls = true;
  private gestureGatedControls = false;
  private onStopped?: () => void;
  private debug?: (message: string, data?: unknown) => void;

  /** Target media element if loaded as a content script. */
  private mediaElement?: HTMLMediaElement;

  private isLocalMedia = false;
  private isLocalMediaEnabled = false;

  private wasSessionRequested = false;
  private stopOnUnloadEnabled = false;
  private syncElementEnabled = false;
  private hasStoppedForUnload = false;

  // Cast API objects
  private session?: Session;
  private media?: Media;
  private removeMediaElementListeners?: () => void;
  /**
   * The receiver-action (Stop) listener registered on the shared `cast` SDK.
   * The SDK is a reused page singleton (see export.ts ensureInit), so its
   * listener set persists across re-casts. Keep a reference to THIS sender's
   * listener so stop() can remove it; otherwise every re-cast leaks another
   * listener and a single Stop fires stop() once per past sender.
   */
  private receiverActionListener?: (
    receiver: unknown,
    action: unknown
  ) => void;

  constructor(opts: MediaSenderOpts) {
    this.mediaUrl = opts.mediaUrl;
    this.mediaElement = opts.mediaElement;
    this.mediaTitle = opts.mediaTitle;
    this.mediaContentType = opts.mediaContentType ?? "";
    this.isVideo = opts.isVideo ?? false;
    this.remoteProxy = opts.remoteProxy;
    this.forwardPageControls = opts.forwardPageControls ?? true;
    this.gestureGatedControls = opts.gestureGatedControls ?? false;
    this.onStopped = opts.onStopped;
    this.debug = opts.debug;
    this.debug?.("media sender created");
    void this.init().catch((err) => {
      this.debug?.("media sender init failed", String(err));
      logger.error("Media sender init failed", err);
    });
  }

  stop() {
    this.removeMediaElementListeners?.();
    this.removeMediaElementListeners = undefined;
    // Remove this sender's Stop listener from the reused SDK singleton so it
    // doesn't accumulate across re-casts (a leaked listener would make one
    // Stop click fire stop() once per past sender).
    if (this.receiverActionListener) {
      cast.removeReceiverActionListener(this.receiverActionListener);
      this.receiverActionListener = undefined;
    }
    this.port?.postMessage({ subject: "bridge:stopMediaServer" });
    this.session?.stop();
    this.onStopped?.();
  }

  /** Temporarily detach page controls before a programmatic page pause. */
  suspendMediaElementSync() {
    this.removeMediaElementListeners?.();
    this.removeMediaElementListeners = undefined;
  }

  /** Reload a new Bilibili item in the existing Cast session. */
  async updateMedia(opts: MediaSenderOpts) {
    this.debug?.("updating cast media", {
      title: opts.mediaTitle,
      host: new URL(opts.mediaUrl).hostname,
      currentTime: opts.mediaElement?.currentTime,
    });
    this.suspendMediaElementSync();
    this.mediaUrl = opts.mediaUrl;
    this.mediaTitle = opts.mediaTitle;
    this.mediaContentType = opts.mediaContentType ?? "";
    this.mediaElement = opts.mediaElement;
    this.remoteProxy = opts.remoteProxy;
    this.isVideo = opts.isVideo ?? this.isVideo;
    await this.loadMedia();
  }

  private async init() {
    try {
      this.port = await ensureInit();
    } catch (err) {
      logger.error("Failed to initialize cast API", err);
    }

    this.stopOnUnloadEnabled = await getOption("mediaStopOnUnload");
    this.syncElementEnabled = await getOption("mediaSyncElement");
    this.debug?.("media options", {
      stopOnUnload: this.stopOnUnloadEnabled,
      syncElement: this.syncElementEnabled,
      hasMediaElement: this.mediaElement instanceof HTMLMediaElement,
    });

    const stopForUnload = () => {
      if (!this.stopOnUnloadEnabled || this.hasStoppedForUnload) return;
      this.hasStoppedForUnload = true;
      this.debug?.("page unload: stopping receiver session");
      this.port?.postMessage({ subject: "bridge:stopMediaServer" });
      this.session?.stop();
    };
    window.addEventListener("pagehide", stopForUnload, { once: true });
    window.addEventListener("beforeunload", stopForUnload, { once: true });

    // The popup "Stop" button reaches injected senders as a receiver action
    // (cast:receiverAction -> STOP). Without listening for it, only the bridge
    // media server is torn down while the receiver app keeps running, so the
    // popup hangs on "Stopping..." until it times out. Actually stop the
    // Cast session here.
    this.receiverActionListener = (_receiver, action) => {
      if (action === cast.ReceiverAction.STOP) {
        this.debug?.("receiver action: stop requested");
        this.stop();
      }
    };
    cast.addReceiverActionListener(this.receiverActionListener);

    this.isLocalMedia = this.mediaUrl.startsWith("file://");
    this.isLocalMediaEnabled = await getOption("localMediaEnabled");

    if (this.isLocalMedia && !this.isLocalMediaEnabled) {
      throw logger.error("Local media casting not enabled");
    }

    const capabilities = [cast.Capability.AUDIO_OUT];
    if (
      this.isVideo ||
      this.mediaElement instanceof HTMLVideoElement ||
      this.mediaElement instanceof HTMLImageElement
    ) {
      capabilities.push(cast.Capability.VIDEO_OUT);
    }

    this.debug?.("calling cast.initialize", {
      wasSessionRequested: this.wasSessionRequested,
      capabilities: capabilities.length,
    });
    cast.initialize(
      new cast.ApiConfig(
        new cast.SessionRequest(
          cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          capabilities
        ),
        this.sessionListener.bind(this),
        this.receiverListener.bind(this),
        AutoJoinPolicy.PAGE_SCOPED
      ),
      undefined,
      (err) => {
        this.debug?.("cast.initialize error callback", String(err));
        logger.error("Failed to initialize cast SDK", err);
      }
    );
    this.debug?.("cast.initialize returned");
  }

  private sessionListener(session: Session) {
    this.debug?.("session listener: session created", session.sessionId);
    this.session = session;
    this.wasSessionRequested = true;
    void this.loadMedia().catch((err) => {
      this.debug?.("media load failed", String(err));
      logger.error("Media load failed", err);
    });
  }
  private receiverListener(availability: ReceiverAvailability) {
    if (this.wasSessionRequested) return;

    this.debug?.("receiver availability", availability);
    if (availability === cast.ReceiverAvailability.AVAILABLE) {
      this.wasSessionRequested = true;
      this.debug?.("requesting receiver selection");
      cast.requestSession(
        (session) => {
          this.debug?.("cast session created", session.sessionId);
          this.session = session;
          void this.loadMedia().catch((err) => {
            this.debug?.("media load failed", String(err));
            logger.error("Media load failed", err);
          });
        },
        (err) => {
          this.wasSessionRequested = false;
          // Distinguish a user/logic cancellation (selector closed or clobbered
          // by another launch) from a genuine failure. `err` here is the Cast
          // SDK error object; its `code` is "cancel" when the selector was
          // closed out from under this request.
          this.debug?.("receiver selection failed", {
            code: (err as { code?: string })?.code ?? String(err),
            description: (err as { description?: string })?.description,
          });
          logger.error("Session request failed", err);
        }
      );
    }
  }

  private async loadMedia() {
    let mediaUrl = new URL(this.mediaUrl);
    const mediaTitle = this.mediaTitle ?? mediaUrl.pathname.slice(1);
    const subtitleUrls: URL[] = [];

    if (this.remoteProxy) {
      const port = await getOption("localMediaServerPort");
      this.debug?.("starting bridge proxy", {
        port,
        host: mediaUrl.hostname,
        hasSeparateAudio: Boolean(this.remoteProxy.audioUrl),
        expectedMode: this.remoteProxy.audioUrl ? "dash-remux" : "proxy",
      });
      const result = await this.startRemoteMediaServer(
        this.mediaUrl,
        this.remoteProxy.referer,
        this.mediaContentType,
        port,
        this.remoteProxy.audioUrl,
        this.mediaElement instanceof HTMLMediaElement
          ? this.mediaElement.currentTime
          : 0
      );
      mediaUrl = new URL(
        result.mediaPath,
        `http://${result.localAddress}:${port}/`
      );
      mediaUrl.searchParams.set("v", String(Date.now()));
      this.debug?.("bridge proxy ready", mediaUrl.href);
    } else if (this.isLocalMedia) {
      const port = await getOption("localMediaServerPort");
      try {
        const { localAddress, mediaPath, subtitlePaths } =
          await this.startMediaServer(mediaTitle, port);

        const baseUrl = new URL(`http://${localAddress}:${port}/`);
        mediaUrl = new URL(mediaPath, baseUrl);
        subtitleUrls.push(
          ...subtitlePaths.map((path) => new URL(path, baseUrl))
        );
      } catch (err) {
        throw logger.error("Failed to start media server", err);
      }
    }

    this.debug?.("loading media", mediaUrl.href);
    const mediaInfo = new cast.media.MediaInfo(
      mediaUrl.href,
      this.mediaContentType
    );
    mediaInfo.metadata = new cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = mediaTitle;
    mediaInfo.tracks = [];

    const activeTrackIds: number[] = [];

    let trackIndex = 0;
    for (const url of subtitleUrls) {
      const track = new cast.media.Track(
        trackIndex++,
        cast.media.TrackType.TEXT
      );
      track.name = url.pathname;
      track.trackContentId = url.href;
      track.trackContentType = "text/vtt";
      track.subtype = cast.media.TextTrackType.SUBTITLES;

      mediaInfo.tracks.push(track);
    }

    if (this.mediaElement instanceof HTMLMediaElement) {
      if (this.mediaElement instanceof HTMLVideoElement) {
        if (this.mediaElement.poster) {
          mediaInfo.metadata.images = [
            new cast.Image(this.mediaElement.poster),
          ];
        }
      }

      if (this.mediaElement.textTracks.length) {
        const textTracks = Array.from(this.mediaElement.textTracks);
        const trackElements = this.mediaElement.querySelectorAll("track");

        let mediaTrackIndex = mediaInfo.tracks.length;
        textTracks.forEach((track, index) => {
          const trackElement = trackElements[index];

          /**
           * Create media.Track object with the index as the track ID
           * and type as TrackType.TEXT.
           */
          const castTrack = new cast.media.Track(
            mediaTrackIndex,
            cast.media.TrackType.TEXT
          );

          // Copy TextTrack properties
          castTrack.name = track.label || `track-${mediaTrackIndex}`;
          castTrack.language = track.language;
          castTrack.trackContentId = trackElement.src;
          castTrack.trackContentType = "text/vtt";

          switch (track.kind) {
            case "subtitles":
              castTrack.subtype = cast.media.TextTrackType.SUBTITLES;
              break;
            case "captions":
              castTrack.subtype = cast.media.TextTrackType.CAPTIONS;
              break;
            case "descriptions":
              castTrack.subtype = cast.media.TextTrackType.DESCRIPTIONS;
              break;
            case "chapters":
              castTrack.subtype = cast.media.TextTrackType.CHAPTERS;
              break;
            case "metadata":
              castTrack.subtype = cast.media.TextTrackType.METADATA;
              break;

            // Default to subtitles
            default:
              castTrack.subtype = cast.media.TextTrackType.SUBTITLES;
          }

          // Add track to mediaInfo
          mediaInfo.tracks?.push(castTrack);

          // If enabled, mark as active track for load request
          if (track.mode === "showing" || trackElement.default) {
            activeTrackIds.push(mediaTrackIndex);
          }

          mediaTrackIndex++;
        });
      }
    }

    const loadRequest = new cast.media.LoadRequest(mediaInfo);
    loadRequest.autoplay = true;
    loadRequest.activeTrackIds = activeTrackIds;

    if (this.mediaElement instanceof HTMLMediaElement) {
      if (Number.isFinite(this.mediaElement.currentTime)) {
        loadRequest.currentTime = this.mediaElement.currentTime;
      }
      this.debug?.("applying initial media position", {
        currentTime: loadRequest.currentTime,
        sourcePaused: this.mediaElement.paused,
        continuousSync: this.syncElementEnabled,
      });
    }

    this.session?.loadMedia(
      loadRequest,
      (media) => {
        this.debug?.("receiver media loaded");
        this.media = media;
        if (this.mediaElement instanceof HTMLMediaElement) {
          // Silence only the local tab. This assignment happens before
          // controls are attached, so it can never mute the receiver.
          this.mediaElement.muted = true;
          this.debug?.("local page muted; receiver audio unchanged");
        }
        if (
          this.syncElementEnabled &&
          this.forwardPageControls &&
          this.mediaElement instanceof HTMLMediaElement
        ) {
          this.debug?.("media element synchronization enabled");
          this.addMediaElementListeners(this.mediaElement);
        } else if (!this.forwardPageControls) {
          // Page controls are disabled (e.g. Bilibili). Keep the local
          // element parked and muted; the receiver is driven only by the
          // popup, so the page player's own events can't hijack it.
          this.debug?.(
            "page control sync disabled; receiver controlled via popup"
          );
        }
      },
      (err) => {
        this.debug?.("receiver media load rejected", err);
        logger.error("Failed to load media", err);
      }
    );
  }

  private addMediaElementListeners(mediaElement: HTMLMediaElement) {
    const boundMedia = this.media;

    // Receiver -> local sync fires media events on the element (play/pause/
    // seeked). Those events are dispatched on a later macrotask, so a
    // microtask/Promise-based flag would already be cleared by the time they
    // arrive and would be echoed straight back to the receiver, causing
    // feedback (e.g. the receiver pausing itself). Instead, count each
    // programmatic operation and let the matching event handler consume it.
    let suppressPlay = 0;
    let suppressPause = 0;
    let suppressSeek = 0;

    // Gesture gating: when enabled, only forward page media events that
    // happen shortly after a real user gesture. This lets the site's own
    // player controls (play/pause button, progress bar) drive the receiver,
    // while the player script's autonomous events (autoplay, buffering,
    // quality switches) are ignored so they can't hijack the receiver.
    const GESTURE_WINDOW_MS = 1500;
    let lastGestureTime = 0;
    const markGesture = () => {
      lastGestureTime = Date.now();
    };
    const fromGesture = () =>
      !this.gestureGatedControls ||
      Date.now() - lastGestureTime <= GESTURE_WINDOW_MS;
    if (this.gestureGatedControls) {
      window.addEventListener("pointerdown", markGesture, true);
      window.addEventListener("keydown", markGesture, true);
    }

    const sendError = (operation: string) => (err: unknown) => {
      this.debug?.(`page control failed: ${operation}`, err);
      logger.error(`Page control failed: ${operation}`, err);
    };
    const onPlay = () => {
      if (suppressPlay > 0) {
        suppressPlay--;
        return;
      }
      if (!fromGesture()) {
        this.debug?.("ignored autonomous page play");
        return;
      }
      this.debug?.("page control: play");
      boundMedia?.play(undefined, undefined, sendError("play"));
    };
    const onPause = () => {
      if (suppressPause > 0) {
        suppressPause--;
        return;
      }
      if (!fromGesture()) {
        this.debug?.("ignored autonomous page pause");
        return;
      }
      this.debug?.("page control: pause");
      boundMedia?.pause(undefined, undefined, sendError("pause"));
    };
    const onSeeked = () => {
      if (suppressSeek > 0) {
        suppressSeek--;
        return;
      }
      if (!boundMedia) return;
      if (!fromGesture()) {
        this.debug?.("ignored autonomous page seek");
        return;
      }
      const request = new cast.media.SeekRequest();
      request.currentTime = mediaElement.currentTime;
      this.debug?.("page control: seek", request.currentTime);
      boundMedia.seek(request, undefined, sendError("seek"));
    };
    const gated = this.gestureGatedControls;
    const syncFromReceiver = () => {
      if (!boundMedia) return;
      // In gesture-gated mode, mirror the receiver's position/state onto the
      // local <video> so the page's progress bar and play state faithfully
      // follow the receiver. But right after a real user interaction, back
      // off for the gesture window so we don't yank the element back before
      // the user's command reaches the receiver (which would fight the seek).
      if (gated && fromGesture()) return;

      const estimatedTime = boundMedia.getEstimatedTime();
      // Chromecast HLS reports currentTime=-1 while its event timeline is
      // being established. Skip only position reconciliation for that
      // sentinel. Playback-state reconciliation below must still run, or the
      // page video remains paused while the receiver is already PLAYING.
      const canSyncPosition =
        boundMedia.playerState === cast.media.PlayerState.PLAYING ||
        boundMedia.playerState === cast.media.PlayerState.PAUSED;
      if (
        canSyncPosition &&
        Number.isFinite(estimatedTime) &&
        estimatedTime >= 0
      ) {
        const drift = Math.abs(mediaElement.currentTime - estimatedTime);
        const driftLimit =
          boundMedia.playerState === cast.media.PlayerState.PLAYING ? 0.75 : 0.25;
        if (drift > driftLimit) {
          // In gated mode these programmatic writes are filtered by the gesture
          // gate in onSeeked (no recent gesture), so no suppress counter is
          // needed — avoiding the counter drift that used to swallow real seeks.
          if (!gated) suppressSeek++;
          mediaElement.currentTime = estimatedTime;
          if (drift > 1) {
            this.debug?.("corrected local playback drift", {
              drift,
              estimatedTime,
              playerState: boundMedia.playerState,
            });
          }
        }
      }

      const localState = mediaElement.paused
        ? cast.media.PlayerState.PAUSED
        : cast.media.PlayerState.PLAYING;
      if (localState === boundMedia.playerState) return;
      switch (boundMedia.playerState) {
        case cast.media.PlayerState.PLAYING:
          if (!gated && mediaElement.paused) suppressPlay++;
          void mediaElement
            .play()
            .catch((err) => {
              if (!gated) suppressPlay = Math.max(0, suppressPlay - 1);
              logger.error("Failed to sync play state", err);
            });
          break;
        case cast.media.PlayerState.PAUSED:
        case cast.media.PlayerState.BUFFERING:
        case cast.media.PlayerState.IDLE:
          if (!gated && !mediaElement.paused) suppressPause++;
          mediaElement.pause();
          break;
      }
    };
    const onMediaUpdate = (isAlive: boolean) => {
      if (!isAlive) return;
      syncFromReceiver();
    };
    // Receiver status updates are event-driven and may be sparse while media is
    // steadily playing. Reconcile against the SDK's estimated receiver clock so
    // repeated play/pause cycles cannot accumulate local decoder drift.
    const syncIntervalId = window.setInterval(syncFromReceiver, 500);

    mediaElement.addEventListener("play", onPlay);
    mediaElement.addEventListener("pause", onPause);
    mediaElement.addEventListener("seeked", onSeeked);
    boundMedia?.addUpdateListener(onMediaUpdate);
    this.removeMediaElementListeners = () => {
      mediaElement.removeEventListener("play", onPlay);
      mediaElement.removeEventListener("pause", onPause);
      mediaElement.removeEventListener("seeked", onSeeked);
      if (this.gestureGatedControls) {
        window.removeEventListener("pointerdown", markGesture, true);
        window.removeEventListener("keydown", markGesture, true);
      }
      boundMedia?.removeUpdateListener(onMediaUpdate);
      window.clearInterval(syncIntervalId);
      this.debug?.("old page controls detached");
    };
    this.debug?.("page-to-receiver controls attached");
  }

  private startRemoteMediaServer(
    mediaUrl: string,
    referer: string,
    contentType: string,
    port: number,
    audioUrl?: string,
    requiredDuration = 0
  ): Promise<{ mediaPath: string; localAddress: string }> {
    return new Promise((resolve, reject) => {
      if (!this.port) return reject("Cast bridge unavailable");

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.port?.removeEventListener("message", onMessage);
      };
      const onMessage = (ev: MessageEvent<Message>) => {
        const message = ev.data;
        this.debug?.(`bridge: ${message.subject}`, message.data);
        if (message.subject === "mediaCast:mediaServerStarted") {
          this.debug?.("bridge media server reported ready", message.data);
          if (audioUrl && message.data.mode !== "dash-remux") {
            cleanup();
            reject(
              "The installed native bridge does not support DASH remux. " +
                "Rebuild, reinstall, and restart the fx_cast native bridge."
            );
            return;
          }
          cleanup();
          resolve(message.data);
        } else if (message.subject === "mediaCast:mediaServerError") {
          cleanup();
          reject(message.data);
        } else if (message.subject === "mediaCast:mediaServerStopped") {
          this.debug?.("previous bridge proxy stopped");
        }
      };
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject("Timed out waiting for the Cast bridge media server");
      }, audioUrl ? 90_000 : 10_000);

      this.port.addEventListener("message", onMessage);
      this.port.start();
      this.debug?.("sending bridge:startRemoteMediaServer", {
        videoHost: new URL(mediaUrl).hostname,
        audioHost: audioUrl ? new URL(audioUrl).hostname : undefined,
        hasSeparateAudio: Boolean(audioUrl),
        contentType,
        port,
        requiredDuration,
      });
      this.port.postMessage({
        subject: "bridge:startRemoteMediaServer",
        data: {
          mediaUrl,
          audioUrl,
          referer,
          contentType,
          port,
          requiredDuration,
        },
      });
    });
  }

  private startMediaServer(
    filePath: string,
    port: number
  ): Promise<{
    mediaPath: string;
    subtitlePaths: string[];
    localAddress: string;
  }> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject();
        return;
      }

      this.port.postMessage({
        subject: "bridge:startMediaServer",
        data: {
          filePath: decodeURI(filePath),
          port: port,
        },
      });

      const onMessage = (ev: MessageEvent<Message>) => {
        const message = ev.data;

        if (message.subject.startsWith("mediaCast:mediaServer")) {
          this.port?.removeEventListener("message", onMessage);
        }

        switch (message.subject) {
          case "mediaCast:mediaServerStarted":
            resolve(message.data);
            break;
          case "mediaCast:mediaServerError":
            reject(message.data);
            break;
        }
      };

      this.port.addEventListener("message", onMessage);
      this.port.start();
    });
  }
}

/**
 * If loaded as a content script, opts are stored on the window object.
 */
if (window.location.protocol !== "moz-extension:") {
  const window_ = window as any;

  let mediaElement: Optional<HTMLMediaElement>;
  if (window_.targetElementId) {
    mediaElement = browser.menus.getTargetElement(
      window_.targetElementId
    ) as HTMLMediaElement;
  }

  if (typeof window_.mediaUrl === "string") {
    new MediaSender({
      mediaUrl: window_.mediaUrl,
      mediaElement,
    });
  }
}
