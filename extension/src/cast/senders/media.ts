import type {
    PagePlaybackDispatchResult,
    PlaybackPageCommand
} from "../../../../shared/playbackCommand";
import { Logger } from "../../lib/logger";
import defaultOptions, { type Options } from "../../defaultOptions";
import { normalizeRokuTranscodePreset } from "../../lib/rokuTranscodePresets";

import type { Message } from "../../messaging";

// Cast types
import { AutoJoinPolicy, ReceiverAvailability } from "../sdk/enums";
import type Session from "../sdk/Session";
import type Media from "../sdk/media/Media";

import cast, { ensureInit, type CastPort } from "../export";
import {
    bindPresentationMedia,
    createDashPresentation,
    identityPresentation,
    normalizeContentId,
    type DashPresentation
} from "../dashPresentation";
import PlaybackCoordinator, {
    type PlaybackIntentOrigin
} from "./playbackCoordinator";

const logger = new Logger("fx_cast_bilibili [media sender]");

/**
 * How long the sender waits for the bridge to report its media server ready.
 * The bridge answers `mediaCast:mediaServerStarted` only after the Roku startup
 * segments are closed, and its own readiness poll gives up after ~90s
 * (900 x 100ms, mediaServer.ts), so this is the sender-side bound on the same
 * window.
 */
const BRIDGE_MEDIA_SERVER_READY_TIMEOUT_MS = 90_000;

/**
 * Liveness cap for the DASH seek priming window - a backstop, not a product
 * promise, and not the popup's seek-confirm window.
 *
 * It has to cover a legitimate rebuild (the bridge needs its startup segments
 * closed before it reports ready, and only then does the receiver load and
 * consume). It must NOT be the popup's 15s settle window: releasing the page
 * mid-rebuild stalls the capture, the readiness gate then never closes, and the
 * seek dies in the sender's bridge-readiness timeout instead of degrading.
 *
 * Ordering, stated as it is: the priming starts at the capture-ready, which the
 * bridge sends BEFORE its own readiness poll starts (mediaServer.ts: the capture
 * input server listens and reports before the media server does), and the
 * sender's ready timeout started even earlier - before the request was posted.
 * So in the live paths this cap expires after the failure paths that clear the
 * priming (a rejected/timed-out LOAD or the media server error). That is a
 * nominal ordering, not a guarantee: the margin below is what keeps a live
 * transaction ending through its own path, and this cap remains the backstop
 * when such a path is itself delayed. The clear path logs the real elapsed time
 * so measurement can replace this reasoning.
 */
const DASH_SEEK_PRIME_MAX_MS = BRIDGE_MEDIA_SERVER_READY_TIMEOUT_MS + 30_000;

/**
 * How long an item/quality transition may hold the receiver's authority off the
 * page. Same budget as a seek's priming: it covers the bridge reconnect, the
 * remux restart and the receiver's LOAD, and it is only the backstop — the
 * window normally closes on the new session's first real position (or on a
 * rejected load).
 */
const DASH_ITEM_TRANSITION_MAX_MS = DASH_SEEK_PRIME_MAX_MS;

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
    /**
     * Lazily supplies the real mediaUrl (+ relay userAgent) before the FIRST
     * load. Lets the receiver selector open immediately while the URL is still
     * being resolved in parallel (CCTV captures the live playlist off the
     * page's network traffic, which takes up to a playlist refresh cycle).
     * `mediaUrl` may be a placeholder when this is provided; loadMedia awaits
     * the resolver once, then reuses this.mediaUrl for reloads (DASH seeks,
     * auto-recovery).
     */
    mediaUrlResolver?: () => Promise<{ mediaUrl: string; userAgent?: string }>;
    /**
     * Roku passive capture: called lazily by MediaSender when the receiver
     * is confirmed as Roku, replacing the playurl pair with the page-captured
     * video/audio. Never called for Chromecast.
     */
    rokuMediaResolver?: () => Promise<{
        mediaUrl: string;
        audioUrl?: string;
    }>;
    mediaElement?: HTMLMediaElement;
    mediaTitle?: string;
    /**
     * The page's own key for the media (its BV/CID pair). Carried so an explicit
     * seek can name the media it was asked for: a seek an item load coalesced is
     * served when THAT item's media is live, and dropped if the page has already
     * moved to a different video.
     */
    mediaIdentity?: string;
    mediaContentType?: string;
    isVideo?: boolean;
    /**
     * Live stream (e.g. CCTV live HLS). Sets MediaInfo streamType to LIVE and
     * skips duration reporting so the receiver/popup treat it as a live
     * broadcast instead of a seekable VOD item.
     */
    isLive?: boolean;
    remoteProxy?: {
        referer: string;
        audioUrl?: string;
        hlsLive?: boolean;
        /** Real Chrome UA (from docs/ua.json) for the bridge's upstream CDN
         *  fetches; used by the live HLS relay to avoid CDN UA throttling. */
        userAgent?: string;
    };
    /**
     * Forward the local media element's play/pause/seek events to the
     * receiver. Disable for sites (e.g. Bilibili) whose own player script
     * autonomously drives the <video> element, which would otherwise hijack
     * the receiver's playback state.
     */
    forwardPageControls?: boolean;
    /**
     * Mirror receiver time/seek position onto the page element. Disable when the
     * page and receiver use different timelines, while retaining play-state sync.
     */
    syncMediaPosition?: boolean;
    /**
     * When true, only forward page play/pause/seek events that happen shortly
     * after a real user gesture (pointerdown/keydown). This lets the site's own
     * player controls drive the receiver while ignoring the player script's
     * autonomous events (autoplay, buffering, quality switches).
     */
    gestureGatedControls?: boolean;
    /** Invoked after the user has selected and the sender has bound a receiver. */
    onReceiverSelected?: (isRoku: boolean) => void;
    /** Invoked after the Cast session is stopped (e.g. the popup Stop button). */
    onStopped?: () => void;
    /**
     * Recover automatically when the receiver's media session dies mid-cast
     * (playerState IDLE without a user stop). The CNTV live CDN intermittently
     * emits corrupted segments; the strict receiver pipeline treats one bad
     * segment as fatal and unloads the media, while desktop players merely
     * glitch. When enabled, the sender reloads the same media at the last known
     * position (mapped onto the freshly rebuilt DVR timeline), stepping forward
     * past corrupt content on repeated quick deaths.
     */
    autoRecoverOnIdle?: boolean;
    debug?: (message: string, data?: unknown) => void;
}

/**
 * How long the page treats a page-route transition as "mine". Mirrors the
 * closure's BLE_EVENT_WINDOW_MS; kept here so a structured caller can report
 * the same window it armed.
 */
const PAGE_EVENT_WINDOW_MS = 2000;

/**
 * What the closure's most recent play/pause dispatch did, and when.
 *
 * `at` is when the DECISION started; `armedAt` is when the page-command arm
 * became visible to page events - different moments, and only the second is a
 * valid boundary for attributing a `pause`/`play` event.
 */
export type PlaybackDispatchResult = {
    outcome: "no-media" | "receiver-only" | "transition" | "page-sync-failed";
    at: number;
    armedAt?: number;
};

export default class MediaSender {
    private port?: CastPort;

    private mediaUrl: string;
    private mediaUrlResolver?: () => Promise<{
        mediaUrl: string;
        userAgent?: string;
    }>;
    private mediaTitle?: string;
    /** The page's key for the media being played, when the caller supplies one. */
    private mediaIdentity?: string;
    private mediaContentType = "";
    private isVideo = false;
    private isLive = false;
    private remoteProxy?: {
        referer: string;
        audioUrl?: string;
        hlsLive?: boolean;
        userAgent?: string;
    };
    private forwardPageControls = true;
    private syncMediaPosition = true;
    /**
     * The play/pause state the USER last asked for, so a reload cannot change it.
     *
     * `loadRequest.autoplay` used to be a hard `true`, so a seek while the popup
     * was holding a pause started playback nobody asked for - the position
     * transaction silently editing the playback intent, which is exactly the
     * ownership split this refactor keeps apart. Written only where a user intent
     * is known: a play/pause the extension dispatches to the receiver (the popup
     * route and a BLE button both land in `dispatchToReceiver` or the
     * already-at-target branch), and a gesture-gated page play/pause the user made
     * in the site's own player. Deliberately NOT written by a receiver report (a
     * LOAD's own autoplay is what makes it play) and NOT by the seek hold, which
     * pauses the receiver because a rebuild is coming.
     */
    private desiredPlayback: "playing" | "paused" = "playing";
    private gestureGatedControls = false;
    private autoRecoverOnIdle = false;
    private preserveSourcePlayback = false;
    /**
     * What the closure's most recent play/pause dispatch did, and when. Written
     * by onBleRemoteAction (which owns the decision) and read by
     * controlPlayback (which must report it without duplicating that logic).
     */
    private lastPlaybackDispatch: PlaybackDispatchResult | null = null;
    private rokuMediaResolver?: MediaSenderOpts["rokuMediaResolver"];
    private onReceiverSelected?: (isRoku: boolean) => void;
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
            data: { requestId }
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
    private dashSeekRunning = false;
    /**
     * Incremented on every loadMedia call. Used to drop a load callback that
     * belongs to a superseded generation, so an older in-flight reload cannot
     * resume sync while a newer seek is still loading.
     */
    private dashLoadId = 0;
    /**
     * Set by addMediaElementListeners (it closes over the suppress counters).
     * Invoked when a DASH seek starts: pause the receiver immediately so the
     * old stream holds, and (Chromecast only) park the page at the target.
     * Roku capture primes the page later via primePageCaptureAt, after the
     * new capture port is listening — seeking earlier dumps the target
     * fragments into the generation that is about to be torn down.
     */
    private onDashSeekStart?: (target: number) => void;
    /**
     * Absolute page time the current capture generation should start at.
     * Primed onto the real <video> only AFTER the new capture port is
     * listening, so the target fragments are ingested here instead of the
     * generation that stopMediaServer just tore down.
     */
    private capturePrimeTarget?: number;
    /** Monotonic id for one DASH seek transaction (a target can repeat). */
    private dashSeekId = 0;
    /**
     * runDashSeek -> loadMedia handoff. Set immediately before loadMedia(target)
     * and consumed (and cleared) SYNCHRONOUSLY at loadMedia's entry, so a pending
     * seek can never leak into the next load.
     */
    private pendingDashSeekPrime?: {
        seekId: number;
        target: number;
        /** Receiver media session bound when the seek started. */
        previousMediaSessionId?: number;
    };
    /**
     * The load a pending seek turned into. primeCaptureSource consumes it to arm
     * the priming for exactly this load/request (never a stale one).
     */
    private dashSeekLoadIdentity?: {
        seekId: number;
        loadId: number;
        requestId?: string;
        target: number;
        previousMediaSessionId?: number;
    };
    /**
     * Seek-scoped source priming: the new capture generation has been primed
     * onto the page, and the receiver's NEW media has not taken over yet.
     *
     * The page is what feeds the capture, so the receiver's own PAUSED - which
     * during this window is the seek's hold echoed by the OLD media session -
     * must not be mirrored onto the page (see reconcilePlaybackState). Once the
     * receiver's new session reports PLAYING, ordinary receiver -> page
     * play/pause authority resumes, so a real user pause still stops the page.
     *
     * Only ever armed for an explicit DASH seek: initial casts, quality changes
     * and capture-recovery reloads keep their behaviour.
     */
    private dashSeekSourcePriming?: {
        requestId: string;
        seekId: number;
        loadId: number;
        target: number;
        previousMediaSessionId?: number;
        /** The current-loadId LOAD callback resolved. */
        loadResolved: boolean;
        startedAt: number;
        deadline: number;
    };

    /**
     * Item-transition window: the page navigation (BV/p change, quality reload)
     * replaced the media the receiver is playing, and the receiver's NEW media
     * has not reported its position yet.
     *
     * While it is open the OLD media session's stale reports must not steer the
     * page: its PAUSED would stop the very player that has to keep supplying the
     * new item's state and controls, and its position would drag the page back
     * into the previous video. Play/pause from the receiver is therefore ignored
     * during the window (BUFFERING still self-heals, see reconcilePlaybackState)
     * and position reconciliation is skipped until the new session's first real
     * position arrives — which is also what closes the window.
     *
     * Unlike the seek-scoped priming this is not about a capture generation: the
     * LOAD is issued with the page's current position as the start, so the page
     * needs no correction when it lands.
     */
    private dashItemTransition?: {
        loadId: number;
        previousMediaSessionId?: number;
        /**
         * The current-loadId LOAD callback resolved. It is the identity evidence
         * when there was no previous session to compare against: without it, any
         * PLAYING report — including one from a session that predates this load —
         * would count as "the new media took over" and close the window early.
         */
        loadResolved: boolean;
        startedAt: number;
        deadline: number;
    };

    /**
     * Seeks/plays the page element with the listener suppress counters armed.
     * Undefined when page controls are detached.
     */
    private primePageCaptureAt?: (target: number) => void;

    // ---- Auto-recovery state (autoRecoverOnIdle) ----
    /**
     * Death is judged by the receiver's BEHAVIOR, not its status reports:
     * the relay reports one message per /seg serve BEYOND the initial
     * prebuffer window (the bridge suppresses the event for the first
     * prebuffered segments — see the background forwarder), and a receiver
     * that keeps being served segments is alive. The liveness clock only
     * STARTS at the first post-prebuffer serve: while the receiver is still
     * inside the prebuffered window there is nothing to judge (it may drain
     * the cache at any pace, or the session may die before ever reaching
     * pipeline-served content — recovery is pointless until the receiver has
     * demonstrated progress). Once started, each serve contributes one period
     * of liveness credit — the slot's MEASURED duration (clamped to 1–2
     * nominal segment periods), because a slot's content can legitimately
     * measure above or below one nominal segment and the receiver's next
     * request arrives accordingly. This preserves credit when the receiver drains several
     * slots in a burst instead of assuming that every request must be followed
     * by another within a fixed wall-clock interval. Recovery fires only after
     * all accumulated credit plus a 1.5-segment jitter allowance has elapsed
     * while the receiver is not paused. A single steady-state serve therefore
     * gets 2.5 segment periods total: one period of earned credit plus 1.5
     * periods for receiver/scheduler jitter.
     */
    /** Segment cadence (seconds) of the current live relay, from the bridge. */
    private relaySegmentStepSeconds = 4;
    private relayActivityTimeoutMs(): number {
        return this.relaySegmentStepSeconds * 1.5 * 1000;
    }
    /**
     * Wall-clock of the last LIVE /seg request the relay proxied.
     * 0 = receiver has not yet fetched beyond the prebuffer — no judgment.
     */
    private lastRelaySegmentRequestAt = 0;
    /**
     * Playback deadline accumulated from post-prebuffer requests. Every request
     * adds one segment period, so burst requests retain credit for later checks.
     */
    private relayLivenessDeadlineAt = 0;
    /** Logs the "requests stopped" transition once per stale episode. */
    private relayStaleLogged = false;
    /** First observation of a liveness failure without a receiver ERROR. */
    private receiverLivenessGraceObservedAt = 0;
    /** Dedupes receiver ERROR diagnostics while the same media remains idle. */
    private receiverErrorLoggedForSession?: number;
    /**
     * Fallback while the receiver is still inside the prebuffer. Prebuffer
     * request cadence is intentionally NOT liveness; instead, track receiver
     * media-time progress so any load that stalls before its first
     * post-prebuffer request can still be detected without penalizing a healthy
     * receiver that consumes cached segments at an arbitrary request rate.
     */
    private prebufferProgressMediaTime?: number;
    private prebufferProgressObservedAt = 0;
    /** Last successful cached prebuffer serve; never arms steady-state liveness. */
    private lastPrebufferSegmentRequestAt = 0;
    /** A recovery reload is in flight / cooling down. */
    private recoverInFlight = false;
    /** Not before this time may another recovery trigger (post-reload cooldown). */
    private recoverNotBeforeAt = 0;
    /**
     * Watchdog that re-attempts recovery after a FAILED reload.
     *
     * Death detection lives in the media-element sync interval, but
     * recoverFromIdleDeath() calls suspendMediaElementSync() (which clears that
     * interval) BEFORE reloading. A SUCCESSFUL reload rebuilds the interval via
     * addMediaElementListeners, but a FAILED reload — e.g. the bridge's boot
     * prebuffer can't fill within the sender's waitForMediaServer timeout, so
     * startRemoteMediaServer rejects with "Timed out waiting for the Cast bridge
     * media server" — leaves nothing running to try again, so recovery would
     * dead-end after a single failure. This timer bridges that gap by
     * re-attempting on a backoff until a reload succeeds (restoring the normal
     * detection loop) or the sender is stopped.
     */
    private recoveryRetryTimer?: number;
    /** A submitted recovery LOAD is not successful until the new relay serves
     * receiver traffic. This independent watchdog survives a missing media
     * callback/sync loop and retries instead of dead-ending on a black screen. */
    private recoveryActivityTimer?: number;
    private recoveryAwaitingRelayActivity = false;
    private recoveryGeneration = 0;
    /** Backoff for consecutive failed recovery attempts (reset on success). */
    private recoveryRetryBackoffMs = 0;
    /** Base/cap for the failed-recovery retry backoff. */
    private static readonly RECOVERY_RETRY_BASE_MS = 15_000;
    private static readonly RECOVERY_RETRY_MAX_MS = 120_000;

    /**
     * Routes a trusted BLE action through the page media event pipeline. The
     * listener closure arms exactly one matching event so gesture gating accepts
     * it, while normal receiver-to-page suppression remains unchanged.
     */
    private onBleRemoteAction?: (
        action: "seek_backward" | "seek_forward" | "pause" | "play",
        seekBackwardSeconds: number,
        seekForwardSeconds: number,
        /**
         * The page-route command this call belongs to, if any. Passed BY
         * ARGUMENT on purpose: the arm has to be attributable to exactly this
         * synchronous call, and the previous implicit handshake (a class field
         * written by `controlPlayback`, read by a same-named LOCAL variable in
         * the listener closure) never connected at all - the arm install block
         * was dead code, so the page route could drive the receiver through the
         * BLE arm while reporting no progress and never confirming.
         */
        pageCommand?: PlaybackPageCommand,
        /**
         * The caller's OWN result slot. The closure still records the last
         * dispatch on the instance (the BLE path has no caller to report to),
         * but a caller that passes a sink reads its own result, so an older
         * dispatch unwinding - a synchronous throw after a re-entrant command
         * already ran - cannot overwrite the newer command's outcome.
         */
        pageDispatchSink?: { dispatch: PlaybackDispatchResult | null }
    ) => boolean;

    /** True while the current receiver session is a Roku device running the
     *  passive page-capture path. */
    isRokuReceiver() {
        return this.session?.receiver.label.startsWith("roku-") === true;
    }

    private get isDashRemux() {
        // Only the true Bilibili DASH remux (separate audio track): the receiver
        // cannot seek inside the sequentially-remuxed HLS, so seeks restart the
        // bridge remux at the target. The CCTV live relay is NOT part of this
        // path — see isHlsDvr.
        return Boolean(this.remoteProxy?.audioUrl);
    }

    /**
     * CCTV live synthetic DVR: the bridge serves a frozen, fully-synthesized
     * VOD playlist (60s history + future segments up to 2h). It is a plain
     * seekable VOD on the receiver, so seeks go through the receiver's native
     * SEEK — except forward seeks, which the background clamps to the live
     * edge so they never target segments the CDN hasn't published yet.
     */
    private get isHlsDvr() {
        return Boolean(this.remoteProxy?.hlsLive);
    }

