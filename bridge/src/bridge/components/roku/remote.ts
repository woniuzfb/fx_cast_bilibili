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

import type {
    RokuMediaStatusProvenance,
    RokuMediaStatusSource
} from "../../../../../shared/rokuMediaStatusProvenance";

const NS_MEDIA = "urn:x-cast:com.google.cast.media";

const POLL_INTERVAL_MS = 3000;
/**
 * How long (ms) the HLS DVR startup synthesis may outlive an idle ECP report.
 *
 * Same order as the receiver-side confirmation window (10s), and for the same
 * reason: that is how long this bridge is willing to wait for a Roku to reach
 * the state it was asked for before it believes the observation instead. A DVR
 * channel that has not started by then is not starting, and a synthesised
 * BUFFERING must not stand in for it any longer.
 */
const STARTUP_OVERLAY_MAX_MS = 10_000;

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

/**
 * A media status broadcast, or the local "nothing to report" notification.
 *
 * A discriminated union rather than an optional second argument: when a status
 * is present its provenance is REQUIRED, so a new emit site cannot be added
 * without classifying itself. The `status: undefined` arm never crosses the
 * bridge (the owner returns early on it); it exists because the idle branch
 * must still wake the owner's debug path.
 */
export type RokuMediaStatusEmission =
    | {
          status: MediaStatus;
          provenance: RokuMediaStatusProvenance;
      }
    | {
          status: undefined;
      };

interface RokuRemoteOptions {
    /**
     * LOAD generation to attribute samples to from the very first poll. Needed
     * because the constructor starts polling immediately, so a generation set
     * after construction is already too late for that first sample.
     */
    initialLoadGeneration?: number;
    onReceiverStatusUpdate?: (status: ReceiverStatus) => void;
    onMediaStatusUpdate?: (emission: RokuMediaStatusEmission) => void;
    /**
     * Every completed ECP poll sample, with its provenance.
     *
     * Separate from onMediaStatusUpdate because that one suppresses the idle
     * state ("nothing to report"), while confirmation needs to see an idle
     * sample as an observation - "the device is idle" and "we could not observe
     * the device" are different verdicts.
     */
    onPlaybackObservation?: (
        loadGeneration: number | undefined,
        status: MediaStatus,
        provenance: RokuMediaStatusProvenance
    ) => void;
    /**
     * Flattened buildStatusMedia snapshot, forwarded by the owner to the
     * extension background log. Only invoked when the snapshot changes.
     */
    onStatusMediaDebug?: (debug: RokuStatusMediaDebug) => void;
}

/**
 * A locally-decided state fragment awaiting observation. `revision` preserves
 * the order the fragments were written: two overlays can touch the same field
 * (a seek echo's position and a command echo's state), and static precedence
 * would hide that ordering.
 */
interface StateOverlay {
    revision: number;
    state?: RokuPlaybackState["state"];
    position?: number;
}

interface RokuPlaybackState {
    state?: string;
    position?: number;
    duration?: number;
    title?: string;
}

export default class RokuRemote {
    private pollTimer?: NodeJS.Timeout;
    /**
     * The in-flight poll sample, if any. Single-flight: a periodic tick, a
     * one-shot nudge and a command-triggered confirmation poll all share this
     * one promise instead of overlapping (two overlapping samples could
     * complete out of order and let an older one win).
     */
    private pollInFlight?: Promise<void>;
    /**
     * Which confirmation sequence currently owns the dense sampling.
     *
     * This is a BRIDGE-local playback-transport generation, not the extension's
     * command lifecycle: the bridge has no commandId (the device route is a
     * fire-and-forget control message), so it cannot know when the extension
     * considers a command confirmed, superseded or stopped. Every new
     * play/pause transport and every disconnect bumps this, which is enough to
     * stop a stale sequence from consuming ECP samples.
     */
    private playbackPollToken = 0;
    /**
     * The extension's current LOAD generation for this device, pushed over
     * bridge:rokuSetLoadGeneration or supplied at construction. The bridge cannot derive it (Roku's
     * mediaSessionId is a constant 1, and a contentId can be loaded twice), so
     * a sample without one is reported without it rather than guessed at.
     */
    private loadGeneration?: number;
    private destroyed = false;

