/**
 * Chromecast session emulation for Roku devices.
 *
 * The extension side (cast SDK, media sender, popup) only speaks the
 * Chromecast protocol: sessions are created with `main:castSessionCreated`
 * and media is controlled with JSON messages on the
 * `urn:x-cast:com.google.cast.media` namespace, answered by MEDIA_STATUS
 * payloads. On a Roku there is no such socket protocol — ECP is
 * stateless HTTP. This class stands in for the real `Session`
 * (components/cast/Session.ts) when the target device is a Roku:
 *
 *   bridge:createCastSession   -> immediate fake session (no app launch yet;
 *                                 media is launched on LOAD, exactly like the
 *                                 Default Media Receiver does)
 *   LOAD                       -> ECP launch of the media player channel.
 *                                 Live-relay casts (fxcastReceiver=roku URLs)
 *                                 DEFER the LOAD answer until the device is
 *                                 observed fetching the relay, so the page
 *                                 and the receiver start playback together.
 *   PLAY / PAUSE               -> ECP /keypress (state-aware to dodge the
 *                                 Play-key toggle ambiguity)
 *   SEEK                       -> re-launch with `mediaPosition`
 *   STOP                       -> ECP /keypress/Home
 *   GET_STATUS                 -> last synthesized MEDIA_STATUS
 *
 * Playback state is polled from /query/media-player and pushed to the SDK
 * as MEDIA_STATUS updates, so page senders (bilibili/cctv sync loops) and
 * the popup's media controls behave identically to a Chromecast session.
 */
import type { Messenger } from "../../messaging";
import type {
    ReceiverDevice,
    CastSessionUpdatedDetails
} from "../../messagingTypes";
import type {
    MediaInformation,
    MediaStatus,
    SenderMediaMessage,
    SenderMessage,
    Volume
} from "../cast/types";
import {
    IdleReason,
    PlayerState,
    RepeatMode,
    VolumeControlType
} from "../cast/types";

import {
    buildLaunchParams,
    input,
    keypress,
    launch,
    queryMediaPlayer,
    resolvePlayerAppId,
    MEDIA_ASSISTANT_APP_ID
} from "./ecp";
import { observeLiveRelayClientRequests } from "../mediaServer";
import {
    registerRokuSessionMedia,
    unregisterRokuSessionMedia
} from "./sessionMedia";

const NS_MEDIA = "urn:x-cast:com.google.cast.media";

const MEDIA_POLL_INTERVAL_MS = 2500;
/**
 * How long a PLAY/PAUSE intent stays ahead of the session's own observation.
 * The poll runs every 2.5s, so this has to outlast at least one sample or the
 * sender would see the intent flicker.
 */
const SESSION_PLAYER_INTENT_WINDOW_MS = 6_000;
/**
 * How long a PAUSE intent survives a PLAYING observation before it is treated
 * as refused. A DASH remux LOAD relaunches the Roku player, and the relaunched
 * item starts playing, so the pause the sender issues just before the LOAD is
 * observed as PLAYING a moment later — that is the launch, not a refusal.
 */
const PAUSE_RESUME_SETTLE_MS = 2_500;
/** How long after a launch an idle /query/media-player is treated as
 * "player starting" rather than "media ended/dismissed". Covers slow HLS
 * starts and channels that briefly report idle before playback. */
const LAUNCH_IDLE_GRACE_MS = 30_000;
/** Position delta that qualifies as an external seek (Roku remote pressed)
 * worth pushing to senders even though playerState didn't change. */
const SEEK_REPORT_THRESHOLD_SECONDS = 2;

/**
 * Live-relay casts (fxcastReceiver=roku URL): how long after ECP launch the
 * session may wait for the device's first relay request before answering the
 * deferred LOAD anyway. Roku channel (re)starts can take well over 15s (an
 * already-playing media player must be torn down first); the page sender's
 * prebuffer-stall watchdog only arms once the LOAD answer resolves the SDK
 * load, so deferring keeps that watchdog from mis-firing mid-launch. The
 * fallback keeps the safety net: if the device truly never consumes, the
 * machinery (sync loop + watchdog + auto-recovery) takes over.
 */
const DEFERRED_CONSUME_FALLBACK_MS = 60_000;
/**
 * After the device's first relay request, transient "buffer" polls are still
 * part of the launch settle (the player is filling its prebuffer). Reporting
 * them would flip the page video play/pause (the sync loop pauses on
 * BUFFERING), so within this window they are ignored.
 */
const CONSUME_SETTLE_MS = 10_000;

const SUPPORTED_MEDIA_COMMANDS =
    1 | // PAUSE
    2 | // SEEK
    4 | // STREAM_VOLUME
    8; //  STREAM_MUTE

const MEDIA_PLAYER_DISPLAY_NAME = "Roku Media Player";

function withRokuLiveRelayMarker(url: string, sessionId?: string): string {
    try {
        const marked = new URL(url);
        if (marked.pathname !== "/index.m3u8") return url;
        marked.searchParams.set("fxcastReceiver", "roku");
        if (sessionId) marked.searchParams.set("fxcastSession", sessionId);
        return marked.toString();
    } catch {
        return url;
    }
}

/** True when the URL is a bridge live-HLS relay entry (marked by
 * withRokuLiveRelayMarker) — the deferred-consumption LOAD flow applies. */
function isLiveRelayUrl(url: string): boolean {
    try {
        return new URL(url).searchParams.get("fxcastReceiver") === "roku";
    } catch {
        return false;
    }
}

/** Only CCTV synthetic DVR media uses the live-relay consumption observer.
 * Bilibili DASH remux also serves /index.m3u8, but that URL belongs to the
 * independent DASH remux server and must follow the normal Roku LOAD path. */
function isHlsDvrMedia(media: MediaInformation | undefined): boolean {
    const customData = media?.customData;
    return Boolean(
        customData &&
            typeof customData === "object" &&
            (customData as { hlsDvr?: unknown }).hlsDvr === true
    );
}

function isDashRemuxMedia(media: MediaInformation | undefined): boolean {
    const customData = media?.customData;
    return Boolean(
        customData &&
            typeof customData === "object" &&
            (customData as { dashRemux?: unknown }).dashRemux === true
    );
}

