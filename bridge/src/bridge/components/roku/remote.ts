/**
 * Device-level status tracking and control for discovered Roku devices.
 *
 * The Chromecast equivalent (components/cast/remote.ts) holds a persistent
 * protobuf socket that pushes RECEIVER_STATUS/MEDIA_STATUS. ECP has no push
 * channel, so this class polls /query/media-player on an interval and
 * synthesizes the same status objects the extension already consumes:
 *
 *   onReceiverStatusUpdate  -> "main:receiverDeviceStatusUpdated"
 *   onMediaStatusUpdate     -> "main:receiverDeviceMediaStatusUpdated"
 *
 * It also translates the popup's session-less media controls
 * (deviceManager#sendMediaMessage) and receiver messages (volume, stop)
 * into ECP calls.
 */
import type { ReceiverDevice } from "../../messagingTypes";
import type {
    MediaInformation,
    MediaStatus,
    ReceiverApplication,
    ReceiverStatus,
    SenderMediaMessage,
    SenderMessage,
    Volume
} from "../cast/types";
import { PlayerState, RepeatMode, VolumeControlType } from "../cast/types";

import { getRokuSessionMedia, observeRokuSessionMedia } from "./sessionMedia";

import {
    buildLaunchParams,
    keypress,
    launch,
    queryActiveApp,
    queryMediaPlayer,
    resolvePlayerAppId,
    ROKU_MEDIA_PLAYER_APP_ID,
    type ActiveAppInfo
} from "./ecp";

const NS_MEDIA = "urn:x-cast:com.google.cast.media";

const POLL_INTERVAL_MS = 3000;
const POLL_BUSY_TIMEOUT_MS = 3500;

const SUPPORTED_MEDIA_COMMANDS = 1 | 2 | 4 | 8; // PAUSE|SEEK|VOLUME|MUTE

/**
 * Flatten an arbitrary JSON-ish value into `k=v` tokens. Firefox's
 * background console collapses nested objects as `{…}` in the preview
 * line, which hides the duration / customData trail this function is
 * diagnosing. Primitive tokens render inline.
 */
function flattenForDebug(value: unknown, prefix = ""): string[] {
    if (value === undefined) {
        return [prefix ? `${prefix}=undefined` : "undefined"];
    }
    if (value === null) {
        return [prefix ? `${prefix}=null` : "null"];
    }
    const valueType = typeof value;
    if (
        valueType === "string" ||
        valueType === "number" ||
        valueType === "boolean"
    ) {
        return [prefix ? `${prefix}=${value}` : String(value)];
    }
    if (valueType !== "object") {
        const text = String(value);
        return [prefix ? `${prefix}=${text}` : text];
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return [prefix ? `${prefix}=[]` : "[]"];
        }
        return value.flatMap((entry, index) =>
            flattenForDebug(
                entry,
                prefix ? `${prefix}[${index}]` : `[${index}]`
            )
        );
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
        return [prefix ? `${prefix}={}` : "{}"];
    }
    return keys.flatMap(key =>
        flattenForDebug(obj[key], prefix ? `${prefix}.${key}` : key)
    );
}

function flattenDebugLine(value: unknown): string {
    return flattenForDebug(value).join(" ");
}

export type RokuStatusMediaDebug = {
    deviceId: string;
    branch: "session" | "loadedUrl" | "none" | "skippedIdle";
    playerDuration: string;
    isHlsDvr: string;
    durationSource: "session" | "player" | "null" | "n/a";
    duration: string;
    rokuLiveElapsed: string;
    loadedUrl: string;
    loadedTitle: string;
    lastState: string;
    /** Full session MediaInformation, flattened to k=v tokens. */
    sessionMedia: string;
    /** Incoming customData (session path) flattened. */
    customDataIn: string;
    /** Outgoing customData on the returned MediaInformation. */
    customDataOut: string;
    /** Full returned MediaInformation, flattened. */
    result: string;
};

