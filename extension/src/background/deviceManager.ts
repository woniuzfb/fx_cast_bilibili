import bridge, { type BridgeInfo } from "../lib/bridge";
import logger from "../lib/logger";
import options from "../lib/options";
import { TypedEventTarget } from "../lib/TypedEventTarget";

import type { Message, Port } from "../messaging";
import type { ReceiverDevice } from "../types";

import type {
    MediaStatus,
    ReceiverStatus,
    SenderMediaMessage,
    SenderMessage
} from "../cast/sdk/types";
import type { MediaInfo } from "../cast/sdk/media/classes";
import { PlayerState, RepeatMode } from "../cast/sdk/media/enums";

import type { RokuMediaStatusProvenance } from "../../../shared/rokuMediaStatusProvenance";
import type { PlaybackCommandProgress } from "../../../shared/playbackCommand";
import {
    declaredPresentationOffset,
    normalizeContentId
} from "../cast/dashPresentation";

/**
 * A CCTV live relay never takes the DASH remux timeline path: its customData is
 * {hlsDvr: true} with no dashStart and no presentation offset, and its receiver
 * positions are on the synthetic VOD clock, not shifted by any pad runway. This
 * guard (and its log) exists because a media carrying both flags would mean the
 * two senders' metadata is being crossed, and silently adding dashStart to a
 * live position would be invisible in the popup.
 */
function isHlsDvrCustomData(customData: { hlsDvr?: unknown }) {
    if (customData.hlsDvr !== true) return false;
    logger.error(
        "CCTV live media reached the DASH remux timeline path; skipping the remux conversion",
        { customData }
    );
    return true;
}

/**
 * The identities a DASH remux media generation reports under, as map keys.
 *
 * Both are namespaced by device so one device's media can never answer for
 * another's, and the content key strips the cache-busting query the sender
 * appends per remux restart (otherwise the media would not match its own id).
 */
function dashSessionKey(deviceId: string, mediaSessionId: number): string {
    return `${deviceId}|session:${mediaSessionId}`;
}

function dashContentKey(
    deviceId: string,
    contentId: unknown
): string | undefined {
    const normalized = normalizeContentId(contentId);
    return normalized === undefined
        ? undefined
        : `${deviceId}|content:${normalized}`;
}

import {
    currentRokuMediaIdentities,
    currentRokuMediaIdentity,
    nextRokuLoadGeneration,
    setRokuMediaIdentityFields,
    terminateActivePlaybackCommand,
    terminateAllPlaybackCommands
} from "./playbackCommand";

/**
 * Name the device the way the user sees it, for log lines.
 *
 * These traces originally said "Roku ..." for every device, because the merge
 * path started as Roku-only. The same code now also carries Chromecast statuses,
 * and a log that calls a Chromecast a Roku sends debugging down the wrong path
 * (the two have different session, timeline and capture semantics), so the label
 * is derived from the device instead of assumed.
 */
export function deviceDebugLabel(device: ReceiverDevice | undefined) {
    if (device?.deviceType === "roku") return "Roku";
    const model = String(device?.modelName ?? "").trim();
    if (!model) return "Cast";
    // "Chromecast", "Chromecast Ultra", "Google Nest Mini", ...
    return model;
}

async function logMediaDebug(message: string, data: unknown) {
    try {
        const opts = await options.getAll();
        if (!opts.cctvDebugEnabled && !opts.bilibiliDebugEnabled) return;
        logger.info(message, data);
    } catch {
        // Debug logging must never affect device status handling.
    }
}

interface EventMap {
    deviceUp: { deviceInfo: ReceiverDevice };
    deviceDown: { deviceId: string };
    deviceUpdated: { deviceId: string; status: ReceiverStatus };
    deviceMediaUpdated: {
        deviceId: string;
        status: MediaStatus;
        /**
         * How the bridge produced this status (Roku only). Absent for the
         * Chromecast push path and for statuses the extension synthesizes
         * itself. Carried through because only `ecp-poll` may be used to
         * confirm a play/pause command - see shared/rokuMediaStatusProvenance.
         */
        provenance?: RokuMediaStatusProvenance;
    };
    /** The device's play/pause command view changed (see playbackCommand). */
    devicePlaybackUpdated: { deviceId: string };
    /**
     * One completed ECP poll sample, including idle. Distinct from
     * deviceMediaUpdated, which the bridge suppresses for idle ("nothing to
     * report") - an observed idle must not look like a failed observation.
     */
    /** Asynchronous play/pause facts reported by the page sender. */
    bilibiliPlaybackProgress: PlaybackCommandProgress;
    rokuPlaybackObservation: {
        deviceId: string;
        status: MediaStatus;
        /** LOAD generation snapshotted when the poll started. */
        loadGeneration?: number;
        provenance: RokuMediaStatusProvenance;
    };

    applicationFound: { deviceId: string; appId: string };
    applicationClosed: { deviceId: string; appId: string; sessionId: string };
}

/**
 * How long a device may report NO receiver application (or a Roku home screen)
# while this extension still owns a session, before that is treated as the
 * session really ending.
 *
 * A Roku DASH remux LOAD relaunches the player app, so the device reports an
 * empty application list for a moment. Tearing the session down on that report
 * cleared `device.mediaStatus`, which is the popup's progress bar, and dropped
 * the transport ownership, which turned the popup's Stop button back into a
 * Cast button — measured on-device during a mid-video seek (2026-09-17 02:17),
 * where the bar vanished and the popup looked freshly opened.
 */
const RECEIVER_APP_GONE_GRACE_MS = 8000;