/** Bilibili DASH is already input-seeked by ffmpeg. Roku must consume that
 * remux from playlist time zero instead of traversing repeated pad.ts entries. */
function withRokuDashMarker(url: string): string {
    try {
        const marked = new URL(url);
        marked.searchParams.set("fxcastNoPad", "1");
        return marked.toString();
    } catch {
        return url;
    }
}

type OnSessionStoppedCallback = (sessionId: string) => void;

export default class RokuSession {
    public sessionId: string;

    /**
     * Mirrors the real Default Media Receiver: every LOAD is a NEW media
     * session with a fresh id. The extension SDK resolves a pending
     * Session#loadMedia only when a status carrying a mediaSessionId it has
     * not seen before arrives — a Roku reload (recovery, quality change) that
     * reuses the old id would leave the page sender's load callback pending
     * forever, so its receiver->page sync loop (and the auto-recovery
     * watchdog living inside it) would never re-attach.
     */
    private mediaSessionId = 0;
    private mediaRequestIdCounter = 1;

    private playerAppId?: string;
    private loadedMedia?: MediaInformation;
    private playerState: PlayerState = PlayerState.IDLE;
    /**
     * Optimistic overlay for a PLAY/PAUSE transport that has been accepted by
     * the device but not yet observed.
     *
     * The sender protocol needs the intent immediately, but the session also
     * runs its own ECP poll, so the overlay has to expire on evidence rather
     * than stand in for it: a poll that observes the requested state (or the
     * opposite one) clears it. It is deliberately NOT the extension's command
     * lifecycle - the two state machines stay separate, so there is no
     * "not-confirmed" verdict here, only "back to what was observed".
     *
     * Neither the deadline nor the "is this still the current transport" check
     * lives on this object: the deadline is the `pendingIntentTimer` below (its
     * callback clears the overlay and pushes the observed state), and staleness
     * is `playbackIntentToken` against the token captured when the keypress
     * started. Storing an `expiresAt`/`token` pair here as well would be state
     * nothing reads - and an `expiresAt` on the object invites the reader to
     * think expiry is evaluated from it, which is not how this one works.
     */
    private pendingPlayerIntent?: {
        intent: "PLAY" | "PAUSE";
        requestedState: PlayerState;
        /** When the keypress landed, so a resume we did not ask for can be told
         *  apart from the device refusing the intent (see
         *  reconcilePendingIntentFromObservation). */
        requestedAtMs: number;
    };
    /** Cancels a pending intent when a newer transport starts. */
    private playbackIntentToken = 0;
    /**
     * Set when a LOAD arrives while a PAUSE was pending: the launch resumes, so
     * the pause is re-issued when it settles.
     */
    private reapplyPauseAfterLaunch = false;
    private pendingIntentTimer?: NodeJS.Timeout;
    private lastPosition?: number;
    /** Bilibili DASH uses a remux-relative monotonic clock after the first
     * confirmed Roku ECP sample. Later Media Assistant position glitches must
     * not become Cast MEDIA_STATUS jumps. */
    private dashClockUpdatedAt?: number;
    private lastDuration?: number;
    private volume: Volume = {
        level: 1,
        muted: false,
        controlType: VolumeControlType.MASTER
    };

    private pollTimer?: NodeJS.Timeout;
    private pollBusy = false;
    private tornDown = false;
    /** Set after a successful launch; polls within the grace window treat
     * an idle media player as "still starting" instead of "media ended". */
    private lastLaunchAt = 0;

    // ---- Deferred-consumption LOAD state (live-relay casts) ----
    /**
     * A live-relay LOAD has been launched but the device has not yet been
     * observed requesting the relay. While set, no MEDIA_STATUS carrying the
     * new media session is pushed (answering now would resolve the sender's
     * load callback, start its sync loop + watchdog, and mirror the device's
     * old-media playback noise onto the page). Cleared on the first relay
     * request from this device — or on the fallback timer, whichever first.
     */
    private awaitingConsume = false;
    /** Wall clock of Roku's first positive player telemetry after launch. */
    private consumeStartedAt = 0;
    /** The LOAD requestId whose answer is deferred until consumption. */
    private deferredRequestId?: number;
    /** autoplay flag of the deferred LOAD (PAUSED instead of PLAYING). */
    private deferredAutoplay = true;
    private deferredTimer?: NodeJS.Timeout;
    /** Guards stale fallback callbacks from superseded launches. */
    private consumeWatchGeneration = 0;
    /** Roku stream segment observed before this LOAD; used to reject stale player telemetry. */
    private launchBaselineSegmentKey = "";
    /** A post-LOAD idle observation proves Roku has torn down the previous item. */
    private sawPostLoadIdle = false;
    /** Last stream segment signature observed while waiting for the new LOAD. */
    private lastLaunchSegmentKey = "";
    private detachLiveRelayObserver?: () => void;
    /** The current load is a live-relay cast tracked by the deferral. */
    private liveRelayLoad = false;
    /**
     * Hard deadline for a live-relay launch that NEVER observes consumption:
     * idle polls are ignored until then (the sender's watchdog drives retries
     * via the deferred fallback), after which idle may end the session as
     * usual instead of retrying forever.
     */
    private noConsumeHardDeadline = 0;

    constructor(
        private appId: string,
        private receiverDevice: ReceiverDevice,
        private messaging: Messenger,
        private onSessionStopped?: OnSessionStoppedCallback
    ) {
        this.sessionId = `roku-${this.receiverDevice.host}-${Date.now()}`;

        // A Roku session exists as soon as the user selects the device —
        // unlike Chromecast there is no launch round-trip to wait for. The
        // media player channel is launched later, on LOAD.
        this.messaging.sendMessage({
            subject: "main:castSessionCreated",
            data: {
                sessionId: this.sessionId,
                statusText: MEDIA_PLAYER_DISPLAY_NAME,
                namespaces: [{ name: NS_MEDIA }],
                volume: this.volume,
                appId: this.appId,
                displayName: MEDIA_PLAYER_DISPLAY_NAME,
                receiverId: this.receiverDevice.id,
                receiverFriendlyName: this.receiverDevice.friendlyName,
                // MUST match the transportId RokuRemote reports in
                // RECEIVER_STATUS (`roku-<deviceId>`). The popup decides
                // session ownership by checking this ID against the device
                // status application's transportId — a per-session unique
                // value here would never match and leave the popup stuck on
                // "connecting" until its 20s timeout.
                transportId: `roku-${this.receiverDevice.id}`,
                senderApps: [],
                appImages: []
            }
        });

        // NOTE: do not take an onSessionCreated callback here. The caller
        // constructs this class as `const session = new RokuSession(...)`
        // and its tracking callback closes over `session`, which is still
        // in the temporal dead zone while the constructor runs — invoking
        // it synchronously throws "Cannot access 'session' before
        // initialization" and terminates the whole bridge process (Node 22
        // exits on the uncaught exception; Firefox only reports an empty
        // native-messaging disconnect). The caller registers the session
        // by sessionId after construction instead.

        void this.startPolling();
    }