interface RokuRemoteOptions {
    onReceiverStatusUpdate?: (status: ReceiverStatus) => void;
    onMediaStatusUpdate?: (status?: MediaStatus) => void;
    /**
     * Flattened buildStatusMedia snapshot, forwarded by the owner to the
     * extension background log. Only invoked when the snapshot changes.
     */
    onStatusMediaDebug?: (debug: RokuStatusMediaDebug) => void;
}

interface RokuPlaybackState {
    state?: string;
    position?: number;
    duration?: number;
    title?: string;
}

export default class RokuRemote {
    private pollTimer?: NodeJS.Timeout;
    private pollBusy = false;
    private destroyed = false;

    private lastState: RokuPlaybackState = { state: "idle" };
    /** Foreground channel from /query/active-app (undefined = home screen). */
    private lastActiveApp?: ActiveAppInfo;
    private lastActiveAppId?: string;
    /** Set while this remote owns a media item (popup-initiated loads). */
    private loadedTitle?: string;
    private loadedUrl?: string;
    private detachSessionMediaObserver?: () => void;
    /** Last flattened buildStatusMedia snapshot; skip duplicate logs. */
    private lastStatusMediaDebug = "";
    private volume: Volume = {
        level: 1,
        muted: false,
        controlType: VolumeControlType.MASTER
    };

    constructor(
        private device: ReceiverDevice,
        private options: RokuRemoteOptions = {}
    ) {
        this.pollTimer = setInterval(() => {
            void this.pollOnce();
        }, POLL_INTERVAL_MS);
        // Push Roku session media metadata as soon as the emulated session
        // registers it. This avoids a race with the popup opening before the
        // normal ECP polling tick notices the new media.
        this.detachSessionMediaObserver = observeRokuSessionMedia(
            this.device.id,
            media => {
                if (this.destroyed) return;

                // A CCTV Roku LOAD can register the synthetic-DVR media before
                // /query/media-player reports the new channel as playing. If we
                // emit IDLE here, deviceManager immediately removes `media`,
                // leaving ReceiverMedia without the duration/customData needed
                // to render the Roku-specific progress bar. Keep this one
                // startup state as BUFFERING until ECP supplies the real state.
                const isHlsDvr =
                    !!media.customData &&
                    typeof media.customData === "object" &&
                    (media.customData as { hlsDvr?: unknown }).hlsDvr === true;
                if (isHlsDvr && this.lastState.state === "idle") {
                    this.lastState = {
                        ...this.lastState,
                        state: "buffering"
                    };
                }

                this.emitReceiverStatus();
                this.emitMediaStatus();
            }
        );
        // First update right away so the popup has data on open.
        void this.pollOnce();
    }

    disconnect() {
        this.destroyed = true;
        this.detachSessionMediaObserver?.();
        this.detachSessionMediaObserver = undefined;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
    }

    /** Nudges an immediate refresh (used before casting starts). */
    ensureConnected() {
        void this.pollOnce();
    }

    get host() {
        return this.device.host;
    }

    // ------------------------------------------------------------------
    // Message translations (session-less control paths)
    // ------------------------------------------------------------------

    sendReceiverMessage(message: SenderMessage) {
        switch (message.type) {
            case "STOP":
                void keypress(this.host, "Home").catch(err =>
                    console.warn("[fx_cast_bilibili] Roku stop failed", {
                        host: this.host,
                        error: err instanceof Error ? err.message : String(err)
                    })
                );
                break;

            case "SET_VOLUME":
                this.handleSetVolume(message.volume);
                break;

            case "VOLUME_UP":
            case "VOLUME_DOWN": {
                const isUp = message.type === "VOLUME_UP";
                const key = isUp ? "VolumeUp" : "VolumeDown";
                // The rejection MUST be consumed: skipping the optimistic
                // volume update and the status broadcast is the correct
                // outcome, while an unhandled rejection would terminate the
                // whole bridge process (Node 22 throws by default and Firefox
                // only reports an empty disconnect).
                void keypress(this.host, key)
                    .then(() => {
                        this.volume = {
                            level: Math.max(
                                0,
                                Math.min(
                                    1,
                                    (this.volume?.level ?? 1) +
                                        (isUp ? 0.1 : -0.1)
                                )
                            ),
                            // Roku itself unmutes private listening when
                            // VolumeUp is pressed. Mirror that deterministic
                            // key behavior in the optimistic popup state.
                            muted: isUp ? false : this.volume.muted
                        };
                        this.emitReceiverStatus();
                        this.emitMediaStatus();
                    })
                    .catch(err =>
                        console.warn(
                            "[fx_cast_bilibili] Roku volume keypress failed",
                            {
                                host: this.host,
                                key,
                                error:
                                    err instanceof Error
                                        ? err.message
                                        : String(err)
                            }
                        )
                    );
                break;
            }

            case "GET_STATUS":
                this.emitReceiverStatus();
                break;

            default:
                break;
        }
    }