    /**
     * Synthetic-DVR live-edge anchor, set when the bridge reports one. At
     * builtAtMs the edge sits at baseSeconds in the VOD timeline; it advances
     * with wall clock. Kept in sync with the clamp in background/castManager
     * (which reads the same values from customData).
     */
    private dvrLiveEdge?: { baseSeconds: number; builtAtMs: number };

    /** Forward seeks stay this far behind the live edge (published segments only). */
    private static DVR_FORWARD_SEEK_MARGIN_SECONDS = 60;

    /** Current live-edge offset (seconds) in the synthetic DVR timeline. */
    private dvrLiveEdgeSeconds(): number | undefined {
        if (!this.dvrLiveEdge) return undefined;
        return (
            this.dvrLiveEdge.baseSeconds +
            (Date.now() - this.dvrLiveEdge.builtAtMs) / 1000
        );
    }

    constructor(opts: MediaSenderOpts) {
        this.mediaUrl = opts.mediaUrl;
        this.mediaUrlResolver = opts.mediaUrlResolver;
        this.mediaElement = opts.mediaElement;
        this.mediaTitle = opts.mediaTitle;
        this.adoptMediaIdentity(opts);
        this.mediaContentType = opts.mediaContentType ?? "";
        this.isVideo = opts.isVideo ?? false;
        this.isLive = opts.isLive ?? false;
        this.remoteProxy = opts.remoteProxy;
        this.forwardPageControls = opts.forwardPageControls ?? true;
        this.syncMediaPosition = opts.syncMediaPosition ?? true;
        this.gestureGatedControls = opts.gestureGatedControls ?? false;
        this.autoRecoverOnIdle = opts.autoRecoverOnIdle ?? false;
        this.rokuMediaResolver = opts.rokuMediaResolver;
        this.onReceiverSelected = opts.onReceiverSelected;
        this.onStopped = opts.onStopped;
        this.debug = opts.debug;
        this.debug?.("media sender created");
        void this.init().catch(err => {
            this.debug?.("media sender init failed", String(err));
            logger.error("Media sender init failed", err);
        });
    }

    /**
     * The page element a previous item/quality change took audio ownership of,
     * and its muted state before that. Tracked here (not by the page sender) so
     * the restore on stop covers the CURRENT element: the site's player rebuilds
     * its <video> on navigation, and restoring only the element captured at the
     * original selection would leave the new one muted forever.
     */
    private ownedMediaElement?: HTMLMediaElement;
    private ownedMediaElementMuted?: boolean;

    /**
     * Take audio ownership of a NEW page element after an item/quality change.
     *
     * This is the updateMedia counterpart of the initial selection's
     * "pause + mute": the page must keep PLAYING (it is the state source, the
     * control source and — on Roku — the capture source), so only the audio is
     * taken, and idempotently. The previous element's muted state is restored
     * first if the site replaced the element, and ownership moves to the new one
     * so stop() restores the right element.
     */
    prepareUpdatedMediaElement(element?: HTMLMediaElement) {
        if (!(element instanceof HTMLMediaElement)) return;
        if (this.ownedMediaElement && this.ownedMediaElement !== element) {
            if (
                this.ownedMediaElementMuted !== undefined &&
                this.ownedMediaElement.isConnected
            ) {
                this.ownedMediaElement.muted = this.ownedMediaElementMuted;
            }
            this.ownedMediaElement = undefined;
            this.ownedMediaElementMuted = undefined;
        }
        if (!this.ownedMediaElement) {
            this.ownedMediaElement = element;
            this.ownedMediaElementMuted = element.muted;
        }
        element.muted = true;
        this.debug?.("updated media element muted; page playback untouched", {
            currentTime: element.currentTime,
            paused: element.paused,
            originalMuted: this.ownedMediaElementMuted
        });
    }

    /** Give the page element's audio state back (stop). */
    private restoreOwnedMediaElement() {
        if (
            this.ownedMediaElement &&
            this.ownedMediaElementMuted !== undefined &&
            this.ownedMediaElement.isConnected
        ) {
            this.ownedMediaElement.muted = this.ownedMediaElementMuted;
        }
        this.ownedMediaElement = undefined;
        this.ownedMediaElementMuted = undefined;
    }

    stop(stopReceiver = true) {
        if (this.stopped) return;
        this.stopped = true;
        this.dashLoadId++;
        this.capturePrimeTarget = undefined;
        this.dashSeekLoadIdentity = undefined;
        this.clearDashSeekSourcePriming("stopped");
        this.clearDashItemTransition();
        // Every pending intent is void once the cast is gone: no transaction
        // survives a stop, and no orphaned "seeking" phase can hold the page.
        this.playbackCoordinator.reset("stopped");
        // No command can be confirmed after the cast is gone.
        this.pendingReceiverPlaybackEcho = undefined;
        this.suspendMediaElementSync();
        this.clearRecoveryActivityWatchdog();
        this.clearRecoveryRetry();

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
        this.clearRecoveryRetry();

        this.stopOwnedMediaServer();
        if (stopReceiver) this.session?.stop();
        this.session = undefined;
        this.media = undefined;
        this.restoreOwnedMediaElement();
        this.mediaElement = undefined;
        this.syncElementEnabled = false;
        this.forwardPageControls = false;
        this.onStopped?.();
    }

    /**
     * True when `requestId` is the bridge media-server generation this sender
     * is currently bound to — used to drop stale asynchronous notifications
     * (e.g. a capture overflow from a generation that was already replaced).
     */
    isCurrentMediaServerRequest(requestId: string) {
        return this.activeMediaServerRequestId === requestId;
    }

    /**
     * Command the receiver's play/pause, recording that WE did.
     *
     * Every dispatch goes through here - the user's own intents (page, popup, BLE)
     * and the extension's internal one (the seek hold) - so the observation they
     * cause can be told apart from the user moving the receiver themselves: the
     * report that confirms THIS command is its echo, and a state the user chose is
     * by definition not the one we asked for.
     *
     * What is recorded is a PENDING command (see `pendingReceiverPlaybackEcho`),
     * not "the last state we ever asked for": the difference is the whole point -
     * a memory of the last command refuses a later REAL remote action that happens
     * to equal it.
     *
     * A command the receiver REFUSES is not pending either. The SDK reports that
     * asynchronously on the error callback, and an echo that never comes would
     * otherwise stay armed for the whole confirmation window: the user pressing
     * the same state on the physical remote would be dismissed as the echo of a
     * command the receiver never accepted. The revocation is by COMMAND INSTANCE,
     * because the callbacks are asynchronous: a late error for command A must not
     * disarm command B, which is the one the receiver is actually confirming now.
     */
    private commandReceiverPlayback(
        media: Media,
        action: "play" | "pause",
        onError: (err: unknown) => void
    ) {
        const pending: {
            playerState: "PLAYING" | "PAUSED";
            mediaSessionId?: number;
            issuedAt: number;
        } = {
            playerState:
                action === "play"
                    ? cast.media.PlayerState.PLAYING
                    : cast.media.PlayerState.PAUSED,
            mediaSessionId: media.mediaSessionId,
            issuedAt: Date.now()
        };
        this.pendingReceiverPlaybackEcho = pending;
        const failed = (err: unknown) => {
            // Only THIS command's echo is revoked, and only while it is still the
            // one being awaited.
            if (this.pendingReceiverPlaybackEcho === pending) {
                this.pendingReceiverPlaybackEcho = undefined;
                this.debug?.(
                    "receiver refused the play/pause this extension commanded: nothing is awaited",
                    { playerState: pending.playerState, err: String(err) }
                );
            }
            onError(err);
        };
        // The SDK's Media takes an explicit `undefined` request and the success
        // callback before the error callback, which is the shape every sender call
        // site already used; routing them through here is what records the command.
        if (action === "play") {
            media.play(undefined, undefined, failed);
        } else {
            media.pause(undefined, undefined, failed);
        }
    }

    /** Record the play/pause state the user asked for. */
    private noteDesiredPlayback(action: "play" | "pause") {
        this.desiredPlayback = action === "play" ? "playing" : "paused";
    }

    /**
     * The last receiver state the mirror saw, and which media session reported it
     * (see noteReceiverReport / adoptReceiverPlaybackIntent). Kept as the raw
     * pair, because the whole question is "did THIS session move", which no
     * device-level or page-level value can answer.
     */
    private lastReceiverReport?: {
        mediaSessionId?: number;
        playerState: string;
    };
    /**
     * The play/pause command still WAITING to be confirmed by the receiver.
     *
     * The receiver reports back what it was told, and one of those commands is
     * ours alone: a DASH seek pauses the receiver to hold the frame while the remux
     * is rebuilt (`onDashSeekStart`), which the user never asked for. Reading that
     * echo as a user intent set `desiredPlayback = paused`, so the seek's own
     * reload came back `autoplay: false` and the page - which follows the receiver -
     * stopped: a seek that silently paused playback.
     *
     * It is deliberately NOT "the state we last commanded". Those are different
     * questions, and answering the second one loses real user actions: our PLAY is
     * confirmed, the user then PAUSES and PLAYS on the physical remote, and that
     * later PLAY equals what we once asked for - a sticky memory refuses it as an
     * echo, so the intent stays paused and the next seek pauses playback again.
     * Hence the three things this record carries:
     *
     *   - the SESSION it was sent to. A command belongs to the media session of its
     *     day; the item change's new session is the user's to move, and a report
     *     from it can never be an echo of a command aimed at the previous one.
     *   - WHEN it was sent. A confirmation that never comes must not arm the
     *     refusal forever (see RECEIVER_ECHO_CONFIRM_WINDOW_MS).
     *   - that it is CONSUMED. One command, one echo: once answered - or refuted by
     *     a settled report on that session that does not match it - it is gone.
     */
    private pendingReceiverPlaybackEcho?: {
        playerState: "PLAYING" | "PAUSED";
        mediaSessionId?: number;
        issuedAt: number;
    };
    /**
     * How long a play/pause command's echo is expected to take.
     *
     * Generous on purpose: a Chromecast confirms in well under a second, a Roku
     * within one of the bridge's ECP polls (~3s). What matters is that the window
     * ENDS - past it a report is the user's by definition, because "we asked for
     * this at some point" cannot be a reason to ignore them. Matches the seek's own
     * confirmation budget (DASH_TIGHTEN_WINDOW_MS, same 15s), which is how long a
     * seek hold's echo has to come back before the cast is treated as settled on
     * its own.
     */
    private static RECEIVER_ECHO_CONFIRM_WINDOW_MS = 15000;
    /**
     * What the receiver reported BEFORE the report this tick is handling.
     *
     * Recorded once per tick, at the tick's own entry (see the call site), because
     * the decision that consumes it lives deeper in the flow - behind windows that
     * are allowed to suppress the ACTION but never the memory.
     */
    private previousReceiverReport?: {
        mediaSessionId?: number;
        playerState: string;
    };

    /**
     * Remember what the receiver just reported, for the NEXT report to be compared
     * against.
     *
     * Separate from the decision below, and called BEFORE every suppression rule in
     * the tick on purpose: the windows that suppress an ACTION (an item
     * transition's PAUSED, a seek transaction's stale state) must not suppress the
     * MEMORY. Skipping the memory made the first report after such a window look
     * like "a session we have never seen" - so a receiver PLAY/PAUSE that arrived
     * while the window was open was not just ignored, it made the NEXT one
     * unadoptable too, and the user's pause was lost twice over.
     */
    private noteReceiverReport(media: {
        playerState: string;
        mediaSessionId?: number;
    }): { mediaSessionId?: number; playerState: string } | undefined {
        const previous = this.lastReceiverReport;
        this.lastReceiverReport = {
            mediaSessionId: media.mediaSessionId,
            playerState: media.playerState
        };
        return previous;
    }

    /**
     * Adopt a receiver PLAY/PAUSE the extension did NOT command as the user's
     * playback intent, so a following reload LOADs in the state the user left the
     * receiver in.
     *
     * A pause pressed on the PHYSICAL remote (or on the receiver's own UI, or by
     * another controller) reaches this sender as an observation, and nothing says
     * "the user asked for this" except the observation itself. Without adopting
     * it, `desiredPlayback` keeps describing the extension's last command, and the
     * next seek LOADs `autoplay: true` — silently resuming playback the user
     * stopped. The physical remote IS the user, so its state is intent.
     *
     * Each guard below is a way the receiver moves WITHOUT the user, which is what
     * makes "not our command" decidable at all:
     *
     *   - only a SETTLED state counts. BUFFERING/IDLE are the transitions our own
     *     load and seek transactions produce (and are what the page hold covers);
     *     adopting one would inherit a state nobody asked for.
     *   - the state must CHANGE on a media session we have already reported: the
     *     first state of a NEWER session is the receiver starting the session WE
     *     just loaded. On a Roku that relaunch auto-plays regardless of
     *     `autoplay`, so adopting it would overwrite a pause the user did ask for
     *     with the device's own startup state.
     *   - the state must not be the FIRST report of a session we just created: a
     *     LOAD creates that session, and on a Roku its first state is the device
     *     auto-playing whatever `autoplay` said. That IS the same-session rule
     *     above, which is why nothing else has to exclude our own transaction - and
     *     why a real user action arriving while a load settles is still adopted.
     *
     * When adoption happens it is logged, because "the intent changed without a
     * command" is otherwise invisible in a trace. The page still follows the
     * receiver in `reconcilePlaybackState` either way — this only decides what the
     * NEXT reload inherits.
     */
    private adoptReceiverPlaybackIntent(
        media: { playerState: string; mediaSessionId?: number },
        /** What the receiver reported before this one (see noteReceiverReport). */
        previous: { mediaSessionId?: number; playerState: string } | undefined
    ): void {
        const state = media.playerState;
        const settled =
            state === cast.media.PlayerState.PLAYING ||
            state === cast.media.PlayerState.PAUSED;
        if (!settled) return;
        if (
            previous === undefined ||
            previous.playerState === state ||
            media.mediaSessionId === undefined ||
            previous.mediaSessionId !== media.mediaSessionId
        ) {
            return;
        }
        // The observation must not be the ECHO OF A COMMAND WE ISSUED.
        //
        // A hold guard (`isHoldingPage()`) is NOT the right test here: a real user
        // action that happens to arrive while our own load settles must still be
        // adopted (the phase-3 generator found exactly that case). What must never
        // be adopted is the confirmation of the command we are WAITING on - and one
        // of those commands is not a user intent at all: a DASH seek pauses the
        // receiver to hold the frame while the remux is rebuilt. Reading that echo
        // as intent made the seek's own reload come back `autoplay: false`, and the
        // page, which follows the receiver, stopped with it.
        //
        // Either way this report SETTLES the pending command: it is its echo (and
        // is consumed), or it is a state our command does not explain - which is the
        // user moving the receiver, so the command must stop being awaited.
        const reportedPlaybackState =
            state === cast.media.PlayerState.PLAYING ? "PLAYING" : "PAUSED";
        const pending = this.pendingReceiverPlaybackEcho;
        // The session must be KNOWN and EQUAL, on both sides. An unknown session
        // is not evidence that this report is ours, and treating it as a wildcard
        // would let a command we could not attribute swallow a real action on
        // whatever session comes next (the relaunch window is exactly when a media
        // has no session id yet). The safe direction is the same one the generation
        // gate follows: refuse a state only on evidence, and where there is none,
        // the user wins - a wrongly-adopted echo shows up immediately as a paused
        // reload, while a wrongly-refused user pause is silent.
        const sameKnownSession =
            pending !== undefined &&
            pending.mediaSessionId !== undefined &&
            media.mediaSessionId !== undefined &&
            pending.mediaSessionId === media.mediaSessionId;
        const echo =
            sameKnownSession &&
            pending.playerState === reportedPlaybackState &&
            Date.now() - pending.issuedAt <=
                MediaSender.RECEIVER_ECHO_CONFIRM_WINDOW_MS;
        this.pendingReceiverPlaybackEcho = undefined;
        if (echo) {
            this.debug?.(
                pending?.mediaSessionId === media.mediaSessionId
                    ? "receiver confirmed the command this extension is waiting on: not an intent"
                    : "receiver confirmed a command issued before this session's states: not an intent",
                {
                    receiverState: state,
                    mediaSessionId: media.mediaSessionId,
                    commandedForSession: pending?.mediaSessionId
                }
            );
            return;
        }
        const desired =
            state === cast.media.PlayerState.PLAYING ? "play" : "pause";
        if (
            this.desiredPlayback === (desired === "play" ? "playing" : "paused")
        ) {
            return;
        }
        this.noteDesiredPlayback(desired);
        this.debug?.(
            "receiver moved on its own: the playback intent follows it",
            {
                receiverState: state,
                mediaSessionId: media.mediaSessionId,
                desiredPlayback: this.desiredPlayback
            }
        );
    }

    /** Route a trusted BLE action through page-to-receiver synchronization. */
    controlFromBleRemote(
        action: "seek_backward" | "seek_forward" | "pause" | "play",
        seekBackwardSeconds: number,
        seekForwardSeconds: number
    ) {
        if (!this.session) return false;
        if (this.onBleRemoteAction) {
            return this.onBleRemoteAction(
                action,
                seekBackwardSeconds,
                seekForwardSeconds
            );
        }
        // The page-event closure is detached for the duration of a reload
        // (`suspendMediaElementSync`), deliberately: the site's own page events
        // must not steer the receiver while a new item loads. A BLE command is NOT
        // a page event though — it comes from the physical remote — and routing it
        // through that closure dropped it entirely, so of a racing pair (popup seek
        // 5:00, then BLE skip to 0:00) the OLDER intent won because the newer one
        // never became an intent at all.
        //
        // A BLE PLAY/PAUSE is not a skip either, and must not reach the skip
        // arithmetic below: its delta only branches on `seek_backward`, so play and
        // pause both fell into the `forward` case and became a forward seek during
        // every reload window. With the page transition impossible here (there are
        // no page controls to drive), the correct behaviour is the closure's
        // receiver-only branch, in the same order: the user's intent first, then
        // the receiver.
        if (action === "play" || action === "pause") {
            const media = this.currentReceiverMedia();
            if (!media) {
                this.debug?.("BLE play/pause ignored: no cast media", {
                    action
                });
                return false;
            }
            this.noteDesiredPlayback(action);
            this.debug?.(
                "BLE playback command with the page controls detached",
                {
                    action
                }
            );
            const onError = (err: unknown) =>
                this.debug?.("BLE playback command failed", { action, err });
            this.commandReceiverPlayback(media, action, onError);
            return true;
        }
        if (!this.isDashRemux) return false;
        const seek = this.bleSeekTarget(
            action,
            seekBackwardSeconds,
            seekForwardSeconds
        );
        if (seek.kind === "no-op") return true;
        if (seek.kind === "unsupported") {
            this.debug?.("BLE remote ignored: no page position to skip from", {
                action
            });
            return false;
        }
        this.debug?.("BLE remote seek with the page controls detached", {
            action,
            target: seek.target
        });
        this.seekDashRemux(seek.target, "ble");
        return true;
    }

    /**
     * Adopt the media key the caller supplied, retiring any pending seek that
     * named a DIFFERENT media.
     *
     * The page's key is the only thing that can tell "the seek the user made while
     * this item was loading" from "a seek left over from the previous video": both
     * are plain page positions by the time they reach the coordinator, and without
     * the key, serving a leftover intent on the next item's media would start
     * playback at a position nobody asked for. A quality change passes the SAME key
     * (one video, one item), so a pending seek survives it.
     */
    private adoptMediaIdentity(opts: MediaSenderOpts) {
        if (opts.mediaIdentity === undefined) return;
        if (opts.mediaIdentity !== this.mediaIdentity) {
            this.playbackCoordinator.noteMediaIdentity(opts.mediaIdentity);
        }
        this.mediaIdentity = opts.mediaIdentity;
    }