    // ------------------------------------------------------------------
    // Protocol surface shared with components/cast/Session.ts
    // ------------------------------------------------------------------

    /** Messages on the media namespace from the SDK / media senders. */
    sendMessage(namespace: string, messageData: unknown) {
        if (this.tornDown || namespace !== NS_MEDIA) return;

        const message = messageData as SenderMediaMessage;
        const requestId = (message as { requestId?: number }).requestId ?? 0;

        switch (message.type) {
            case "LOAD":
                void this.handleLoad(message);
                break;

            case "PLAY":
                void this.handlePlayPause(requestId, "PLAY");
                break;

            case "PAUSE":
                void this.handlePlayPause(requestId, "PAUSE");
                break;

            case "SEEK":
                void this.handleSeek(message);
                break;

            case "STOP":
                void this.handleStop(requestId);
                break;

            case "GET_STATUS":
            case "MEDIA_GET_STATUS":
                this.sendMediaStatus(requestId);
                break;

            case "SET_VOLUME":
            case "MEDIA_SET_VOLUME":
                this.handleSetVolume(requestId, message.volume);
                break;

            default:
                // EDIT_TRACKS_INFO / SET_PLAYBACK_RATE / QUEUE_* have no ECP
                // equivalent; acknowledge with current status so the SDK's
                // request tracking stays consistent.
                this.sendMediaStatus(requestId);
                break;
        }
    }

    /** NS_RECEIVER messages routed through the session (stop, volume). */
    sendReceiverMessage(message: SenderMessage) {
        if (this.tornDown) return;

        switch (message.type) {
            case "STOP":
                void this.handleStop(message.requestId);
                break;

            case "SET_VOLUME":
                this.handleSetVolume(message.requestId, message.volume);
                break;

            case "VOLUME_UP":
            case "VOLUME_DOWN": {
                const key =
                    message.type === "VOLUME_UP" ? "VolumeUp" : "VolumeDown";
                // Fire-and-forget, but the rejection must still be consumed:
                // an unhandled rejection terminates the bridge process
                // (Node 22 throws by default).
                void keypress(this.receiverDevice.host, key).catch(err =>
                    console.warn(
                        "[fx_cast_bilibili] Roku volume keypress failed",
                        {
                            host: this.receiverDevice.host,
                            key,
                            error:
                                err instanceof Error ? err.message : String(err)
                        }
                    )
                );
                break;
            }

            case "GET_STATUS":
                this.sendReceiverStatus();
                break;

            default:
                // LAUNCH / GET_APP_AVAILABILITY: the media player app is the
                // only launchable target on this emulated session.
                break;
        }
    }

    /** Tears the emulated session down and notifies the extension. */
    stop() {
        this.teardown();
    }

    // ------------------------------------------------------------------
    // ECP translations
    // ------------------------------------------------------------------

    /**
     * Launch (or replace) the media player item. A DASH remux seek MUST
     * open a new live HLS asset: the Video node keys identity on the URL
     * path, so a second play of the same path is "Rewind live TV".
     *
     * Media Assistant (782875) is already running after the first LOAD.
     * POST /input rebuilds the ContentNode in-channel — same as first play,
     * no Home, no /install, no splash. OEM 2213 falls back to /launch of
     * the unique playlist URL.
     */
    private async relaunchPlayer(
        url: string,
        title: string,
        startPosition: number | undefined,
        replaceItem: boolean
    ) {
        const params = buildLaunchParams(url, title, startPosition);
        if (replaceItem && this.playerAppId === MEDIA_ASSISTANT_APP_ID) {
            try {
                await input(this.receiverDevice.host, params);
                return;
            } catch (err) {
                console.error(
                    "[fx_cast_bilibili] Media Assistant /input failed; using /launch",
                    {
                        host: this.receiverDevice.host,
                        error: err instanceof Error ? err.message : String(err)
                    }
                );
            }
        }
        await launch(this.receiverDevice.host, this.playerAppId!, params);
    }

