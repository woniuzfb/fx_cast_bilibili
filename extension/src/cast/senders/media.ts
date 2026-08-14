import { Logger } from "../../lib/logger";
import defaultOptions, { type Options } from "../../defaultOptions";

import type { Message } from "../../messaging";

// Cast types
import { AutoJoinPolicy, ReceiverAvailability } from "../sdk/enums";
import type Session from "../sdk/Session";
import type Media from "../sdk/media/Media";

import cast, { ensureInit, type CastPort } from "../export";

const logger = new Logger("fx_cast_bilibili [media sender]");

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
  private sessionUpdateListener?: (isAlive: boolean) => void;
  private stopForUnload?: () => void;
  private stopped = false;
  private activeMediaServerRequestId?: string;

  private nextMediaServerRequestId() {
    return crypto.randomUUID();
  }

  private stopOwnedMediaServer(requestId = this.activeMediaServerRequestId) {
    if (!requestId || !this.port) return;
    this.port.postMessage({
      subject: "bridge:stopMediaServer",
      data: { requestId },
    });
    if (this.activeMediaServerRequestId === requestId) {
      this.activeMediaServerRequestId = undefined;
    }
  }

  /**
   * DASH remux mode (Bilibili): the receiver cannot seek inside the
   * sequentially-remuxed HLS (segments past the ffmpeg download frontier
   * don't exist, and the Default Media Receiver treats the event playlist as
   * live). So seeks restart the bridge remux at the target and reload the
   * receiver. The bridge pads the playlist up to the seek target, so the
   * receiver timeline stays in absolute video time (no offset mapping).
   */
  /**
   * While a DASH seek reload is in flight, the old media session reports
   * stale positions/states. Hold receiver->page sync so the sync loop can't
   * yank the page back (which would also queue bogus follow-up seeks).
   */
  private dashSyncHold = false;
  private dashSeekTarget?: number;
  private dashSeekRunning = false;
  /**
   * Incremented on every loadMedia call. A receiver load callback only
   * releases dashSyncHold when it belongs to the latest load, so an older
   * in-flight reload can't resume sync while a newer seek is still loading.
   */
  private dashLoadId = 0;
  /**
   * Set by addMediaElementListeners (it closes over the suppress counters).
   * Invoked when a DASH seek starts so the page video can be paused while
   * the bridge re-prepares the stream without the pause echoing back to the
   * receiver.
   */
  private onDashSeekStart?: (target: number) => void;
  /**
   * Routes a trusted BLE action through the page media event pipeline. The
   * listener closure arms exactly one matching event so gesture gating accepts
   * it, while normal receiver-to-page suppression remains unchanged.
   */
  private onBleRemoteAction?: (
    action: "seek_backward" | "seek_forward" | "pause" | "play",
    seekBackwardSeconds: number,
    seekForwardSeconds: number
  ) => boolean;

  private get isDashRemux() {
    return Boolean(this.remoteProxy?.audioUrl);
  }

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

  stop(stopReceiver = true) {
    if (this.stopped) return;
    this.stopped = true;
    this.dashLoadId++;
    this.dashSeekTarget = undefined;
    this.dashSyncHold = false;
    this.dashTightenSync = false;
    this.suspendMediaElementSync();

    if (this.receiverActionListener) {
      cast.removeReceiverActionListener(this.receiverActionListener);
      this.receiverActionListener = undefined;
    }
    if (this.sessionUpdateListener && this.session) {
      this.session.removeUpdateListener(this.sessionUpdateListener);
      this.sessionUpdateListener = undefined;
    }
    if (this.stopForUnload) {
      window.removeEventListener("pagehide", this.stopForUnload);
      window.removeEventListener("beforeunload", this.stopForUnload);
      this.stopForUnload = undefined;
    }
    if (this.dashSeekDebounceId !== undefined) {
      window.clearTimeout(this.dashSeekDebounceId);
      this.dashSeekDebounceId = undefined;
    }

    this.stopOwnedMediaServer();
    if (stopReceiver) this.session?.stop();
    this.session = undefined;
    this.media = undefined;
    this.mediaElement = undefined;
    this.syncElementEnabled = false;
    this.forwardPageControls = false;
    this.onStopped?.();
  }

  /** Route a trusted BLE action through page-to-receiver synchronization. */
  controlFromBleRemote(
    action: "seek_backward" | "seek_forward" | "pause" | "play",
    seekBackwardSeconds: number,
    seekForwardSeconds: number
  ) {
    if (!this.session || !this.onBleRemoteAction) {
      this.debug?.("BLE remote ignored: sender controls are not ready", {
        action,
      });
      return false;
    }
    return this.onBleRemoteAction(
      action,
      seekBackwardSeconds,
      seekForwardSeconds
    );
  }

  /** Seek a DASH remux session by restarting the remux at the target. */
  seekDashRemux(target: number) {
    if (!this.isDashRemux || !this.session) return;
    if (!Number.isFinite(target) || target < 0) return;
    this.debug?.("dash seek requested", target);
    // Pause/pre-position the page immediately for responsive feedback…
    this.onDashSeekStart?.(target);
    this.dashSeekTarget = target;
    this.dashSyncHold = true;
    // …but debounce the expensive remux restart so rapid seek clicks (popup
    // ±5s button) coalesce into a single reload once clicking stops.
    if (this.dashSeekDebounceId !== undefined) {
      window.clearTimeout(this.dashSeekDebounceId);
    }
    this.dashSeekDebounceId = window.setTimeout(() => {
      this.dashSeekDebounceId = undefined;
      void this.runDashSeek();
    }, MediaSender.DASH_SEEK_DEBOUNCE_MS);
  }

  private dashSeekDebounceId?: number;
  private static DASH_SEEK_DEBOUNCE_MS = 800;
  /**
   * Settle window for the post-seek/post-load tight sync. Keep in sync
   * with SEEK_CONFIRM_WINDOW_MS in ui/popup/mediaTimeline.ts: the popup
   * freezes its optimistic seek bar for the same duration, so a shorter
   * popup window would snap back to the stale position mid-reload.
   */
  private static DASH_TIGHTEN_WINDOW_MS = 15000;
  /**
   * Set while a DASH seek reload is completing; the next valid sync tick
   * performs a one-shot tight (0.25s) position snap to the receiver.
   */
  private dashTightenSync = false;
  /**
   * While a tighten is pending, the new media session may be invisible to
   * this page (reload responses only carry the old session's INTERRUPTED
   * status; the new one arrives via later broadcasts). Poll GET_STATUS to
   * force a full status until the deadline, so reconciliation self-heals.
   */
  private dashTightenDeadline = 0;

  /** Temporarily detach page controls before a programmatic page pause. */
  suspendMediaElementSync() {
    this.removeMediaElementListeners?.();
    this.removeMediaElementListeners = undefined;
    this.onBleRemoteAction = undefined;
  }

  /** Reload a new Bilibili item in the existing Cast session. */
  async updateMedia(opts: MediaSenderOpts) {
    if (this.stopped) return;
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

    this.stopForUnload = () => {
      if (!this.stopOnUnloadEnabled || this.hasStoppedForUnload) return;
      this.hasStoppedForUnload = true;
      this.debug?.("page unload: stopping receiver session");
      this.stop();
    };
    window.addEventListener("pagehide", this.stopForUnload, { once: true });
    window.addEventListener("beforeunload", this.stopForUnload, { once: true });

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

  private bindSession(session: Session) {
    if (this.stopped) {
      session.stop();
      return false;
    }
    if (this.sessionUpdateListener && this.session) {
      this.session.removeUpdateListener(this.sessionUpdateListener);
    }
    this.session = session;
    this.sessionUpdateListener = (isAlive) => {
      if (isAlive || this.stopped) return;
      this.debug?.("cast session ended externally");
      this.stop(false);
    };
    session.addUpdateListener(this.sessionUpdateListener);
    return true;
  }

  private sessionListener(session: Session) {
    this.debug?.("session listener: session created", session.sessionId);
    if (!this.bindSession(session)) return;
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
          if (!this.bindSession(session)) return;
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

  private async loadMedia(startTimeOverride?: number) {
    if (this.stopped) return;
    const loadId = ++this.dashLoadId;
    let mediaUrl = new URL(this.mediaUrl);
    const mediaTitle = this.mediaTitle ?? mediaUrl.pathname.slice(1);
    const subtitleUrls: URL[] = [];
    let bridgePageDuration: number | undefined;

    // In DASH remux mode the bridge restarts ffmpeg at this position and
    // pads the playlist so the receiver timeline stays in absolute video
    // time (receiver currentTime == page currentTime).
    const dashStartTime = this.isDashRemux
      ? startTimeOverride ??
        (this.mediaElement instanceof HTMLMediaElement &&
        Number.isFinite(this.mediaElement.currentTime)
          ? this.mediaElement.currentTime
          : 0)
      : 0;

    if (this.remoteProxy) {
      const port = await getOption("localMediaServerPort");
      this.debug?.("starting bridge proxy", {
        port,
        host: mediaUrl.hostname,
        hasSeparateAudio: Boolean(this.remoteProxy.audioUrl),
        expectedMode: this.remoteProxy.audioUrl ? "dash-remux" : "proxy",
        startTime: this.isDashRemux ? dashStartTime : undefined,
      });
      const requestId = this.nextMediaServerRequestId();
      this.activeMediaServerRequestId = requestId;
      const result = await this.startRemoteMediaServer(
        requestId,
        this.mediaUrl,
        this.remoteProxy.referer,
        this.mediaContentType,
        port,
        this.remoteProxy.audioUrl,
        dashStartTime
      );
      if (this.stopped || loadId !== this.dashLoadId) {
        this.stopOwnedMediaServer(requestId);
        return;
      }
      mediaUrl = new URL(
        result.mediaPath,
        `http://${result.localAddress}:${port}/`
      );
      mediaUrl.searchParams.set("v", String(Date.now()));
      if (
        Number.isFinite(result.pageDuration) &&
        Number(result.pageDuration) > 0
      ) {
        bridgePageDuration = Number(result.pageDuration);
      }
      this.debug?.("bridge proxy ready", mediaUrl.href);
    } else if (this.isLocalMedia) {
      const port = await getOption("localMediaServerPort");
      try {
        const requestId = this.nextMediaServerRequestId();
        this.activeMediaServerRequestId = requestId;
        const { localAddress, mediaPath, subtitlePaths } =
          await this.startMediaServer(requestId, mediaTitle, port);
        if (this.stopped || loadId !== this.dashLoadId) {
          this.stopOwnedMediaServer(requestId);
          return;
        }

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
    if (
      this.mediaElement instanceof HTMLMediaElement &&
      Number.isFinite(this.mediaElement.duration) &&
      this.mediaElement.duration > 0
    ) {
      mediaInfo.duration = this.mediaElement.duration;
    }
    if (this.isDashRemux) {
      // The receiver may not report a duration for the live-style event
      // playlist; the popup falls back to this for its seek bar, and uses
      // the flag to route seeks back to the page sender.
      const elementDuration =
        this.mediaElement instanceof HTMLMediaElement &&
        Number.isFinite(this.mediaElement.duration) &&
        this.mediaElement.duration > 0
          ? this.mediaElement.duration
          : undefined;
      const pageDuration = elementDuration ?? bridgePageDuration;
      mediaInfo.customData = {
        dashRemux: true,
        ...(pageDuration !== undefined ? { pageDuration } : {}),
      };
    }
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
      // DASH remux streams are padded up to dashStartTime, so the initial
      // position is expressed in absolute video time.
      const initialTime = this.isDashRemux
        ? dashStartTime
        : this.mediaElement.currentTime;
      if (Number.isFinite(initialTime)) {
        loadRequest.currentTime = initialTime;
      }
      this.debug?.("applying initial media position", {
        currentTime: loadRequest.currentTime,
        sourcePaused: this.mediaElement.paused,
        continuousSync: this.syncElementEnabled,
      });
    }

    if (!this.session) {
      // No active session: nothing will bind new media, so a DASH seek
      // reload would leave receiver->page sync held (and the tighten
      // polling) forever.
      this.dashSyncHold = false;
      this.dashTightenSync = false;
      this.debug?.("loadMedia skipped: no cast session");
      return;
    }

    // Initial Cast and Bilibili item changes also start/restart the DASH remux
    // at the page position. Arm the same one-shot receiver->page correction
    // used after explicit seeks, but only after bridge preparation has
    // completed so the 15-second settle deadline covers receiver loading.
    const tightenAfterLoad =
      this.isDashRemux && startTimeOverride === undefined;
    if (tightenAfterLoad) {
      this.dashTightenSync = true;
      this.dashTightenDeadline =
        Date.now() + MediaSender.DASH_TIGHTEN_WINDOW_MS;
      this.debug?.("post-load sync armed", {
        reason: this.media ? "media-update" : "initial-cast",
        targetTime: dashStartTime,
      });
    }

    const activeSession = this.session;
    activeSession.loadMedia(
      loadRequest,
      (media) => {
        if (this.stopped || loadId !== this.dashLoadId) {
          this.debug?.("ignored stale receiver media load callback", { loadId });
          return;
        }
        this.debug?.("receiver media loaded");
        this.media = media;
        if (loadId === this.dashLoadId) this.dashSyncHold = false;
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
          // Detach any previous element listeners first: loadMedia also runs
          // for DASH seek reloads, and re-attaching without detaching would
          // stack duplicate listeners and sync intervals.
          this.suspendMediaElementSync();
          if (this.isDashRemux && activeSession.media.length > 2) {
            // Session#loadMedia now resolves only after the new mediaSessionId
            // appears. Keep that current Media plus one generation of history
            // for late receiver statuses, and let WeakMap state follow normal
            // garbage collection once older objects become unreachable.
            activeSession.media = activeSession.media.slice(-2);
            this.debug?.("compacted DASH media history", {
              retainedMediaSessionIds: activeSession.media.map(
                item => item.mediaSessionId
              ),
            });
          }
          this.debug?.("media element synchronization enabled");
          this.addMediaElementListeners(this.mediaElement);
        } else if (!this.forwardPageControls) {
          // Page controls are disabled for this sender. Keep the local
          // element parked and muted; the receiver is driven only by the
          // popup, so the page player's own events can't hijack it.
          // (Bilibili no longer lands here: it forwards page controls with
          // gesture gating — see cast/senders/bilibili.ts.)
          this.debug?.(
            "page control sync disabled; receiver controlled via popup"
          );
        }
      },
      (err) => {
        if (this.stopped || loadId !== this.dashLoadId) return;
        this.debug?.("receiver media load rejected", err);
        if (loadId === this.dashLoadId) {
          this.dashSyncHold = false;
          // A rejected LOAD arrives via this callback — loadMedia never
          // throws for it — so this is the only place a failed seek reload
          // clears the tighten. Otherwise it would linger until its
          // deadline, polling GET_STATUS every second and suppressing
          // normal drift correction.
          this.dashTightenSync = false;
        }
        logger.error("Failed to load media", err);
      }
    );
  }

  private addMediaElementListeners(mediaElement: HTMLMediaElement) {
    // The Media object delivered by the loadMedia callback can be STALE after
    // a reload (seek restart / quality change): the receiver answers the
    // reload with the OLD item's INTERRUPTED status (the new media session
    // only appears in later broadcasts), and Session#loadMedia resolves with
    // the last entry of session.media — i.e. the dead, IDLE-forever old
    // item. Session.media grows with each load and mediaSessionIds
    // increment, so always resolve the latest entry instead of capturing the
    // callback's object.
    const currentMedia = () => {
      const sessionMedia = this.session?.media;
      return sessionMedia && sessionMedia.length
        ? sessionMedia[sessionMedia.length - 1]
        : this.media;
    };
    // Captured only for update-listener symmetry (removeEventListener needs
    // the same object it was added to).
    const listenerMedia = currentMedia();

    // Receiver -> local sync fires media events on the element (play/pause/
    // seeked). Those events are dispatched on a later macrotask, so a
    // microtask/Promise-based flag would already be cleared by the time they
    // arrive and would be echoed straight back to the receiver, causing
    // feedback (e.g. the receiver pausing itself). Instead, count each
    // programmatic operation and let the matching event handler consume it.
    let suppressPlay = 0;
    let suppressPause = 0;
    let suppressSeek = 0;
    const BLE_EVENT_WINDOW_MS = 2000;
    const BLE_SEEK_ARM_WINDOW_MS = 10000;
    let blePlayArmedUntil = 0;
    let blePauseArmedUntil = 0;
    let bleSeekArmedUntil = 0;

    const consumeBleArm = (kind: "play" | "pause" | "seek") => {
      const now = Date.now();
      if (kind === "play") {
        const armed = now < blePlayArmedUntil;
        blePlayArmedUntil = 0;
        return armed;
      }
      if (kind === "pause") {
        const armed = now < blePauseArmedUntil;
        blePauseArmedUntil = 0;
        return armed;
      }
      const armed = now < bleSeekArmedUntil;
      bleSeekArmedUntil = 0;
      return armed;
    };

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
      window.addEventListener("pointerup", markGesture, true);
      window.addEventListener("keydown", markGesture, true);
    }

    // A user seek on the site's progress bar fires `seeking` immediately but
    // `seeked` only after the site's player has fetched the data — for DASH
    // sites (Bilibili) that can take seconds when the target isn't buffered,
    // so the seeked lands outside the gesture window and gets dropped. Arm a
    // grace window on the gesture-adjacent `seeking` and let its matching
    // `seeked` through no matter how late it arrives.
    const SEEK_ARM_WINDOW_MS = 10000;
    let seekArmedUntil = 0;
    const onSeeking = () => {
      if (fromGesture()) seekArmedUntil = Date.now() + SEEK_ARM_WINDOW_MS;
    };

    const sendError = (operation: string) => (err: unknown) => {
      this.debug?.(`page control failed: ${operation}`, err);
      logger.error(`Page control failed: ${operation}`, err);
    };
    const onPlay = () => {
      if (suppressPlay > 0) {
        suppressPlay--;
        return;
      }
      const fromBleRemote = consumeBleArm("play");
      if (!fromBleRemote && !fromGesture()) {
        this.debug?.("ignored autonomous page play");
        return;
      }
      this.debug?.(
        fromBleRemote ? "BLE remote page control: play" : "page control: play"
      );
      // A trusted BLE or user-driven play/pause ends the settle window.
      this.dashTightenSync = false;
      currentMedia()?.play(undefined, undefined, sendError("play"));
    };
    const onPause = () => {
      if (suppressPause > 0) {
        suppressPause--;
        return;
      }
      const fromBleRemote = consumeBleArm("pause");
      if (!fromBleRemote && !fromGesture()) {
        this.debug?.("ignored autonomous page pause");
        return;
      }
      this.debug?.(
        fromBleRemote
          ? "BLE remote page control: pause"
          : "page control: pause"
      );
      // A trusted BLE or user-driven play/pause ends the settle window.
      this.dashTightenSync = false;
      currentMedia()?.pause(undefined, undefined, sendError("pause"));
    };
    // While the bridge re-prepares the stream for a DASH seek, pause the
    // page video (suppressed so the pause isn't forwarded to the receiver)
    // and pre-position it at the target; the sync loop resumes playback once
    // the receiver reports PLAYING again.
    this.onDashSeekStart = (target: number) => {
      if (!mediaElement.paused) {
        suppressPause++;
        mediaElement.pause();
      }
      if (Math.abs(mediaElement.currentTime - target) > 0.1) {
        suppressSeek++;
        mediaElement.currentTime = target;
      }
    };

    const onSeeked = () => {
      if (suppressSeek > 0) {
        suppressSeek--;
        return;
      }
      const boundMedia = currentMedia();
      if (!boundMedia) return;
      // Consume the armed flag whether or not it is still needed: one
      // gesture-adjacent `seeking` legitimizes exactly one `seeked`.
      const seekArmed = Date.now() < seekArmedUntil;
      seekArmedUntil = 0;
      const fromBleRemote = consumeBleArm("seek");
      if (!fromBleRemote && !seekArmed && !fromGesture()) {
        this.debug?.("ignored autonomous page seek");
        return;
      }
      if (fromBleRemote) {
        this.debug?.("BLE remote page control: seek", {
          currentTime: mediaElement.currentTime,
          dashRemux: this.isDashRemux,
        });
      }
      if (this.isDashRemux) {
        // The receiver cannot seek inside the sequentially-remuxed HLS:
        // segments past the ffmpeg download frontier return 404 and the
        // receiver buffers forever. Restart the remux at the target instead.
        this.debug?.("page control: seek (dash remux restart)",
          mediaElement.currentTime);
        this.seekDashRemux(mediaElement.currentTime);
        return;
      }
      const request = new cast.media.SeekRequest();
      request.currentTime = mediaElement.currentTime;
      this.debug?.("page control: seek", request.currentTime);
      boundMedia.seek(request, undefined, sendError("seek"));
    };
    this.onBleRemoteAction = (
      action,
      seekBackwardSeconds,
      seekForwardSeconds
    ) => {
      const now = Date.now();
      if (action === "pause") {
        if (mediaElement.paused) {
          this.debug?.("BLE remote pause already reflected on page");
          currentMedia()?.pause(undefined, undefined, sendError("BLE pause"));
          return true;
        }
        blePauseArmedUntil = now + BLE_EVENT_WINDOW_MS;
        mediaElement.pause();
        return true;
      }
      if (action === "play") {
        if (!mediaElement.paused) {
          this.debug?.("BLE remote play already reflected on page");
          currentMedia()?.play(undefined, undefined, sendError("BLE play"));
          return true;
        }
        blePlayArmedUntil = now + BLE_EVENT_WINDOW_MS;
        void mediaElement.play().catch((error) => {
          blePlayArmedUntil = 0;
          sendError("BLE page play")(error);
        });
        return true;
      }

      const backwardSeconds = Math.max(1, Number(seekBackwardSeconds) || 30);
      const forwardSeconds = Math.max(1, Number(seekForwardSeconds) || 30);
      const delta = action === "seek_backward"
        ? -backwardSeconds
        : forwardSeconds;
      const duration = Number(mediaElement.duration);
      const target = Math.max(
        0,
        Number.isFinite(duration)
          ? Math.min(duration, mediaElement.currentTime + delta)
          : mediaElement.currentTime + delta
      );
      if (Math.abs(target - mediaElement.currentTime) <= 0.01) {
        this.debug?.("BLE remote seek already at boundary", {
          action,
          currentTime: mediaElement.currentTime,
        });
        return true;
      }
      this.debug?.("BLE remote synchronized seek", {
        action,
        from: mediaElement.currentTime,
        target,
        dashRemux: this.isDashRemux,
      });
      if (this.isDashRemux) {
        // Enter the existing DASH seek transaction synchronously. It sets
        // dashSyncHold and suppresses the local page seek before the periodic
        // receiver sync can overwrite the requested target.
        this.seekDashRemux(target);
        return true;
      }
      bleSeekArmedUntil = now + BLE_SEEK_ARM_WINDOW_MS;
      mediaElement.currentTime = target;
      return true;
    };

    const gated = this.gestureGatedControls;
    let lastSyncDebugAt = 0;
    let lastGetStatusPollAt = 0;
    const syncFromReceiver = () => {
      const boundMedia = currentMedia();
      // While a DASH seek reload is settling, log the sync inputs once per
      // second so it's visible exactly where reconciliation is stuck.
      if (
        (this.dashSyncHold || this.dashTightenSync) &&
        Date.now() - lastSyncDebugAt > 1000
      ) {
        lastSyncDebugAt = Date.now();
        this.debug?.("post-seek sync state", {
          hold: this.dashSyncHold,
          tighten: this.dashTightenSync,
          playerState: boundMedia?.playerState,
          estimatedTime: boundMedia?.getEstimatedTime(),
          mediaCount: this.session?.media?.length,
          boundMediaSessionId: boundMedia?.mediaSessionId,
          pageTime: mediaElement.currentTime,
          pagePaused: mediaElement.paused,
        });
      }
      if (!boundMedia) return;
      // A DASH seek reload is restarting the remux and rebinding the media
      // session; the old session's position/state is stale and must not be
      // mirrored onto the page.
      if (this.dashSyncHold) return;
      // In gesture-gated mode, mirror the receiver's position/state onto the
      // local <video> so the page's progress bar and play state faithfully
      // follow the receiver. But right after a real user interaction, back
      // off for the gesture window so we don't yank the element back before
      // the user's command reaches the receiver (which would fight the seek).
      if (gated && fromGesture()) return;

      // Give up on a tighten that never saw PLAYING (e.g. the user paused
      // right after seeking): clear it at the deadline so the flag (and its
      // diagnostics/polling) don't linger forever.
      if (
        this.dashTightenSync &&
        Date.now() >= this.dashTightenDeadline
      ) {
        this.dashTightenSync = false;
        this.debug?.("post-seek sync: tighten expired", {
          playerState: boundMedia.playerState,
        });
      }

      // The reload's new media session becomes visible to this page only
      // when a status carrying its mediaSessionId arrives. If that hasn't
      // happened (the receiver just echoed INTERRUPTED for the old session),
      // poll GET_STATUS — the response carries every active session and
      // re-creates the binding. Throttled and deadline-bound.
      if (
        this.dashTightenSync &&
        Date.now() < this.dashTightenDeadline &&
        boundMedia.playerState !== cast.media.PlayerState.PLAYING &&
        Date.now() - lastGetStatusPollAt > 1000
      ) {
        lastGetStatusPollAt = Date.now();
        this.debug?.("post-seek sync: polling GET_STATUS", {
          playerState: boundMedia.playerState,
          boundMediaSessionId: boundMedia.mediaSessionId,
        });
        this.session?.sendMessage("urn:x-cast:com.google.cast.media", {
          type: "GET_STATUS",
          requestId: 0,
        });
      }

      const rawEstimatedTime = boundMedia.getEstimatedTime();
      // Chromecast HLS reports currentTime=-1 while its event timeline is
      // being established. Skip only position reconciliation for that
      // sentinel. Playback-state reconciliation below must still run, or the
      // page video remains paused while the receiver is already PLAYING.
      const canSyncPosition =
        boundMedia.playerState === cast.media.PlayerState.PLAYING ||
        boundMedia.playerState === cast.media.PlayerState.PAUSED;
      if (
        canSyncPosition &&
        Number.isFinite(rawEstimatedTime) &&
        rawEstimatedTime >= 0
      ) {
        // DASH remux playlists are padded, so receiver positions are already
        // in absolute video time and match the page timeline directly.
        const estimatedTime = rawEstimatedTime;
        const drift = Math.abs(mediaElement.currentTime - estimatedTime);
        // After a DASH seek reload, do a one-shot tight correction (the same
        // 0.25s tolerance the paused-state correction gets) so the page snaps
        // to the receiver's actual start position. Otherwise the loose 0.75s
        // playing tolerance would leave a residual offset forever.
        //
        // Only evaluate once the receiver is actually PLAYING: the
        // PAUSED/BUFFERING reports right after LOAD just echo the requested
        // start position, which would consume the flag while the page is
        // parked at the same value — without correcting anything.
        if (this.dashTightenSync) {
          if (boundMedia.playerState === cast.media.PlayerState.PLAYING) {
            this.dashTightenSync = false;
            if (drift > 0.25) {
              if (!gated) suppressSeek++;
              mediaElement.currentTime = estimatedTime;
              this.debug?.("post-seek sync snap", {
                drift,
                estimatedTime,
                playerState: boundMedia.playerState,
              });
            } else {
              this.debug?.("post-seek sync already aligned", {
                drift,
                estimatedTime,
              });
            }
          }
        } else {
          const driftLimit =
            boundMedia.playerState === cast.media.PlayerState.PLAYING
              ? 0.75
              : 0.25;
          if (drift > driftLimit) {
            // In gated mode these programmatic writes are filtered by the
            // gesture gate in onSeeked (no recent gesture), so no suppress
            // counter is needed — avoiding the counter drift that used to
            // swallow real seeks.
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
    mediaElement.addEventListener("seeking", onSeeking);
    mediaElement.addEventListener("seeked", onSeeked);
    listenerMedia?.addUpdateListener(onMediaUpdate);
    this.removeMediaElementListeners = () => {
      mediaElement.removeEventListener("play", onPlay);
      mediaElement.removeEventListener("pause", onPause);
      mediaElement.removeEventListener("seeking", onSeeking);
      mediaElement.removeEventListener("seeked", onSeeked);
      this.onDashSeekStart = undefined;
      this.onBleRemoteAction = undefined;
      if (this.gestureGatedControls) {
        window.removeEventListener("pointerdown", markGesture, true);
        window.removeEventListener("pointerup", markGesture, true);
        window.removeEventListener("keydown", markGesture, true);
      }
      try {
        listenerMedia?.removeUpdateListener(onMediaUpdate);
      } catch (err) {
        logger.error("Failed to detach media update listener", err);
      } finally {
        window.clearInterval(syncIntervalId);
      }
      this.debug?.("old page controls detached");
    };
    this.debug?.("page-to-receiver controls attached");
  }

  /**
   * Process queued DASH seek targets one at a time (latest wins while a
   * reload is already running). Each seek restarts the bridge remux at the
   * target and reloads the receiver with a keyframe-padded playlist.
   */
  private async runDashSeek() {
    if (this.dashSeekRunning) return;
    this.dashSeekRunning = true;
    try {
      while (this.dashSeekTarget !== undefined) {
        const target = this.dashSeekTarget;
        this.dashSeekTarget = undefined;
        // Re-assert the hold for every reload: a failed previous iteration
        // clears it, and a stale load callback may have released it early.
        this.dashSyncHold = true;
        this.dashTightenSync = true;
        this.dashTightenDeadline =
          Date.now() + MediaSender.DASH_TIGHTEN_WINDOW_MS;
        try {
          await this.loadMedia(target);
        } catch (err) {
          this.dashSyncHold = false;
          // Don't snap to the stale position of a failed reload.
          this.dashTightenSync = false;
          this.debug?.("dash seek reload failed", String(err));
          logger.error("DASH seek reload failed", err);
        }
      }
    } finally {
      this.dashSeekRunning = false;
    }
  }

  private startRemoteMediaServer(
    requestId: string,
    mediaUrl: string,
    referer: string,
    contentType: string,
    port: number,
    audioUrl?: string,
    startTime = 0
  ): Promise<{
    mediaPath: string;
    localAddress: string;
    pageDuration?: number;
    mode?: "proxy" | "dash-remux";
    startTime?: number;
    padBaseSeconds?: number;
  }> {
    return new Promise((resolve, reject) => {
      if (!this.port) return reject("Cast bridge unavailable");

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.port?.removeEventListener("message", onMessage);
      };
      const onMessage = (ev: MessageEvent<Message>) => {
        const message = ev.data;
        this.debug?.(`bridge: ${message.subject}`, message.data);
        if (
          message.subject === "mediaCast:mediaServerStarted" &&
          message.data.requestId === requestId
        ) {
          this.debug?.("bridge media server reported ready", message.data);
          if (audioUrl && message.data.mode !== "dash-remux") {
            cleanup();
            reject(
              "The installed native bridge does not support DASH remux. " +
                "Rebuild, reinstall, and restart the fx_cast_bilibili native bridge."
            );
            return;
          }
          cleanup();
          resolve(message.data);
        } else if (
          message.subject === "mediaCast:mediaServerError" &&
          message.data.requestId === requestId
        ) {
          cleanup();
          reject(message.data.message);
        } else if (
          message.subject === "mediaCast:mediaServerStopped" &&
          message.data.requestId === requestId
        ) {
          cleanup();
          reject(new Error("Media server stopped before becoming ready"));
        } else if (message.subject === "mediaCast:mediaServerStopped") {
          this.debug?.("previous bridge proxy stopped", {
            stoppedRequestId: message.data.requestId,
            pendingRequestId: requestId,
          });
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
        startTime,
      });
      this.port.postMessage({
        subject: "bridge:startRemoteMediaServer",
        data: {
          requestId,
          mediaUrl,
          audioUrl,
          referer,
          contentType,
          port,
          startTime,
        },
      });
    });
  }

  private startMediaServer(
    requestId: string,
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
          requestId,
          filePath: decodeURI(filePath),
          port: port,
        },
      });

      const onMessage = (ev: MessageEvent<Message>) => {
        const message = ev.data;

        const matchingRequest =
          message.subject === "mediaCast:mediaServerStarted" ||
          message.subject === "mediaCast:mediaServerError" ||
          message.subject === "mediaCast:mediaServerStopped"
            ? message.data.requestId === requestId
            : false;
        if (matchingRequest) {
          this.port?.removeEventListener("message", onMessage);
        }

        switch (message.subject) {
          case "mediaCast:mediaServerStarted":
            if (message.data.requestId !== requestId) break;
            resolve(message.data);
            break;
          case "mediaCast:mediaServerError":
            if (message.data.requestId !== requestId) break;
            reject(message.data.message);
            break;
          case "mediaCast:mediaServerStopped":
            if (message.data.requestId !== requestId) break;
            reject(new Error("Media server stopped before becoming ready"));
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
