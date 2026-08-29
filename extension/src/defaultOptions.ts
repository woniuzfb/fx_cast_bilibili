import type { WhitelistItemData } from "./background/whitelist";

export interface Options {
    /** Native messaging host name. */
    bridgeApplicationName: string;

    /** Attempt to connect to daemon if native messaging fails. */
    bridgeBackupEnabled: boolean;
    /** Daemon WebSocket server host. */
    bridgeBackupHost: string;
    /** Daemon WebSocket server port. */
    bridgeBackupPort: number;
    /** Whether daemon WebSocket server uses HTTPS. */
    bridgeBackupSecure: boolean;
    /** Daemon password. */
    bridgeBackupPassword: string;

    /** HTML5 media/image casting. */
    mediaEnabled: boolean;
    /** Sync media element state with remote media. */
    mediaSyncElement: boolean;
    /** Stop media cast session if page is closed. */
    mediaStopOnUnload: boolean;
    /** Casting for media on local filesystem. */
    localMediaEnabled: boolean;
    /** HTTP server port for local media. */
    localMediaServerPort: number;

    /** Screen mirroring casting. */
    mirroringEnabled: boolean;
    /** Chromecast receiver app ID for mirroring. */
    mirroringAppId: string;
    /** Max frame rate for mirroring WebRTC media stream. */
    mirroringStreamMaxFrameRate: number;
    /** Max bitrate for mirroring WebRTC media stream. */
    mirroringStreamMaxBitRate: number;
    /**
     * Base `scaleResolutionDownBy` parameter for mirroring WebRTC media
     * stream.
     */
    mirroringStreamDownscaleFactor: number;
    /** Max width/height to use for calculating final
     * `scaleResolutionDownBy` parameter for mirroring WebRTC media
     * stream.
     */
    mirroringStreamMaxResolution: { width?: number; height?: number };
    /** Whether to apply max resolution limits to mirroring WebRTC media
     * stream.
     */
    mirroringStreamUseMaxResolution: boolean;

    /**
     * Close receiver selector popup if another browser window is
     * focused.
     */
    receiverSelectorCloseIfFocusLost: boolean;
    /** Close receiver selector after a session is established. */
    receiverSelectorWaitForConnection: boolean;
    /** Auto-expand active sessions managed by the extension. */
    receiverSelectorExpandActive: boolean;
    /** Show media images in receiver selector. */
    receiverSelectorShowMediaImages: boolean;

    /** User agent replacement whitelist enabled. */
    siteWhitelistEnabled: boolean;
    /** User agent replacement whitelist items data. */
    siteWhitelist: WhitelistItemData[];
    /** Custom user agent string for whitelist. */
    siteWhitelistCustomUserAgent: string;

    /** Internal version for custom Bilibili default migrations. */
    bilibiliDefaultsVersion: number;
    /** Show Bilibili debug overlay and verbose traces. */
    bilibiliDebugEnabled: boolean;
    /** Show verbose CCTV relay diagnostics. */
    cctvDebugEnabled: boolean;
    /** Enable Voice Edge BLE remote event consumption. */
    bleRemoteEnabled: boolean;
    /** Voice Edge BLE remote newline-delimited JSON event stream URL. */
    bleRemoteUrl: string;
    /** Seconds to seek for the BLE remote left button. */
    bleRemoteSeekBackwardSeconds: number;
    /** Seconds to seek for the BLE remote right button. */
    bleRemoteSeekForwardSeconds: number;

    /**
     * Half-dead watchdog timeout (ms) for a device's platform status
     * connection in the bridge (remote.ts). No PONG within this window ->
     * the connection is rebuilt. Higher = more tolerant of load spikes but
     * slower to recover; lower = faster recovery but risks false positives.
     */
    castRemoteHeartbeatStaleMs: number;
    /**
     * Half-dead watchdog timeout (ms) for an active cast session's socket
     * in the bridge (Session.ts). No PONG within this window -> the session
     * is torn down so the extension can re-cast. Governs how quickly page
     * PLAY/PAUSE/SEEK failures on a silently-dead session are detected.
     */
    castSessionHeartbeatStaleMs: number;

    /** Show advanced options on options page. */
    showAdvancedOptions: boolean;

    [key: string]: Options[keyof Options];
}

export default {
    bridgeApplicationName: BRIDGE_NAME,
    bridgeBackupEnabled: false,
    bridgeBackupHost: "localhost",
    bridgeBackupPort: 9556,
    bridgeBackupSecure: false,
    bridgeBackupPassword: "",

    mediaEnabled: true,
    mediaSyncElement: true,
    mediaStopOnUnload: true,
    localMediaEnabled: true,
    localMediaServerPort: 9555,

    mirroringEnabled: false,
    mirroringAppId: MIRRORING_APP_ID,
    mirroringStreamMaxFrameRate: 15,
    mirroringStreamMaxBitRate: 1000000,
    mirroringStreamDownscaleFactor: 1.0,
    mirroringStreamMaxResolution: { width: 1920, height: 1080 },
    mirroringStreamUseMaxResolution: true,

    receiverSelectorCloseIfFocusLost: true,
    receiverSelectorWaitForConnection: true,
    receiverSelectorExpandActive: true,
    receiverSelectorShowMediaImages: false,

    siteWhitelistEnabled: true,
    siteWhitelist: [
        { pattern: "https://www.netflix.com/*", isEnabled: true },
        { pattern: "https://www.bilibili.com/video/*", isEnabled: true },
        { pattern: "https://m.bilibili.com/video/*", isEnabled: true }
    ],
    siteWhitelistCustomUserAgent: "",

    bilibiliDefaultsVersion: 1,
    bilibiliDebugEnabled: false,
    cctvDebugEnabled: false,
    bleRemoteEnabled: true,
    bleRemoteUrl: "http://127.0.0.1:5002/ble-remote/events",
    bleRemoteSeekBackwardSeconds: 30,
    bleRemoteSeekForwardSeconds: 30,

    castRemoteHeartbeatStaleMs: 15000,
    castSessionHeartbeatStaleMs: 15000,

    showAdvancedOptions: false
} as Options;