    private async handleLoad(
        message: Extract<SenderMediaMessage, { type: "LOAD" }>
    ) {
        const requestId = message.requestId ?? 0;
        // A new media object: a PLAY/PAUSE intent for the previous one must not
        // colour its status. The LOAD path below establishes the new baseline.
        //
        // A PENDING PAUSE is the exception, and it is remembered rather than
        // dropped: the launch below resumes playback on its own (the new item
        // starts playing), so without re-applying it the user's seek shows a
        // pause overlay and then playback resumes by itself (on-device
        // 2026-09-17 02:25). The intent is re-issued once the launch settles.
        const pendingPause =
            this.pendingPlayerIntent?.intent === "PAUSE" ? true : false;
        this.playbackIntentToken++;
        this.clearPendingPlayerIntent();
        if (pendingPause) {
            this.reapplyPauseAfterLaunch = true;
        }
        const url = message.media?.contentId;
        if (!url || !/^https?:\/\//i.test(url)) {
            this.messaging.sendMessage({
                subject: "cast:sessionMessageReceived",
                data: {
                    sessionId: this.sessionId,
                    namespace: NS_MEDIA,
                    messageData: JSON.stringify({
                        type: "LOAD_FAILED",
                        requestId,
                        mediaSessionId: this.mediaSessionId
                    })
                }
            });
            return;
        }

        const metadata = message.media.metadata as
            | { title?: string }
            | null
            | undefined;
        let title = metadata?.title || "";
        if (!title) {
            try {
                title = decodeURIComponent(
                    new URL(url).pathname.split("/").filter(Boolean).pop() ??
                        url
                );
            } catch {
                title = url;
            }
        }

        const startPosition =
            message.currentTime && message.currentTime > 0
                ? message.currentTime
                : undefined;

        try {
            this.playerAppId =
                this.playerAppId ??
                (await resolvePlayerAppId(this.receiverDevice.host));

            const isHlsDvr = isHlsDvrMedia(message.media);
            const isDashRemux = isDashRemuxMedia(message.media);
            const deferUntilFreshPlayer = isHlsDvr || isDashRemux;
            const launchUrl = isHlsDvr
                ? withRokuLiveRelayMarker(url, this.sessionId)
                : isDashRemux
                ? withRokuDashMarker(url)
                : url;
            if (deferUntilFreshPlayer) {
                this.launchBaselineSegmentKey = "";
                this.sawPostLoadIdle = false;
                this.lastLaunchSegmentKey = "";
                try {
                    const before = await queryMediaPlayer(
                        this.receiverDevice.host
                    );
                    this.launchBaselineSegmentKey =
                        this.streamSegmentKey(before);
                    this.lastLaunchSegmentKey = this.launchBaselineSegmentKey;
                } catch {
                    // A pre-load telemetry failure is non-fatal; the post-load
                    // idle/segment checks below remain authoritative.
                }
            }
            await this.relaunchPlayer(
                launchUrl,
                title,
                isDashRemux ? undefined : startPosition,
                Boolean(this.loadedMedia) && isDashRemux
            );

            this.loadedMedia = message.media;
            // Every LOAD is a new media session (mirrors the real Default
            // Media Receiver; see the mediaSessionId field note).
            this.mediaSessionId++;
            this.lastPosition = startPosition;
            this.dashClockUpdatedAt = undefined;
            this.lastLaunchAt = Date.now();

            if (deferUntilFreshPlayer) {
                // Do not publish the new media to RokuRemote yet. The device may
                // still be tearing down the previous item; publishing now can
                // make the popup look connected while the new relay is not yet
                // consumed. The first request to this relay is the authoritative
                // consumption signal, handled by observeLiveRelayClientRequests.
                if (isHlsDvr && isLiveRelayUrl(launchUrl)) {
                    this.installLiveRelayConsumeObserver();
                }
                // CCTV has an authoritative relay observer. Bilibili DASH remux
                // has no such observer, so its LOAD is confirmed by the same
                // fast post-launch /query/media-player evidence polling.
                // Live-relay cast (CCTV synthetic DVR): the ECP launch merely
                // ASKS the device to play — it can take tens of seconds before
                // the channel actually starts fetching the relay, and until
                // then /query/media-player reports the PREVIOUS stream (or
                // idle). Answering the LOAD now (the old behavior: synthesize
                // PLAYING) made the page video play immediately and the
                // sender's prebuffer-stall watchdog mis-fire mid-launch.
                // Instead defer the answer until the device is observed
                // requesting the relay — then both sides start together.
                this.armDeferredConsume(
                    requestId,
                    message.autoplay !== false,
                    isHlsDvr
                );
            } else {
                // Non-live Roku loads have no relay-consumption deferral, so the
                // complete media metadata can be exposed immediately.
                registerRokuSessionMedia(
                    this.receiverDevice.id,
                    this.sessionId,
                    message.media
                );
                this.publishSessionMedia(message.media);
                this.liveRelayLoad = false;
                this.playerState =
                    message.autoplay === false
                        ? PlayerState.PAUSED
                        : PlayerState.PLAYING;
                this.sendMediaStatus(requestId);
                void this.reapplyPauseAfterLaunchIfArmed();
            }
        } catch (err) {
            console.error("[fx_cast_bilibili] Roku launch failed", {
                host: this.receiverDevice.host,
                url,
                error: err instanceof Error ? err.message : String(err)
            });

            this.messaging.sendMessage({
                subject: "cast:sessionMessageReceived",
                data: {
                    sessionId: this.sessionId,
                    namespace: NS_MEDIA,
                    messageData: JSON.stringify({
                        type: "LOAD_FAILED",
                        requestId,
                        mediaSessionId: this.mediaSessionId
                    })
                }
            });
        }
    }

    /** Observe actual HTTP requests from this Roku into the freshly launched
     * live relay. This is more authoritative than /query/media-player during
     * channel startup because ECP can still report the previous item for a
     * while. */
    private installLiveRelayConsumeObserver() {
        this.detachLiveRelayObserver?.();
        const sessionId = this.sessionId;
        this.detachLiveRelayObserver = observeLiveRelayClientRequests(info => {
            if (this.tornDown || !this.awaitingConsume) return;
            if (!info.isRokuPlaylist) return;
            if (info.clientHost !== this.receiverDevice.host) return;
            if (info.relaySessionId !== sessionId) return;

            this.messaging.sendMessage({
                subject: "main:rokuSessionMediaDebug",
                data: {
                    deviceId: this.receiverDevice.id,
                    event: "consumeObserved",
                    host: this.receiverDevice.host,
                    clientHost: info.clientHost,
                    title: "",
                    duration: "",
                    customData: "",
                    fallback: "false"
                }
            });
            this.onConsumeStarted();
        });
    }

    /**
     * Live-relay LOAD deferral (see awaitingConsume). The ECP launch has been
     * accepted; wait until the device actually requests the freshly started
     * relay before answering the LOAD. /query/media-player cannot distinguish
     * the old stream from the new one during this window, but the relay CAN:
     * any request from this device's address to the just-started relay is the
     * new media being consumed. On that first request the deferred answer goes
     * out as PLAYING (or PAUSED for autoplay=false) — the page sender's load
     * callback resolves at that moment, its sync loop attaches, and the page
     * video starts in step with the device's prebuffer fetch instead of tens
     * of seconds ahead of it.
     */
    private armDeferredConsume(
        requestId: number,
        autoplay: boolean,
        liveRelayLoad = this.liveRelayLoad
    ) {
        this.clearDeferredConsume();
        this.awaitingConsume = true;
        this.consumeStartedAt = 0;
        this.liveRelayLoad = liveRelayLoad;
        this.deferredRequestId = requestId;
        this.deferredAutoplay = autoplay;
        this.noConsumeHardDeadline =
            Date.now() + DEFERRED_CONSUME_FALLBACK_MS * 3;
        this.playerState = autoplay
            ? PlayerState.BUFFERING
            : PlayerState.PAUSED;
        const generation = ++this.consumeWatchGeneration;

        // Poll much faster only during Roku startup. ECP's /query/media-player
        // exposes buffering plus stream_segment, which is a Roku-side signal
        // that the new player has actually entered media consumption.
        this.startPolling(250);

        this.deferredTimer = setTimeout(() => {
            if (generation !== this.consumeWatchGeneration) return;
            console.warn(
                "[fx_cast_bilibili] Roku deferred LOAD fallback: no new player telemetry observed",
                {
                    host: this.receiverDevice.host,
                    waitedMs: DEFERRED_CONSUME_FALLBACK_MS
                }
            );
            this.onConsumeStarted(true);
        }, DEFERRED_CONSUME_FALLBACK_MS);
        this.deferredTimer.unref?.();
    }