    /** The media the receiver is currently playing (newest session entry). */
    private currentReceiverMedia() {
        const sessionMedia = this.session?.media;
        return sessionMedia && sessionMedia.length
            ? sessionMedia[sessionMedia.length - 1]
            : this.media;
    }

    /**
     * Where a BLE skip lands, from the page's own position.
     *
     * ONE implementation, used by the page-event closure (which owns the arm and
     * the page-write path for a non-remux receiver) and by
     * `controlFromBleRemote`'s direct path above. Two copies of this arithmetic
     * would be two answers to "where does this skip go".
     *
     * The parameter type is the SEEK actions only, on purpose: the delta below has
     * no branch for play/pause, so accepting them here is what turned a BLE
     * play/pause into a forward skip. Narrowing it is the compiler enforcing that
     * contract, not documentation of it.
     */
    private bleSeekTarget(
        action: "seek_backward" | "seek_forward",
        seekBackwardSeconds: number,
        seekForwardSeconds: number
    ):
        | { kind: "seek"; target: number }
        | { kind: "no-op"; target: number }
        | { kind: "unsupported" } {
        const element = this.mediaElement;
        if (!(element instanceof HTMLMediaElement)) {
            return { kind: "unsupported" };
        }
        const backwardSeconds = Math.max(1, Number(seekBackwardSeconds) || 30);
        const forwardSeconds = Math.max(1, Number(seekForwardSeconds) || 30);
        const delta =
            action === "seek_backward" ? -backwardSeconds : forwardSeconds;
        const current = element.currentTime;
        if (!Number.isFinite(current) || current < 0) {
            return { kind: "unsupported" };
        }
        const duration = Number(element.duration);
        const target = Math.max(
            0,
            Number.isFinite(duration)
                ? Math.min(duration, current + delta)
                : current + delta
        );
        return Math.abs(target - current) <= 0.01
            ? { kind: "no-op", target }
            : { kind: "seek", target };
    }

    /**
     * Is a transaction currently driving the page?
     *
     * The ONE place that answers this. The coordinator owns the transaction
     * phase, and the two capture-side windows that outlive a LOAD (the seek's
     * source priming and an item transition) are ORed in here rather than at each
     * call site — previously the answer was assembled from a combination of
     * `dashSyncHold`, `dashTightenSync`, `dashSeekSourcePriming` and
     * `dashItemTransition` wherever it was needed, so a site that read three of
     * the four behaved differently from a site that read all of them.
     *
     * `dashSyncHold` is GONE (not merely derived): it had become an alias of the
     * coordinator's own transaction, covering only ONE of the three conditions
     * here, and every reader now asks this method instead — so a live priming or
     * item-transition window can no longer be invisible to the mirror hold.
     *
     * ORDERING MATTERS AS MUCH AS UNIFICATION. Because this predicate includes the
     * item-transition window, a caller that returns on it BEFORE giving that window
     * a chance to close makes the window's own release unreachable — it holds
     * itself alive until its backstop expires. See the tick in
     * addMediaElementListeners, where window advancement runs first.
     *
     * Still NOT unified: `dashTightenSync`/`dashTightenDeadline` remain separate
     * mechanical state (post-load settle position + GET_STATUS polling), and the
     * priming window is not yet a member of the coordinator's transaction.
     */
    private isHoldingPage(): boolean {
        return this.pageHoldState().holding;
    }

    /**
     * The ONE derivation of the page hold, and which condition causes it.
     *
     * Both entry points read THIS, so the boolean and its explanation cannot list
     * different conditions. `isHoldingPage()` is what decisions use;
     * `describePageHold()` exposes the same computation for diagnostics, where
     * knowing WHICH window holds the page is the whole point — a single boolean
     * cannot distinguish the coordinator's own transaction from a capture window
     * that outlived it.
     */
    private pageHoldState(): {
        holding: boolean;
        coordinatorTransaction: boolean;
        seekPriming: boolean;
        itemTransition: boolean;
    } {
        const coordinatorTransaction = this.playbackCoordinator.isHoldingPage();
        const seekPriming = this.dashSeekSourcePriming !== undefined;
        const itemTransition = this.dashItemTransition !== undefined;
        return {
            holding: coordinatorTransaction || seekPriming || itemTransition,
            coordinatorTransaction,
            seekPriming,
            itemTransition
        };
    }

    /**
     * Bind the receiver's media session id to the adapter, but ONLY on evidence
     * that the media belongs to this generation.
     *
     * ## Why the LOAD callback is not evidence
     *
     * The callback's Media argument can be the STALE previous session: the
     * receiver answers a reload with the old item's INTERRUPTED status, and
     * `Session#loadMedia` resolves with the last entry of the session's media
     * stack. The old code bound that argument, so a reload taught the adapter the
     * PREVIOUS media session id — and since the adapter refuses what it cannot
     * describe, the receiver's real reports were then dropped, silently: not
     * converted, not observed, page unchanged. It also starved the item-transition
     * release, which needs a real position from the NEW session.
     *
     * ## The evidence
     *
     * Stage 1 (in loadMedia): the generation binds its OWN declared content id,
     * the URI the bridge built. No receiver evidence needed — the sender chose it.
     *
     * Stage 2 (here): a media session may be added only when BOTH hold —
     *
     *   - the LOAD this adapter was built for has been accepted, and
     *   - the session's media STATES this generation's content id, i.e.
     *     `normalizeContentId` agrees with the declared one (compared normalized,
     *     because the sender appends a per-remux cache-busting query).
     *
     * The `previousMediaSessionId` half of the item-transition rule is checked in
     * the tick, not here: this method may legitimately be called again for the
     * same generation, and refusing a NEW session is the failure mode it exists to
     * prevent.
     *
     * Content identity is REQUIRED. When a report (or the harness) carries no
     * contentId there is nothing to check the session id against, so nothing is
     * bound: an unverifiable session id is exactly the guess this replaces.
     */
    private confirmReceiverMediaIdentity() {
        const declared = this.dashPresentationContentId;
        if (declared === undefined) return;
        const boundMedia = this.latestBoundMedia();
        if (!boundMedia) return;
        const reportedContentId = boundMedia.media?.contentId;
        const matchesDeclared =
            reportedContentId !== undefined &&
            normalizeContentId(reportedContentId) ===
                normalizeContentId(declared);
        if (!matchesDeclared) {
            this.debug?.(
                "presentation identity NOT confirmed: the media does not state this generation's content",
                {
                    generationId: this.dashPresentation.generationId,
                    declaredContentId: normalizeContentId(declared),
                    reportedContentId: normalizeContentId(reportedContentId),
                    mediaSessionId: boundMedia.mediaSessionId
                }
            );
            return;
        }
        const identity = {
            contentId: reportedContentId,
            mediaSessionId: boundMedia.mediaSessionId
        };
        if (this.dashPresentation.describes(identity)) return;
        bindPresentationMedia(this.dashPresentation, identity);
        this.debug?.("presentation identity confirmed", {
            generationId: this.dashPresentation.generationId,
            contentId: normalizeContentId(reportedContentId),
            mediaSessionId: identity.mediaSessionId,
            offsetSeconds: this.dashPresentation.offsetSeconds
        });
    }

    /**
     * Can the presentation adapter describe the media the receiver is reporting on
     * right now?
     *
     * False means every receiver position for this generation is being DROPPED —
     * not converted, not observed. That is a silent failure by nature: the page
     * looks correct because nothing writes it, so it is indistinguishable from the
     * receiver never reporting. Callers use it to tell "the page is right" from
     * "the page is never updated".
     */
    canConvertReceiverPosition(): boolean {
        const boundMedia = this.latestBoundMedia();
        if (!boundMedia) return false;
        return this.dashPresentation.describes({
            contentId: boundMedia.media?.contentId,
            mediaSessionId: boundMedia.mediaSessionId
        });
    }

    /** The content id this generation declared, for diagnostics. */
    describeDeclaredContentId() {
        return this.dashPresentationContentId;
    }

    /**
     * One read-only view of the presentation identity, for debug output and tests
     * alike.
     *
     * A single descriptor instead of one getter per field (and instead of a
     * `*ForTest` accessor, which invites the next test hook to be a writer): the
     * question these callers actually have is "is the receiver on the media this
     * generation declared", which is a property of the pair, not of either id.
     */
    describePresentationIdentity() {
        const bound = this.latestBoundMedia();
        const declaredContentId = this.dashPresentationContentId;
        const reportedContentId = bound?.media?.contentId;
        return {
            declaredContentId,
            reportedContentId,
            reportedSessionId: bound?.mediaSessionId,
            describesCurrentMedia:
                declaredContentId !== undefined &&
                reportedContentId === declaredContentId
        };
    }

    /** Read-only view of the page hold, for diagnostics. Never a decision input. */
    describePageHold() {
        return this.pageHoldState();
    }

    /**
     * Move the page's own clock, as the EXTENSION.
     *
     * Every programmatic write to `mediaElement.currentTime` goes through here,
     * for two reasons: the coordinator is told the write is ours (so the
     * `seeked` event it causes is not read as a user seeking — that confusion is
     * what turned a drift correction into another remux restart), and the
     * receiver's presentation clock never enters the page's timeline.
     *
     * `origin` is the intent this write serves, when it serves one: a seek's
     * hold carries its intent id, so the load that follows can be attributed to
     * exactly that intent.
     */
    private writePageTime(
        element: HTMLMediaElement,
        pageSeconds: number,
        options: { intentId?: number; origin?: PlaybackIntentOrigin } = {}
    ): boolean {
        if (!Number.isFinite(pageSeconds)) return false;
        const target = Math.max(0, pageSeconds);
        if (Math.abs(element.currentTime - target) <= 0.1) return false;
        this.playbackCoordinator.notePageWrite(
            options.origin ?? "sync-write",
            options.intentId
        );
        element.currentTime = target;
        return true;
    }

    /**
     * The only entry point that may restart the remux.
     *
     * Every origin funnels through here — the popup's seek, the page's own
     * progress bar, a BLE skip, an item/quality change, one recovery retry — and
     * the coordinator decides whether a restart actually happens:
     *
     *  - it refuses anything that is not an explicit seek intent (origin
     *    `receiver-status` / `sync-write` / `page-autonomous`), so a status
     *    report or one of our own page writes can never reach this point;
     *  - it coalesces requests that arrive while a restart is already in
     *    flight, so two rapid seeks produce ONE remux generation instead of two;
     *  - it stamps every accepted request with an `intentId`, which is what the
     *    page write and the load callback below are attributed to.
     */
    seekDashRemux(
        target: number,
        origin: PlaybackIntentOrigin = "popup"
    ): boolean {
        if (!this.isDashRemux || !this.session) return false;
        if (!Number.isFinite(target) || target < 0) return false;

        const request = this.playbackCoordinator.requestSeek(
            origin,
            target,
            this.mediaIdentity
        );
        if (!request.accepted) {
            // Not an intent (a status report, or one of our own writes asking
            // where playback is). Recorded in the coordinator's view and
            // dropped here: this is the branch that breaks the feedback loop.
            this.debug?.("dash seek refused: not an explicit intent", {
                origin,
                target,
                reason: request.reason,
                coordinator: this.playbackCoordinator.describe()
            });
            return false;
        }
        if (!request.restart) {
            // A restart is already running: the running transaction retargets to
            // this (newer) intent. Starting a second generation here is what
            // produced duplicate reloads on rapid seeks.
            //
            // WHY it thinks a restart is running is decided by the coordinator
            // (`isTransactionActive() || loadInFlight`, see requestSeek), so the
            // whole state that answer is made of goes in the line: a coalesce that
            // nothing in flight can explain is a lifecycle defect, and inferring
            // which flag was stale from the symptom is how one gets missed.
            this.debug?.("dash seek coalesced onto the running transaction", {
                origin,
                target: request.targetPageSeconds,
                intentId: request.intentId,
                ...this.dashSeekState()
            });
            return true;
        }
        this.debug?.("dash seek accepted", {
            origin,
            target: request.targetPageSeconds,
            intentId: request.intentId
        });
        // Pause the receiver immediately so the user sees a hold, not the
        // previous stream, while the remux generation is rebuilt. The page
        // source is primed later (see primeCaptureSource) so capture bytes
        // land in the NEW generation.
        this.onDashSeekStart?.(request.targetPageSeconds);
        // …but debounce the expensive remux restart so rapid seek clicks (popup
        // ±5s button) coalesce into a single reload once clicking stops.
        if (this.dashSeekDebounceId !== undefined) {
            window.clearTimeout(this.dashSeekDebounceId);
        }
        this.dashSeekDebounceId = window.setTimeout(() => {
            this.dashSeekDebounceId = undefined;
            void this.runDashSeek();
        }, MediaSender.DASH_SEEK_DEBOUNCE_MS);
        return true;
    }

    /**
     * Everything a "is a transaction running?" answer is made of.
     *
     * One place, so a coalescing decision and its trace can never describe
     * different states - the same rule `isHoldingPage` follows for the page's
     * transactions.
     */
    private dashSeekState() {
        return {
            dashSeekRunning: this.dashSeekRunning,
            coordinator: this.playbackCoordinator.describe(),
            activeMediaServerRequestId: this.activeMediaServerRequestId,
            dashLoadId: this.dashLoadId,
            tightenSync: this.dashTightenSync,
            itemTransition: this.dashItemTransitionActive(),
            sourcePriming: this.dashSeekSourcePriming !== undefined,
            pendingDashSeekPrime: this.pendingDashSeekPrime !== undefined,
            holdingPage: this.isHoldingPage()
        };
    }

