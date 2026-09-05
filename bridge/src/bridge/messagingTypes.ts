import type {
    Image,
    ReceiverStatus,
    SenderApplication,
    Volume
} from "./components/cast/types";

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
    /**
     * Receiver protocol family. "cast" (Chromecast) when absent for
     * backwards compatibility with older bridges/extensions; "roku" devices
     * speak ECP (HTTP port 8060) and are emulated as cast sessions by the
     * bridge's Roku components.
     */
    deviceType?: "cast" | "roku";
}

export interface CastSessionUpdatedDetails {
    sessionId: string;
    statusText: string;
    namespaces: Array<{ name: string }>;
    volume: Volume;
}
export interface CastSessionCreatedDetails extends CastSessionUpdatedDetails {
    appId: string;
    appImages: Image[];
    displayName: string;
    receiverId: string;
    receiverFriendlyName: string;
    senderApps: SenderApplication[];
    transportId: string;
}