    /**
     * The device as last OBSERVED by a completed ECP poll. Every confirmation
     * observation is built from a poll's own result, never from this cache or
     * from an overlay, so a locally-written echo can never be mistaken for a
     * device observation.
     */
    private observedState: RokuPlaybackState = { state: "idle" };
    /**
     * Locally-written state that the UI should reflect before the device has
     * been observed in it: the PLAY/PAUSE echo (so the popup does not wait for
     * a poll), the seek echo, and the HLS DVR startup synthesis.
     *
     * These used to be written into one shared `lastState`, which is what made
     * "observed" and "what we just wrote" indistinguishable. They are composed
     * on read, in the order they were written (see effectiveState), so the
     * previous last-writer-wins behaviour is preserved exactly.
     */
    private startupOverlay?: StateOverlay;
    private commandOverlay?: StateOverlay;
    private seekOverlay?: StateOverlay;
    /** Orders the overlays so composition matches the old write order. */
    private overlayRevision = 0;
    /**
     * When the startup synthesis stops being justified, as an absolute time.
     *
     * The synthesis exists because ECP can keep reporting idle while an HLS DVR
     * channel is still coming up, so it deliberately outlives idle samples -
     * which means something else has to bound it. This is that bound: past it,
     * an idle report is the truth and the synthesis is dropped.
     */
    private startupOverlayExpiresAt: number | undefined;
    /**
     * Monotonic counter for ECP poll samples. Together with pollStartedAt it
     * is what lets a consumer tell an observation that STARTED after a command
     * from one that merely arrived after it.
     */
    private pollSequence = 0;
    /** Whether a completed poll has been reported from this remote yet. */
    private reportedFirstSample = false;
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
            void this.poll();
        }, POLL_INTERVAL_MS);
        // Push Roku session media metadata as soon as the emulated session
        // registers it. This avoids a race with the popup opening before the
        // normal ECP polling tick notices the new media.
        this.detachSessionMediaObserver = observeRokuSessionMedia(
            this.device.id,
            media => {
                if (this.destroyed) return;

                if (!media) {
                    // The session's media is gone. Anything synthesised from it
                    // - the startup overlay in particular - is no longer
                    // justified, so it is dropped before the status is
                    // rebuilt. The status itself stays whatever the
                    // observation says; no IDLE is fabricated here.
                    this.clearStartupOverlay();
                    this.emitReceiverStatus();
                    this.emitMediaStatus({ source: "session-media-refresh" });
                    return;
                }
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
                // Two different facts share this call site: synthesizing
                // buffering for a starting HLS DVR session, or merely
                // rebroadcasting the cached state because session media
                // changed. Neither performs an ECP query, so neither may be
                // used to confirm receiver state.
                let source: RokuMediaStatusSource = "session-media-refresh";
                // The synthesis applies while the effective state is idle, and
                // it deliberately OUTLIVES idle observations: ECP reporting
                // idle while a DVR channel comes up is the case it exists for,
                // so dropping it on the next idle poll would make it useless.
                // Every way it can end is listed on acceptObservedState; this
                // site writes one, arms the time bound, or clears one.
                // The test is on the OBSERVATION, not on the composed state:
                // once a synthesis is up the composed state reads "buffering",
                // so testing it here would drop the very overlay that a
                // re-registration is meant to refresh.
                if (isHlsDvr && this.observedState.state === "idle") {
                    this.writeOverlay("startup", { state: "buffering" });
                    this.startupOverlayExpiresAt =
                        Date.now() + STARTUP_OVERLAY_MAX_MS;
                    source = "startup-synthetic";
                } else {
                    // The callback owns the synthesis: it either writes one or
                    // clears one. Otherwise a synthesis justified by a previous
                    // HLS DVR media would keep standing after that media was
                    // replaced by something that does not need it (rule 2, the
                    // "replaced" half; the "cleared" half is the null branch).
                    this.clearStartupOverlay();
                }

                this.emitReceiverStatus();
                this.emitMediaStatus({ source });
            }
        );
        // Applied BEFORE the first poll: the constructor kicks that poll off
        // itself, and a sample snapshots the generation when it starts, so
        // setting it afterwards would leave exactly one sample unattributed -
        // and an unattributed sample is accepted by the coordinator by design.
        if (options.initialLoadGeneration !== undefined) {
            this.setLoadGeneration(options.initialLoadGeneration);
        }
        // First update right away so the popup has data on open.
        void this.poll();
    }

    disconnect() {
        this.destroyed = true;
        // Cancels any in-flight confirmation sequence.
        this.playbackPollToken++;
        this.detachSessionMediaObserver?.();
        this.detachSessionMediaObserver = undefined;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
    }

    /** Nudges an immediate refresh (used before casting starts). */
    ensureConnected() {
        void this.poll();
    }

    /** Records the extension's current LOAD generation for this device. */
    setLoadGeneration(loadGeneration: number) {
        // Validation comes FIRST, before any state is written. Putting the
        // overlay clearing above it (as this used to) let a NaN/0/negative
        // generation - which is then rejected - drop the startup synthesis on
        // its way out: an invalid value must have no effect at all, not a
        // partial one.
        //
        // The producer is a monotonic counter that starts at 1; anything else
        // has crossed a process boundary and is not trusted.
        if (!Number.isSafeInteger(loadGeneration) || loadGeneration <= 0) {
            return;
        }
        // Monotonic for the same reason, and it is the rule the rest of the
        // chain relies on: a late message from an older load must not roll this
        // back (a replay of the current one is fine and changes nothing).
        if (
            this.loadGeneration !== undefined &&
            loadGeneration < this.loadGeneration
        ) {
            return;
        }
        // Rule 1: a different LOAD supersedes whatever was synthesised for the
        // previous one. Only an actual change - the constructor applies the
        // cached generation once, and that must not drop a synthesis the
        // observer's replay just wrote.
        if (
            this.loadGeneration !== undefined &&
            this.loadGeneration !== loadGeneration
        ) {
            this.clearStartupOverlay();
        }
        this.loadGeneration = loadGeneration;
    }

    /**
     * Starts a short, dense sampling window for a play/pause transport that was
     * just submitted to this device - the extension asks for it after either
     * route completed (the bridge-side keypress, or a page-owned Cast call whose
     * session response the extension sees).
     *
     * Called AFTER the transport completes on purpose: the extension's
     * receiverDispatchStartedAt marks when it began submitting, not when the
     * device acted, so sampling before the keypress lands could read a
     * pre-command state whose pollStartedAt still passes the strict gate.
     *
     * The samples it produces are ordinary observations: they still have to pass
     * the extension's ecp-poll whitelist and the strict poll-start gate.
     */
    requestPlaybackConfirmationPoll() {
        const token = ++this.playbackPollToken;
        void this.runPlaybackConfirmationPolls(token);
    }

    /** Dense window: immediately, then the gaps between successive samples. */
    private static readonly FAST_POLL_DELAYS_MS = [0, 150, 350, 750, 1500];

    private async runPlaybackConfirmationPolls(token: number) {
        for (const delay of RokuRemote.FAST_POLL_DELAYS_MS) {
            if (this.destroyed || token !== this.playbackPollToken) return;
            if (delay > 0) {
                await new Promise<void>(resolve => setTimeout(resolve, delay));
            }
            if (this.destroyed || token !== this.playbackPollToken) return;
            // Reusing an in-flight sample does NOT mean this command has been
            // observed: it may have started before the transport landed. The
            // loop therefore always continues to the next round rather than
            // treating a resolved await as confirmation.
            await this.poll();
            if (this.destroyed || token !== this.playbackPollToken) return;
        }
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
                // Rule 3: the user ended playback, so a synthesised BUFFERING
                // is no longer justified and must not survive the stop. Nothing
                // is emitted here - the idle clear still comes from the next
                // observation, as before.
                this.clearStartupOverlay();
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
                        this.emitMediaStatus({ source: "volume-key-echo" });
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
                // Rule 3, the session-less path (see sendReceiverMessage).
                this.clearStartupOverlay();
                void keypress(this.host, "Home").catch(err =>
                    console.warn("[fx_cast_bilibili] Roku stop failed", {
                        host: this.host,
                        error: err instanceof Error ? err.message : String(err)
                    })
                );
                break;

            case "GET_STATUS":
            case "MEDIA_GET_STATUS":
                this.emitMediaStatus({ source: "status-probe" });
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

        // A new play/pause transport also cancels any dense window the previous
        // one opened (latest wins at the bridge's own granularity).
        this.playbackPollToken++;
        void keypress(this.host, key)
            .then(() => {
                this.writeOverlay("command", {
                    state: intent === "PLAY" ? "play" : "pausing"
                });
                this.emitMediaStatus({ source: "command-echo" });
                // The transport has landed: this is the moment from which a
                // sample can observe the command's effect. Started only on
                // success, so a failed keypress does not consume ECP samples.
                this.requestPlaybackConfirmationPoll();
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
                this.writeOverlay("seek", { state: "play", position });
                this.emitMediaStatus({ source: "seek-echo" });
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
            this.emitMediaStatus({ source: "volume-key-echo" });
        });
    }

    // ------------------------------------------------------------------
    // Polling + status synthesis
    // ------------------------------------------------------------------

    /**
     * Single-flight entry point for every poll request: the interval tick, the
     * pre-cast nudge and the confirmation window all come through here, so at
     * most one sample is ever in flight. A second request while a sample is
     * running simply joins it.
     */
    private poll(): Promise<void> {
        if (this.pollInFlight) return this.pollInFlight;

        const tracked = this.pollSample()
            .catch(err => {
                // A sample must never reject into the void: it is fired from a
                // timer, a nudge and a confirmation loop, none of which await
                // it in a position to handle a failure.
                console.warn(
                    "[fx_cast_bilibili] Roku poll sample failed",
                    err instanceof Error ? err.message : String(err)
                );
            })
            .finally(() => {
                // Identity check: a sample must never clear a promise that a later
                // request has already installed.
                if (this.pollInFlight === tracked)
                    this.pollInFlight = undefined;
            });
        this.pollInFlight = tracked;
        return tracked;
    }

    /**
     * One complete sample: both ECP reads, the cache update and the emissions.
     * Nothing may be split out of this function, or a periodic tick and a
     * confirmation poll could interleave between the media-player read and the
     * active-app read and leave the cache holding a mix of two sample moments.
     */
    private async pollSample(): Promise<void> {
        if (this.destroyed) return;

        const pollStartedAt = Date.now();
        // Snapshotted BEFORE the ECP reads: a sample that starts under one LOAD
        // and completes after the next one begins must stay attributed to the
        // load it observed, not to whatever is current when it finishes.
        const loadGeneration = this.loadGeneration;
        const rawState = await queryMediaPlayer(this.host);

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

        // Some Roku firmware keeps /query/media-player at its last non-idle
        // state after playback has ended: a "play" that carries no position,
        // duration or title while the home screen is foreground (no channel
        // id) is that residue, not playback. Re-read it as idle so neither
        // the popup nor the media trace keeps showing a phantom playing
        // device. Real playback is never caught by this: our own casts and
        // foreign channels are both foreground (an active-app id), and a
        // foreground channel that reports no metadata still has one.
        const stalePlayingReport =
            rawState.state !== "idle" &&
            !activeApp?.id &&
            rawState.position === undefined &&
            rawState.duration === undefined &&
            rawState.title === undefined;
        const state = stalePlayingReport
            ? { ...rawState, state: "idle" }
            : rawState;

        // Change detection compares the composed state BEFORE the update with
        // the composed state AFTER it - i.e. what the consumer was last shown
        // against what it will be shown now - rather than the composed state
        // against the raw sample.
        //
        // The two agree in every case where no overlay survives the update, so
        // this is the old `previous = lastState; lastState = state` comparison.
        // They differ exactly when the startup synthesis survives an idle
        // sample: comparing against the raw idle sample would call that a
        // change on every poll and re-broadcast an identical receiver status
        // every 3s until the synthesis expired.
        const previous = this.effectiveState();
        this.acceptObservedState(state);
        const current = this.effectiveState();
        this.lastActiveApp = activeApp;

        // Media title is provided by sessionMedia (from the cast sender).
        // Roku devices lack CJK fonts, so the title sent to Roku via ECP is
        // deliberately omitted. Fall back to player-reported title only if
        // non-blank and not an index / placeholder filename.
        if (state.title && !this.loadedTitle) {
            const clean = state.title.trim();
            if (
                clean &&
                !/^index\.(m3u8|mpd)$/i.test(clean) &&
                clean !== "Unknown Video"
            ) {
                this.loadedTitle = clean;
            }
        }

        const positionMoved =
            previous.position !== undefined &&
            current.position !== undefined &&
            Math.abs(current.position - previous.position) > 2;
        const stateChanged = previous.state !== current.state;
        const appChanged =
            (activeApp?.id ?? undefined) !==
            (this.lastActiveAppId ?? undefined);
        this.lastActiveAppId = activeApp?.id;

        // The first COMPLETED sample always reports the receiver status,
        // even when nothing changed from this fresh remote's initial
        // idle/no-app view: a bridge restart must be able to retire a stale
        // media status the extension still holds from before the restart
        // (a receiver status with no applications is what makes
        // deviceManager drop it).
        const isFirstCompletedSample = !this.reportedFirstSample;
        this.reportedFirstSample = true;

        if (
            stateChanged ||
            positionMoved ||
            appChanged ||
            isFirstCompletedSample
        ) {
            this.emitReceiverStatus();
        }
        // Every completed poll is a sample, and must be published as one
        // regardless of whether it differs from the cached state: an
        // observation is "a fresh /query/media-player result", not "a
        // change". Throttling this to deltas silently starves command
        // confirmation of the exact case it needs — after a PLAY/PAUSE
        // keypress the cached state already holds the requested one, so a
        // poll that agrees with the device can look like "no change" and
        // never be published, leaving the command unconfirmed.
        //
        // (Receiver status, which drives the popup, stays throttled.)
        const pollProvenance: RokuMediaStatusProvenance = {
            source: "ecp-poll",
            pollStartedAt,
            pollCompletedAt: Date.now(),
            sequence: ++this.pollSequence
        };
        this.emitMediaStatus(pollProvenance);
        // Also report the raw sample, so an idle poll is still an
        // observation rather than silence (emitMediaStatus suppresses idle
        // as "nothing to report").
        this.options.onPlaybackObservation?.(
            loadGeneration,
            {
                mediaSessionId: 1,
                playbackRate: 1,
                playerState: this.observedPlayerState(state.state),
                currentTime: state.position ?? 0,
                supportedMediaCommands: SUPPORTED_MEDIA_COMMANDS,
                repeatMode: RepeatMode.OFF,
                volume: this.volume,
                customData: null
            },
            pollProvenance
        );
        // NOTE: deliberately no catch here. Only the ACTIVE-APP read above is
        // tolerated locally (its absence is not evidence that the device is
        // gone, so the previous value is kept). Everything else - notably the
        // media-player read - must propagate to poll(), which is the single
        // place that logs a failed sample. Swallowing it here would make that
        // log unreachable while leaving lastState untouched either way.
    }

    private resolveMediaTitle(): string {
        const sessionMedia = getRokuSessionMedia(this.device.id);
        const sessionTitle = sessionMedia?.metadata?.title?.trim();
        if (sessionTitle) {
            return sessionTitle;
        }
        if (this.loadedTitle && this.loadedTitle.trim()) {
            const clean = this.loadedTitle.trim();
            if (
                !/^index\.(m3u8|mpd)$/i.test(clean) &&
                clean !== "Unknown Video"
            ) {
                return clean;
            }
        }
        return "";
    }

    private buildApplication(): ReceiverApplication {
        const title = this.resolveMediaTitle();
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
            statusText: title || displayName,
            transportId: `roku-${this.device.id}`,
            universalAppId: appId
        };
    }

    private emitReceiverStatus() {
        if (this.destroyed) return;

        const composed = this.effectiveState();
        const isPlaying = composed.state && composed.state !== "idle";
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
                loadedTitle: this.resolveMediaTitle() || "undefined",
                lastState: flattenDebugLine(this.effectiveState()),
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
                    title: this.resolveMediaTitle()
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
                loadedTitle: this.resolveMediaTitle() || "undefined",
                lastState: flattenDebugLine(this.effectiveState()),
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
            loadedTitle: this.resolveMediaTitle() || "undefined",
            lastState: flattenDebugLine(this.effectiveState()),
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

    /**
     * Notifies the owner that there is nothing to report, e.g. ECP says idle.
     * Separate from emitMediaStatus so that every real broadcast is forced to
     * declare where its state came from.
     */
    private emitMediaStatusCleared() {
        if (this.destroyed) return;
        this.options.onMediaStatusUpdate?.({ status: undefined });
    }

    /**
     * Maps a raw ECP playback state onto the extension's player state.
     *
     * Unlike buildMediaStatus, an unknown/idle state stays IDLE instead of
     * falling back to PLAYING: an observation has to be able to say "the device
     * is idle", or "observed idle" and "no observation at all" become the same
     * verdict.
     */
    private observedPlayerState(state: string | undefined): PlayerState {
        switch (state) {
            case "pausing":
            case "paused":
            case "pause":
                return PlayerState.PAUSED;
            case "buffering":
            case "buffer":
                return PlayerState.BUFFERING;
            case "play":
            case "playing":
                return PlayerState.PLAYING;
            default:
                return PlayerState.IDLE;
        }
    }

    /**
     * What the UI should show: the last observation with the locally-written
     * fragments applied in write order.
     *
     * The media-status gate reads THIS, not observedState: during an HLS DVR
     * startup the observation is still idle while the startup overlay says
     * buffering, and gating on the observation would emit the idle clear that
     * makes deviceManager drop `media` (losing the progress bar) - the exact
     * regression that synthesis exists to prevent.
     */
    private effectiveState(): RokuPlaybackState {
        const overlays = [
            this.startupOverlay,
            this.commandOverlay,
            this.seekOverlay
        ]
            .filter((overlay): overlay is StateOverlay => overlay !== undefined)
            .sort((a, b) => a.revision - b.revision);

        return overlays.reduce<RokuPlaybackState>(
            (state, overlay) => ({
                ...state,
                ...(overlay.state !== undefined
                    ? { state: overlay.state }
                    : {}),
                ...(overlay.position !== undefined
                    ? { position: overlay.position }
                    : {})
            }),
            this.observedState
        );
    }

    private writeOverlay(
        which: "startup" | "command" | "seek",
        overlay: Omit<StateOverlay, "revision">
    ) {
        const written: StateOverlay = {
            ...overlay,
            revision: ++this.overlayRevision
        };
        if (which === "startup") this.startupOverlay = written;
        else if (which === "command") this.commandOverlay = written;
        else this.seekOverlay = written;
    }

    /**
     * Folds in a completed poll. The command and seek echoes expire here
     * unconditionally, because the old code did exactly that: `this.lastState =
     * state` replaced the whole cache, so an echo survived only until the next
     * successful poll, idle or not. Deliberately not conditional on the
     * observation matching an echo's target: that would be a stricter rule than
     * the old code had, and it would keep an echo alive indefinitely whenever
     * the device never reached the requested state.
     *
     * The startup synthesis is the ONE deliberate exception. ECP reporting idle
     * while an HLS DVR channel is still coming up is precisely the case it
     * exists for, so an idle sample does not end it. Its invalidation rules are
     * therefore explicit, and complete:
     *
     *   1. the LOAD generation changes (a new load supersedes the synthesis);
     *   2. the session media is cleared (observer called with undefined);
     *   3. a STOP is submitted from the popup;
     *   4. a successful poll reports a NON-idle state (the device answered);
     *   5. STARTUP_OVERLAY_MAX_MS elapses (bounded, so a DVR that never starts
     *      cannot leave a synthesised BUFFERING standing). Evaluated HERE, when
     *      a poll is folded in, because that is what publishes the transition:
     *      dropping the overlay without comparing it against what the consumer
     *      was last shown would leave the last broadcast claiming a playing
     *      device. The cost is that a non-poll emission inside the one poll
     *      interval after the bound can still report the synthesis; the next
     *      completed poll ends it. (If no poll ever completes again, the
     *      overlay lingers exactly as an unconsumed echo does today - the poll
     *      loop is what retires local state, and that is unchanged.)
     *   6. the remote is disconnected (destroyed; nothing is emitted after).
     *
     * The write site in the observer points back here; the list lives in one
     * place on purpose, so it cannot drift.
     */
    private acceptObservedState(state: RokuPlaybackState) {
        this.observedState = state;
        this.commandOverlay = undefined;
        this.seekOverlay = undefined;
        // Only an idle sample inside the window keeps the synthesis alive.
        if (state.state !== "idle" || !this.startupSynthesisActive()) {
            this.clearStartupOverlay();
        }
    }

    /**
     * Whether a synthesised startup BUFFERING is currently standing in for an
     * idle observation, i.e. whether the reported state is synthetic rather
     * than observed. Invalidation asks this.
     */
    private startupSynthesisActive(): boolean {
        return (
            this.startupOverlay !== undefined &&
            this.startupOverlayExpiresAt !== undefined &&
            Date.now() < this.startupOverlayExpiresAt
        );
    }

    /**
     * Whether the state a consumer would be shown RIGHT NOW is the synthesis.
     *
     * True only while the synthesis is active and no later overlay has set a
     * state since: a PLAY/PAUSE echo written after it wins the composition, and
     * then the reported state is the echo's, not the synthesis's.
     */
    private startupSynthesisIsReportedState(): boolean {
        const startup = this.startupOverlay;
        if (!this.startupSynthesisActive() || !startup) return false;
        return ![this.commandOverlay, this.seekOverlay].some(
            overlay =>
                overlay !== undefined &&
                overlay.state !== undefined &&
                overlay.revision > startup.revision
        );
    }

    private clearStartupOverlay() {
        this.startupOverlay = undefined;
        this.startupOverlayExpiresAt = undefined;
    }

    private emitMediaStatus(provenance: RokuMediaStatusProvenance) {
        if (this.destroyed) return;

        const composed = this.effectiveState();
        const isPlaying = composed.state && composed.state !== "idle";
        if (!isPlaying) {
            // Still emit a flattened snapshot: the seek-bar bug we are
            // diagnosing is often "session media is registered but ECP
            // still says idle, so this function never runs".
            this.emitStatusMediaDebug({
                deviceId: this.device.id,
                branch: "skippedIdle",
                playerDuration:
                    this.observedState.duration == null
                        ? "undefined"
                        : String(this.observedState.duration),
                isHlsDvr: "n/a",
                durationSource: "n/a",
                duration: "undefined",
                rokuLiveElapsed: "n/a",
                loadedUrl: this.loadedUrl ?? "undefined",
                loadedTitle: this.loadedTitle ?? "undefined",
                lastState: flattenDebugLine(this.effectiveState()),
                sessionMedia: flattenDebugLine(
                    getRokuSessionMedia(this.device.id)
                ),
                customDataIn: "n/a",
                customDataOut: "n/a",
                result: "skipped: emitMediaStatus lastState is idle"
            });
            this.emitMediaStatusCleared();
            return;
        }

        // `ecp-poll` claims a fresh /query/media-player sample PRODUCED this
        // state. While the startup synthesis is what makes it non-idle, that
        // claim is false: the sample reported the opposite and the synthesis
        // replaced it. Such an emission is relabelled - and, because a
        // synthetic source cannot carry poll timings, drops them.
        //
        // Deliberately narrow: only this one arm makes a state claim, and only
        // when the synthesis is the state actually being reported (an echo
        // written after it wins the composition and keeps its own label). The
        // other sources describe why the emission happened, which stays true.
        // The raw sample is still published as an ecp-poll OBSERVATION by
        // pollSample, with its timings and its idle state, untouched.
        const overrodeProvenance =
            provenance.source === "ecp-poll" &&
            this.startupSynthesisIsReportedState();
        this.options.onMediaStatusUpdate?.({
            status: this.buildMediaStatus(composed),
            provenance: overrodeProvenance
                ? { source: "startup-synthetic" }
                : provenance
        });
    }

    /**
     * Synthesizes the media status for the current cached state.
     *
     * Note the fallback: any unrecognized state (including idle) maps to
     * PLAYING. Callers that need the device's real state must therefore not
     * rely on this mapping alone - the idle case never reaches here through
     * emitMediaStatus, which is why the poll path reports its raw sample
     * through onPlaybackObservation as well.
     */
    private buildMediaStatus(composed: RokuPlaybackState): MediaStatus {
        return {
            mediaSessionId: 1,
            media: this.buildStatusMedia(this.observedState.duration),
            playbackRate: 1,
            playerState:
                composed.state === "pausing" ||
                composed.state === "paused" ||
                composed.state === "pause"
                    ? PlayerState.PAUSED
                    : composed.state === "buffering" ||
                      composed.state === "buffer"
                    ? PlayerState.BUFFERING
                    : PlayerState.PLAYING,
            currentTime: composed.position ?? 0,
            supportedMediaCommands: SUPPORTED_MEDIA_COMMANDS,
            repeatMode: RepeatMode.OFF,
            volume: this.volume,
            customData: null
        };
    }
}