    /** Roku has started the newly launched item, or the safety fallback fired. */
    private onConsumeStarted(fallback = false) {
        if (!this.awaitingConsume) return;
        this.clearDeferredConsume();
        this.consumeStartedAt = fallback ? 0 : Date.now();
        this.playerState = this.deferredAutoplay
            ? PlayerState.PLAYING
            : PlayerState.PAUSED;

        // Publish the full LOAD metadata only after live consumption has been
        // positively established. RokuRemote will immediately re-poll ECP and
        // publish an authoritative device-media status for the popup progress
        // bar, while the session LOAD acknowledgement below resolves the page
        // sender at the same boundary.
        if (this.loadedMedia) {
            registerRokuSessionMedia(
                this.receiverDevice.id,
                this.sessionId,
                this.loadedMedia
            );
            this.publishSessionMedia(this.loadedMedia);
            this.messaging.sendMessage({
                subject: "main:rokuSessionMediaDebug",
                data: {
                    deviceId: this.receiverDevice.id,
                    event: "sessionMediaRegistered",
                    host: this.receiverDevice.host,
                    clientHost: "n/a",
                    title:
                        (this.loadedMedia.metadata as { title?: string } | null)
                            ?.title ?? "",
                    duration:
                        this.loadedMedia.duration == null
                            ? "null"
                            : String(this.loadedMedia.duration),
                    customData: JSON.stringify(this.loadedMedia.customData),
                    fallback: String(fallback)
                }
            });
        }

        this.sendMediaStatus(this.deferredRequestId);
        this.deferredRequestId = undefined;
        void this.reapplyPauseAfterLaunchIfArmed();
        // Startup polling is intentionally aggressive; once the new Roku
        // media session is confirmed, return to the normal cadence so ECP
        // itself cannot become a source of load or instability.
        this.startPolling(MEDIA_POLL_INTERVAL_MS);
    }

    /**
     * Publishes the session's LOAD media to the extension so it can be
     * merged into the device-level media status. The sessionMedia registry
     * (sessionMedia.ts) is per-process and RokuRemote lives in a DIFFERENT
     * bridge process (every connectNative spawns one), so the registry
     * alone never reaches the popup — this message is the cross-process
     * counterpart of registerRokuSessionMedia. `null` clears it.
     */
    private publishSessionMedia(media: MediaInformation | null) {
        this.messaging.sendMessage({
            subject: "main:rokuSessionMedia",
            data: {
                deviceId: this.receiverDevice.id,
                sessionId: this.sessionId,
                media
            }
        });
    }

    private clearDeferredConsume() {
        this.awaitingConsume = false;
        if (this.deferredTimer) {
            clearTimeout(this.deferredTimer);
            this.deferredTimer = undefined;
        }
    }

    private streamSegmentKey(
        state: Awaited<ReturnType<typeof queryMediaPlayer>>
    ) {
        const segment = state.streamSegment;
        if (!segment) return "";
        return [
            segment.mediaSequence ?? "",
            segment.segmentType ?? "",
            segment.timeSeconds ?? ""
        ].join(":");
    }

    private hasFreshRokuMediaEvidence(
        state: Awaited<ReturnType<typeof queryMediaPlayer>>
    ) {
        if (state.state === "idle") {
            this.sawPostLoadIdle = true;
            return false;
        }

        const key = this.streamSegmentKey(state);
        const changed = Boolean(key) && key !== this.launchBaselineSegmentKey;
        const newSegmentAfterIdle = this.sawPostLoadIdle && Boolean(key);
        const newTelemetryWithoutSegment =
            this.sawPostLoadIdle &&
            (state.buffering !== undefined ||
                state.position !== undefined ||
                state.duration !== undefined);

        if (key) this.lastLaunchSegmentKey = key;
        return changed || newSegmentAfterIdle || newTelemetryWithoutSegment;
    }

    /** PLAY/PAUSE keypresses: an absolute intent mapped to its ECP key.
     * Whether the Play key toggles on some firmware is not verified here, so
     * the mapping is kept mechanical (see the note below). */
    /** What the sender protocol should report: intent while it is pending. */
    private effectivePlayerState(): PlayerState {
        return this.pendingPlayerIntent?.requestedState ?? this.playerState;
    }

    /**
     * Settles a pending intent against a real observation.
     *
     * Matching the requested state confirms it; observing the opposite state
     * refutes it immediately rather than waiting for the deadline. BUFFERING is
     * transitional in both directions and settles nothing, which mirrors the
     * extension coordinator's classification - the same rule applied to the
     * session's own clock. IDLE is deliberately NOT treated as an opposite
     * state here: the launch and live-relay paths (awaitingConsume, the deferred
     * consume fallback, sawPostLoadIdle) own that interpretation, and a generic
     * rule would race with them.
     */
    private reconcilePendingIntentFromObservation(observed: PlayerState) {
        const pending = this.pendingPlayerIntent;
        if (!pending) return;
        if (observed === PlayerState.BUFFERING) return;
        const matched = observed === pending.requestedState;
        // A Roku RESUME that follows a PAUSE within the intent window is the
        // item change / relaunch (a DASH remux LOAD relaunches the player, which
        // starts the new item playing), not the device refusing the intent: the
        // user sees the pause overlay appear and then playback resume
        // (on-device 2026-09-17 02:25). Keep the intent so it is applied again
        // once the launch settles; a resume that persists past the window still
        // refutes it, as does an immediate resume right after a PLAY.
        const opposite =
            (pending.intent === "PLAY" && observed === PlayerState.PAUSED) ||
            (pending.intent === "PAUSE" &&
                observed === PlayerState.PLAYING &&
                Date.now() - pending.requestedAtMs >= PAUSE_RESUME_SETTLE_MS);
        if (matched || opposite) this.clearPendingPlayerIntent();
    }

