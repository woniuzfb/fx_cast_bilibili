import type { SessionRequest } from "./cast/sdk/classes";
import type { MediaStatus, ReceiverStatus } from "./cast/sdk/types";
import type { ReceiverPlaybackView } from "../../shared/playbackCommand";

export enum ReceiverDeviceCapabilities {
    NONE = 0,
    VIDEO_OUT = 1,
    VIDEO_IN = 2,
    AUDIO_OUT = 4,
    AUDIO_IN = 8,
    MULTIZONE_GROUP = 32
}

export interface ReceiverDevice {
    id: string;
    friendlyName: string;
    modelName: string;
    capabilities: ReceiverDeviceCapabilities;
    host: string;
    port: number;
    status?: ReceiverStatus;
    mediaStatus?: MediaStatus;
    /**
     * Receiver protocol family. "cast" (Chromecast) when absent (older
     * bridges never sent it); "roku" devices are emulated as cast sessions
     * by the bridge over the ECP protocol, but do not support screen
     * mirroring.
     */
    deviceType?: "cast" | "roku";
    /**
     * Play/pause command view, kept as a SIBLING of mediaStatus rather than
     * folded into it: `mediaStatus.playerState` is an observation that the
     * timeline, the buffering shimmer and the seek-settling logic all read, so
     * the user's outstanding intent must never overwrite it. While
     * `lifecycle === "active"`, `intent` is what the popup's play/pause
     * affordance reflects.
     */
    playbackCommand?: ReceiverPlaybackView;
}

export enum ReceiverSelectorMediaType {
    None = 0,
    App = 1,
    Tab = 2,
    Screen = 4
}

export interface ReceiverSelectorAppInfo {
    sessionRequest: SessionRequest;
    isRequestAppAudioCompatible?: boolean;
}

/** Info about sender page context. */
export interface ReceiverSelectorPageInfo {
    url: string;
    tabId: number;
    frameId: number;
}