    sendMediaMessage(message: SenderMediaMessage) {
        switch (message.type) {
            case "PLAY":
            case "PAUSE":
                this.handlePlayPause(message.type);
                break;

            case "SEEK":
                void this.handleSeek(message.currentTime ?? 0);
                break;

            case "STOP":
                void keypress(this.host, "Home").catch(err =>
                    console.warn("[fx_cast_bilibili] Roku stop failed", {
                        host: this.host,
                        error: err instanceof Error ? err.message : String(err)
                    })
                );
                break;

            case "GET_STATUS":
            case "MEDIA_GET_STATUS":
                this.emitMediaStatus();
                this.emitReceiverStatus();
                break;

            case "LOAD": {
                // The popup's media UI can start playback without a cast
                // session (sendMediaMessage LOAD). Launch the player channel.
                const url = message.media?.contentId;
                if (!url) break;
                const title =
                    (message.media.metadata as { title?: string } | null)
                        ?.title || "Roku media";
                this.loadedUrl = url;
                this.loadedTitle = title;
                void (async () => {
                    try {
                        const appId = await resolvePlayerAppId(this.host);
                        await launch(
                            this.host,
                            appId,
                            buildLaunchParams(
                                url,
                                title,
                                message.currentTime ?? undefined
                            )
                        );
                    } catch (err) {
                        console.warn(
                            "[fx_cast_bilibili] Roku popup LOAD failed",
                            {
                                host: this.host,
                                error:
                                    err instanceof Error
                                        ? err.message
                                        : String(err)
                            }
                        );
                    }
                })();
                break;
            }

            default:
                break;
        }
    }

    private handlePlayPause(intent: "PLAY" | "PAUSE") {
        // Absolute intent -> ECP key, one-to-one. The previous "state-aware"
        // ternary here was an identity expression (all four branches returned
        // the same literal as `intent`), so it never consulted the observed
        // state despite its comment. Whether the Roku Play key toggles is
        // firmware behaviour this repo has not verified, so the mapping is
        // deliberately kept mechanical and unchanged.
        const key = intent === "PLAY" ? "Play" : "Pause";

        void keypress(this.host, key)
            .then(() => {
                this.lastState = {
                    ...this.lastState,
                    state: intent === "PLAY" ? "play" : "pausing"
                };
                this.emitMediaStatus();
            })
            .catch(err =>
                console.warn("[fx_cast_bilibili] Roku keypress failed", {
                    host: this.host,
                    key,
                    error: err instanceof Error ? err.message : String(err)
                })
            );
    }