    /**
     * Re-issues the pause the user asked for before this LOAD, once the launch
     * has settled.
     *
     * The relaunch starts the new item playing, and an ECP `Pause` sent before
     * it is lost with the old item, so the press has to be repeated on the new
     * one. The Cast intent is then active again, which is what the sender's
     * PLAY/PAUSE reconciliation expects: it resumes playback itself when the
     * cast is meant to be playing.
     */
    private async reapplyPauseAfterLaunchIfArmed() {
        if (!this.reapplyPauseAfterLaunch) return;
        this.reapplyPauseAfterLaunch = false;
        if (this.tornDown) return;
        const token = ++this.playbackIntentToken;
        try {
            await keypress(this.receiverDevice.host, "Pause");
            if (this.tornDown || token !== this.playbackIntentToken) return;
            this.pendingPlayerIntent = {
                intent: "PAUSE",
                requestedState: PlayerState.PAUSED,
                requestedAtMs: Date.now()
            };
            this.pendingIntentTimer = setTimeout(() => {
                this.pendingIntentTimer = undefined;
                this.sendMediaStatus();
            }, SESSION_PLAYER_INTENT_WINDOW_MS);
            this.pendingIntentTimer.unref?.();
            this.sendMediaStatus();
        } catch (err) {
            console.error(
                "[fx_cast_bilibili] Roku re-pause after launch failed",
                {
                    host: this.receiverDevice.host,
                    error: err instanceof Error ? err.message : String(err)
                }
            );
        }
    }

    private clearPendingPlayerIntent() {
        if (this.pendingIntentTimer) {
            clearTimeout(this.pendingIntentTimer);
            this.pendingIntentTimer = undefined;
        }
        this.pendingPlayerIntent = undefined;
    }

    private async handlePlayPause(requestId: number, intent: "PLAY" | "PAUSE") {
        // Absolute intent -> ECP key, one-to-one. The previous "already
        // playing/paused; harmless no-op" branches were an identity
        // expression: every branch returned the same literal as `intent`, so
        // the observed playerState never affected the key and the no-op
        // assumption in those comments was never actually enforced.
        const key = intent === "PLAY" ? "Play" : "Pause";
        // Taken before the await: if a newer transport arrives while this one is
        // in flight, its result must not resurrect this intent.
        const token = ++this.playbackIntentToken;
        this.clearPendingPlayerIntent();

        try {
            await keypress(this.receiverDevice.host, key);
            if (this.tornDown) return;
            if (token !== this.playbackIntentToken) {
                // A newer transport took over while this one was in flight. Its
                // intent must not be restored, but this request is still a Cast
                // request waiting for a reply: settle it with the current
                // effective state instead of leaving it pending forever. The
                // dense sampling window is deliberately NOT requested here -
                // the newer transport already owns it.
                this.sendMediaStatus(requestId);
                return;
            }
            this.pendingPlayerIntent = {
                intent,
                requestedState:
                    intent === "PLAY"
                        ? PlayerState.PLAYING
                        : PlayerState.PAUSED,
                requestedAtMs: Date.now()
            };
            this.pendingIntentTimer = setTimeout(() => {
                this.pendingIntentTimer = undefined;
                if (token !== this.playbackIntentToken) return;
                // Deadline: fall back to the last observed state. Never invent
                // a failure verdict - that belongs to the extension's command
                // lifecycle, not to the sender protocol.
                this.pendingPlayerIntent = undefined;
                // Sent as an ASYNC state convergence with a fresh request id,
                // not as a second answer to the original PLAY/PAUSE request:
                // that request was already answered when the keypress resolved,
                // and reusing its id would make one Cast request appear to have
                // two replies. The media-ended push above does the same.
                this.sendMediaStatus();
            }, SESSION_PLAYER_INTENT_WINDOW_MS);
            this.pendingIntentTimer.unref?.();
            this.sendMediaStatus(requestId);
            // The transport has landed on the device. The dense observation
            // window belongs to the discovery process (which owns the polling
            // loop and emits every observation), and this session runs in a
            // different one, so the request goes through the extension.
            this.messaging.sendMessage({
                subject: "main:rokuSessionPlaybackTransport",
                data: { deviceId: this.receiverDevice.id }
            });
        } catch (err) {
            console.error("[fx_cast_bilibili] Roku keypress failed", {
                host: this.receiverDevice.host,
                key,
                error: err instanceof Error ? err.message : String(err)
            });
            this.sendMediaStatus(requestId);
        }
    }

    /** ECP has no absolute seek; the documented workaround is relaunching
     * the channel with a `mediaPosition` param. Bilibili DASH remux is NOT
     * seekable this way: the HLS is a live EVENT playlist, so a mediaPosition
     * relaunch shows "Rewind live TV" and never opens the new remux. The
     * page sender restarts ffmpeg and sends a fresh LOAD instead. */
    private async handleSeek(
        message: Extract<SenderMediaMessage, { type: "SEEK" }>
    ) {
        const requestId = message.requestId ?? 0;
        const position = message.currentTime ?? 0;

        if (!this.loadedMedia) {
            this.sendMediaStatus(requestId);
            return;
        }

        if (isDashRemuxMedia(this.loadedMedia)) {
            console.error(
                "[fx_cast_bilibili] ignoring native Roku SEEK on DASH remux; page sender owns remux restart",
                { position }
            );
            this.sendMediaStatus(requestId);
            return;
        }

        try {
            this.playerAppId =
                this.playerAppId ??
                (await resolvePlayerAppId(this.receiverDevice.host));

            await launch(
                this.receiverDevice.host,
                this.playerAppId,
                buildLaunchParams(
                    isHlsDvrMedia(this.loadedMedia)
                        ? withRokuLiveRelayMarker(
                              this.loadedMedia.contentId,
                              this.sessionId
                          )
                        : this.loadedMedia.contentId,
                    (this.loadedMedia.metadata as { title?: string } | null)
                        ?.title ?? "",
                    position
                )
            );

            this.lastPosition = position;
            this.lastLaunchAt = Date.now();
            if (this.awaitingConsume) {
                // A live-relay LOAD is still deferred (device has not
                // consumed yet): replace the pending deferral with this
                // relaunch's request instead of answering early — sendMediaStatus
                // stays gated to an empty status until consumption.
                this.armDeferredConsume(requestId, this.deferredAutoplay);
            } else {
                this.playerState = PlayerState.PLAYING;
                this.sendMediaStatus(requestId);
            }
        } catch (err) {
            console.error("[fx_cast_bilibili] Roku seek relaunch failed", {
                host: this.receiverDevice.host,
                position,
                error: err instanceof Error ? err.message : String(err)
            });
            this.sendMediaStatus(requestId);
        }
    }

