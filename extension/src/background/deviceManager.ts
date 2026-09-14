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
    currentRokuMediaIdentities,
    currentRokuMediaIdentity,
    nextRokuLoadGeneration,
    setRokuMediaIdentityFields,
    terminateActivePlaybackCommand,
    terminateAllPlaybackCommands
} from "./playbackCommand";

async function logRokuDebug(message: string, data: unknown) {
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

export default new (class extends TypedEventTarget<EventMap> {
    /**
     * Map of receiver device IDs to devices. Updated as receiverDevice
     * messages are received from the bridge.
     */
    private receiverDevices = new Map<string, ReceiverDevice>();

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
    /** Last authoritative extension-side Roku media snapshot logged per device. */
    private lastRokuMergedMediaDebug = new Map<string, string>();
    private rokuMediaTraceSequence = 0;
    /** New Roku LOAD generation. Old ECP status is blocked until the real LOAD
     * media is registered and the next remote sample belongs to that LOAD. */
    private pendingRokuMediaLoads = new Set<string>();
    private rokuRealMediaReady = new Set<string>();

    private traceRokuMedia(
        deviceId: string,
        event: string,
        data: Record<string, unknown> = {}
    ) {
        const device = this.receiverDevices.get(deviceId);
        const stored = this.rokuSessionMedia.get(deviceId);
        const displayed = device?.mediaStatus;
        void logRokuDebug(`Roku media trace [${deviceId}] ${event}`, {
            sequence: ++this.rokuMediaTraceSequence,
            storedOwnerId: stored?.ownerId,
            storedContentId: stored?.media.contentId,
            displayedPlayerState: displayed?.playerState,
            displayedCurrentTime: displayed?.currentTime,
            displayedMediaSessionId: displayed?.mediaSessionId,
            displayedContentId: displayed?.media?.contentId,
            displayedDuration: displayed?.media?.duration,
            displayedCustomData: displayed?.media?.customData,
            ...data
        });
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

    /** Log only the final media state consumed by the popup, after session/relay
     * metadata has been merged into the device status. */
    private logRokuMergedMedia(
        deviceId: string,
        status: MediaStatus,
        source: "session-publish" | "device-status"
    ) {
        const media = status.media;
        const customData =
            media?.customData && typeof media.customData === "object"
                ? (media.customData as Record<string, unknown>)
                : undefined;
        const snapshot = {
            source,
            playerState: status.playerState,
            currentTime: status.currentTime,
            duration: media?.duration,
            hlsDvr: customData?.hlsDvr === true,
            pageDuration: customData?.pageDuration,
            rokuLiveElapsed: customData?.rokuLiveElapsed === true,
            optimisticRelayMedia: customData?.optimisticRelayMedia === true,
            ownerId: this.rokuSessionMedia.get(deviceId)?.ownerId
        };
        const key = JSON.stringify(snapshot);
        if (this.lastRokuMergedMediaDebug.get(deviceId) === key) return;
        this.lastRokuMergedMediaDebug.set(deviceId, key);
        void logRokuDebug(`Roku merged media [${deviceId}]`, snapshot);
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
        this.traceRokuMedia(deviceId, "load-generation-began");

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

    cancelRokuMediaLoad(deviceId: string) {
        this.pendingRokuMediaLoads.delete(deviceId);
        this.rokuRealMediaReady.delete(deviceId);
        this.traceRokuMedia(deviceId, "load-generation-cancelled");
    }

    /** Stores (or clears, with null) a Roku session's LOAD media. */
    setRokuSessionMedia(
        deviceId: string,
        ownerId: string,
        media: MediaInfo | null
    ) {
        this.traceRokuMedia(deviceId, "session-media-input", {
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
        this.traceRokuMedia(deviceId, "session-media-published", {
            inputOwnerId: ownerId,
            inputWasOptimistic:
                (
                    mergedMedia.customData as {
                        optimisticRelayMedia?: unknown;
                    } | null
                )?.optimisticRelayMedia === true
        });
        this.logRokuMergedMedia(deviceId, status, "session-publish");
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
                // "Roku merged media" is the authoritative extension-side view.
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
                void logRokuDebug(
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
                this.lastRokuMergedMediaDebug.delete(deviceId);
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
                if (this.pendingRokuMediaLoads.has(deviceId)) {
                    if (!this.rokuRealMediaReady.has(deviceId)) {
                        this.traceRokuMedia(deviceId, "remote-status-blocked", {
                            inputPlayerState: status.playerState,
                            inputCurrentTime: status.currentTime
                        });
                        break;
                    }
                    this.pendingRokuMediaLoads.delete(deviceId);
                    this.rokuRealMediaReady.delete(deviceId);
                    this.traceRokuMedia(
                        deviceId,
                        "first-real-load-status-accepted",
                        {
                            inputPlayerState: status.playerState,
                            inputCurrentTime: status.currentTime
                        }
                    );
                }
                this.traceRokuMedia(deviceId, "remote-status-input", {
                    inputPlayerState: status.playerState,
                    inputCurrentTime: status.currentTime,
                    inputMediaSessionId: status.mediaSessionId,
                    inputContentId: status.media?.contentId,
                    inputDuration: status.media?.duration,
                    inputCustomData: status.media?.customData
                });

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
                if (mergedSessionMedia) {
                    status.media = mergedSessionMedia;
                    const customData =
                        mergedSessionMedia.customData &&
                        typeof mergedSessionMedia.customData === "object"
                            ? (mergedSessionMedia.customData as {
                                  dashRemux?: unknown;
                                  dashStart?: unknown;
                              })
                            : undefined;
                    if (customData?.dashRemux === true) {
                        const dashStart = Number(customData.dashStart);
                        if (Number.isFinite(dashStart)) {
                            status.currentTime =
                                dashStart + (status.currentTime ?? 0);
                        }
                    }
                }

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
                        // Per-field copies (a keyed loop trips TS2322:
                        // assigning the union of field types to the
                        // intersection-typed target).
                        if (
                            newMedia.duration == null &&
                            oldMedia.duration != null
                        ) {
                            newMedia.duration = oldMedia.duration;
                        }
                        if (
                            newMedia.customData == null &&
                            oldMedia.customData != null
                        ) {
                            newMedia.customData = oldMedia.customData;
                        }
                        if (
                            newMedia.metadata == null &&
                            oldMedia.metadata != null
                        ) {
                            newMedia.metadata = oldMedia.metadata;
                        }
                        if (
                            newMedia.tracks == null &&
                            oldMedia.tracks != null
                        ) {
                            newMedia.tracks = oldMedia.tracks;
                        }
                    }
                    if (status.playerState === PlayerState.IDLE) {
                        delete device.mediaStatus.media;
                    }
                } else {
                    device.mediaStatus = status;
                }

                this.traceRokuMedia(deviceId, "remote-status-published");
                this.logRokuMergedMedia(
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
        this.lastRokuMergedMediaDebug.clear();
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