    private async handleSeek(position: number) {
        const url = this.loadedUrl;
        try {
            if (url) {
                // Re-launch with mediaPosition (same workaround as sessions).
                const appId = await resolvePlayerAppId(this.host);
                await launch(
                    this.host,
                    appId,
                    buildLaunchParams(url, this.loadedTitle ?? "", position)
                );
                this.lastState = { ...this.lastState, state: "play", position };
                this.emitMediaStatus();
            }
        } catch (err) {
            console.warn("[fx_cast_bilibili] Roku seek failed", {
                host: this.host,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }

    private handleSetVolume(volume: Partial<Volume>) {
        const steps: Promise<void>[] = [];

        if (typeof volume.level === "number") {
            const target = Math.min(1, Math.max(0, volume.level));
            const delta = Math.round((target - (this.volume.level ?? 1)) * 10);
            const key = delta > 0 ? "VolumeUp" : "VolumeDown";
            for (let i = 0; i < Math.min(Math.abs(delta), 10); i++) {
                steps.push(keypress(this.host, key));
            }
            this.volume = { ...this.volume, level: target };
        }

        if (
            typeof volume.muted === "boolean" &&
            volume.muted !== this.volume.muted
        ) {
            if (volume.muted) {
                // ECP only exposes a toggle key for entering mute.
                steps.push(keypress(this.host, "VolumeMute"));
            } else {
                // There is no ECP query for the real mute state and no
                // explicit MuteOff key. VolumeUp deterministically restores
                // private-listening audio on Roku; VolumeDown then compensates
                // for the one-step increase. Keep these ordered.
                steps.push(
                    keypress(this.host, "VolumeUp")
                        // Roku may acknowledge ECP before the audio path applies
                        // the key. A back-to-back VolumeDown can be coalesced or
                        // dropped, so wait one short input interval before the
                        // compensating key.
                        .then(
                            () =>
                                new Promise<void>(resolve =>
                                    setTimeout(resolve, 250)
                                )
                        )
                        .then(() => keypress(this.host, "VolumeDown"))
                );
            }
            this.volume = { ...this.volume, muted: volume.muted };
        }

        void Promise.allSettled(steps).then(() => {
            this.emitReceiverStatus();
            this.emitMediaStatus();
        });
    }

    // ------------------------------------------------------------------
    // Polling + status synthesis
    // ------------------------------------------------------------------

    private async pollOnce() {
        if (this.pollBusy || this.destroyed) return;
        this.pollBusy = true;

        // Guard against an ECP request hanging past the next tick.
        const timeout = setTimeout(() => {
            this.pollBusy = false;
        }, POLL_BUSY_TIMEOUT_MS);

        try {
            const state = await queryMediaPlayer(this.host);

            // The foreground channel decides whether an application is
            // reported at all (/query/media-player only knows about active
            // playback — a player sitting on its home screen reports idle).
            let activeApp: ActiveAppInfo | undefined;
            try {
                const app = await queryActiveApp(this.host);
                if (app.id) activeApp = app;
            } catch {
                // Keep the previous value on transient failures.
                activeApp = this.lastActiveApp;
            }
            if (this.destroyed) return;

            const previous = this.lastState;
            this.lastState = state;
            this.lastActiveApp = activeApp;

            // Media title is only known to us when this remote loaded it;
            // fall back to whatever the player reports.
            if (state.title && !this.loadedTitle)
                this.loadedTitle = state.title;

            const positionMoved =
                previous.position !== undefined &&
                state.position !== undefined &&
                Math.abs(state.position - previous.position) > 2;
            const stateChanged = previous.state !== state.state;
            const appChanged =
                (activeApp?.id ?? undefined) !==
                (this.lastActiveAppId ?? undefined);
            this.lastActiveAppId = activeApp?.id;

            if (stateChanged || positionMoved || appChanged) {
                this.emitReceiverStatus();
                this.emitMediaStatus();
            }
        } catch {
            // Leave lastState as-is; deviceBrowser health-checks decide when
            // the device is gone.
        } finally {
            clearTimeout(timeout);
            this.pollBusy = false;
        }
    }

    private buildApplication(): ReceiverApplication {
        const title = this.loadedTitle;
        // Report the actual foreground channel when known (e.g. the user
        // opened Netflix); fall back to the media player we can control.
        const appId = this.lastActiveApp?.id ?? ROKU_MEDIA_PLAYER_APP_ID;
        const displayName =
            (this.lastActiveApp?.id ? this.lastActiveApp.name : undefined) ??
            "Roku Media Player";
        return {
            appId,
            appType: "WEB",
            displayName,
            iconUrl: "",
            isIdleScreen: false,
            launchedFromCloud: false,
            namespaces: [{ name: NS_MEDIA }],
            sessionId: `roku-${this.device.id}`,
            statusText: title ?? "",
            transportId: `roku-${this.device.id}`,
            universalAppId: appId
        };
    }

    private emitReceiverStatus() {
        if (this.destroyed) return;

        const isPlaying =
            this.lastState.state && this.lastState.state !== "idle";
        // A channel is "running" whenever it is foreground — even before
        // playback starts. Without this the popup can never pair the cast
        // session's transportId with a receiver application, leaving the
        // Stop button hidden and the row stuck in "connecting".
        const hasApp = Boolean(this.lastActiveApp?.id);
        const status: ReceiverStatus = {
            applications: isPlaying || hasApp ? [this.buildApplication()] : [],
            isActiveInput: true,
            isStandBy: !isPlaying,
            volume: this.volume
        };

        this.options.onReceiverStatusUpdate?.(status);
    }

    /**
     * Builds the MediaInformation for the device status. Without this the
     * popup's ReceiverMedia never sees `status.media` (no duration, no
     * customData) and its seek bar stays hidden — a real Chromecast echoes
     * the full media back in MEDIA_STATUS, so this mirrors that for Roku.
     *
     * Sources, best first: the emulated session's loaded media (page-sender
     * casts; carries the hlsDvr customData anchors and the synthetic-DVR
     * pageDuration the popup timeline needs), this remote's own popup
     * LOAD, and finally nothing (device playing foreign content).
     */
    private buildStatusMedia(
        playerDuration: number | undefined
    ): MediaInformation | undefined {
        const sessionMedia = getRokuSessionMedia(this.device.id);
        if (sessionMedia) {
            // Keep the LOAD-provided duration (the synthetic-DVR nominal
            // duration, e.g. 2h) when present: the player-reported duration
            // of a sliding live window (~2min) is NOT the popup timeline.
            const duration =
                sessionMedia.duration != null && sessionMedia.duration > 0
                    ? sessionMedia.duration
                    : playerDuration ?? null;
            const durationSource: RokuStatusMediaDebug["durationSource"] =
                sessionMedia.duration != null && sessionMedia.duration > 0
                    ? "session"
                    : playerDuration != null
                    ? "player"
                    : "null";
            const customData =
                sessionMedia.customData &&
                typeof sessionMedia.customData === "object"
                    ? sessionMedia.customData
                    : {};
            const isHlsDvr =
                (customData as { hlsDvr?: unknown }).hlsDvr === true;
            const result: MediaInformation = {
                ...sessionMedia,
                duration,
                ...(isHlsDvr
                    ? {
                          customData: {
                              ...customData,
                              rokuLiveElapsed: true
                          }
                      }
                    : {})
            };
            this.emitStatusMediaDebug({
                deviceId: this.device.id,
                branch: "session",
                playerDuration:
                    playerDuration == null
                        ? "undefined"
                        : String(playerDuration),
                isHlsDvr: String(isHlsDvr),
                durationSource,
                duration: duration == null ? "null" : String(duration),
                rokuLiveElapsed: isHlsDvr ? "true" : "n/a",
                loadedUrl: this.loadedUrl ?? "undefined",
                loadedTitle: this.loadedTitle ?? "undefined",
                lastState: flattenDebugLine(this.lastState),
                sessionMedia: flattenDebugLine(sessionMedia),
                customDataIn: flattenDebugLine(sessionMedia.customData),
                customDataOut: flattenDebugLine(result.customData),
                result: flattenDebugLine(result)
            });
            return result;
        }
        if (this.loadedUrl) {
            const result: MediaInformation = {
                contentId: this.loadedUrl,
                contentType: "",
                customData: null,
                duration: playerDuration ?? null,
                metadata: {
                    title: this.loadedTitle
                } as MediaInformation["metadata"],
                streamType: "BUFFERED" as MediaInformation["streamType"],
                textTrackStyle: null,
                tracks: null
            };
            this.emitStatusMediaDebug({
                deviceId: this.device.id,
                branch: "loadedUrl",
                playerDuration:
                    playerDuration == null
                        ? "undefined"
                        : String(playerDuration),
                isHlsDvr: "false",
                durationSource: playerDuration != null ? "player" : "null",
                duration:
                    result.duration == null ? "null" : String(result.duration),
                rokuLiveElapsed: "n/a",
                loadedUrl: this.loadedUrl,
                loadedTitle: this.loadedTitle ?? "undefined",
                lastState: flattenDebugLine(this.lastState),
                sessionMedia: "undefined",
                customDataIn: "null",
                customDataOut: "null",
                result: flattenDebugLine(result)
            });
            return result;
        }
        this.emitStatusMediaDebug({
            deviceId: this.device.id,
            branch: "none",
            playerDuration:
                playerDuration == null ? "undefined" : String(playerDuration),
            isHlsDvr: "false",
            durationSource: "n/a",
            duration: "undefined",
            rokuLiveElapsed: "n/a",
            loadedUrl: "undefined",
            loadedTitle: this.loadedTitle ?? "undefined",
            lastState: flattenDebugLine(this.lastState),
            sessionMedia: "undefined",
            customDataIn: "undefined",
            customDataOut: "undefined",
            result: "undefined"
        });
        return undefined;
    }

    /**
     * Push a flattened snapshot to the extension background log. Deduped
     * against the last emission so the 3s ECP poll does not flood the
     * console with identical lines; the first call and every field change
     * always go through.
     */
    private emitStatusMediaDebug(debug: RokuStatusMediaDebug) {
        const key = [
            debug.branch,
            debug.playerDuration,
            debug.isHlsDvr,
            debug.durationSource,
            debug.duration,
            debug.rokuLiveElapsed,
            debug.loadedUrl,
            debug.loadedTitle,
            debug.lastState,
            debug.sessionMedia,
            debug.customDataIn,
            debug.customDataOut,
            debug.result
        ].join("\n");
        if (key === this.lastStatusMediaDebug) return;
        this.lastStatusMediaDebug = key;
        this.options.onStatusMediaDebug?.(debug);
    }

    private emitMediaStatus() {
        if (this.destroyed) return;

        const isPlaying =
            this.lastState.state && this.lastState.state !== "idle";
        if (!isPlaying) {
            // Still emit a flattened snapshot: the seek-bar bug we are
            // diagnosing is often "session media is registered but ECP
            // still says idle, so this function never runs".
            this.emitStatusMediaDebug({
                deviceId: this.device.id,
                branch: "skippedIdle",
                playerDuration:
                    this.lastState.duration == null
                        ? "undefined"
                        : String(this.lastState.duration),
                isHlsDvr: "n/a",
                durationSource: "n/a",
                duration: "undefined",
                rokuLiveElapsed: "n/a",
                loadedUrl: this.loadedUrl ?? "undefined",
                loadedTitle: this.loadedTitle ?? "undefined",
                lastState: flattenDebugLine(this.lastState),
                sessionMedia: flattenDebugLine(
                    getRokuSessionMedia(this.device.id)
                ),
                customDataIn: "n/a",
                customDataOut: "n/a",
                result: "skipped: emitMediaStatus lastState is idle"
            });
            this.options.onMediaStatusUpdate?.(undefined);
            return;
        }

        const status: MediaStatus = {
            mediaSessionId: 1,
            media: this.buildStatusMedia(this.lastState.duration),
            playbackRate: 1,
            playerState:
                this.lastState.state === "pausing" ||
                this.lastState.state === "paused" ||
                this.lastState.state === "pause"
                    ? PlayerState.PAUSED
                    : this.lastState.state === "buffering" ||
                      this.lastState.state === "buffer"
                    ? PlayerState.BUFFERING
                    : PlayerState.PLAYING,
            currentTime: this.lastState.position ?? 0,
            supportedMediaCommands: SUPPORTED_MEDIA_COMMANDS,
            repeatMode: RepeatMode.OFF,
            volume: this.volume,
            customData: null
        };

        this.options.onMediaStatusUpdate?.(status);
    }
}