    private async handleStop(requestId: number) {
        // The session is going home: a pending intent would otherwise keep
        // reporting PLAYING/PAUSED while the status is forced idle.
        this.playbackIntentToken++;
        this.clearPendingPlayerIntent();
        try {
            await keypress(this.receiverDevice.host, "Home");
        } catch (err) {
            console.error("[fx_cast_bilibili] Roku stop failed", {
                host: this.receiverDevice.host,
                error: err instanceof Error ? err.message : String(err)
            });
        }

        this.sendMediaStatus(requestId, { forceIdle: true });
        this.teardown();
    }

    /** Maps an absolute Chromecast volume to Roku's relative keys. Coarse by
     * nature (ECP has no volume query); good enough for the popup slider. */
    private handleSetVolume(_requestId: number, volume: Partial<Volume>) {
        const steps: Promise<void>[] = [];

        if (typeof volume.level === "number") {
            const target = Math.min(1, Math.max(0, volume.level));
            const current = this.volume.level ?? 1;
            const delta = Math.round((target - current) * 10);
            const key = delta > 0 ? "VolumeUp" : "VolumeDown";
            for (let i = 0; i < Math.min(Math.abs(delta), 10); i++) {
                steps.push(keypress(this.receiverDevice.host, key));
            }
            this.volume = { ...this.volume, level: target };
        }

        if (
            typeof volume.muted === "boolean" &&
            volume.muted !== this.volume.muted
        ) {
            steps.push(keypress(this.receiverDevice.host, "VolumeMute"));
            this.volume = { ...this.volume, muted: volume.muted };
        }

        void Promise.allSettled(steps).then(() => {
            // Surface the (approximate) new volume to the session UI.
            this.sendReceiverStatus();
        });
    }

    // ------------------------------------------------------------------
    // Status synthesis
    // ------------------------------------------------------------------

    private buildMediaStatus(): MediaStatus {
        // Media Assistant reports the currently generated HLS EVENT runtime as
        // duration while Bilibili DASH is still being remuxed. That value grows
        // in large steps (for example 195, 390, 695) and Media#getEstimatedTime
        // clamps currentTime to it, making the page jump backwards and loop.
        // Preserve Bilibili's full page duration for Roku DASH; other Roku media,
        // including CCTV, retain the existing ECP-duration behavior.
        const isDashRemux = isDashRemuxMedia(this.loadedMedia);
        const media =
            this.loadedMedia && this.lastDuration !== undefined && !isDashRemux
                ? { ...this.loadedMedia, duration: this.lastDuration }
                : this.loadedMedia;
        return {
            mediaSessionId: this.mediaSessionId,
            media,
            playbackRate: 1,
            playerState: this.effectivePlayerState(),
            currentTime: isDashRemuxMedia(this.loadedMedia)
                ? Number(
                      (
                          this.loadedMedia?.customData as {
                              dashStart?: unknown;
                          } | null
                      )?.dashStart ?? 0
                  ) + (this.lastPosition ?? 0)
                : this.lastPosition ?? 0,
            supportedMediaCommands: SUPPORTED_MEDIA_COMMANDS,
            repeatMode: RepeatMode.OFF,
            volume: this.volume,
            customData: null
        };
    }

    private sendMediaStatus(
        requestId?: number,
        options: { forceIdle?: boolean } = {}
    ) {
        if (this.tornDown) return;

        // While a live-relay LOAD is deferred, a status carrying the new
        // media session would prematurely resolve the sender's pending
        // Session#loadMedia (the SDK keys on unseen mediaSessionIds).
        // Acknowledge with an empty status list instead: request tracking
        // stays consistent while the deferred answer stays deferred.
        if (this.awaitingConsume && !options.forceIdle) {
            this.messaging.sendMessage({
                subject: "cast:sessionMessageReceived",
                data: {
                    sessionId: this.sessionId,
                    namespace: NS_MEDIA,
                    messageData: JSON.stringify({
                        type: "MEDIA_STATUS",
                        requestId: requestId ?? this.mediaRequestIdCounter++,
                        status: []
                    })
                }
            });
            return;
        }

        const status = this.buildMediaStatus();
        if (options.forceIdle) {
            status.playerState = PlayerState.IDLE;
            status.idleReason = IdleReason.INTERRUPTED;
            status.media = undefined;
        }

        this.messaging.sendMessage({
            subject: "cast:sessionMessageReceived",
            data: {
                sessionId: this.sessionId,
                namespace: NS_MEDIA,
                messageData: JSON.stringify({
                    type: "MEDIA_STATUS",
                    requestId: requestId ?? this.mediaRequestIdCounter++,
                    status: [status]
                })
            }
        });
    }

    /** RECEIVER_STATUS equivalents are delivered as session updates; the
     * emulated app is "running" for the session's whole lifetime. */
    private sendReceiverStatus() {
        if (this.tornDown) return;

        const details: CastSessionUpdatedDetails = {
            sessionId: this.sessionId,
            statusText: this.loadedMedia
                ? (this.loadedMedia.metadata as { title?: string } | null)
                      ?.title ?? MEDIA_PLAYER_DISPLAY_NAME
                : MEDIA_PLAYER_DISPLAY_NAME,
            namespaces: [{ name: NS_MEDIA }],
            volume: this.volume
        };

        this.messaging.sendMessage({
            subject: "main:castSessionUpdated",
            data: details
        });
    }

    // ------------------------------------------------------------------
    // Playback state polling
    // ------------------------------------------------------------------