    /** The coordinator's view, for diagnostics and tests. */
    getPlaybackCoordinator() {
        return this.playbackCoordinator;
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
    /**
     * Shift between the receiver's presentation clock and the page's video time
     * for the CURRENT DASH remux: receiverTime = pageTime + offset.
     *
     * Held as an immutable adapter built from THIS load's bridge reply (see
     * cast/dashPresentation), never as a mutable number: a number written by one
     * generation could be applied to the next generation's reports, which is
     * exactly how a stale 32s runway moved the page. The adapter answers for the
     * media it was built for and refuses anything else.
     *
     * Usually the identity, because the bridge pads the playlist up to the seek
     * target. It is non-zero only when the bridge inserts a pad runway in front
     * of the real segments (an opening cast inside the first pad window, see
     * CHROMECAST_MIN_PAD_SECONDS in the bridge): the receiver then starts at
     * padBase + (startTime - keyframe) and every receiver position it reports is
     * that much ahead of the page. The page stays authoritative — the offset is
     * removed before any receiver position is used as a page value.
     */
    private dashPresentation: DashPresentation = identityPresentation("none");

    /**
     * The contentId THIS generation declared when it built its media.
     *
     * The sender chooses it, so it is known before the LOAD is even sent and does
     * not depend on any receiver report. It is the evidence a media session id is
     * confirmed against: a session may only be bound to the adapter if the media
     * it is reported through carries this content id (see
     * confirmReceiverMediaIdentity).
     */
    private dashPresentationContentId?: string;

    /**
     * The single owner of "what is playback supposed to be doing".
     *
     * Every seek intent enters through it, it holds exactly one phase, and its
     * `requestSeek` refuses anything that is not an explicit intent — which is
     * the structural reason a receiver status report can no longer restart the
     * remux.
     */
    private readonly playbackCoordinator = new PlaybackCoordinator();

    /**
     * Receiver presentation time -> page video time for the current remux.
     *
     * The ONLY crossing between the two clocks on this side. Everything that
     * touches the page element, the page's position, or a seek target uses page
     * time; everything that talks to the receiver uses presentation time.
     *
     * `media` identifies the generation the report is about. A report from media
     * this adapter does not describe is refused (`undefined`) rather than
     * converted, so the caller has to decide consciously instead of silently
     * applying a stale shift.
     */
    private dashPageTimeFromReceiver(
        presentationTime: number,
        media?: { contentId?: string; mediaSessionId?: number }
    ): number | undefined {
        if (media && !this.dashPresentation.describes(media)) {
            // NOT silent. A refusal means this position is neither converted nor
            // observed, so every symptom it produces looks like "the page simply
            // did not move" and is indistinguishable from the receiver never having
            // reported at all. One line per distinct identity (the sync tick runs
            // twice a second) so a real session can be diagnosed from the log.
            const signature = `${media.contentId}|${media.mediaSessionId}`;
            if (this.lastRefusedPresentationSignature !== signature) {
                this.lastRefusedPresentationSignature = signature;
                this.debug?.(
                    "receiver position refused: media is not this generation's",
                    {
                        generationId: this.dashPresentation.generationId,
                        declaredContentId: normalizeContentId(
                            this.dashPresentationContentId
                        ),
                        reportedContentId: normalizeContentId(media.contentId),
                        reportedMediaSessionId: media.mediaSessionId,
                        statusBindings:
                            this.dashPresentation.describeBindings(),
                        loadId: this.dashLoadId,
                        activeRequestId: this.activeMediaServerRequestId
                    }
                );
            }
            return undefined;
        }
        return this.dashPresentation.receiverToPage(presentationTime);
    }

    /** Last (contentId|mediaSessionId) refused, so the trace logs it once. */
    private lastRefusedPresentationSignature?: string;

    /**
     * Page-clock-master mode: the page owns POSITION (no receiver->page drift
     * correction or snap, no Chromecast-style post-load tighten), because the
     * page player is what produces the capture watermark this sender feeds from.
     *
     * It does NOT mean "the page ignores the receiver": play/pause still follows
     * the receiver's state, since receiver state also changes outside commands
     * that already passed through the page (Roku remote, Roku UI).
     */
    setPreserveSourcePlayback(enabled: boolean) {
        this.preserveSourcePlayback = enabled;
    }

    /**
     * Popup play/pause: apply to the page immediately so capture and the
     * receiver stay in lockstep. The page event then forwards to the
     * receiver (same path as a user gesture / BLE remote).
     */
    /**
     * Popup play/pause, page route. Returns a structured result so the
     * background can (a) tell already-target from a page transition and (b)
     * take the receiver-dispatch timestamp from the page, which is the only
     * place that knows when the Cast API was actually called.
     *
     * A bare boolean was not enough: "the page accepted the control flow" does
     * not say whether a page transition happened, nor whether the receiver was
     * commanded, so a page-owned command could never reach a receiver verdict.
     */
    controlPlayback(command: PlaybackPageCommand): PagePlaybackDispatchResult {
        const action = command.intent === "PLAY" ? "play" : "pause";
        if (!this.session || !this.onBleRemoteAction) {
            this.debug?.(
                "popup playback ignored: sender controls are not ready",
                {
                    action
                }
            );
            return { accepted: false, error: "sender controls not ready" };
        }
        this.debug?.("popup control routed through page", { action });
        // The closure decides whether a page transition is needed; when one is,
        // it arms this exact command so a later page event can be attributed to
        // it (and reports a timeout if that event never comes). The command
        // travels as an argument, so there is no second slot to fall out of sync
        // with and no state left behind if the closure throws.
        const dispatchSink: { dispatch: PlaybackDispatchResult | null } = {
            dispatch: null
        };
        const accepted = this.onBleRemoteAction(
            action,
            0,
            0,
            command,
            dispatchSink
        );
        if (!accepted) {
            const failed = dispatchSink.dispatch;
            return {
                accepted: false,
                error:
                    failed?.outcome === "no-media"
                        ? "No active cast media"
                        : failed?.outcome === "page-sync-failed"
                        ? "Page transition could not be started"
                        : "Page playback route rejected"
            };
        }
        const dispatch = dispatchSink.dispatch;
        if (!dispatch || dispatch.outcome === "no-media") {
            // Defensive: a truthy return with no recorded dispatch would mean
            // the closure and this method disagree about what happened.
            return { accepted: false, error: "Page dispatch not recorded" };
        }
        if (dispatch.outcome === "transition") {
            // The page transition is in flight; the Cast call happens later,
            // when the page event consumes the arm.
            const armedAt = dispatch.armedAt ?? dispatch.at;
            return {
                accepted: true,
                disposition: "transition-requested",
                receiverRequested: false,
                armedAt,
                expiresAt: armedAt + PAGE_EVENT_WINDOW_MS
            };
        }
        return {
            accepted: true,
            disposition: "already-target",
            receiverRequested: true,
            // Sampled during onBleRemoteAction, immediately before the Cast
            // Media.play/pause call.
            receiverDispatchStartedAt: dispatch.at
        };
    }

    /**
     * Called when the new capture HTTP port is listening. Seek the real page
     * player to this generation's start time so the m4s fetches that follow
     * are ingested here, then keep it playing so the remux cannot starve.
     */
    primeCaptureSource(requestId: string) {
        if (this.stopped) return;
        if (this.activeMediaServerRequestId !== requestId) return;
        if (!this.preserveSourcePlayback) return;
        const mediaElement = this.mediaElement;
        if (!(mediaElement instanceof HTMLMediaElement)) return;
        const target = this.capturePrimeTarget;
        // Arm the seek-scoped priming BEFORE the page is moved: from here until
        // the receiver's new session reports PLAYING, this page is the only
        // supplier of the new capture generation.
        this.armDashSeekSourcePriming(requestId);
        if (target !== undefined && this.primePageCaptureAt) {
            this.debug?.("priming page capture at remux start", {
                requestId,
                target,
                pageTime: mediaElement.currentTime,
                paused: mediaElement.paused
            });
            this.primePageCaptureAt(target);
            return;
        }
        if (
            target !== undefined &&
            Number.isFinite(target) &&
            this.writePageTime(mediaElement, target, { origin: "sync-write" })
        ) {
            this.debug?.("primed page capture position", { target });
        }
        if (mediaElement.paused) {
            void mediaElement.play().catch(err => {
                logger.error("Failed to prime page capture", err);
            });
        }
        this.debug?.("primed page capture without listener suppress", {
            requestId,
            target,
            pageTime: mediaElement.currentTime
        });
    }

    /** The receiver media session the sync loop reconciles against. */
    private latestBoundMedia() {
        const sessionMedia = this.session?.media;
        return sessionMedia && sessionMedia.length
            ? sessionMedia[sessionMedia.length - 1]
            : this.media;
    }

    /**
     * Arm the seek-scoped priming for exactly the load that asked for
     * `requestId`. No identity match means no priming: a stale or foreign
     * capture-ready must not create a transaction (initial casts, item changes
     * and recovery reloads have no seek identity at all).
     */
    private armDashSeekSourcePriming(requestId: string) {
        const identity = this.dashSeekLoadIdentity;
        if (!identity) return;
        if (identity.requestId !== requestId) return;
        if (identity.loadId !== this.dashLoadId) return;
        const now = Date.now();
        this.dashSeekSourcePriming = {
            requestId,
            seekId: identity.seekId,
            loadId: identity.loadId,
            target: identity.target,
            previousMediaSessionId: identity.previousMediaSessionId,
            loadResolved: false,
            startedAt: now,
            deadline: now + DASH_SEEK_PRIME_MAX_MS
        };
        this.dashSeekLoadIdentity = undefined;
        this.debug?.("DASH seek source priming armed", {
            requestId,
            target: identity.target,
            previousMediaSessionId: identity.previousMediaSessionId,
            maxMs: DASH_SEEK_PRIME_MAX_MS
        });
    }

    /**
     * Drop everything a FAILED seek iteration owned, by identity only: a later
     * transaction (or a newer load) must survive the failure of an older one.
     * unowned state is left alone.
     */
    private clearDashSeekTransaction(seekId: number, reason: string) {
        if (this.pendingDashSeekPrime?.seekId === seekId) {
            this.pendingDashSeekPrime = undefined;
        }
        if (this.dashSeekLoadIdentity?.seekId === seekId) {
            this.dashSeekLoadIdentity = undefined;
        }
        if (this.dashSeekSourcePriming?.seekId === seekId) {
            this.clearDashSeekSourcePriming(reason);
        }
    }

    /**
     * Open the item-transition window (see dashItemTransition). Called by the
     * page sender right before it reloads the receiver for a new item/quality.
     *
     * The coordinator records the same moment as a GENERATION boundary, which is
     * the structural half of the same idea: the item change invalidates every
     * previous generation's events by identity, so the transition window below
     * only has to cover what identity alone cannot — the receiver's own startup
     * sequencing within the new generation.
     */
    beginDashItemTransition() {
        if (!this.isDashRemux || this.preserveSourcePlayback) return;
        const now = Date.now();
        // The generation boundary is opened INSIDE the same guard as the window:
        // on the page-clock-master path (Roku capture) the page owns position and
        // the receiver's reports are already reconciled by identity, so there is
        // no boundary to open and nothing to hold.
        this.playbackCoordinator.beginItemChange();
        this.dashItemTransition = {
            loadId: this.dashLoadId,
            previousMediaSessionId: this.latestBoundMedia()?.mediaSessionId,
            loadResolved: false,
            startedAt: now,
            deadline: now + DASH_ITEM_TRANSITION_MAX_MS
        };
        // The reload restarts the remux generation; the previous stream's
        // liveness/progress sample must not be judged as a stall while the new
        // one is being prepared.
        this.lastRelaySegmentRequestAt = 0;
        this.prebufferProgressMediaTime = undefined;
        this.prebufferProgressObservedAt = now;
        this.debug?.("DASH item transition window opened", {
            previousMediaSessionId:
                this.dashItemTransition.previousMediaSessionId,
            maxMs: DASH_ITEM_TRANSITION_MAX_MS
        });
    }

    /**
     * Close the item-transition window, with the reason in the trace.
     *
     * Closing the window settles the coordinator; it does NOT serve a pending
     * seek. This method runs from `deadline`, `load-rejected` and the new
     * session's first position report as well as from a successful load, and only
     * the last of those is a point where the page controls are known to be
     * attached (`onDashSeekStart` is re-installed by `addMediaElementListeners`,
     * which a reload detaches). Serving from here could therefore start a
     * generation whose hold is silently dropped - the page would stay where the
     * previous step left it while the receiver played the new target. The one
     * safe point is the end of the LOAD success callback; a REJECTED item load
     * keeps the intent for a later successful load or the next user action, and
     * never runs it without page controls (see `serveSeekPendingFromItemChange`).
     */
    private clearDashItemTransition(reason?: string) {
        const transition = this.dashItemTransition;
        if (!transition) return;
        this.dashItemTransition = undefined;
        // The new item's media is live: the generation boundary the item change
        // opened is settled, so the coordinator stops holding the page.
        this.playbackCoordinator.markItemSettled();
        if (reason) {
            this.debug?.("DASH item transition window closed", {
                reason,
                elapsedMs: Date.now() - transition.startedAt,
                previousMediaSessionId: transition.previousMediaSessionId
            });
        }
    }

    /**
     * Is the transition window still open? Never past its deadline: a reload
     * that never produces a playable session must not hold the receiver's
     * authority forever.
     */
    private dashItemTransitionActive() {
        const transition = this.dashItemTransition;
        if (!transition) return false;
        if (Date.now() >= transition.deadline) {
            this.clearDashItemTransition("deadline");
            return false;
        }
        return true;
    }

    /**
     * Serve an explicit seek that an item/quality change coalesced and could not
     * run itself.
     *
     * While the item change holds the load, `requestSeek` records the intent and
     * reports `restart: false`, so no debounce is armed and nothing would ever
     * apply it. Once the item's own media is live the outstanding intent is
     * served by the ordinary loop, whose plan and hold are the usual ones for its
     * target. A no-op when nothing is outstanding, when a transaction is already
     * running (its own loop will retarget), or on the page-clock-master path,
     * where the page primed the capture instead.
     *
     * The ONLY caller is the end of the LOAD success callback - after the page
     * controls have been re-attached, so the generation this starts can park the
     * page at its target. A REJECTED item load leaves the intent in place: it is
     * neither run without page controls nor dropped, and the next successful load
     * (or the next explicit seek, which supersedes it) decides what happens to it.
     */
    private serveSeekPendingFromItemChange() {
        if (!this.isDashRemux || !this.session || this.stopped) return;
        if (this.preserveSourcePlayback || this.dashSeekRunning) return;
        const intent = this.playbackCoordinator.peekIntent();
        if (!intent) return;
        this.debug?.("serving the seek an item change coalesced", {
            intentId: intent.intentId,
            origin: intent.origin,
            target: intent.targetPageSeconds
        });
        void this.runDashSeek();
    }

    /**
     * One line per CHANGED transition tick, so a failed handoff shows exactly
     * what the receiver was reporting when it stopped: which session is bound,
     * what state it claims, where it says it is, and how far the window has run.
     * (A transition on a stuck receiver is otherwise invisible between the
     * "window opened" and "window closed" lines.)
     */
    private traceItemTransition(boundMedia: {
        playerState: string;
        mediaSessionId?: number;
        getEstimatedTime?: () => number;
    }) {
        const transition = this.dashItemTransition;
        if (!transition) return;
        const rawEstimatedTime = boundMedia.getEstimatedTime?.();
        const signature = `${boundMedia.mediaSessionId}|${
            boundMedia.playerState
        }|${Math.round(rawEstimatedTime ?? -1)}|${transition.loadResolved}`;
        if (this.lastItemTransitionTrace === signature) return;
        this.lastItemTransitionTrace = signature;
        this.debug?.("DASH item transition tick", {
            previousMediaSessionId: transition.previousMediaSessionId,
            boundMediaSessionId: boundMedia.mediaSessionId,
            playerState: boundMedia.playerState,
            rawEstimatedTime,
            loadResolved: transition.loadResolved,
            elapsedMs: Date.now() - transition.startedAt
        });
    }
    private lastItemTransitionTrace?: string;

    /** Open the transition window (see dashItemTransition). Called right before
     *  the sender reloads the receiver for a new item/quality. */
    /**
     * End the seek-scoped priming, with the reason in the trace. */
    private clearDashSeekSourcePriming(reason: string) {
        const priming = this.dashSeekSourcePriming;
        if (!priming) return;
        this.dashSeekSourcePriming = undefined;
        this.debug?.("DASH seek source priming ended", {
            reason,
            requestId: priming.requestId,
            target: priming.target,
            elapsedMs: Date.now() - priming.startedAt,
            loadResolved: priming.loadResolved
        });
    }

    /**
     * Has the receiver's NEW session taken over? With a known previous session,
     * only a different mediaSessionId counts; without one, the LOAD callback of
     * THIS load has to have resolved first - any PLAYING (including the old
     * session's last one, before our pause lands) is not proof. Both forms still
     * require PLAYING, so a transaction never ends on an echo of its own hold.
     */
    private isDashSeekPrimingSatisfied(boundMedia: {
        playerState: string;
        mediaSessionId?: number;
    }) {
        const priming = this.dashSeekSourcePriming;
        if (!priming) return false;
        if (boundMedia.playerState !== cast.media.PlayerState.PLAYING) {
            return false;
        }
        return priming.previousMediaSessionId !== undefined
            ? boundMedia.mediaSessionId !== priming.previousMediaSessionId
            : priming.loadResolved;
    }

    /**
     * Has the receiver declared this seek's new media dead?
     *
     * The seek reload produced a new session (so the id is not the previous one)
     * and that session reports IDLE with a real error. The page has been held
     * playing for a transaction that can no longer succeed, so it has to end now
     * rather than at the deadline. Only the NEW session counts: the previous one
     * going idle on its way out is the normal shape of a reload.
     */
    private isDashSeekPrimingDead(boundMedia: {
        playerState: string;
        mediaSessionId?: number;
        idleReason?: string | null;
    }) {
        const priming = this.dashSeekSourcePriming;
        if (!priming) return false;
        if (boundMedia.playerState !== cast.media.PlayerState.IDLE) {
            return false;
        }
        if (boundMedia.idleReason !== cast.media.IdleReason.ERROR) return false;
        return priming.previousMediaSessionId === undefined
            ? priming.loadResolved
            : boundMedia.mediaSessionId !== priming.previousMediaSessionId;
    }

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
            currentTime: opts.mediaElement?.currentTime
        });
        this.suspendMediaElementSync();
        this.mediaUrl = opts.mediaUrl;
        // Lazy resolvers are one-shot (loadMedia clears them after resolving), so
        // an update must re-arm the resolver when the caller passes one — CCTV
        // quality changes re-resolve the live stream URL through this path.
        this.mediaUrlResolver = opts.mediaUrlResolver;
        this.rokuMediaResolver = opts.rokuMediaResolver;
        this.mediaTitle = opts.mediaTitle;
        this.adoptMediaIdentity(opts);
        this.mediaContentType = opts.mediaContentType ?? "";
        this.mediaElement = opts.mediaElement;
        this.remoteProxy = opts.remoteProxy;
        this.isVideo = opts.isVideo ?? this.isVideo;
        this.isLive = opts.isLive ?? this.isLive;
        // Lifecycle callbacks follow the latest opts: a media reload that
        // reuses this sender must rebind onStopped/onReceiverSelected,
        // otherwise the NEW closure's guards and restores never run. Transactional CALLBACK swap: if loadMedia
        // fails, the previous callbacks are restored so the still-working
        // old lifecycle keeps a matching stop handler. Media configuration
        // fields above are NOT rolled back — they reflect the latest attempt
        // and are overwritten by whichever rebuild runs next.
        const previousOnStopped = this.onStopped;
        const previousOnReceiverSelected = this.onReceiverSelected;
        this.onStopped = opts.onStopped;
        this.onReceiverSelected = opts.onReceiverSelected;
        try {
            await this.loadMedia();
        } catch (error) {
            this.onStopped = previousOnStopped;
            this.onReceiverSelected = previousOnReceiverSelected;
            throw error;
        }
    }

    private async init() {
        try {
            this.port = await ensureInit();
        } catch (err) {
            logger.error("Failed to initialize cast API", err);
        }

        // Receiver-liveness feed: the background forwards one message per /seg
        // serve beyond the initial prebuffer window. Death detection starts only
        // once the receiver moves past the prebuffer (see the comment on
        // lastRelaySegmentRequestAt). Credit is the slot's MEASURED duration —
        // a slot's measured duration can legitimately differ from one nominal
        // segment, so the receiver's next request arrives accordingly.
        this.port?.addEventListener("message", ev => {
            const message = ev.data as Message | undefined;
            const subject = message?.subject;
            if (subject === "mediaCast:relaySegmentRequested") {
                this.confirmRecoveryRelayActivity("steady-state-segment");
                const now = Date.now();
                const measured = (
                    message?.data as { durationSeconds?: number } | undefined
                )?.durationSeconds;
                // Clamp against measurement noise: never less than one nominal
                // period, never more than two (a gross mis-measurement must not
                // blind the death detector for minutes).
                const creditSeconds =
                    typeof measured === "number" &&
                    Number.isFinite(measured) &&
                    measured > 0
                        ? Math.min(
                              Math.max(measured, this.relaySegmentStepSeconds),
                              this.relaySegmentStepSeconds * 2
                          )
                        : this.relaySegmentStepSeconds;
                this.lastRelaySegmentRequestAt = now;
                this.relayLivenessDeadlineAt =
                    Math.max(this.relayLivenessDeadlineAt, now) +
                    creditSeconds * 1000;
                this.relayStaleLogged = false;
            } else if (subject === "mediaCast:relayPrebufferSegmentRequested") {
                this.confirmRecoveryRelayActivity("prebuffer-segment");
                this.lastPrebufferSegmentRequestAt = Date.now();
                this.relayStaleLogged = false;
            }
        });
        this.port?.start();

        this.stopOnUnloadEnabled = await getOption("mediaStopOnUnload");
        this.syncElementEnabled = await getOption("mediaSyncElement");
        this.debug?.("media options", {
            stopOnUnload: this.stopOnUnloadEnabled,
            syncElement: this.syncElementEnabled,
            hasMediaElement: this.mediaElement instanceof HTMLMediaElement
        });

        this.stopForUnload = () => {
            if (!this.stopOnUnloadEnabled || this.hasStoppedForUnload) return;
            this.hasStoppedForUnload = true;
            this.debug?.("page unload: stopping receiver session");
            this.stop();
        };
        window.addEventListener("pagehide", this.stopForUnload, { once: true });
        window.addEventListener("beforeunload", this.stopForUnload, {
            once: true
        });

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
            capabilities: capabilities.length
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
            err => {
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
        // Own the page-clock-master switch internally: a late/foreign
        // onReceiverSelected callback must never flip another instance's
        // flag through the outer sender variable.
        const isRokuReceiver = session.receiver.label.startsWith("roku-");
        // Page-clock-master mode exists only for Bilibili DASH passive capture.
        // Applying it to every Roku session makes syncFromReceiver return before
        // the normal PLAYING/BUFFERING reconciliation, so a CCTV page that was
        // paused while Cast prepared never receives mediaElement.play().
        this.setPreserveSourcePlayback(this.isDashRemux && isRokuReceiver);
        this.onReceiverSelected?.(isRokuReceiver);
        this.sessionUpdateListener = isAlive => {
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
        void this.loadMedia().catch(err => {
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
                session => {
                    this.debug?.("cast session created", session.sessionId);
                    if (!this.bindSession(session)) return;
                    void this.loadMedia().catch(err => {
                        this.debug?.("media load failed", String(err));
                        logger.error("Media load failed", err);
                    });
                },
                err => {
                    this.wasSessionRequested = false;
                    // Distinguish a user/logic cancellation (selector closed or clobbered
                    // by another launch) from a genuine failure. `err` here is the Cast
                    // SDK error object; its `code` is "cancel" when the selector was
                    // closed out from under this request.
                    this.debug?.("receiver selection failed", {
                        code: (err as { code?: string })?.code ?? String(err),
                        description: (err as { description?: string })
                            ?.description
                    });
                    logger.error("Session request failed", err);
                }
            );
        }
    }

    /**
     * Load the media on the active cast session.
     *
     * @param startTimeOverride Restart position. Used by DASH seeks (absolute
     *   video time). Auto-recovery reloads pass NO override: the bridge
     *   rebuilds the synthetic DVR window to continue right after the last
     *   segment it served (see its live-relay continuation state), so the
     *   receiver simply starts at the head of the fresh prebuffer.
     */
    private async loadMedia(startTimeOverride?: number) {
        if (this.stopped) return;
        // This load's identity and the seek handoff are claimed FIRST, before any
        // await: runDashSeek sets the pending immediately before calling this, so
        // claiming it here makes "a pending seek can never leak into the next
        // load" structural instead of incidental (the URL resolver below awaits).
        const loadId = ++this.dashLoadId;
        const seekPrime = this.pendingDashSeekPrime;
        this.pendingDashSeekPrime = undefined;
        this.dashSeekLoadIdentity = seekPrime
            ? {
                  seekId: seekPrime.seekId,
                  loadId,
                  target: seekPrime.target,
                  previousMediaSessionId: seekPrime.previousMediaSessionId
              }
            : undefined;
        // Every load supersedes the previous transaction's hold.
        this.clearDashSeekSourcePriming("new-load");
        // An item/quality transition survives into this load: its window is
        // about the RECEIVER's old session still reporting, which is exactly
        // what happens while the new LOAD is in flight. Re-anchor it to this
        // load's id and to the session bound right now.
        if (this.dashItemTransition) {
            this.dashItemTransition.loadId = loadId;
            this.dashItemTransition.loadResolved = false;
            this.dashItemTransition.previousMediaSessionId =
                this.latestBoundMedia()?.mediaSessionId ??
                this.dashItemTransition.previousMediaSessionId;
        }
        // Consume the lazy URL resolver (CCTV live capture) before anything
        // touches this.mediaUrl. One-shot: reloads (seeks, auto-recovery) reuse
        // the resolved URL — the bridge rebuilds its relay from it directly.
        if (this.mediaUrlResolver) {
            const resolver = this.mediaUrlResolver;
            this.mediaUrlResolver = undefined;
            const resolved = await resolver();
            this.mediaUrl = resolved.mediaUrl;
            if (resolved.userAgent && this.remoteProxy) {
                this.remoteProxy.userAgent = resolved.userAgent;
            }
            this.debug?.("lazy media URL resolved", {
                mediaUrl: this.mediaUrl
            });
        }
        let mediaUrl = new URL(this.mediaUrl);
        const mediaTitle = this.mediaTitle ?? mediaUrl.pathname.slice(1);
        const subtitleUrls: URL[] = [];
        let bridgePageDuration: number | undefined;
        // Start position the bridge asks the receiver to begin playback at
        // (e.g. a DASH remux restarted at a seek target).
        let bridgeStartTime: number | undefined;
        // Synthetic DVR live edge: at dvrBuiltAtMs the edge sits at
        // dvrLiveEdgeBaseSeconds in the VOD timeline; it advances with wall
        // clock. Forward seeks must be clamped to it (the segments beyond don't
        // exist on the CDN yet).
        let dvrLiveEdgeBaseSeconds: number | undefined;
        let dvrBuiltAtMs: number | undefined;

        // In DASH remux mode the bridge restarts ffmpeg at this position and
        // pads the playlist so the receiver timeline stays in absolute video
        // time (receiver currentTime == page currentTime).
        let dashStartTime = this.isDashRemux
            ? this.syncMediaPosition
                ? startTimeOverride ??
                  (this.mediaElement instanceof HTMLMediaElement &&
                  Number.isFinite(this.mediaElement.currentTime)
                      ? this.mediaElement.currentTime
                      : 0)
                : 0
            : 0;
        // This load's own bridge decides the presentation timeline (it is a
        // property of the generated playlist), so the previous generation's
        // adapter is retired before asking. A load that never reaches the bridge
        // ready message leaves the identity adapter in place, which can only
        // refuse unrelated media — never apply a stale runway.
        this.dashPresentation = identityPresentation(`load:${loadId}`);
        this.dashPresentationContentId = undefined;

        if (this.remoteProxy) {
            const port = await getOption("localMediaServerPort");
            const cctvDebugEnabled = this.remoteProxy.hlsLive
                ? await getOption("cctvDebugEnabled")
                : false;
            this.debug?.("starting bridge proxy", {
                port,
                host: mediaUrl.hostname,
                hasSeparateAudio: Boolean(this.remoteProxy.audioUrl),
                expectedMode: this.remoteProxy.audioUrl
                    ? "dash-remux"
                    : this.remoteProxy.hlsLive
                    ? "hls-live-relay"
                    : "proxy",
                startTime: this.isDashRemux ? dashStartTime : undefined
            });
            if (
                this.isDashRemux &&
                this.preserveSourcePlayback &&
                this.rokuMediaResolver &&
                startTimeOverride === undefined
            ) {
                const rokuMedia = await this.rokuMediaResolver();
                this.mediaUrl = rokuMedia.mediaUrl;
                if (this.remoteProxy) {
                    this.remoteProxy.audioUrl = rokuMedia.audioUrl;
                }
                this.debug?.("roku capture media resolved", {
                    mediaUrl: rokuMedia.mediaUrl
                });
            }
            const requestId = this.nextMediaServerRequestId();
            this.activeMediaServerRequestId = requestId;
            // Bind the request identity to this load so primeCaptureSource can
            // only ever arm the priming for THIS generation.
            if (this.dashSeekLoadIdentity?.loadId === loadId) {
                this.dashSeekLoadIdentity.requestId = requestId;
            }
            if (
                this.isDashRemux &&
                startTimeOverride === undefined &&
                this.preserveSourcePlayback &&
                this.mediaElement instanceof HTMLMediaElement
            ) {
                const refreshed = this.mediaElement.currentTime;
                if (Number.isFinite(refreshed) && refreshed >= 0) {
                    dashStartTime = refreshed;
                    this.debug?.("refreshed page-authoritative DASH start", {
                        dashStartTime
                    });
                }
            }
            this.capturePrimeTarget =
                this.isDashRemux && this.preserveSourcePlayback
                    ? dashStartTime
                    : undefined;
            const result = await this.startRemoteMediaServer(
                requestId,
                this.mediaUrl,
                this.remoteProxy.referer,
                this.mediaContentType,
                port,
                this.remoteProxy.audioUrl,
                dashStartTime,
                this.remoteProxy.hlsLive,
                this.remoteProxy.userAgent,
                cctvDebugEnabled,
                Boolean(this.remoteProxy.audioUrl) &&
                    this.session?.receiver.label.startsWith("roku-") === true,
                Boolean(this.isDashRemux && startTimeOverride !== undefined)
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
            if (
                Number.isFinite(result.liveEdgeBaseSeconds) &&
                Number(result.liveEdgeBaseSeconds) > 0 &&
                Number.isFinite(result.builtAtMs) &&
                Number(result.builtAtMs) > 0
            ) {
                dvrLiveEdgeBaseSeconds = Number(result.liveEdgeBaseSeconds);
                dvrBuiltAtMs = Number(result.builtAtMs);
                this.dvrLiveEdge = {
                    baseSeconds: dvrLiveEdgeBaseSeconds,
                    builtAtMs: dvrBuiltAtMs
                };
            }
            if (Number.isFinite(result.startTime)) {
                bridgeStartTime = Number(result.startTime);
            }
            if (
                this.isDashRemux &&
                Number.isFinite(result.presentationStartTime) &&
                Number(result.presentationStartTime) >= 0
            ) {
                // The bridge pads in front of the real segments only when the
                // remux starts inside its first pad window; the pair it reports
                // (page start, presentation start) is the whole mapping between
                // the receiver's presentation clock and the page's video time.
                // Frozen into an adapter for THIS generation: it cannot be
                // mutated later, so it cannot leak onto the next media.
                this.dashPresentation = createDashPresentation({
                    generationId: requestId,
                    pageStart: dashStartTime,
                    receiverStart: Number(result.presentationStartTime),
                    // The generation declares its own content id up front: it is
                    // the URI the bridge built for THIS load (and the value the
                    // MediaInfo below is constructed with), so binding it needs no
                    // evidence from the receiver at all.
                    contentIds: [mediaUrl.href]
                });
                this.dashPresentationContentId = mediaUrl.href;
                this.debug?.("DASH presentation identity", {
                    generationId: requestId,
                    pageStart: dashStartTime,
                    presentationStartTime: Number(result.presentationStartTime),
                    padBaseSeconds: result.padBaseSeconds,
                    probedKeyframeSeconds: result.probedKeyframeSeconds,
                    offsetSeconds: this.dashPresentation.offsetSeconds
                });
            }
            if (this.isHlsDvr) {
                // Segment cadence from the relay (drives the liveness timeout).
                if (
                    Number.isFinite(result.stepSeconds) &&
                    Number(result.stepSeconds) > 0
                ) {
                    this.relaySegmentStepSeconds = Number(result.stepSeconds);
                }
                // Reset the liveness clock: a fresh prebuffer window is being
                // served, so death detection is DISARMED until the receiver moves
                // past the prebuffered segments onto the rolling pipeline cache
                // (see lastRelaySegmentRequestAt). This covers the prebuffer/LOAD
                // phase AND the whole initial cached window — first playback gets
                // its full prebuffered runway.
                this.lastRelaySegmentRequestAt = 0;
                this.relayLivenessDeadlineAt = 0;
                this.relayStaleLogged = false;
                this.receiverLivenessGraceObservedAt = 0;
                this.receiverErrorLoggedForSession = undefined;
                this.prebufferProgressMediaTime = undefined;
                this.prebufferProgressObservedAt = Date.now();
                this.lastPrebufferSegmentRequestAt = 0;
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
                    ...subtitlePaths.map(path => new URL(path, baseUrl))
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
        if (this.remoteProxy?.hlsLive) {
            // The bridge republishes CCTV as a frozen synthetic-DVR VOD playlist
            // (PLAYLIST-TYPE:VOD + ENDLIST). BUFFERED makes the receiver treat it
            // as a seekable VOD that buffers ahead from t=0 instead of chasing a
            // live edge — the same semantics as the Bilibili DASH remux path.
            mediaInfo.streamType = cast.media.StreamType.BUFFERED;
        } else if (this.isLive) {
            mediaInfo.streamType = cast.media.StreamType.LIVE;
        }
        if (
            this.isHlsDvr &&
            bridgePageDuration !== undefined &&
            Number.isFinite(bridgePageDuration) &&
            bridgePageDuration > 0
        ) {
            // CCTV / Yangshipin live synthetic DVR: the bridge serves a synthetic-DVR
            // VOD playlist whose nominal duration is bridgePageDuration (e.g. 2h).
            // A page <video> element driven by HLS.js (such as on Yangshipin) has a
            // sliding live-edge duration (~20s) that must NOT override the synthetic
            // DVR duration.
            mediaInfo.duration = bridgePageDuration;
        } else if (
            this.mediaElement instanceof HTMLMediaElement &&
            Number.isFinite(this.mediaElement.duration) &&
            this.mediaElement.duration > 0
        ) {
            mediaInfo.duration = this.mediaElement.duration;
        } else if (
            bridgePageDuration !== undefined &&
            Number.isFinite(bridgePageDuration) &&
            bridgePageDuration > 0
        ) {
            // CCTV live has no page <video> duration (it is a live element). Use the
            // bridge's finite nominal duration so the receiver treats the growing
            // event playlist as a seekable VOD (starts at t=0, buffers ahead) instead
            // of a live edge — the same signal a Bilibili DASH remux gets from its
            // page's finite video duration.
            mediaInfo.duration = bridgePageDuration;
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
                // The LOAD position (absolute video time): the page's playback
                // position when the cast started. The popup seeds its timeline
                // here so the seek bar shows the real position as soon as it
                // appears, instead of 00:00 until the receiver's first settled
                // report.
                ...(Number.isFinite(dashStartTime)
                    ? { dashStart: dashStartTime }
                    : {}),
                // The generation's own presentation shift, stated by the media
                // (0 unless the bridge inserted a pad runway). A consumer that
                // needs to turn one of this media's receiver positions into page
                // time reads it here; it is the same number the sender's adapter
                // was built from, and it belongs to THIS media only.
                //
                // ALWAYS written, 0 included: the field's presence is what tells
                // a reader "this media states its own shift", so an explicit 0
                // (startup padding off, or a mid-video restart) can never be
                // filled in from a value left by the previous remux.
                presentationOffsetSeconds: this.dashPresentation.offsetSeconds
            };
        } else if (this.isHlsDvr && bridgePageDuration !== undefined) {
            // Synthetic DVR (CCTV): the popup needs the synthesized duration for
            // its seek bar, and the background needs the live-edge anchor to clamp
            // forward seeks to published segments. No dashRemux flag — this is a
            // plain receiver-seekable VOD, NOT a remux-restart session.
            mediaInfo.customData = {
                hlsDvr: true,
                pageDuration: bridgePageDuration,
                dvrLiveEdgeBaseSeconds: dvrLiveEdgeBaseSeconds,
                dvrBuiltAtMs: dvrBuiltAtMs
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
                        new cast.Image(this.mediaElement.poster)
                    ];
                }
            }

            if (this.mediaElement.textTracks.length) {
                const textTracks = Array.from(this.mediaElement.textTracks);
                const trackElements =
                    this.mediaElement.querySelectorAll("track");

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
                            castTrack.subtype =
                                cast.media.TextTrackType.SUBTITLES;
                            break;
                        case "captions":
                            castTrack.subtype =
                                cast.media.TextTrackType.CAPTIONS;
                            break;
                        case "descriptions":
                            castTrack.subtype =
                                cast.media.TextTrackType.DESCRIPTIONS;
                            break;
                        case "chapters":
                            castTrack.subtype =
                                cast.media.TextTrackType.CHAPTERS;
                            break;
                        case "metadata":
                            castTrack.subtype =
                                cast.media.TextTrackType.METADATA;
                            break;

                        // Default to subtitles
                        default:
                            castTrack.subtype =
                                cast.media.TextTrackType.SUBTITLES;
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
        // A reload carries the user's playback intent across, it does not invent
        // one: a seek while paused loads paused (at the new position), and every
        // other case - an initial cast, an item change, a recovery rebuild -
        // inherits whatever the user last asked for.
        loadRequest.autoplay = this.desiredPlayback === "playing";
        loadRequest.activeTrackIds = activeTrackIds;

        if (this.isHlsDvr) {
            // CCTV synthetic DVR: the page live element's currentTime is on an
            // unrelated live clock and must NOT seed the VOD timeline. The bridge's
            // startTime is the head of the prebuffered window (0 on a first cast —
            // a full lookback behind the live edge; on a recovery reload the
            // continuation point right after the last served segment). Begin
            // exactly there, clamped behind published segments.
            let currentTime =
                bridgeStartTime !== undefined &&
                Number.isFinite(bridgeStartTime)
                    ? bridgeStartTime
                    : 0;
            const frontier = this.dvrLiveEdgeSeconds();
            if (frontier !== undefined && Number.isFinite(frontier)) {
                currentTime = Math.min(
                    currentTime,
                    frontier - MediaSender.DVR_FORWARD_SEEK_MARGIN_SECONDS
                );
            }
            loadRequest.currentTime = Math.max(0, currentTime);
            this.debug?.("applying DVR start position", {
                currentTime: loadRequest.currentTime
            });
        } else if (this.mediaElement instanceof HTMLMediaElement) {
            // The bridge's presentation clock is what the receiver must be
            // loaded at. It equals the page position (dashStartTime) unless the
            // bridge inserted a pad runway in front of the real segments, in
            // which case the whole timeline — LOAD position included — sits that
            // much later: the receiver walks over the pads and lands in the real
            // media at the page's position. That crossing is the adapter's job,
            // and only the adapter's.
            const initialTime =
                this.isDashRemux &&
                this.preserveSourcePlayback &&
                startTimeOverride === undefined
                    ? this.mediaElement.currentTime
                    : this.isDashRemux
                    ? this.dashPresentation.pageToReceiver(dashStartTime)
                    : this.mediaElement.currentTime;
            if (Number.isFinite(initialTime)) {
                loadRequest.currentTime = initialTime;
            }
            this.debug?.("applying initial media position", {
                currentTime: loadRequest.currentTime,
                sourcePaused: this.mediaElement.paused,
                continuousSync: this.syncElementEnabled,
                sourceAuthoritative: this.preserveSourcePlayback,
                remuxStartTime: this.isDashRemux ? dashStartTime : undefined,
                presentationOffset: this.isDashRemux
                    ? this.dashPresentation.offsetSeconds
                    : undefined
            });
        } else if (
            bridgeStartTime !== undefined &&
            Number.isFinite(bridgeStartTime)
        ) {
            loadRequest.currentTime = bridgeStartTime;
            this.debug?.("applying live start position", {
                currentTime: loadRequest.currentTime
            });
        }

        if (!this.session) {
            // No active session: nothing will bind new media, so a DASH seek
            // reload would leave receiver->page sync held (and the tighten
            // polling) forever.
            this.dashTightenSync = false;
            this.debug?.("loadMedia skipped: no cast session");
            return;
        }

        // Initial Cast and Bilibili item changes also start/restart the DASH remux
        // at the page position. Arm the same one-shot receiver->page correction
        // used after explicit seeks, but only after bridge preparation has
        // completed so the 15-second settle deadline covers receiver loading.
        const tightenAfterLoad =
            this.isDashRemux &&
            startTimeOverride === undefined &&
            !this.preserveSourcePlayback;
        if (tightenAfterLoad) {
            this.dashTightenSync = true;
            this.dashTightenDeadline =
                Date.now() + MediaSender.DASH_TIGHTEN_WINDOW_MS;
            this.debug?.("post-load sync armed", {
                reason: this.media ? "media-update" : "initial-cast",
                targetTime: dashStartTime
            });
        }

        const activeSession = this.session;
        activeSession.loadMedia(
            loadRequest,
            media => {
                if (this.stopped || loadId !== this.dashLoadId) {
                    this.debug?.("ignored stale receiver media load callback", {
                        loadId
                    });
                    return;
                }
                this.debug?.("receiver media loaded");
                this.media = media;
                // A LOAD the coordinator did not start (the initial cast, a
                // quality change, a recovery rebuild, an item transition) still
                // has to leave it with a settled phase: `markLoadSettled` below
                // only clears a phase this coordinator's own transaction set, so
                // without this the phase would be left at whatever a previous
                // operation put there. Nothing here releases a hold — those are
                // owned by the capture-side windows (see isHoldingPage).
                if (!this.playbackCoordinator.isTransactionActive()) {
                    this.playbackCoordinator.markItemSettled();
                }
                // The LOAD this adapter belongs to has been accepted, so a media
                // session carrying THIS generation's declared content may be bound
                // to it. The callback's own Media object is deliberately NOT the
                // evidence: it can be the stale previous session, which is exactly
                // why binding it taught the adapter the OLD identity and made it
                // refuse the new one — a refusal that drops the position silently.
                // See confirmReceiverMediaIdentity.
                this.confirmReceiverMediaIdentity();
                // Load identity for the priming release check: the callback's own
                // Media object can be the stale previous session (see
                // addMediaElementListeners), so this is a signal, not proof.
                if (this.dashSeekSourcePriming?.loadId === loadId) {
                    this.dashSeekSourcePriming.loadResolved = true;
                }
                if (this.dashItemTransition?.loadId === loadId) {
                    this.dashItemTransition.loadResolved = true;
                    this.debug?.("item transition: LOAD callback resolved", {
                        loadId,
                        callbackMediaSessionId: media?.mediaSessionId,
                        sessionMediaIds: this.session?.media?.map(
                            item => item.mediaSessionId
                        ),
                        callbackPlayerState: media?.playerState
                    });
                }
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
                            )
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
                // Last, and only now: a seek this load coalesced is served with
                // the page controls attached again, so that generation's hold can
                // park the page at its target. `loadCurrentItem` detaches them
                // (`suspendMediaElementSync`) for the reload, which leaves
                // `onDashSeekStart` undefined until the line above re-attaches it
                // — a hold issued before that would be silently dropped and the
                // page would stay wherever the previous step left it.
                this.serveSeekPendingFromItemChange();
            },
            err => {
                if (this.stopped || loadId !== this.dashLoadId) return;
                // The whole rejection context in one line: a bare SDK error has
                // no identity, so it cannot be told apart from the PREVIOUS
                // session's INTERRUPTED arriving late.
                this.debug?.("receiver media load rejected", {
                    loadId,
                    requestId: this.activeMediaServerRequestId,
                    code: (err as { code?: string })?.code,
                    description: (err as { description?: string })?.description,
                    error: err instanceof Error ? err.message : String(err),
                    itemTransition: Boolean(this.dashItemTransition),
                    seekPriming: Boolean(this.dashSeekSourcePriming),
                    loadedAt: loadRequest.currentTime,
                    sessionMediaIds: this.session?.media?.map(
                        item => item.mediaSessionId
                    )
                });
                if (loadId === this.dashLoadId) {
                    // A rejected LOAD arrives via this callback — loadMedia never
                    // throws for it — so this is the only place a failed seek reload
                    // clears the tighten. Otherwise it would linger until its
                    // deadline, polling GET_STATUS every second and suppressing
                    // normal drift correction.
                    this.dashTightenSync = false;
                    // A rejected load must not leave a hold behind either.
                    if (this.dashSeekSourcePriming?.loadId === loadId) {
                        this.clearDashSeekSourcePriming("load-rejected");
                    }
                    // …nor an item-transition window: with no new session coming,
                    // holding the receiver's authority off would be permanent.
                    if (this.dashItemTransition?.loadId === loadId) {
                        this.clearDashItemTransition("load-rejected");
                    }
                    if (this.dashSeekLoadIdentity?.loadId === loadId) {
                        this.dashSeekLoadIdentity = undefined;
                    }
                }
                logger.error("Failed to load media", err);
            }
        );
    }

    /**
     * One-shot holds waiting for the page to arrive at a seek target.
     *
     * Held on the sender, not in the listener closure, because the closure is
     * rebuilt on every load while the element (and the arrival it is waiting for)
     * outlives it.
     */
    private pageArrivalHold?: () => void;

    /** Drop any pending arrival hold (the element it belonged to is gone). */
    private cancelPageArrivalHolds() {
        const hold = this.pageArrivalHold;
        this.pageArrivalHold = undefined;
        hold?.();
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
        const BLE_EVENT_WINDOW_MS = PAGE_EVENT_WINDOW_MS;
        const BLE_SEEK_ARM_WINDOW_MS = 10000;
        let blePlayArmedUntil = 0;
        let blePauseArmedUntil = 0;
        let bleSeekArmedUntil = 0;

        /**
         * The page-route command currently owning the transition, if any. Only
         * one can be outstanding: a newer command replaces the arm, which is
         * what makes latest-wins hold on the page side too.
         */

        let pageArm:
            | {
                  command: PlaybackPageCommand;
                  expiresAt: number;
                  timeoutId: number;
              }
            | undefined;

        const reportProgress = (
            command: PlaybackPageCommand,
            progress: Record<string, unknown>
        ) => {
            void browser.runtime
                .sendMessage({
                    subject: "main:bilibiliPlaybackProgress",
                    data: {
                        commandId: command.commandId,
                        mediaIdentity: command.mediaIdentity,
                        ...progress
                    }
                })
                .catch(() => undefined);
        };

        const clearPageArm = () => {
            if (pageArm) window.clearTimeout(pageArm.timeoutId);
            pageArm = undefined;
        };

        /**
         * Drives the Cast receiver and reports the exact boundary. Shared by the
         * two page paths so the "already at target" and "page transition
         * happened" cases cannot drift apart (they used to).
         */
        const dispatchToReceiver = (
            command: PlaybackPageCommand,
            media: Media,
            action: "play" | "pause",
            reportRequested: boolean
        ) => {
            if (reportRequested) {
                reportProgress(command, {
                    receiverPhase: "requested",
                    // Sampled immediately BEFORE the Cast call: this is the
                    // timestamp the strict observation gate compares against.
                    receiverDispatchStartedAt: Date.now()
                });
            }
            this.noteDesiredPlayback(action);
            const onError = (err: unknown) => {
                sendError(`${action} receiver`)(err);
                reportProgress(command, {
                    receiverPhase: "failed",
                    error: err instanceof Error ? err.message : String(err)
                });
            };
            this.commandReceiverPlayback(media, action, onError);
        };

        /**
         * Consumes the armed window for an event kind. Returns whether a BLE
         * (touch-remote) action armed it, plus the page-route command whose arm
         * this event satisfies, if any - the page needs that identity to report
         * "target-observed" for the right command.
         */
        const consumeBleArm = (kind: "play" | "pause" | "seek") => {
            const now = Date.now();
            let armed = false;
            if (kind === "play") {
                armed = now < blePlayArmedUntil;
                blePlayArmedUntil = 0;
            } else if (kind === "pause") {
                armed = now < blePauseArmedUntil;
                blePauseArmedUntil = 0;
            } else {
                armed = now < bleSeekArmedUntil;
                bleSeekArmedUntil = 0;
            }
            let page: PlaybackPageCommand | undefined;
            if (pageArm && kind !== "seek") {
                const wanted = kind === "play" ? "PLAY" : "PAUSE";
                if (pageArm.command.intent === wanted) {
                    page = pageArm.command;
                    clearPageArm();
                }
            }
            return { ble: armed, page };
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
            if (!fromGesture()) return;
            seekArmedUntil = Date.now() + SEEK_ARM_WINDOW_MS;
            // Reset the rolling handoff before the page's target Range requests
            // arrive. The seek restart can then replay those bytes into the new
            // bridge generation even when MSE suppresses a second fetch.
            void browser.runtime
                .sendMessage({ subject: "bilibili:pageSeekStarted" })
                .catch(() => undefined);
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
            const pagePlay = consumeBleArm("play");
            const fromBleRemote = pagePlay.ble;
            if (!fromBleRemote && !fromGesture()) {
                this.debug?.("ignored autonomous page play");
                return;
            }
            this.debug?.(
                fromBleRemote
                    ? "BLE remote page control: play"
                    : "page control: play"
            );
            // A trusted BLE or user-driven play/pause ends the settle window.
            this.dashTightenSync = false;
            const media = currentMedia();
            if (pagePlay.page) {
                // The page transition this command asked for has happened.
                reportProgress(pagePlay.page, {
                    pagePhase: "target-observed"
                });
            }
            if (!media) {
                if (pagePlay.page) {
                    // The page changed but the receiver cannot be driven: an
                    // explicit failure of this owner's receiver leg, not an
                    // unobserved state. Owner is already fixed, so no fallback.
                    reportProgress(pagePlay.page, {
                        receiverPhase: "failed",
                        error: "No active cast media"
                    });
                }
                return;
            }
            if (pagePlay.page) {
                dispatchToReceiver(pagePlay.page, media, "play", true);
                return;
            }
            this.noteDesiredPlayback("play");
            this.commandReceiverPlayback(media, "play", sendError("play"));
        };
        const onPause = () => {
            if (suppressPause > 0) {
                suppressPause--;
                return;
            }
            const pagePause = consumeBleArm("pause");
            const fromBleRemote = pagePause.ble;
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
            const media = currentMedia();
            if (pagePause.page) {
                reportProgress(pagePause.page, {
                    pagePhase: "target-observed"
                });
            }
            if (!media) {
                if (pagePause.page) {
                    reportProgress(pagePause.page, {
                        receiverPhase: "failed",
                        error: "No active cast media"
                    });
                }
                return;
            }
            if (pagePause.page) {
                dispatchToReceiver(pagePause.page, media, "pause", true);
                return;
            }
            this.noteDesiredPlayback("pause");
            this.commandReceiverPlayback(media, "pause", sendError("pause"));
        };
        // While the bridge re-prepares the stream for a DASH seek, pause the
        // receiver immediately so playback holds at the old frame instead of
        // running ahead of the rebuild. Chromecast also parks the page at the
        // target; Roku capture must NOT seek the page yet — those m4s bytes
        // would be ingested by the generation that is about to be replaced.
        this.onDashSeekStart = (target: number) => {
            // The seek hold: OUR command, not the user's. It pauses the receiver so
            // playback holds the old frame instead of running ahead of the rebuild.
            const held = currentMedia();
            if (held) {
                this.commandReceiverPlayback(
                    held,
                    "pause",
                    sendError("dash seek pause")
                );
            }
            if (this.preserveSourcePlayback) {
                this.debug?.(
                    "source-authoritative DASH seek paused receiver; page deferred until capture listens",
                    {
                        target,
                        pageTime: mediaElement.currentTime
                    }
                );
                return;
            }
            // WRITE FIRST, FREEZE AFTER. A page player fetches and decodes the
            // target range only while it is PLAYING, so pausing the element
            // before the write is a position that never arrives: the element
            // reports `seeking` and then sits on the OLD position until something
            // plays it again - on a cast that is the receiver's PLAYING, which is
            // why the page appeared to jump to the target only once the receiver
            // started. The hold is about where the page ENDS UP (frozen at the
            // target), not about freezing it before it can get there.
            //
            // Tagged with the intent that owns the write, so the `seeked` it
            // causes is attributed to the coordinator rather than read as a
            // second, independent user seek.
            const wrote = this.writePageTime(mediaElement, target, {
                origin: "sync-write",
                intentId: this.playbackCoordinator.peekIntent()?.intentId
            });
            const freeze = () => {
                if (mediaElement.paused) return;
                suppressPause++;
                mediaElement.pause();
            };
            if (!wrote) {
                // Already at the target (the write was a no-op): nothing to wait
                // for, freeze where it is.
                freeze();
                return;
            }
            if (mediaElement.paused) {
                // Already frozen and unable to fetch the target: there is no hold
                // to add (the position lands when the page plays again).
                return;
            }
            const onPageArrived = () => {
                mediaElement.removeEventListener("seeked", onPageArrived);
                this.pageArrivalHold = undefined;
                freeze();
            };
            // Registered on the sender so a rebuilt listener set can drop it: the
            // element it belongs to may be replaced while it waits.
            this.pageArrivalHold = () =>
                mediaElement.removeEventListener("seeked", onPageArrived);
            mediaElement.addEventListener("seeked", onPageArrived);
        };
        this.primePageCaptureAt = (target: number) => {
            this.writePageTime(mediaElement, target, { origin: "sync-write" });
            if (mediaElement.paused) {
                suppressPlay++;
                void mediaElement.play().catch(err => {
                    suppressPlay = Math.max(0, suppressPlay - 1);
                    logger.error(
                        "Failed to prime page capture after seek",
                        err
                    );
                });
            }
        };

        const onSeeked = () => {
            if (!this.syncMediaPosition) return;
            // Origin first: is this event the acknowledgement of a write WE
            // just made? A drift correction, a seek hold and a capture prime all
            // move the element, and the element then reports the change back as
            // `seeked`. Reading that as "the user asked to seek here" is what
            // turned one correction into another remux restart — and, with the
            // receiver's own report feeding the correction, into a loop.
            const ownWrite = this.playbackCoordinator.consumePageWrite();
            if (ownWrite) {
                this.debug?.(
                    "ignored page seek: acknowledgement of our own write",
                    {
                        origin: ownWrite.origin,
                        intentId: ownWrite.intentId,
                        pageTime: mediaElement.currentTime
                    }
                );
                return;
            }
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
            // Exactly two things may carry a seek intent out of the page: a BLE
            // (touch-remote) skip, and the arm the gesture-adjacent `seeking`
            // installed above. `consumeBleArm` returns a RECORD, not a flag -
            // testing it directly made this gate dead, so every page `seeked`
            // (the site's own buffering/quality/navigation seeks included)
            // restarted the remux with origin `ble`, killing the generation the
            // receiver had just been loaded on.
            //
            // A bare pointerdown is deliberately NOT a third source: `fromGesture`
            // would re-open this gate for whatever the page does in the next
            // 1.5s, which is precisely the autonomous event this gate exists to
            // refuse. The narrow authorization is the `seeking` arm, which only
            // a gesture-adjacent `seeking` can install.
            const fromBleRemote = consumeBleArm("seek").ble;
            if (!fromBleRemote && !seekArmed) {
                this.debug?.("ignored autonomous page seek", {
                    pageTime: mediaElement.currentTime
                });
                return;
            }
            if (fromBleRemote) {
                this.debug?.("BLE remote page control: seek", {
                    currentTime: mediaElement.currentTime,
                    dashRemux: this.isDashRemux
                });
            }
            if (this.isHlsDvr) {
                // The CCTV page player runs on its own live clock, unrelated to the
                // synthetic VOD timeline — its seek positions cannot be translated.
                // Only play/pause are forwarded for live sources.
                this.debug?.("ignored page seek on unrelated live timeline");
                return;
            }
            if (this.isDashRemux) {
                // The receiver cannot seek inside the sequentially-remuxed HLS:
                // segments past the ffmpeg download frontier return 404 and the
                // receiver buffers forever. Restart the remux at the target instead.
                //
                // This is the ONE page-originated intent that may restart the
                // remux, and it reaches the coordinator through the single entry
                // point with its origin stated, so the trace can tell a user's
                // seek apart from anything else that moved the element.
                //
                // A transaction already owns the page here: the user's seek is
                // recorded as an intent (the running transaction retargets to it,
                // newest wins) but must not start a SECOND bridge generation —
                // which is exactly the duplicate-reload shape this refactor
                // removes.
                const target = mediaElement.currentTime;
                this.debug?.("page control: seek (dash remux restart)", {
                    target,
                    holding: this.isHoldingPage()
                });
                this.seekDashRemux(target, fromBleRemote ? "ble" : "page");
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
            seekForwardSeconds,
            pageCommand,
            pageDispatchSink
        ) => {
            const now = Date.now();
            const recordDispatch = (value: PlaybackDispatchResult) => {
                this.lastPlaybackDispatch = value;
                if (pageDispatchSink) pageDispatchSink.dispatch = value;
            };
            // Shared by the BLE-remote path and the popup page route (see
            // controlPlayback): the page transition and the receiver dispatch
            // are the same two operations either way, so they must not drift.
            if (action === "pause" || action === "play") {
                const media = currentMedia();
                if (!media) {
                    this.debug?.("page play/pause ignored: no cast media");
                    recordDispatch({
                        outcome: "no-media",
                        at: now
                    });
                    return false;
                }
                const alreadyAtTarget =
                    action === "pause"
                        ? mediaElement.paused
                        : !mediaElement.paused;
                if (alreadyAtTarget) {
                    // No page transition, hence no arm and no page event: the
                    // receiver is driven directly, and the dispatch timestamp
                    // is the moment before that call.
                    recordDispatch({
                        outcome: "receiver-only",
                        at: Date.now()
                    });
                    this.noteDesiredPlayback(action);
                    this.commandReceiverPlayback(
                        media,
                        action,
                        action === "pause"
                            ? sendError("pause")
                            : sendError("play")
                    );
                    return true;
                }
                // Arm FIRST, then trigger the page transition. `pause()` and
                // `play()` can deliver their media events synchronously (or so
                // fast that the arm is not yet visible), and an event that
                // arrives before its arm exists cannot be attributed to the
                // command: it is consumed by the BLE arm instead, the receiver
                // is driven, and every `reportProgress` for that command is
                // skipped - which is exactly how a real session ended up with a
                // paused Roku and a background still waiting for the page leg.
                let armedAt: number | undefined;
                if (pageCommand) {
                    // The window's arm must be usable by ONE command: a second
                    // command replaces it, and the replaced one is told why it
                    // will never see its event.
                    const replaced = pageArm?.command;
                    if (replaced && replaced !== pageCommand) {
                        reportProgress(replaced, {
                            pagePhase: "timeout",
                            pagePausedSnapshot: mediaElement.paused
                        });
                    }
                    clearPageArm();
                    const command = pageCommand;
                    // Sampled HERE, at the assignment, not at the top of the
                    // dispatch: `armedAt` is handed to the background as the
                    // boundary a page event must be newer than, so it has to be
                    // the moment the arm really exists. `lastPlaybackDispatch.at`
                    // stays what it always was - when the decision started.
                    const pageArmInstalledAt = Date.now();
                    pageArm = {
                        command,
                        expiresAt: pageArmInstalledAt + BLE_EVENT_WINDOW_MS,
                        timeoutId: window.setTimeout(() => {
                            const expired = pageArm;
                            if (!expired || expired.command !== command) return;
                            pageArm = undefined;
                            // The armed window closed with no consumable page
                            // event: the receiver was never dispatched for this
                            // command, and the page may or may not have changed.
                            reportProgress(command, {
                                pagePhase: "timeout",
                                pagePausedSnapshot: mediaElement.paused
                            });
                        }, BLE_EVENT_WINDOW_MS)
                    };
                    armedAt = pageArmInstalledAt;
                }
                recordDispatch({
                    outcome: "transition",
                    at: now,
                    ...(armedAt === undefined ? {} : { armedAt })
                });
                try {
                    if (action === "pause") {
                        blePauseArmedUntil = now + BLE_EVENT_WINDOW_MS;
                        mediaElement.pause();
                    } else {
                        blePlayArmedUntil = now + BLE_EVENT_WINDOW_MS;
                        void mediaElement.play().catch(error => {
                            blePlayArmedUntil = 0;
                            sendError("page play")(error);
                        });
                    }
                } catch (error) {
                    // The page call failed SYNCHRONOUSLY: nothing was
                    // dispatched, so the arm installed above must not stay
                    // behind waiting for an event that will never come - but
                    // only OUR arm may be cleared, never one a re-entrant
                    // command installed while this call was unwinding.
                    if (pageCommand && pageArm?.command === pageCommand) {
                        clearPageArm();
                    }
                    if (action === "pause") blePauseArmedUntil = 0;
                    else blePlayArmedUntil = 0;
                    recordDispatch({
                        outcome: "page-sync-failed",
                        at: Date.now()
                    });
                    sendError(action === "pause" ? "page pause" : "page play")(
                        error
                    );
                    return false;
                }
                return true;
            }

            const backwardSeconds = Math.max(
                1,
                Number(seekBackwardSeconds) || 30
            );
            const forwardSeconds = Math.max(
                1,
                Number(seekForwardSeconds) || 30
            );
            const delta =
                action === "seek_backward" ? -backwardSeconds : forwardSeconds;
            if (this.isHlsDvr) {
                // The page element runs on an unrelated live clock, so seek the
                // receiver directly on its VOD timeline. Backward is free (history
                // segments exist); forward is clamped behind the live edge so it
                // never targets a segment the CDN hasn't published yet.
                const boundMedia = currentMedia();
                const current = boundMedia?.getEstimatedTime();
                if (
                    !boundMedia ||
                    current === undefined ||
                    !Number.isFinite(current) ||
                    current < 0
                ) {
                    this.debug?.(
                        "BLE remote seek ignored: no receiver position"
                    );
                    return true;
                }
                const liveEdge = this.dvrLiveEdgeSeconds();
                let target = current + delta;
                if (liveEdge !== undefined) {
                    target = Math.min(
                        target,
                        Math.max(
                            0,
                            liveEdge -
                                MediaSender.DVR_FORWARD_SEEK_MARGIN_SECONDS
                        )
                    );
                }
                target = Math.max(0, target);
                this.debug?.("BLE remote receiver-native DVR seek", {
                    action,
                    from: current,
                    target,
                    liveEdge
                });
                const request = new cast.media.SeekRequest();
                request.currentTime = target;
                boundMedia.seek(request, undefined, sendError("BLE DVR seek"));
                return true;
            }
            // Where the skip lands: the same helper the direct path uses, so the
            // closure and `controlFromBleRemote` cannot disagree.
            const seek = this.bleSeekTarget(
                action,
                seekBackwardSeconds,
                seekForwardSeconds
            );
            if (seek.kind === "unsupported") {
                this.debug?.("BLE remote seek ignored: no page position", {
                    action
                });
                return true;
            }
            if (seek.kind === "no-op") {
                this.debug?.("BLE remote seek already at boundary", {
                    action,
                    currentTime: mediaElement.currentTime
                });
                return true;
            }
            const target = seek.target;
            this.debug?.("BLE remote synchronized seek", {
                action,
                from: mediaElement.currentTime,
                target,
                dashRemux: this.isDashRemux
            });
            if (this.isDashRemux) {
                // A BLE skip is an explicit user intent: it enters the single
                // seek entry point with its own origin, so the restart it causes
                // is attributable and coalesces with any other seek in flight.
                this.seekDashRemux(target, "ble");
                return true;
            }
            bleSeekArmedUntil = now + BLE_SEEK_ARM_WINDOW_MS;
            this.writePageTime(mediaElement, target, { origin: "sync-write" });
            return true;
        };

        const gated = this.gestureGatedControls;
        let lastSyncDebugAt = 0;
        let lastGetStatusPollAt = 0;

        /**
         * Receiver play/pause -> page, for EVERY sender.
         *
         * This is deliberately separate from position reconciliation: a page that
         * supplies the source watermark (`preserveSourcePlayback`, i.e. Bilibili
         * on a Roku) keeps the POSITION authority - the receiver must not drag the
         * page's clock around - but its play/pause state still has to follow the
         * receiver, because the receiver's state changes on its own (Roku remote,
         * Roku UI, another controller) and not only through commands that already
         * went through the page.
         */
        const reconcilePlaybackState = (boundMedia: {
            playerState: string;
            mediaSessionId?: number;
            idleReason?: string | null;
        }) => {
            // DASH seek transaction first, and BEFORE every early return below:
            // a tick that would otherwise be a no-op still has to end the hold
            // (satisfied / superseded / expired), and neither the release test
            // nor the deadline may be skipped by the localState early return.
            let seekPriming = this.dashSeekSourcePriming;
            if (seekPriming) {
                if (seekPriming.requestId !== this.activeMediaServerRequestId) {
                    // A newer load owns the sender: this transaction is stale.
                    this.clearDashSeekSourcePriming("request-superseded");
                    seekPriming = undefined;
                } else if (this.isDashSeekPrimingSatisfied(boundMedia)) {
                    this.clearDashSeekSourcePriming("new-media-playing");
                    seekPriming = undefined;
                } else if (this.isDashSeekPrimingDead(boundMedia)) {
                    // The new session is up and the receiver itself declares the
                    // media dead: the transaction has failed, and holding the
                    // receiver's authority off until the 120s deadline would
                    // leave the page paused and every control held while the
                    // receiver sits on an error screen.
                    this.clearDashSeekSourcePriming("new-media-error");
                    seekPriming = undefined;
                } else if (Date.now() >= seekPriming.deadline) {
                    // Clearing is enough: this same call now falls through to the
                    // ordinary reconciliation below (no recursion needed).
                    this.clearDashSeekSourcePriming("deadline");
                    seekPriming = undefined;
                }
            }

            /**
             * Item/quality transition, evaluated BEFORE the local-state early
             * return below: with the page already playing and the OLD session
             * also reporting PLAYING, an equal-state tick would otherwise skip
             * this function entirely — and with it the window's own
             * identity/expiry accounting. Same ordering rule the seek priming
             * above follows.
             *
             * The media the receiver is reporting on is the PREVIOUS item until
             * the new session shows up, so its PAUSED (and its IDLE at the end of
             * the old stream) must not stop the page that is already playing the
             * new item. A receiver PAUSED that arrives AFTER the window closes is
             * a real user pause and still stops the page.
             */
            const itemTransition = this.dashItemTransitionActive();
            if (itemTransition) {
                this.traceItemTransition(boundMedia);
            }
            if (
                itemTransition &&
                boundMedia.playerState === cast.media.PlayerState.PAUSED
            ) {
                this.debug?.(
                    "receiver PAUSED ignored during the item transition",
                    { mediaSessionId: boundMedia.mediaSessionId }
                );
                return;
            }

            const localState = mediaElement.paused
                ? cast.media.PlayerState.PAUSED
                : cast.media.PlayerState.PLAYING;
            if (localState === boundMedia.playerState) return;

            /**
             * Which senders must keep the page PLAYING through receiver
             * startup/recovery states: the page player is what produces the
             * source watermark they feed from (CCTV's HLS DVR live frontier,
             * Bilibili's DASH capture frontier). Pausing it there starves the
             * very relay that has to recover.
             */
            const needsSourceWatermark =
                this.isHlsDvr ||
                (this.isDashRemux && this.preserveSourcePlayback);

            const resumePage = () => {
                if (!mediaElement.paused) return;
                // The suppression is UNCONDITIONAL, gate or no gate. Skipping it
                // for a gated sender left our own mirrored `play` to the gesture
                // window: with a window open - a real page gesture moments earlier,
                // which is exactly when a receiver report arrives - the element's
                // `play` event passed `fromGesture()` and was read as a USER play,
                // so an OBSERVATION ended up commanding the receiver. That command
                // also became `lastCommandedReceiverState`, which is how a later
                // genuine remote pause came to be dismissed as our own echo. The
                // gate drops an unattributed page event, but it cannot tell our own
                // event from the user's, so the counter that can must always be
                // armed - and released by `onPlay`, which is the only thing that
                // consumes it.
                suppressPlay++;
                void mediaElement.play().catch(err => {
                    suppressPlay = Math.max(0, suppressPlay - 1);
                    logger.error(
                        needsSourceWatermark
                            ? "Failed to keep page playback alive for the source watermark"
                            : "Failed to sync play state",
                        err
                    );
                });
            };

            switch (boundMedia.playerState) {
                case cast.media.PlayerState.PLAYING:
                    resumePage();
                    break;
                case cast.media.PlayerState.PAUSED:
                    // DASH seek transaction: during this window this PAUSED is
                    // our own seek hold echoed by the OLD media session while the
                    // new capture generation is being built. The page is the only
                    // supplier of that generation, so it keeps playing until the
                    // receiver's new session plays (or the transaction ends).
                    // Outside the window a receiver pause pauses the page as
                    // before (9704dac).
                    if (seekPriming) break;
                    // Unconditional for the same reason as resumePage's: a mirrored
                    // pause inside an open gesture window is ours, not the user's.
                    if (!mediaElement.paused) suppressPause++;
                    mediaElement.pause();
                    break;
                case cast.media.PlayerState.BUFFERING:
                case cast.media.PlayerState.IDLE:
                    if (needsSourceWatermark) {
                        resumePage();
                        break;
                    }
                    if (!mediaElement.paused) suppressPause++;
                    mediaElement.pause();
                    break;
            }
        };
        const syncFromReceiver = () => {
            if (this.preserveSourcePlayback) {
                // Page-clock-master: the page keeps POSITION authority, so no
                // receiver status is written onto the page clock, no drift
                // correction and no receiver-position snap. Clear the DASH
                // seek/load transaction flags (runDashSeek / loadMedia arm them;
                // loadMedia's callback also clears the hold, but a
                // failed/abandoned load still needs this).
                //
                // Play/pause is NOT part of that authority: a receiver pauses on
                // its own (Roku remote, Roku UI, another controller), so the page
                // must follow the receiver's state here too. Skipping it left the
                // Bilibili page playing while the Roku was paused.
                this.dashTightenSync = false;
                const boundMedia = currentMedia();
                if (
                    boundMedia &&
                    boundMedia.playerState === cast.media.PlayerState.IDLE &&
                    boundMedia.idleReason === cast.media.IdleReason.ERROR &&
                    this.receiverErrorLoggedForSession !==
                        boundMedia.mediaSessionId
                ) {
                    this.receiverErrorLoggedForSession =
                        boundMedia.mediaSessionId;
                    this.debug?.("receiver returned media error", {
                        mediaSessionId: boundMedia.mediaSessionId,
                        currentTime: boundMedia.currentTime
                    });
                    this.logRecovery("info", "Receiver returned media error", {
                        mediaSessionId: boundMedia.mediaSessionId,
                        currentTime: boundMedia.currentTime
                    });
                }
                if (boundMedia) reconcilePlaybackState(boundMedia);
                return;
            }
            const boundMedia = currentMedia();
            // One answer to "is a transaction driving the page?" — the same one
            // the mirror-hold below uses, so the log cannot describe a different
            // state from the decision it explains.
            const holdingPage = this.isHoldingPage();
            // While a DASH seek reload is settling, log the sync inputs once per
            // second so it's visible exactly where reconciliation is stuck.
            if (
                (holdingPage || this.dashTightenSync) &&
                Date.now() - lastSyncDebugAt > 1000
            ) {
                lastSyncDebugAt = Date.now();
                this.debug?.("post-seek sync state", {
                    hold: holdingPage,
                    tighten: this.dashTightenSync,
                    playerState: boundMedia?.playerState,
                    estimatedTime: boundMedia?.getEstimatedTime(),
                    receiverLabel: this.session?.receiver.label,
                    isDashRemux: this.isDashRemux,
                    mediaCount: this.session?.media?.length,
                    boundMediaSessionId: boundMedia?.mediaSessionId,
                    pageTime: mediaElement.currentTime,
                    pagePaused: mediaElement.paused
                });
            }
            if (!boundMedia) return;

            // ---- auto-recovery death detection ----
            // Judge death by the receiver's BEHAVIOR, not its status reports. The
            // liveness clock starts at the receiver's FIRST live-segment fetch
            // (beyond the prebuffer); before that (lastRelaySegmentRequestAt === 0)
            // no judgment is made — first playback gets the whole cached window.
            // Once live fetches have begun, a single steady-state request gets 2.5
            // segment periods before recovery: one earned period plus 1.5 periods
            // of receiver/scheduler jitter. During every load, media-time stagnation
            // provides a
            // separate fallback until the first post-prebuffer request.
            // A paused receiver is exempt from both checks.
            const now = Date.now();
            const receiverMediaTime = Number(boundMedia.currentTime);
            if (
                Number.isFinite(receiverMediaTime) &&
                (this.prebufferProgressMediaTime === undefined ||
                    Math.abs(
                        receiverMediaTime - this.prebufferProgressMediaTime
                    ) >= 0.25)
            ) {
                this.prebufferProgressMediaTime = receiverMediaTime;
                this.prebufferProgressObservedAt = now;
            }
            const prebufferProgressTimeoutMs = Math.max(
                15_000,
                this.relayActivityTimeoutMs() * 2
            );
            const prebufferStalled =
                this.autoRecoverOnIdle &&
                this.lastRelaySegmentRequestAt === 0 &&
                this.prebufferProgressObservedAt > 0 &&
                now - this.prebufferProgressObservedAt >
                    prebufferProgressTimeoutMs &&
                now -
                    Math.max(
                        this.prebufferProgressObservedAt,
                        this.lastPrebufferSegmentRequestAt
                    ) >
                    prebufferProgressTimeoutMs;
            const isReceiverIdle =
                boundMedia.playerState === cast.media.PlayerState.IDLE;
            if (!isReceiverIdle) {
                this.receiverErrorLoggedForSession = undefined;
            }
            const receiverError =
                isReceiverIdle &&
                boundMedia.idleReason === cast.media.IdleReason.ERROR;
            if (
                receiverError &&
                this.receiverErrorLoggedForSession !== boundMedia.mediaSessionId
            ) {
                this.receiverErrorLoggedForSession = boundMedia.mediaSessionId;
                this.debug?.("receiver returned media error", {
                    mediaSessionId: boundMedia.mediaSessionId,
                    playerState: boundMedia.playerState,
                    idleReason: boundMedia.idleReason,
                    currentTime: boundMedia.currentTime
                });
                this.logRecovery("info", "Receiver returned media error", {
                    mediaSessionId: boundMedia.mediaSessionId,
                    playerState: boundMedia.playerState,
                    idleReason: boundMedia.idleReason,
                    currentTime: boundMedia.currentTime
                });
            }
            const relayJitterAllowanceMs =
                this.relaySegmentStepSeconds * 1.5 * 1000;
            const livenessStale =
                this.autoRecoverOnIdle &&
                ((this.relayLivenessDeadlineAt > 0 &&
                    now >
                        this.relayLivenessDeadlineAt +
                            relayJitterAllowanceMs) ||
                    prebufferStalled);
            // Receiver ERROR is diagnostic evidence, not its own death trigger.
            // Only after request/media-time liveness goes stale may ERROR confirm
            // immediate recovery; without ERROR, allow one full segment period.
            if (!livenessStale || receiverError) {
                this.receiverLivenessGraceObservedAt = 0;
            } else if (this.receiverLivenessGraceObservedAt === 0) {
                this.receiverLivenessGraceObservedAt = now;
            }
            const livenessGraceExpired =
                livenessStale &&
                !receiverError &&
                this.receiverLivenessGraceObservedAt > 0 &&
                now - this.receiverLivenessGraceObservedAt >=
                    this.relaySegmentStepSeconds * 1000;
            const relayStale =
                livenessStale && (receiverError || livenessGraceExpired);
            if (!relayStale) {
                // Segment requests flowing (or no live relay yet): playback is healthy.
                this.relayStaleLogged = false;
            } else if (
                boundMedia.playerState === cast.media.PlayerState.PAUSED
            ) {
                // A paused receiver legitimately stops fetching segments.
                this.relayStaleLogged = false;
            } else {
                if (!this.relayStaleLogged) {
                    this.relayStaleLogged = true;
                    this.logRecovery(
                        "info",
                        receiverError
                            ? "Receiver returned media error; treating media as dead"
                            : livenessGraceExpired
                            ? "Receiver liveness remained stale for one segment without an error; treating media as dead"
                            : prebufferStalled
                            ? "Receiver media time stalled inside prebuffer; treating media as dead"
                            : "Receiver segment requests stopped; treating media as dead",
                        {
                            mediaSessionId: boundMedia.mediaSessionId,
                            playerState: boundMedia.playerState,
                            idleReason: boundMedia.idleReason,
                            receiverError,
                            livenessGraceMs:
                                this.receiverLivenessGraceObservedAt > 0
                                    ? now - this.receiverLivenessGraceObservedAt
                                    : undefined,
                            msSinceLastSegmentRequest:
                                this.lastRelaySegmentRequestAt > 0
                                    ? now - this.lastRelaySegmentRequestAt
                                    : undefined,
                            relayCreditSegments:
                                this.relayLivenessDeadlineAt > 0
                                    ? Math.max(
                                          0,
                                          (this.relayLivenessDeadlineAt - now) /
                                              (this.relaySegmentStepSeconds *
                                                  1000)
                                      )
                                    : undefined,
                            segmentDurationMs:
                                this.relaySegmentStepSeconds * 1000,
                            livenessThresholdMs:
                                this.relaySegmentStepSeconds * 1000 +
                                relayJitterAllowanceMs,
                            prebufferStalled,
                            msSinceReceiverProgress: prebufferStalled
                                ? now - this.prebufferProgressObservedAt
                                : undefined,
                            msSinceLastPrebufferSegmentRequest:
                                prebufferStalled &&
                                this.lastPrebufferSegmentRequestAt > 0
                                    ? now - this.lastPrebufferSegmentRequestAt
                                    : undefined
                        }
                    );
                }
                const cooldownRemainingMs = Math.max(
                    0,
                    this.recoverNotBeforeAt - now
                );
                if (
                    !this.stopped &&
                    !this.recoverInFlight &&
                    cooldownRemainingMs === 0
                ) {
                    void this.recoverFromIdleDeath();
                }
            }

            const rawEstimatedTime = boundMedia.getEstimatedTime();
            // Confirm the media session this report comes through, before anything
            // interprets it: the receiver can create a further media session for
            // this generation AFTER the LOAD callback settled, and an identity the
            // adapter cannot describe is refused — dropped silently rather than
            // converted or observed. Idempotent and evidence-gated (see the method).
            this.confirmReceiverMediaIdentity();
            // The receiver's report is REMEMBERED here, before any window or hold
            // can return from this tick.
            //
            // An action may be refused by a window (an item transition's PAUSED
            // belongs to the previous item; a seek transaction's state is stale);
            // the MEMORY may not. Recording it deeper in the flow meant a report
            // that arrived while a window or the coordinator's transaction held the
            // page was invisible twice over: its action was suppressed, and the
            // NEXT report on the same session then looked like "a session we have
            // never seen" - so a receiver PLAY/PAUSE was lost entirely. Measured by
            // the phase-3 generator (seed 96028: a receiver PAUSED after an item
            // change was never adopted as intent, and the seek that followed
            // reloaded playing).
            this.previousReceiverReport = this.noteReceiverReport(boundMedia);
            // And the intent is decided HERE, not inside the page mirror below.
            //
            // Mirroring the receiver onto the page is deliberately suppressible:
            // while a transaction holds the page, while an item transition owns it,
            // and for the gesture window after a real user interaction (the mirror
            // must not yank the element back before the user's own command lands).
            // Which play/pause state the next reload inherits is none of those
            // things - a receiver PAUSED the user asked for with the remote is not
            // "the mirror fighting a user command" - so tying the two together
            // dropped the user's intent every time a window suppressed the mirror.
            // The phase-3 generator found exactly that (seed 96028: an item change,
            // then a gesture, then a receiver PAUSED, and the pause was never
            // adopted).
            this.adoptReceiverPlaybackIntent(
                boundMedia,
                this.previousReceiverReport
            );
            // ---- window ADVANCEMENT comes before the generic hold -------------
            //
            // `isHoldingPage()` includes this very window, so running the hold
            // guard first made the release below UNREACHABLE: the transition kept
            // itself alive merely by existing, the receiver's new session never had
            // its position read, and the window stayed open until its 120s
            // backstop — swallowing the receiver's authority over the page for two
            // minutes. Every window that can contribute to the hold must therefore
            // get the chance to END before anything asks "is something holding the
            // page?".
            //
            // The item/quality transition: until the receiver's NEW session reports
            // a position, every position it has belongs to the PREVIOUS item, so
            // applying one would drag the page back into the old video (a different
            // duration, a different timeline). The first real position of the new
            // session closes the window, and ordinary reconciliation resumes — the
            // LOAD was issued at the page's own position, so there is nothing to
            // correct at that moment.
            if (this.dashItemTransitionActive()) {
                const transition = this.dashItemTransition;
                // Identity: the window closes only on a session this LOAD produced,
                // and BOTH halves are required.
                //
                //  - `loadResolved` alone proves nothing: the LOAD callback can
                //    return the PREVIOUS session's Media object (the receiver
                //    answers a reload with the old item's INTERRUPTED status), so a
                //    PLAYING report at that moment would release the window onto the
                //    old item's timeline.
                //  - A different mediaSessionId alone proves nothing either: the
                //    receiver can have advanced past the old session while the new
                //    media is still being accepted.
                //
                // A transition with no recorded previous session is NOT treated as
                // "any session will do" — that reading is what let an old session
                // close its own replacement. It declines to close early instead; the
                // new session's first real position still arrives.
                const loadBelongsToTransition =
                    transition !== undefined && transition.loadResolved;
                const sessionAdvanced =
                    transition?.previousMediaSessionId !== undefined &&
                    typeof boundMedia.mediaSessionId === "number" &&
                    boundMedia.mediaSessionId !==
                        transition.previousMediaSessionId;
                const hasRealPosition =
                    Number.isFinite(rawEstimatedTime) &&
                    rawEstimatedTime >= 0 &&
                    boundMedia.playerState === cast.media.PlayerState.PLAYING;
                if (
                    loadBelongsToTransition &&
                    sessionAdvanced &&
                    hasRealPosition
                ) {
                    this.clearDashItemTransition("new-media-position");
                } else {
                    reconcilePlaybackState(boundMedia);
                    return;
                }
            }

            // A DASH seek reload is restarting the remux and rebinding the media
            // session; the old session's position/state is stale and must not be
            // mirrored onto the page. `isHoldingPage()` covers the coordinator
            // transaction AND the two capture-side windows that outlive a LOAD
            // (the seek's source priming and an item transition) — a page hold
            // that only noticed the coordinator's own phase let a still-live
            // priming window mirror the PREVIOUS generation's position.
            if (this.isHoldingPage()) return;
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
                    playerState: boundMedia.playerState
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
                    boundMediaSessionId: boundMedia.mediaSessionId
                });
                this.session?.sendMessage("urn:x-cast:com.google.cast.media", {
                    type: "GET_STATUS",
                    requestId: 0
                });
            }

            // Chromecast HLS reports currentTime=-1 while its event timeline is
            // being established. Skip only position reconciliation for that
            // sentinel. Playback-state reconciliation below must still run, or the
            // page video remains paused while the receiver is already PLAYING.
            const canSyncPosition =
                this.syncMediaPosition &&
                (boundMedia.playerState === cast.media.PlayerState.PLAYING ||
                    boundMedia.playerState === cast.media.PlayerState.PAUSED);
            if (
                canSyncPosition &&
                Number.isFinite(rawEstimatedTime) &&
                rawEstimatedTime >= 0
            ) {
                // The receiver's clock -> page time, through the generation's
                // own adapter. `undefined` means this report is about media this
                // sender does not own (a previous generation's session still
                // broadcasting): it is not converted at all, because any number
                // produced from it would belong to a timeline that no longer
                // exists.
                const estimatedTime = this.dashPageTimeFromReceiver(
                    rawEstimatedTime,
                    {
                        contentId: boundMedia.media?.contentId,
                        mediaSessionId: boundMedia.mediaSessionId
                    }
                );
                if (estimatedTime !== undefined) {
                    // Record what the receiver says. This is an OBSERVATION: it
                    // feeds the trace and the popup's display, and it has no path
                    // back into a seek. That separation is what stops the
                    // receiver's own reports from restarting the remux.
                    this.playbackCoordinator.observeReceiverPosition({
                        pageSeconds: estimatedTime,
                        playerState: boundMedia.playerState,
                        mediaSessionId: boundMedia.mediaSessionId
                    });
                    const drift = Math.abs(
                        mediaElement.currentTime - estimatedTime
                    );
                    // DASH remux: the page IS the position authority.
                    //
                    // The receiver plays the SAME content through a different
                    // capture path, so the two clocks diverge by however much the
                    // bridge's relay lags — and writing the receiver's position
                    // onto the page moves the element out from under the user's
                    // own progress bar for no gain. Worse, that write fires a
                    // `seeked` event, which used to be indistinguishable from the
                    // user dragging the bar: the correction became another remux
                    // restart, which produced a fresh receiver position, which
                    // corrected again. Observing instead of writing breaks that
                    // loop at its source.
                    if (this.isDashRemux) {
                        if (drift > 1) {
                            this.debug?.(
                                "page/receiver drift (observed only)",
                                {
                                    drift,
                                    pageTime: mediaElement.currentTime,
                                    receiverPageTime: estimatedTime,
                                    playerState: boundMedia.playerState,
                                    offsetSeconds:
                                        this.dashPresentation.offsetSeconds
                                }
                            );
                        }
                    } else if (
                        this.dashTightenSync &&
                        boundMedia.playerState ===
                            cast.media.PlayerState.PLAYING
                    ) {
                        // Non-remux media is a single clock: the receiver's
                        // position IS the page's, so the post-load settle may
                        // still snap the element onto it.
                        this.dashTightenSync = false;
                        if (drift > 0.25) {
                            this.writePageTime(mediaElement, estimatedTime, {
                                origin: "sync-write"
                            });
                            this.debug?.("post-seek sync snap", {
                                drift,
                                estimatedTime,
                                playerState: boundMedia.playerState
                            });
                        } else {
                            this.debug?.("post-seek sync already aligned", {
                                drift,
                                estimatedTime
                            });
                        }
                    } else if (!this.dashTightenSync) {
                        const driftLimit =
                            boundMedia.playerState ===
                            cast.media.PlayerState.PLAYING
                                ? 0.75
                                : 0.25;
                        if (drift > driftLimit) {
                            this.writePageTime(mediaElement, estimatedTime, {
                                origin: "sync-write"
                            });
                            if (drift > 1) {
                                this.debug?.("corrected local playback drift", {
                                    drift,
                                    estimatedTime,
                                    playerState: boundMedia.playerState
                                });
                            }
                        }
                    }
                }
            }

            reconcilePlaybackState(boundMedia);
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
            this.primePageCaptureAt = undefined;
            this.onBleRemoteAction = undefined;
            // Any hold still waiting for the page's arrival dies with the
            // listener set that armed it.
            this.cancelPageArrivalHolds();
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
     *
     * The target comes from the COORDINATOR, not from a second queue field: the
     * coordinator already holds exactly one outstanding intent and already
     * coalesces newer requests onto it, so reading it here is what makes "two
     * rapid seeks, one remux generation" true rather than hoped for.
     */
    private async runDashSeek() {
        if (this.dashSeekRunning) return;
        const intent = this.playbackCoordinator.peekIntent();
        if (!intent) return;
        if (
            !this.playbackCoordinator.beginTransaction(
                intent.intentId,
                "seeking"
            )
        ) {
            // A newer request superseded this intent before the transaction
            // started; the newer one owns the work now.
            this.debug?.("dash seek skipped: superseded before it started", {
                intentId: intent.intentId
            });
            return;
        }
        this.dashSeekRunning = true;
        try {
            // One iteration per remux generation. The loop is driven by the
            // coordinator's outstanding intent, not by a constant: a seek that
            // arrives while the previous generation is rebuilding RETARGETS this
            // transaction (the coordinator's newest-intent-wins rule), so the loop
            // runs again instead of a second transaction starting.
            for (
                let target = this.playbackCoordinator.getTransactionTarget();
                target !== undefined;
                target = this.playbackCoordinator.getTransactionTarget()
            ) {
                const activeIntent = this.playbackCoordinator.peekIntent();
                // Page-clock-master (Roku capture): never snap the page to
                // the receiver after reload — the page was primed to `target`
                // and is the position authority. Chromecast still tightens.
                if (!this.preserveSourcePlayback) {
                    this.dashTightenSync = true;
                    this.dashTightenDeadline =
                        Date.now() + MediaSender.DASH_TIGHTEN_WINDOW_MS;
                } else {
                    this.dashTightenSync = false;
                }
                // The page hold follows the target THIS iteration serves, not
                // the click that opened the transaction: a burst retargets the
                // loop, and without this the page stayed parked where the FIRST
                // click put it while the receiver played the newest target — the
                // page and the receiver then disagreed in the other direction.
                // Idempotent when the page is already there (writePageTime
                // refuses a no-op write), so the accepting click's own hold and
                // this one do not double up.
                this.onDashSeekStart?.(target);
                // Seek -> load handoff (see pendingDashSeekPrime): the priming
                // transaction this seek may create is scoped to the load it is
                // about to start, and the session bound right now is the one whose
                // PAUSED must not be mirrored while the new generation is primed.
                const seekId = ++this.dashSeekId;
                this.pendingDashSeekPrime = {
                    seekId,
                    target,
                    previousMediaSessionId:
                        this.latestBoundMedia()?.mediaSessionId
                };
                try {
                    await this.loadMedia(target);
                    this.playbackCoordinator.markLoadSettled(
                        activeIntent?.intentId
                    );
                } catch (err) {
                    this.dashTightenSync = false;
                    // A failed reload leaves no transaction behind - but only ITS
                    // OWN: this iteration may have been superseded while it awaited.
                    this.clearDashSeekTransaction(seekId, "seek-load-failed");
                    this.debug?.("dash seek reload failed", String(err));
                    logger.error("DASH seek reload failed", err);
                } finally {
                    // This iteration is done with its target. Consuming it AFTER
                    // the load is what lets a seek that arrived while the remux
                    // was rebuilding be seen by the loop below and retarget this
                    // same transaction, instead of being swallowed or starting a
                    // second bridge generation.
                    if (activeIntent) {
                        this.playbackCoordinator.consumeIntent(
                            activeIntent.intentId
                        );
                    }
                }
            }
        } finally {
            this.dashSeekRunning = false;
            this.playbackCoordinator.endTransaction("seek-settled");
        }
    }

    private async startRemoteMediaServer(
        requestId: string,
        mediaUrl: string,
        referer: string,
        contentType: string,
        port: number,
        audioUrl?: string,
        startTime = 0,
        hlsLive = false,
        userAgent?: string,
        cctvDebugEnabled = false,
        rokuDashPrebuffer = false,
        resetCaptureWindow = false
    ): Promise<{
        mediaPath: string;
        localAddress: string;
        pageDuration?: number;
        mode?: "proxy" | "dash-remux";
        startTime?: number;
        padBaseSeconds?: number;
        /** Probed keyframe the real segments start at (diagnostics). */
        probedKeyframeSeconds?: number;
        /** Position to LOAD the receiver at, on the padded presentation
         *  timeline the bridge just generated. */
        presentationStartTime?: number;
        /** Synthetic-DVR live edge at start: baseSeconds in the VOD timeline. */
        liveEdgeBaseSeconds?: number;
        /** Wall-clock ms when liveEdgeBaseSeconds was captured. */
        builtAtMs?: number;
        /** Synthetic-DVR segment cadence in seconds. */
        stepSeconds?: number;
    }> {
        // Roku DASH remux video handling, set on the options page. Read on
        // every start so a changed preset applies to the next remux start
        // (including seek-driven rebuilds) without re-casting; the bridge
        // ignores it on every non-Roku path.
        const rokuTranscodePreset = rokuDashPrebuffer
            ? normalizeRokuTranscodePreset(
                  await getOption("rokuTranscodePreset")
              )
            : undefined;
        // Chromecast DASH startup compatibility (a pad runway in front of the
        // real segments). Read per remux start so toggling it applies to the next
        // LOAD — including seek-driven rebuilds — without re-casting. Ignored on
        // every path that does not take the Chromecast DASH remux branch.
        const chromecastDashStartupPadding = rokuDashPrebuffer
            ? false
            : (await getOption("chromecastDashStartupPadding")) !== false;
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
                    this.debug?.(
                        "bridge media server reported ready",
                        message.data
                    );
                    if (audioUrl && message.data.mode !== "dash-remux") {
                        cleanup();
                        reject(
                            browser.i18n.getMessage(
                                "errorBridgeDashRemuxUnsupported"
                            )
                        );
                        return;
                    }
                    if (hlsLive && message.data.mode !== "dash-remux") {
                        cleanup();
                        reject(
                            browser.i18n.getMessage(
                                "errorBridgeLiveHlsUnsupported"
                            )
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
                    reject(
                        new Error("Media server stopped before becoming ready")
                    );
                } else if (message.subject === "mediaCast:mediaServerStopped") {
                    this.debug?.("previous bridge proxy stopped", {
                        stoppedRequestId: message.data.requestId,
                        pendingRequestId: requestId
                    });
                }
            };
            const timeoutId = window.setTimeout(
                () => {
                    cleanup();
                    reject(
                        "Timed out waiting for the Cast bridge media server"
                    );
                },
                audioUrl || hlsLive
                    ? BRIDGE_MEDIA_SERVER_READY_TIMEOUT_MS
                    : 10_000
            );

            this.port.addEventListener("message", onMessage);
            this.port.start();
            this.debug?.("sending bridge:startRemoteMediaServer", {
                videoHost: new URL(mediaUrl).hostname,
                audioHost: audioUrl ? new URL(audioUrl).hostname : undefined,
                hasSeparateAudio: Boolean(audioUrl),
                contentType,
                port,
                startTime,
                hlsLive,
                rokuDashPrebuffer,
                resetCaptureWindow,
                rokuTranscodePreset
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
                    hlsLive,
                    rokuDashPrebuffer,
                    resetCaptureWindow,
                    cctvDebugEnabled,
                    userAgent,
                    rokuTranscodePreset,
                    chromecastDashStartupPadding
                }
            });
        });
    }

    /** Forward sender-side recovery diagnostics to the background console. */
    private logRecovery(
        level: "info" | "error",
        message: string,
        data: Record<string, unknown> = {}
    ) {
        if (level === "error") logger.error(message, data);
        else logger.info(message, data);
        void browser.runtime
            .sendMessage({
                subject: "cctv:recoveryDebug",
                data: { level, message, data }
            })
            .catch(() => undefined);
    }

    /**
     * Reload the media after the receiver's segment requests stopped (see the
     * behavior-based death detection in addMediaElementListeners).
     *
     * Same shape as the Bilibili channel change: cleanly disconnect the old
     * pipeline (suspend page element sync, stop the old bridge relay), then
     * reload. The bridge rebuilds the synthetic DVR window to continue right
     * after the last segment the old relay served and re-prebuffers; the
     * receiver starts at the head of that fresh cache. loadMedia re-arms the
     * liveness baseline, so the prebuffer/LOAD phase cannot be mistaken for
     * another death.
     *
     * Guards, kept minimal: one reload at a time (recoverInFlight) and a
     * cooldown after each reload (recoverNotBeforeAt). There is deliberately no
     * attempt budget: every independently detected receiver death may recover.
     */
    private async recoverFromIdleDeath() {
        // We are attempting now: cancel any pending watchdog retry so a scheduled
        // attempt can't overlap this one.
        this.clearRecoveryRetry();
        this.clearRecoveryActivityWatchdog();
        this.recoverInFlight = true;
        const recoveryGeneration = ++this.recoveryGeneration;
        this.recoveryAwaitingRelayActivity = true;
        try {
            this.logRecovery("info", "Receiver media recovery starting", {
                resumeMode: "rokuFullHistoricalLookback"
            });

            // Cleanly disconnect the old pipeline FIRST — the same ordering as
            // the Bilibili channel change (updateMedia). The bridge's live relay
            // startup stops any previous server as its first action, so a failed
            // rebuild never leaves an orphaned relay behind.
            this.suspendMediaElementSync();
            this.stopOwnedMediaServer();

            const reloadStartedAt = Date.now();
            await this.loadMedia();
            const reloadSubmittedAt = Date.now();
            this.recoverNotBeforeAt =
                reloadSubmittedAt + this.relayActivityTimeoutMs();
            // loadMedia returns after relay preparation and LOAD submission; the
            // callback does not prove that Roku consumed the new relay. Keep a
            // separate watchdog until a prebuffer/steady-state segment is served.
            this.logRecovery(
                "info",
                "Receiver media recovery reload submitted",
                { reloadElapsedMs: reloadSubmittedAt - reloadStartedAt }
            );
            this.armRecoveryActivityWatchdog(recoveryGeneration);
        } catch (err) {
            this.recoveryAwaitingRelayActivity = false;
            this.clearRecoveryActivityWatchdog();
            // A failed reload tore down the media-element sync loop
            // (suspendMediaElementSync) without rebuilding it, so nothing else will
            // retry. Grow the backoff and arm the watchdog to try again.
            this.recoveryRetryBackoffMs = Math.min(
                MediaSender.RECOVERY_RETRY_MAX_MS,
                this.recoveryRetryBackoffMs > 0
                    ? Math.round(this.recoveryRetryBackoffMs * 1.5)
                    : MediaSender.RECOVERY_RETRY_BASE_MS
            );
            this.recoverNotBeforeAt = Date.now() + this.recoveryRetryBackoffMs;
            this.logRecovery("error", "Auto-recovery reload failed", {
                error:
                    err instanceof Error
                        ? err.stack ?? err.message
                        : String(err),
                nextRetryInMs: this.recoveryRetryBackoffMs
            });
            this.recoverInFlight = false;
            this.scheduleRecoveryRetry();
            return;
        } finally {
            this.recoverInFlight = false;
        }
    }

    private confirmRecoveryRelayActivity(source: string) {
        if (!this.recoveryAwaitingRelayActivity) return;
        this.recoveryAwaitingRelayActivity = false;
        this.clearRecoveryActivityWatchdog();
        this.recoveryRetryBackoffMs = 0;
        this.clearRecoveryRetry();
        this.logRecovery(
            "info",
            "Receiver media recovery consumption confirmed",
            { source }
        );
    }

    private clearRecoveryActivityWatchdog() {
        if (this.recoveryActivityTimer !== undefined) {
            window.clearTimeout(this.recoveryActivityTimer);
            this.recoveryActivityTimer = undefined;
        }
    }

    private armRecoveryActivityWatchdog(generation: number) {
        if (!this.recoveryAwaitingRelayActivity || this.stopped) return;
        this.clearRecoveryActivityWatchdog();
        const timeoutMs = Math.max(30_000, this.relayActivityTimeoutMs() * 3);
        this.recoveryActivityTimer = window.setTimeout(() => {
            this.recoveryActivityTimer = undefined;
            if (
                this.stopped ||
                generation !== this.recoveryGeneration ||
                !this.recoveryAwaitingRelayActivity
            ) {
                return;
            }
            this.recoveryAwaitingRelayActivity = false;
            this.recoveryRetryBackoffMs = Math.min(
                MediaSender.RECOVERY_RETRY_MAX_MS,
                this.recoveryRetryBackoffMs > 0
                    ? Math.round(this.recoveryRetryBackoffMs * 1.5)
                    : MediaSender.RECOVERY_RETRY_BASE_MS
            );
            this.recoverNotBeforeAt = Date.now() + this.recoveryRetryBackoffMs;
            this.logRecovery(
                "error",
                "Recovery reload produced no relay activity",
                {
                    timeoutMs,
                    nextRetryInMs: this.recoveryRetryBackoffMs
                }
            );
            this.scheduleRecoveryRetry();
        }, timeoutMs);
    }

    /** Cancel a pending failed-recovery watchdog retry, if any. */
    private clearRecoveryRetry() {
        if (this.recoveryRetryTimer !== undefined) {
            window.clearTimeout(this.recoveryRetryTimer);
            this.recoveryRetryTimer = undefined;
        }
    }

    /**
     * Arm the watchdog to re-attempt recovery once the current cooldown
     * (recoverNotBeforeAt) elapses. Only used on the failure path, where the
     * media-element sync loop that normally drives recovery has been torn down.
     * A success clears both the timer and the backoff.
     */
    private scheduleRecoveryRetry() {
        if (this.stopped) return;
        if (this.recoveryRetryTimer !== undefined) return; // already scheduled
        if (!this.autoRecoverOnIdle) return;
        const delayMs = Math.max(0, this.recoverNotBeforeAt - Date.now());
        this.logRecovery("info", "Auto-recovery retry scheduled", { delayMs });
        this.recoveryRetryTimer = window.setTimeout(() => {
            this.recoveryRetryTimer = undefined;
            if (this.stopped || this.recoverInFlight) return;
            void this.recoverFromIdleDeath();
        }, delayMs);
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
                    port: port
                }
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
                        reject(
                            new Error(
                                "Media server stopped before becoming ready"
                            )
                        );
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
            mediaElement
        });
    }
}