export default new (class extends TypedEventTarget<EventMap> {
    /**
     * Map of receiver device IDs to devices. Updated as receiverDevice
     * messages are received from the bridge.
     */
    private receiverDevices = new Map<string, ReceiverDevice>();

    /**
     * When each device first reported no usable receiver application while this
     * extension still owned a session (see RECEIVER_APP_GONE_GRACE_MS).
     */
    private receiverAppGoneAt = new Map<string, number>();

    /**
     * LOAD media published by emulated Roku sessions via
     * main:rokuSessionMedia (forwarded by castManager). RokuSession and
     * RokuRemote run in SEPARATE bridge processes (each connectNative
     * spawns one), so the bridge's per-process sessionMedia registry can
     * never feed RokuRemote's buildStatusMedia — this extension-side
     * store replaces that registry for the device media status path.
     */
    private rokuSessionMedia = new Map<
        string,
        { ownerId: string; media: MediaInfo }
    >();
    /** Last authoritative extension-side media snapshot logged per device. */
    private lastMergedMediaDebug = new Map<string, string>();
    /**
     * The presentation shift of the DASH remux generation each device currently
     * reports on, keyed by that MEDIA's identities (see dashSessionKey /
     * dashContentKey), never by the device alone.
     *
     * The media's own `customData.presentationOffsetSeconds` is the source of
     * truth; this map exists because a periodic MEDIA_STATUS broadcast often
     * carries only the stream's media snapshot with no customData, and a report
     * with no shift to apply must not be guessed at. Entries for a device are
     * replaced whenever that device's media states a new generation, so the table
     * tracks one generation per device instead of growing.
     */
    private dashPresentationByMedia = new Map<
        string,
        { offsetSeconds: number; dashStart: number }
    >();
    /**
     * Signature of the last remote ECP media sample traced per device. The
     * bridge publishes EVERY completed poll - command confirmation needs
     * fresh samples even when they repeat the cached state - so an unchanged
     * sample must not re-enter the trace log every 3s.
     */
    private lastRemoteStatusTrace = new Map<string, string>();
    /** Monotonic sequence for the per-device media traces (any device type). */
    private mediaTraceSequence = 0;
    /** New Roku LOAD generation. Old ECP status is blocked until the real LOAD
     * media is registered and the next remote sample belongs to that LOAD. */
    private pendingRokuMediaLoads = new Set<string>();
    private rokuRealMediaReady = new Set<string>();

    private traceDeviceMedia(
        deviceId: string,
        event: string,
        data: Record<string, unknown> = {}
    ) {
        const device = this.receiverDevices.get(deviceId);
        const stored = this.rokuSessionMedia.get(deviceId);
        const displayed = device?.mediaStatus;
        void logMediaDebug(
            `${deviceDebugLabel(device)} media trace [${deviceId}] ${event}`,
            {
                sequence: ++this.mediaTraceSequence,
                storedOwnerId: stored?.ownerId,
                storedContentId: stored?.media.contentId,
                displayedPlayerState: displayed?.playerState,
                displayedCurrentTime: displayed?.currentTime,
                displayedMediaSessionId: displayed?.mediaSessionId,
                displayedContentId: displayed?.media?.contentId,
                displayedDuration: displayed?.media?.duration,
                displayedCustomData: displayed?.media?.customData,
                ...data
            }
        );
    }

    /**
     * Builds the device-status media for a Roku device from its registered
     * session LOAD media. Mirrors RokuRemote.buildStatusMedia's "session"
     * branch (which can never fire cross-process): keep the LOAD-provided
     * duration (the synthetic-DVR nominal duration, e.g. 2h — the
     * player-reported sliding live window is NOT the popup timeline) and
     * stamp rokuLiveElapsed for hlsDvr casts so the popup shows the
     * live-elapsed progress bar.
     */
    private mergeRokuSessionMedia(
        deviceId: string,
        playerDuration: number | null | undefined
    ): MediaInfo | undefined {
        const state = this.rokuSessionMedia.get(deviceId);
        if (!state) return undefined;
        const sessionMedia = state.media;

        const customData =
            sessionMedia.customData &&
            typeof sessionMedia.customData === "object"
                ? sessionMedia.customData
                : {};
        const isHlsDvr = (customData as { hlsDvr?: unknown }).hlsDvr === true;
        return {
            ...sessionMedia,
            duration:
                sessionMedia.duration != null && sessionMedia.duration > 0
                    ? sessionMedia.duration
                    : playerDuration ?? null,
            ...(isHlsDvr
                ? {
                      customData: {
                          ...customData,
                          rokuLiveElapsed: true
                      }
                  }
                : {})
        };
    }

    /**
     * Receiver position -> page position for a Bilibili DASH remux.
     *
     * Both families report a position on the clock of the playlist the bridge
     * generated, but those playlists do not start at the same place, so the
     * anchor is per FAMILY (see the split at the formula): a Chromecast's runway
     * is padded up to the seek target, so its clock already runs on page time and
     * only the media's stated offset has to come off; the Roku capture path emits
     * no pads at all, so its numbers are remux-relative and `dashStart` restores
     * the page position.
     *
     * `dashStart` is the page position the media was generated from, and
     * `presentationOffset` is the synthetic runway in front of its content — both
     * from the media's OWN statement (`customData`), through the media's
     * identity. Never from a device-level value that a later media could inherit.
     * Periodic MEDIA_STATUS broadcasts often carry only the stream's own media
     * snapshot, so when a report drops `customData` the shift is taken from the
     * identity map below, which is keyed the same way: by this device's
     * mediaSessionId and by the media's base contentId. A report whose media is
     * in neither place is NOT converted — guessing would move the popup by a
     * whole runway (or by a whole seek target), which is exactly the failure this
     * replaces.
     *
     * Returns undefined when there is nothing to map — the media is not a DASH
     * remux, it is the CCTV live relay, the identity is unknown, or the family's
     * own anchor is missing — in which case the caller leaves the status as
     * reported.
     */
    private adjustDashCurrentTime(
        device: ReceiverDevice,
        media: MediaInfo | undefined,
        receiverTime: unknown,
        mediaSessionId: unknown
    ): number | undefined {
        const customData =
            media?.customData && typeof media.customData === "object"
                ? (media.customData as {
                      dashRemux?: unknown;
                      dashStart?: unknown;
                      hlsDvr?: unknown;
                  })
                : undefined;
        if (customData?.dashRemux !== true) return undefined;
        if (isHlsDvrCustomData(customData)) return undefined;
        const identity = {
            deviceId: device.id,
            mediaSessionId:
                typeof mediaSessionId === "number" ? mediaSessionId : undefined,
            contentId: media?.contentId
        };
        // The media's own statement wins and refreshes the identity map, so a
        // later report that dropped customData still resolves to the same shift.
        const declaredOffset = declaredPresentationOffset(customData);
        const declaredStart = Number(customData?.dashStart);
        if (declaredOffset !== undefined && Number.isFinite(declaredStart)) {
            this.rememberDashPresentation(
                identity,
                declaredOffset,
                declaredStart
            );
        }
        // `declaredOffset` may legitimately be undefined while `dashStart` is
        // stated: a media with no runway declares no offset. The pair is
        // resolved below from whichever source has it.
        const recalled = this.recallDashPresentation(identity);
        if (declaredOffset === undefined && recalled === undefined) {
            void logMediaDebug(
                "DASH current time NOT mapped (unknown identity)",
                {
                    deviceId: device.id,
                    deviceLabel: deviceDebugLabel(device),
                    rawStatusCurrentTime: Number(receiverTime ?? 0),
                    mediaSessionId: identity.mediaSessionId,
                    mediaContentId: identity.contentId
                }
            );
            return undefined;
        }

        const raw = Number(receiverTime ?? 0);
        if (!Number.isFinite(raw)) return undefined;
        // Where this media's content starts in page time. Only the Roku family
        // anchors on it (see the family split below); a media that never stated
        // one cannot be converted FOR THAT FAMILY, because without it the
        // receiver's position is anchored nowhere and 0 is a position (the start
        // of the video), not a safe default.
        const dashStart =
            declaredOffset !== undefined && Number.isFinite(declaredStart)
                ? declaredStart
                : recalled?.dashStart;
        const presentationOffset = declaredOffset ?? recalled?.offsetSeconds;
        // WHICH ANCHOR APPLIES IS A PROPERTY OF THE RECEIVER, NOT OF THE MEDIA.
        // The two families are handed different playlists, so their clocks do not
        // start at the same place:
        //
        //   Chromecast  the pad runway is generated UP TO the seek target
        //               (padBaseSeconds = max(keyframe, CHROMECAST_MIN_PAD_SECONDS)),
        //               so the playlist's clock already runs on page time and the
        //               media's stated offset is the whole shift:
        //                   pageTime = receiverTime - presentationOffset
        //               This is the bridge's own invariant (mediaServer.ts:
        //               `presentationTime = pageTime + padBase - contentBase`,
        //               0 for every cast whose keyframe is past the minimum, 32s
        //               for an opening cast that walks the minimum runway).
        //   Roku        the capture path emits NO pad entries (?fxcastNoPad=1)
        //               and its content starts at the captured segment's own
        //               start, so the receiver's numbers are REMUX-relative and
        //               the page position has to be restored with dashStart:
        //                   pageTime = dashStart + receiverTime - presentationOffset
        //
        // Requiring the Roku anchor of both is what doubled a Chromecast
        // mid-video cast: that position already contained the seek target, so
        // adding dashStart again published `page + dashStart` (a cast at 23:51
        // showed ~47:42), while an opening cast (dashStart ~0) looked correct.
        const rokuCapturePlaylist = device.deviceType === "roku";
        if (
            presentationOffset === undefined ||
            (rokuCapturePlaylist && dashStart === undefined)
        ) {
            void logMediaDebug(
                rokuCapturePlaylist
                    ? "DASH current time NOT mapped (no dashStart)"
                    : "DASH current time NOT mapped (no presentation offset)",
                {
                    deviceId: device.id,
                    deviceLabel: deviceDebugLabel(device),
                    rawStatusCurrentTime: raw,
                    mediaSessionId: identity.mediaSessionId,
                    mediaContentId: identity.contentId
                }
            );
            return undefined;
        }
        const clockAnchor =
            rokuCapturePlaylist && dashStart !== undefined ? dashStart : 0;
        const pageTime = Math.max(0, clockAnchor + raw - presentationOffset);
        void logMediaDebug("DASH current time mapped", {
            deviceId: device.id,
            deviceLabel: deviceDebugLabel(device),
            rawStatusCurrentTime: raw,
            mediaDashStart: dashStart,
            declaredOffset,
            mediaSessionId: identity.mediaSessionId,
            chosenOffset: presentationOffset,
            clockAnchor,
            publishedCurrentTime: pageTime
        });
        return pageTime;
    }

    /**
     * Record the presentation shift stated by ONE media generation, keyed by the
     * identities that generation reports under.
     *
     * Keyed by media, not by device: a device-level slot is what allowed a
     * previous remux's 32s runway to be subtracted from the next remux's
     * position. A generation whose media streams and ids are known can be looked
     * up from a report that carries either.
     */
    private rememberDashPresentation(
        identity: {
            deviceId: string;
            mediaSessionId?: number;
            contentId?: string;
        },
        offsetSeconds: number,
        dashStart: number
    ) {
        const normalized =
            Number.isFinite(offsetSeconds) && offsetSeconds > 0
                ? offsetSeconds
                : 0;
        const record = {
            offsetSeconds: normalized,
            dashStart: Number.isFinite(dashStart) ? dashStart : 0
        };
        const records: Array<
            [string, { offsetSeconds: number; dashStart: number }]
        > = [];
        const sessionKey =
            identity.mediaSessionId === undefined
                ? undefined
                : dashSessionKey(identity.deviceId, identity.mediaSessionId);
        if (sessionKey) records.push([sessionKey, record]);
        const contentKey = dashContentKey(
            identity.deviceId,
            identity.contentId
        );
        if (contentKey) records.push([contentKey, record]);
        // Only KEEP one adapter identity per device and per generation: the maps
        // are bounded by clearing this device's entries first, so a long
        // multi-item session cannot accumulate a table of dead media.
        for (const key of this.dashPresentationByMedia.keys()) {
            if (key.startsWith(`${identity.deviceId}|`)) {
                this.dashPresentationByMedia.delete(key);
            }
        }
        for (const [key, value] of records) {
            this.dashPresentationByMedia.set(key, value);
        }
    }

    private recallDashPresentation(identity: {
        deviceId: string;
        mediaSessionId?: number;
        contentId?: string;
    }): { offsetSeconds: number; dashStart: number } | undefined {
        const sessionKey =
            identity.mediaSessionId === undefined
                ? undefined
                : dashSessionKey(identity.deviceId, identity.mediaSessionId);
        if (sessionKey !== undefined) {
            const found = this.dashPresentationByMedia.get(sessionKey);
            if (found !== undefined) return found;
        }
        const contentKey = dashContentKey(
            identity.deviceId,
            identity.contentId
        );
        if (contentKey !== undefined) {
            return this.dashPresentationByMedia.get(contentKey);
        }
        return undefined;
    }

    /** Log only the final media state consumed by the popup, after session/relay
     * metadata has been merged into the device status. */
    private logMergedMedia(
        deviceId: string,
        status: MediaStatus,
        source: "session-publish" | "device-status"
    ) {
        const device = this.receiverDevices.get(deviceId);
        const media = status.media;
        const customData =
            media?.customData && typeof media.customData === "object"
                ? (media.customData as Record<string, unknown>)
                : undefined;
        // hlsDvr / rokuLiveElapsed / optimisticRelayMedia / ownerId come from
        // the emulated Roku session and the CCTV Roku relay; on any other
        // device they are constant false/undefined noise, so they are logged
        // only for a Roku.
        const snapshot: Record<string, unknown> = {
            source,
            playerState: status.playerState,
            currentTime: status.currentTime,
            duration: media?.duration,
            pageDuration: customData?.pageDuration
        };
        if (device?.deviceType === "roku") {
            snapshot.hlsDvr = customData?.hlsDvr === true;
            snapshot.rokuLiveElapsed = customData?.rokuLiveElapsed === true;
            snapshot.optimisticRelayMedia =
                customData?.optimisticRelayMedia === true;
            snapshot.ownerId = this.rokuSessionMedia.get(deviceId)?.ownerId;
        }
        const key = JSON.stringify(snapshot);
        if (this.lastMergedMediaDebug.get(deviceId) === key) return;
        this.lastMergedMediaDebug.set(deviceId, key);
        void logMediaDebug(
            `${deviceDebugLabel(device)} merged media [${deviceId}]`,
            snapshot
        );
    }

    beginRokuMediaLoad(deviceId: string) {
        // New media identity for this device. The generation is monotonic for
        // this background's lifetime and is NOT reset on device down, so a
        // reconnect cannot reuse a number while stale commands are in flight.
        const loadGeneration = nextRokuLoadGeneration(deviceId);
        // The discovery process runs the polling loop and has no way to derive
        // the generation (Roku's mediaSessionId is a constant), so it is pushed
        // there explicitly. Its poll samples then carry the generation they
        // STARTED under, and the coordinator can tell a stale load's sample
        // from the current one.
        this.setRokuLoadGenerationOnBridge(deviceId, loadGeneration);
        // The previous LOAD's command is now about a different cast; it must
        // not keep an overlay on the popup's affordance. Terminated before the
        // device entry is consulted, so the pending intent is dropped even if
        // the device has already gone away.
        terminateActivePlaybackCommand(deviceId, "media-changed");

        this.pendingRokuMediaLoads.add(deviceId);
        this.rokuRealMediaReady.delete(deviceId);
        this.rokuSessionMedia.delete(deviceId);
        this.traceDeviceMedia(deviceId, "load-generation-began");

        const device = this.receiverDevices.get(deviceId);
        if (!device?.mediaStatus) return;
        const status: MediaStatus = {
            ...device.mediaStatus,
            playerState: PlayerState.IDLE,
            currentTime: 0
        };
        delete status.media;
        device.mediaStatus = status;
        this.dispatchEvent(
            new CustomEvent("deviceMediaUpdated", {
                detail: { deviceId, status }
            })
        );
    }

    /**
     * Drops the optimistic early session media registered for the CCTV live
     * relay (customData.optimisticRelayMedia), leaving a real LOAD's entry
     * alone.
     *
     * The optimistic entry exists so a Roku Session's popup bar appears before
     * the Roku starts consuming the relay. A CHROMECAST's real media arrives
     * over the cast session instead (main:receiverDeviceMediaStatusUpdated),
     * which never touches this map — so the optimistic write stayed for the
     * whole session, kept its customData alive through that handler's
     * "newMedia.customData == null" preservation, and the popup froze its
     * timeline on it (isOptimisticRelayMedia blocks the elapsed clock), which
     * is the "progress bar never moves" symptom.
     */
    /**
     * Does this device have a cast this extension still owns? Used to tell a
     * transient receiver-app report (the relaunch a DASH remux LOAD performs)
     * apart from a real teardown: EITHER a LOAD is in flight, OR the receiver's
     * media is already recorded for it. Checking only one of the two would miss
     * the window before the receiver publishes its media.
     */
    private hasOwnedSession(deviceId: string): boolean {
        return (
            this.rokuSessionMedia.has(deviceId) ||
            this.pendingRokuMediaLoads.has(deviceId)
        );
    }

    clearOptimisticRelayMedia(deviceId: string) {
        // Roku keeps it: its real LOAD arrives seconds later and this entry is
        // the only thing putting a bar on screen before then.
        if (this.receiverDevices.get(deviceId)?.deviceType === "roku") return;
        const state = this.rokuSessionMedia.get(deviceId);
        if (!state) return;
        const customData =
            state.media.customData && typeof state.media.customData === "object"
                ? (state.media.customData as { optimisticRelayMedia?: unknown })
                : undefined;
        if (customData?.optimisticRelayMedia !== true) return;
        this.rokuSessionMedia.delete(deviceId);
        this.traceDeviceMedia(deviceId, "optimistic-relay-media-cleared", {
            ownerId: state.ownerId
        });
    }

    cancelRokuMediaLoad(deviceId: string) {
        this.pendingRokuMediaLoads.delete(deviceId);
        this.rokuRealMediaReady.delete(deviceId);
        this.traceDeviceMedia(deviceId, "load-generation-cancelled");
    }

    /** Stores (or clears, with null) a Roku session's LOAD media. */
    setRokuSessionMedia(
        deviceId: string,
        ownerId: string,
        media: MediaInfo | null
    ) {
        this.traceDeviceMedia(deviceId, "session-media-input", {
            inputOwnerId: ownerId,
            inputIsClear: media === null,
            inputContentId: media?.contentId,
            inputDuration: media?.duration,
            inputCustomData: media?.customData
        });
        if (!media) {
            const current = this.rokuSessionMedia.get(deviceId);
            if (current?.ownerId === ownerId) {
                this.rokuSessionMedia.delete(deviceId);
                // A clear must travel too, or the discovery process keeps
                // synthesizing from a session that is gone.
                this.syncRokuSessionMediaToBridge(deviceId, ownerId, null);
            }
            return;
        }
        this.rokuSessionMedia.set(deviceId, { ownerId, media });
        // The discovery bridge runs the RokuRemote whose observer builds the
        // popup's media status, and it is a DIFFERENT connectNative process, so
        // its own sessionMedia registry is a separate module instance that this
        // write can never reach. Without forwarding, the HLS DVR startup
        // synthesis and the session metadata (duration, customData) that
        // buildStatusMedia expects are simply never visible there.
        this.syncRokuSessionMediaToBridge(deviceId, ownerId, media);
        // Refine the CURRENT load generation's identity. Optimistic relay media
        // and the real LOAD media both land here for the same load, so this
        // must never fork the generation.
        setRokuMediaIdentityFields(deviceId, {
            contentId: media.contentId,
            ownerId,
            // The synthetic-DVR relay publishes its optimistic media under
            // `relay:${requestId}`; remember the request id itself so relay
            // lifecycle messages stay correlatable even after the real session
            // media overwrites ownerId.
            relayRequestId: ownerId.startsWith("relay:")
                ? ownerId.slice("relay:".length)
                : undefined
        });
        const optimistic =
            (media.customData as { optimisticRelayMedia?: unknown } | null)
                ?.optimisticRelayMedia === true;
        if (this.pendingRokuMediaLoads.has(deviceId) && !optimistic) {
            this.rokuRealMediaReady.add(deviceId);
        }

        // Surface the media to the popup IMMEDIATELY. The merge hook in
        // main:receiverDeviceMediaStatusUpdated only runs when RokuRemote
        // emits a media status, which it never does while ECP reports the
        // player as idle — i.e. for the whole channel startup/buffering
        // window. Without this the popup progress bar only appears once
        // the Roku actually starts playing.
        const device = this.receiverDevices.get(deviceId);
        if (!device) return;
        const mergedMedia = this.mergeRokuSessionMedia(deviceId, undefined);
        if (!mergedMedia) return;
        const status: MediaStatus = {
            mediaSessionId: 1,
            playbackRate: 1,
            // Any real status the remote already published supplies stable
            // receiver fields. Optimistic relay media then explicitly holds
            // BUFFERING at zero until Roku consumption publishes the real LOAD.
            ...device.mediaStatus,
            playerState:
                (
                    mergedMedia.customData as {
                        optimisticRelayMedia?: unknown;
                    } | null
                )?.optimisticRelayMedia === true ||
                this.pendingRokuMediaLoads.has(deviceId)
                    ? PlayerState.BUFFERING
                    : device.mediaStatus?.playerState ?? PlayerState.BUFFERING,
            currentTime:
                (
                    mergedMedia.customData as {
                        optimisticRelayMedia?: unknown;
                    } | null
                )?.optimisticRelayMedia === true ||
                this.pendingRokuMediaLoads.has(deviceId)
                    ? 0
                    : device.mediaStatus?.currentTime ?? 0,
            supportedMediaCommands: 15,
            repeatMode: RepeatMode.OFF,
            volume: device.status?.volume ?? { level: 1, muted: false },
            customData: null,
            media: mergedMedia
        };
        device.mediaStatus = status;
        this.traceDeviceMedia(deviceId, "session-media-published", {
            inputOwnerId: ownerId,
            inputWasOptimistic:
                (
                    mergedMedia.customData as {
                        optimisticRelayMedia?: unknown;
                    } | null
                )?.optimisticRelayMedia === true
        });
        this.logMergedMedia(deviceId, status, "session-publish");
        this.dispatchEvent(
            new CustomEvent("deviceMediaUpdated", {
                detail: { deviceId, status }
            })
        );
    }

    /**
     * Clears a session-media entry only if it is the optimistic early one
     * castManager registered from the relay's "synthetic DVR playlist
     * constructed" event (customData.optimisticRelayMedia). Real
     * LOAD-published media (main:rokuSessionMedia) is never touched here;
     * it is replaced by the next LOAD or cleared by session teardown.
     */
    clearOptimisticRokuSessionMedia(deviceId: string, requestId: string) {
        const state = this.rokuSessionMedia.get(deviceId);
        if (!state || state.ownerId !== `relay:${requestId}`) return;
        const customData =
            state.media.customData && typeof state.media.customData === "object"
                ? (state.media.customData as { optimisticRelayMedia?: unknown })
                : undefined;
        if (customData?.optimisticRelayMedia !== true) return;

        this.rokuSessionMedia.delete(deviceId);
        const device = this.receiverDevices.get(deviceId);
        if (!device?.mediaStatus) return;
        const displayedCustomData = device.mediaStatus.media?.customData;
        if (
            !displayedCustomData ||
            typeof displayedCustomData !== "object" ||
            (displayedCustomData as { optimisticRelayMedia?: unknown })
                .optimisticRelayMedia !== true
        ) {
            return;
        }
        const status: MediaStatus = {
            ...device.mediaStatus,
            playerState: PlayerState.IDLE
        };
        delete status.media;
        device.mediaStatus = status;
        this.dispatchEvent(
            new CustomEvent("deviceMediaUpdated", {
                detail: { deviceId, status }
            })
        );
    }

    private bridgePort?: Port;
    private bridgeInfo?: BridgeInfo;
    async init() {
        if (!this.bridgePort) {
            await this.refresh();
        }
    }

    /**
     * Initializes (or re-initializes) a bridge connection to start
     * dispatching events.
     */
    async refresh() {
        this.bridgePort?.disconnect();

        try {
            this.bridgeInfo = await bridge.getInfo();
            // eslint-disable-next-line no-empty
        } catch {}

        if (this.bridgeInfo?.isVersionCompatible) {
            this.bridgePort = await bridge.connect();
            this.bridgePort.onMessage.addListener(this.onBridgeMessage);
            this.bridgePort.onDisconnect.addListener(this.onBridgeDisconnect);

            // Forward the user-configured half-dead watchdog timeouts so the
            // bridge's Remote/Session watchdogs use them instead of their
            // built-in defaults. Read defensively: a missing/broken option
            // must not block discovery.
            let remoteHeartbeatStaleMs: number | undefined;
            let sessionHeartbeatStaleMs: number | undefined;
            try {
                const opts = await options.getAll();
                remoteHeartbeatStaleMs = opts.castRemoteHeartbeatStaleMs;
                sessionHeartbeatStaleMs = opts.castSessionHeartbeatStaleMs;
            } catch (err) {
                logger.error(
                    "Failed to read heartbeat options; bridge will use defaults"
                );
            }

            // The discovery process is new (or was recreated), so its remotes
            // and its generation cache start empty while the extension keeps
            // its identities across a reconnect. Replay them, otherwise a
            // device that is mid-playback would report every sample as
            // unattributed until the next LOAD.
            this.replayRokuLoadGenerations();

            this.bridgePort.postMessage({
                subject: "bridge:startDiscovery",
                data: {
                    // Also send back status messages
                    shouldWatchStatus: true,
                    remoteHeartbeatStaleMs,
                    sessionHeartbeatStaleMs
                }
            });
        }
    }

    getBridgeInfo() {
        return this.bridgeInfo;
    }

    /** Gets a list of receiver devices. */
    getDevices() {
        return Array.from(this.receiverDevices.values());
    }
    /** Gets a device by ID. */
    getDeviceById(deviceId: string) {
        return this.receiverDevices.get(deviceId);
    }

    /**
     * Note that a device's CURRENT media generation carries this presentation
     * offset: how far its reported position sits ahead of the page's video time.
     *
     * Scoped to the media the device is reporting on right now, never to the
     * device: a device-level slot outlives the media it was set for, which is how
     * a previous remux's runway came to be subtracted from the next remux's
     * position. It is only a memo of the media's own statement (the media's
     * `customData.presentationOffsetSeconds` remains the source of truth and
     * overwrites this on sight), for the reports that arrive without customData.
     */
    setDashPresentationOffset(deviceId: string, seconds: unknown) {
        const device = this.receiverDevices.get(deviceId);
        // A device that is not in the list needs no entry: the offset only ever
        // converts a position this device reports, and a discovery reconnect that
        // re-adds the device is followed by a fresh LOAD, which states its own.
        if (!device) return;
        const status = device.mediaStatus;
        if (!status?.media) return;
        const mediaCustomData =
            status.media.customData &&
            typeof status.media.customData === "object"
                ? (status.media.customData as { dashStart?: unknown })
                : undefined;
        this.rememberDashPresentation(
            {
                deviceId,
                mediaSessionId: status.mediaSessionId,
                contentId: status.media.contentId
            },
            Number(seconds),
            Number(mediaCustomData?.dashStart)
        );
    }

    /** Sends an NS_RECEIVER message to a given device. */
    sendReceiverMessage(deviceId: string, message: SenderMessage) {
        if (!this.bridgePort) {
            logger.error(
                "Failed to send receiver message (no bridge connection)"
            );
            return;
        }

        const device = this.receiverDevices.get(deviceId);
        if (!device) {
            logger.error(
                "Failed to send receiver message (could not find device)"
            );
            return;
        }

        this.bridgePort?.postMessage({
            subject: "bridge:sendReceiverMessage",
            data: { deviceId, message }
        });
    }

    /** Sends an NS_MEDIA message to a given device. */
    sendMediaMessage(deviceId: string, message: SenderMediaMessage): boolean {
        if (!this.bridgePort) {
            logger.error("Failed to send media message (no bridge connection)");
            return false;
        }

        const device = this.receiverDevices.get(deviceId);
        if (!device) {
            logger.error(
                "Failed to send media message (could not find device)"
            );
            return false;
        }

        try {
            this.bridgePort.postMessage({
                subject: "bridge:sendMediaMessage",
                data: { deviceId, message }
            });
            return true;
        } catch (err) {
            // A disconnected or mid-teardown port can throw synchronously.
            // Reporting it as a failed dispatch keeps a caller that models
            // routing (playbackCommand) able to fall back instead of
            // abandoning the command mid-flight.
            logger.error(
                "Failed to send media message (postMessage threw)",
                err
            );
            return false;
        }
    }

    /**
     * Re-pushes every current LOAD generation to the discovery bridge.
     *
     * The bridge caches what arrives before the matching remote exists, so the
     * order relative to bridge:startDiscovery does not matter; what matters is
     * that a reconnect does not silently drop the binding.
     */
    private replayRokuLoadGenerations() {
        for (const [deviceId, identity] of currentRokuMediaIdentities()) {
            this.setRokuLoadGenerationOnBridge(
                deviceId,
                identity.loadGeneration
            );
        }
        // The new process's session-media cache is empty too.
        for (const [deviceId, entry] of this.rokuSessionMedia) {
            this.syncRokuSessionMediaToBridge(
                deviceId,
                entry.ownerId,
                entry.media
            );
        }
    }

    /**
     * Mirrors one session-media state to the discovery bridge.
     *
     * Carries the LOAD generation as well as the owner: the generation is the
     * media-identity key, and a message from a superseded load must not
     * overwrite the current one even if its owner string happens to match.
     */
    private syncRokuSessionMediaToBridge(
        deviceId: string,
        ownerId: string,
        media: MediaInfo | null
    ) {
        if (!this.bridgePort) return;
        const identity = currentRokuMediaIdentity(deviceId);
        if (!identity) return;
        try {
            this.bridgePort.postMessage({
                subject: "bridge:rokuSetSessionMedia",
                data: {
                    deviceId,
                    loadGeneration: identity.loadGeneration,
                    ownerId,
                    media
                }
            });
        } catch (err) {
            logger.error("Failed to mirror Roku session media", err);
        }
    }

    /** Pushes the current LOAD generation to the discovery bridge. */
    private setRokuLoadGenerationOnBridge(
        deviceId: string,
        loadGeneration: number
    ) {
        if (!this.bridgePort) return;
        try {
            this.bridgePort.postMessage({
                subject: "bridge:rokuSetLoadGeneration",
                data: { deviceId, loadGeneration }
            });
        } catch (err) {
            logger.error("Failed to publish the LOAD generation", err);
        }
    }

    /**
     * Asks the device-discovery bridge to sample this Roku densely for a short
     * window, because a play/pause transport was just submitted to it. The
     * request must go to the discovery connection: that is the process that
     * owns the polling loop and emits every observation.
     */
    requestRokuConfirmationPoll(deviceId: string) {
        if (!this.bridgePort) return;
        if (!this.receiverDevices.has(deviceId)) return;
        try {
            this.bridgePort.postMessage({
                subject: "bridge:rokuRequestConfirmationPoll",
                data: { deviceId }
            });
        } catch (err) {
            logger.error("Failed to request a confirmation poll", err);
        }
    }

    /** Re-broadcasts a device's playback view to the receiver popups. */
    notifyPlaybackCommandChanged(deviceId: string) {
        if (!this.receiverDevices.has(deviceId)) return;
        this.dispatchEvent(
            new CustomEvent("devicePlaybackUpdated", {
                detail: { deviceId }
            })
        );
    }

    /**
     * Page-reported asynchronous facts for a play/pause command (arm consumed,
     * receiver called, arm expired). The coordinator decides whether they belong
     * to the current command.
     *
     * Reachable from BOTH channels on purpose: the page sender posts this with
     * `browser.runtime.sendMessage`, while the coordinator's consumer used to be
     * reachable only from the native bridge port - so the progress never
     * arrived and a page-route command could never be confirmed. The runtime hop
     * is registered in `registerPagePlaybackProgressRuntimeRelay()`.
     */
    handlePagePlaybackProgress(detail: PlaybackCommandProgress) {
        if (!detail || typeof detail !== "object") return;
        this.dispatchEvent(
            new CustomEvent("bilibiliPlaybackProgress", { detail })
        );
    }

    private onBridgeMessage = (message: Message) => {
        switch (message.subject) {
            case "main:deviceUp": {
                const { deviceId, deviceInfo } = message.data;

                this.receiverDevices.set(deviceId, deviceInfo);

                // Sort devices by friendly name
                this.receiverDevices = new Map(
                    [...this.receiverDevices].sort(([, deviceA], [, deviceB]) =>
                        deviceA.friendlyName.localeCompare(deviceB.friendlyName)
                    )
                );

                this.dispatchEvent(
                    new CustomEvent("deviceUp", {
                        detail: { deviceInfo }
                    })
                );

                break;
            }

            case "main:pongDiagnostics": {
                // Only sent by the bridge when the live-calibrated threshold
                // diverges from the configured one, so this always indicates
                // a threshold worth reviewing. `source` says which file's
                // HEARTBEAT_STALE_MS to update (Session.ts vs remote.ts).
                const {
                    source,
                    sessionId,
                    deviceId,
                    configuredThresholdMs,
                    report
                } = message.data;
                logger.info(
                    `Cast heartbeat threshold drift [${source}]` +
                        (report.newMax ? " (new max gap)" : "") +
                        `: suggested HEARTBEAT_STALE_MS=` +
                        `${report.suggestedThresholdMs}ms, configured=` +
                        `${configuredThresholdMs}ms — consider updating ` +
                        `${source === "remote" ? "remote.ts" : "Session.ts"}`,
                    { source, sessionId, deviceId, ...report }
                );

                break;
            }

            case "main:rokuStatusMediaDebug": {
                // Intentionally retain the message path for future architecture
                // work, but hide this process-local snapshot from the console.
                // "<device> merged media" is the authoritative extension-side
                break;
                // Always-on and flattened: Firefox collapses nested
                // MediaInformation / customData as `{…}` in the preview,
                // hiding the duration/hlsDvr/rokuLiveElapsed trail that
                // decides whether the popup seek bar appears. Every field
                // here is a primitive so the whole snapshot is inline.
                // const { deviceId, branch, ...rest } = message.data;
                // logger.info(
                //     `Roku buildStatusMedia [${deviceId}] branch=${branch}`,
                //     rest
                // );
            }

            case "main:rokuSessionMediaDebug": {
                // Session-side counterpart of the buildStatusMedia debug:
                // shows whether consumption was observed (and how: by
                // fxcastSession marker or client-host fallback) and whether
                // the session media actually got registered for the popup.
                const { deviceId, event, ...rest } = message.data;
                void logMediaDebug(
                    `Roku session media [${deviceId}] ${event}`,
                    rest
                );

                break;
            }

            case "main:deviceDown": {
                const { deviceId } = message.data;

                // An active play/pause command cannot outlive its device: the
                // dispatch target is gone, so it must not stay pending.
                terminateActivePlaybackCommand(deviceId, "device-disconnected");

                if (this.receiverDevices.has(deviceId)) {
                    this.receiverDevices.delete(deviceId);
                }
                this.lastMergedMediaDebug.delete(deviceId);
                this.lastRemoteStatusTrace.delete(deviceId);
                this.pendingRokuMediaLoads.delete(deviceId);
                this.rokuRealMediaReady.delete(deviceId);
                this.dispatchEvent(
                    new CustomEvent("deviceDown", {
                        detail: { deviceId: deviceId }
                    })
                );

                break;
            }

            case "main:receiverDeviceStatusUpdated": {
                const { deviceId, status } = message.data;
                const device = this.receiverDevices.get(deviceId);
                if (!device) break;

                const oldApplication = device.status?.applications?.[0];

                // Clear media status when app status changes
                const application = status.applications?.[0];
                // Is this the RELAUNCH a DASH remux LOAD performs, or the cast
                // really ending? An app that disappears while this extension owns
                // a session is the former: tearing down on that report deleted the
                // popup's media status (its progress bar) and dropped the
                // transport ownership (Stop became Cast) mid-seek — measured
                // on-device 2026-09-17 02:17.
                const appDisappeared =
                    (!application || application.isIdleScreen) &&
                    oldApplication !== undefined &&
                    !oldApplication.isIdleScreen;
                if (appDisappeared) {
                    const goneSince = this.receiverAppGoneAt.get(deviceId);
                    if (goneSince === undefined) {
                        this.receiverAppGoneAt.set(deviceId, Date.now());
                    }
                    const stillSettling =
                        Date.now() - (goneSince ?? Date.now()) <
                        RECEIVER_APP_GONE_GRACE_MS;
                    if (stillSettling && this.hasOwnedSession(deviceId)) {
                        // Keep the last known status (the popup reads the app and
                        // the ownership from it) and skip the teardown entirely;
                        // the next report either restores the app or, once the
                        // window expires, tears down for real.
                        break;
                    }
                    this.receiverAppGoneAt.delete(deviceId);
                }
                if (!application || application.isIdleScreen) {
                    delete device.mediaStatus;

                    // Send application closed event
                    if (oldApplication && !oldApplication.isIdleScreen) {
                        this.dispatchEvent(
                            new CustomEvent("applicationClosed", {
                                detail: {
                                    deviceId,
                                    appId: oldApplication.appId,
                                    sessionId: oldApplication.transportId
                                }
                            })
                        );
                    }
                }

                this.receiverAppGoneAt.delete(deviceId);
                device.status = status;

                this.dispatchEvent(
                    new CustomEvent("deviceUpdated", {
                        detail: {
                            deviceId,
                            status: device.status
                        }
                    })
                );

                // Send new application found event
                if (
                    !oldApplication &&
                    application &&
                    !application.isIdleScreen
                ) {
                    this.dispatchEvent(
                        new CustomEvent("applicationFound", {
                            detail: { deviceId, appId: application.appId }
                        })
                    );
                }

                break;
            }

            case "main:bilibiliPlaybackProgress":
                this.handlePagePlaybackProgress(message.data);
                break;

            case "main:rokuPlaybackObservation": {
                // Observation-only feed: does not touch device.mediaStatus,
                // so the media clear semantics stay exactly as they were.
                const { deviceId, status, loadGeneration, provenance } =
                    message.data;
                if (!this.receiverDevices.has(deviceId)) break;
                this.dispatchEvent(
                    new CustomEvent("rokuPlaybackObservation", {
                        detail: { deviceId, status, loadGeneration, provenance }
                    })
                );
                break;
            }

            case "main:receiverDeviceMediaStatusUpdated": {
                const { deviceId, status, provenance } = message.data;
                const device = this.receiverDevices.get(deviceId);
                if (!device) break;
                // The bridge publishes every completed poll, not only
                // changes (RokuRemote.pollSample: command confirmation needs
                // fresh samples even when they repeat the cached state), so
                // the traces below only fire when this sample actually
                // differs from the last one traced for this device.
                const sampleSignature = JSON.stringify([
                    status.playerState,
                    status.currentTime,
                    status.mediaSessionId,
                    status.media?.contentId,
                    status.media?.duration,
                    status.media?.customData
                ]);
                const sampleChanged =
                    this.lastRemoteStatusTrace.get(deviceId) !==
                    sampleSignature;
                if (sampleChanged) {
                    this.lastRemoteStatusTrace.set(deviceId, sampleSignature);
                }
                if (this.pendingRokuMediaLoads.has(deviceId)) {
                    if (!this.rokuRealMediaReady.has(deviceId)) {
                        if (sampleChanged) {
                            this.traceDeviceMedia(
                                deviceId,
                                "remote-status-blocked",
                                {
                                    inputPlayerState: status.playerState,
                                    inputCurrentTime: status.currentTime
                                }
                            );
                        }
                        break;
                    }
                    this.pendingRokuMediaLoads.delete(deviceId);
                    this.rokuRealMediaReady.delete(deviceId);
                    this.traceDeviceMedia(
                        deviceId,
                        "first-real-load-status-accepted",
                        {
                            inputPlayerState: status.playerState,
                            inputCurrentTime: status.currentTime
                        }
                    );
                }
                if (sampleChanged) {
                    this.traceDeviceMedia(deviceId, "remote-status-input", {
                        inputPlayerState: status.playerState,
                        inputCurrentTime: status.currentTime,
                        inputMediaSessionId: status.mediaSessionId,
                        inputContentId: status.media?.contentId,
                        inputDuration: status.media?.duration,
                        inputCustomData: status.media?.customData
                    });
                }

                // Emulated Roku sessions live in a separate bridge process,
                // so RokuRemote's buildStatusMedia can never see the LOAD
                // media (its sessionMedia registry is per-process). The
                // session publishes it via main:rokuSessionMedia instead;
                // merge it into the device media status here.
                const mergedSessionMedia =
                    status.playerState !== PlayerState.IDLE
                        ? this.mergeRokuSessionMedia(
                              deviceId,
                              status.media?.duration
                          )
                        : undefined;
                if (mergedSessionMedia) status.media = mergedSessionMedia;

                if (device.mediaStatus) {
                    // Periodic MEDIA_STATUS broadcasts can carry a
                    // stream-derived media object that lacks fields only
                    // present at LOAD time (duration, customData, ...).
                    // Without preserving them, a reopened popup loses the
                    // seek bar (duration) and DASH remux metadata
                    // (customData.pageDuration).
                    const oldMedia = device.mediaStatus.media;
                    device.mediaStatus = { ...device.mediaStatus, ...status };
                    const newMedia = device.mediaStatus.media;
                    if (oldMedia && newMedia && oldMedia !== newMedia) {
                        // Metadata carries over only between media about the SAME
                        // content: a report that names a different contentId is a
                        // different generation, and inheriting the old fields
                        // hands the new media the old one's dashStart (measured:
                        // an unidentified 500 was published as 936.014207), its
                        // duration (the seek bar's scale), its title and its
                        // tracks. An anonymous media (`contentId` absent on either
                        // side) is still treated as the same content, because a
                        // stream-derived report that drops the id is exactly the
                        // case this preservation exists for.
                        const sameContent =
                            newMedia.contentId === undefined ||
                            oldMedia.contentId === undefined ||
                            normalizeContentId(newMedia.contentId) ===
                                normalizeContentId(oldMedia.contentId);
                        // Per-field copies (a keyed loop trips TS2322:
                        // assigning the union of field types to the
                        // intersection-typed target).
                        if (
                            sameContent &&
                            newMedia.duration == null &&
                            oldMedia.duration != null
                        ) {
                            newMedia.duration = oldMedia.duration;
                        }
                        if (
                            sameContent &&
                            newMedia.customData == null &&
                            oldMedia.customData != null
                        ) {
                            newMedia.customData = oldMedia.customData;
                        }
                        if (
                            sameContent &&
                            newMedia.metadata == null &&
                            oldMedia.metadata != null
                        ) {
                            newMedia.metadata = oldMedia.metadata;
                        }
                        if (
                            sameContent &&
                            newMedia.tracks == null &&
                            oldMedia.tracks != null
                        ) {
                            newMedia.tracks = oldMedia.tracks;
                        }
                    }
                    if (status.playerState === PlayerState.IDLE) {
                        delete device.mediaStatus.media;
                    }
                    // The receiver's OWN media is authoritative: drop the
                    // optimistic relay entry so its customData cannot keep
                    // freezing the popup timeline (see
                    // clearOptimisticRelayMedia). Guarded by the device id, so a
                    // cast device never keeps Roku session media alive.
                    this.clearOptimisticRelayMedia(device.id);
                } else {
                    // A COPY, never the payload itself: the conversion below
                    // mutates the position it is given, and writing into the
                    // message object leaves that message carrying a PAGE value.
                    // Any later handling of the same message — a replay, or the
                    // fan-out this repo's harness used to do for every listener
                    // registered on its stub port — then converts a page value as
                    // if it were a raw one, which is how one position became
                    // three (41.5 -> 81.5 -> 121.5). Copying makes the conversion
                    // idempotent by construction: it always reads a position the
                    // BRIDGE reported, never one it produced.
                    device.mediaStatus = { ...status };
                }

                // Receiver position -> page position, on the MERGED status.
                //
                // It has to be here, after the merge, because the merge is what
                // gives a stream-derived report the LOAD-time metadata: periodic
                // MEDIA_STATUS broadcasts often carry only the stream's own media
                // snapshot, so `currentTime` arrives as the padded clock while
                // `customData` is absent from THAT payload. Converting the
                // incoming status instead meant every later report bypassed the
                // conversion and the popup jumped a whole pad runway forward once
                // playback started.
                //
                // The shift is resolved from the MEDIA's identity (see
                // adjustDashCurrentTime), so a report from a previous generation
                // is left unconverted rather than moved by a runway that was never
                // its own.
                //
                // No "already converted" bookkeeping is needed, because the
                // input to this conversion is always a position the BRIDGE
                // reported: the status is either a copy of the incoming payload
                // or a merge that took `currentTime` from it. A value comparison
                // could not have answered the question anyway - the test that
                // recognises the page value published last also refuses a
                // legitimate conversion whenever a fresh raw position happens to
                // equal it, and then the popup is handed a remux-relative number
                // with nothing to say so.
                const adjusted = this.adjustDashCurrentTime(
                    device,
                    device.mediaStatus.media,
                    device.mediaStatus.currentTime,
                    device.mediaStatus.mediaSessionId
                );
                if (adjusted !== undefined) {
                    device.mediaStatus.currentTime = adjusted;
                }

                if (sampleChanged) {
                    this.traceDeviceMedia(deviceId, "remote-status-published");
                }
                this.logMergedMedia(
                    deviceId,
                    device.mediaStatus,
                    "device-status"
                );
                this.dispatchEvent(
                    new CustomEvent("deviceMediaUpdated", {
                        detail: {
                            deviceId,
                            // The merged status is what the popup renders,
                            // but provenance describes the bridge's SAMPLE,
                            // so it must not be dropped by the merge.
                            status: device.mediaStatus,
                            provenance
                        }
                    })
                );

                break;
            }
        }
    };

    private onBridgeDisconnect = () => {
        const deviceIds = [...this.receiverDevices.keys()];

        // The bridge is the only path to a receiver, so no command can still
        // be executing.
        terminateAllPlaybackCommands("bridge-disconnected");

        delete this.bridgeInfo;
        this.receiverDevices.clear();
        // NOT cleared: session media belongs to the independent session
        // lifecycle, not to the discovery process. Keeping the extension-side
        // mirror is what lets `replayRokuLoadGenerations()` refill the
        // REPLACEMENT process's empty cache on the next connect - clearing it
        // here emptied the very table that replay reads, so a reconnected
        // discovery process could only fall back to ECP state until some later
        // session-media publish or a new LOAD. A new LOAD, the current owner's
        // clear, a legitimate new owner's set or the optimistic-relay cleanup
        // retire it, exactly as before.
        this.lastMergedMediaDebug.clear();
        this.pendingRokuMediaLoads.clear();
        this.rokuRealMediaReady.clear();

        // Notify listeners of device availablility
        for (const deviceId of deviceIds) {
            const event = new CustomEvent("deviceDown", {
                detail: { deviceId }
            });

            this.dispatchEvent(event);
        }

        /**
         * Reconnect 10 seconds after disconnect if not already
         * reconnected (like immediately after a refresh).
         */
        window.setTimeout(() => {
            if (!this.bridgeInfo) {
                this.refresh();
            }
        }, 10000);
    };
})();