    private async startPolling(intervalMs = MEDIA_POLL_INTERVAL_MS) {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
        }

        this.pollTimer = setInterval(() => {
            void this.pollOnce();
        }, intervalMs);
    }

    private stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    private async pollOnce() {
        if (this.pollBusy || this.tornDown) return;
        this.pollBusy = true;

        try {
            const state = await queryMediaPlayer(this.receiverDevice.host);
            if (this.tornDown) return;

            const previousState = this.playerState;
            // What the sender currently sees. Settling a pending intent below
            // can change this without the observation moving at all, and the
            // sender must be told: an opposite poll has to roll it back.
            const previousEffectiveState = this.effectivePlayerState();
            const previousPosition = this.lastPosition;

            if (this.awaitingConsume) {
                if (this.hasFreshRokuMediaEvidence(state)) {
                    // Bilibili DASH is confirmed here by this session's own ECP
                    // poll. Publish that exact sample in the deferred LOAD reply,
                    // rather than the requested absolute-position echo. CCTV
                    // keeps its existing relay-observer/ECP behavior unchanged.
                    if (isDashRemuxMedia(this.loadedMedia)) {
                        if (state.position !== undefined) {
                            this.lastPosition = state.position;
                            this.dashClockUpdatedAt = Date.now();
                        }
                        const customData =
                            this.loadedMedia?.customData &&
                            typeof this.loadedMedia.customData === "object"
                                ? this.loadedMedia.customData
                                : {};
                        this.loadedMedia = {
                            ...this.loadedMedia!,
                            customData
                        };
                    }
                    this.onConsumeStarted();
                }
                return;
            }

            if (state.state === "idle") {
                // Within the launch grace window an idle player just means
                // the channel is still opening/buffering — do NOT report the
                // media as ended and do NOT tear the session down.
                if (Date.now() - this.lastLaunchAt < LAUNCH_IDLE_GRACE_MS) {
                    return;
                }

                // A live-relay launch that never observed consumption keeps
                // reporting idle while its channel (re)starts: the deferred
                // fallback answers the LOAD so the sender's watchdog drives
                // retries. Only past the hard deadline may idle finally end
                // the session instead of retrying forever.
                if (
                    this.liveRelayLoad &&
                    this.consumeStartedAt === 0 &&
                    Date.now() < this.noConsumeHardDeadline
                ) {
                    return;
                }

                // Media ended or was dismissed with the Roku remote.
                if (this.loadedMedia) {
                    const finished =
                        this.lastDuration !== undefined &&
                        state.position !== undefined &&
                        state.position >= this.lastDuration - 5;
                    this.playerState = PlayerState.IDLE;
                    // Unsolicited push: use a fresh requestId so it can't
                    // collide with a pending sender request.
                    this.sendMediaStatus(this.mediaRequestIdCounter++, {
                        forceIdle: finished
                    });

                    this.loadedMedia = undefined;
                    this.stopPolling();
                    this.teardown();
                }
                return;
            }

            // Map ECP's states onto the Chromecast player states. Firmware
            // reports "play" | "pause" | "buffer" | "idle"; the longer
            // variants are accepted for safety.
            const nextState =
                state.state === "pausing" ||
                state.state === "paused" ||
                state.state === "pause"
                    ? PlayerState.PAUSED
                    : state.state === "buffering" || state.state === "buffer"
                    ? PlayerState.BUFFERING
                    : PlayerState.PLAYING;
            // Right after the device's first relay request the player is
            // still filling its prebuffer: transient "buffer" reports are
            // part of the launch settle, not real playback state — reporting
            // them would flap the page video (sync pauses on BUFFERING).
            if (
                nextState === PlayerState.BUFFERING &&
                this.consumeStartedAt > 0 &&
                Date.now() - this.consumeStartedAt < CONSUME_SETTLE_MS
            ) {
                return;
            }
            if (isDashRemuxMedia(this.loadedMedia)) {
                const now = Date.now();
                if (
                    this.lastPosition === undefined &&
                    state.position !== undefined
                ) {
                    this.lastPosition = state.position;
                } else if (
                    this.lastPosition !== undefined &&
                    this.dashClockUpdatedAt !== undefined &&
                    previousState === PlayerState.PLAYING
                ) {
                    this.lastPosition += (now - this.dashClockUpdatedAt) / 1000;
                }
                this.dashClockUpdatedAt = now;
            } else {
                this.lastPosition = state.position;
            }
            this.playerState = nextState;
            this.lastDuration = state.duration ?? this.lastDuration;
            this.reconcilePendingIntentFromObservation(nextState);

            const positionMoved =
                previousPosition !== undefined &&
                this.lastPosition !== undefined &&
                Math.abs(this.lastPosition - previousPosition) >
                    SEEK_REPORT_THRESHOLD_SECONDS;
            const stateChanged = previousState !== this.playerState;
            const effectiveStateChanged =
                previousEffectiveState !== this.effectivePlayerState();
            // Advancing position while PLAYING is the normal heartbeat —
            // push periodically so seek bars move (senders that poll
            // GET_STATUS also get fresh data on demand).
            const heartbeat = this.playerState === "PLAYING";

            if (
                stateChanged ||
                effectiveStateChanged ||
                positionMoved ||
                heartbeat
            ) {
                this.sendMediaStatus();
            }
        } catch {
            // Device temporarily unreachable (network blip, reboot). The
            // health-check in the device browser handles real departures.
        } finally {
            this.pollBusy = false;
        }
    }

    private teardown() {
        if (this.tornDown) return;
        this.tornDown = true;
        // No intent outlives the session, and no timer may fire afterwards.
        this.playbackIntentToken++;
        this.clearPendingPlayerIntent();
        this.consumeWatchGeneration++;
        this.clearDeferredConsume();
        this.launchBaselineSegmentKey = "";
        this.lastLaunchSegmentKey = "";
        this.stopPolling();
        this.detachLiveRelayObserver?.();
        this.detachLiveRelayObserver = undefined;
        unregisterRokuSessionMedia(this.receiverDevice.id, this.sessionId);
        this.publishSessionMedia(null);

        this.messaging.sendMessage({
            subject: "cast:sessionStopped",
            data: { sessionId: this.sessionId }
        });
        this.onSessionStopped?.(this.sessionId);
    }
}
