import type { RokuMediaIdentity } from "../../shared/playbackCommand";
import type { RokuMediaStatusProvenance } from "../../shared/rokuMediaStatusProvenance";
import type { TypedPort } from "./lib/TypedPort";

import type {
    ReceiverSelection,
    ReceiverSelectorMediaMessage,
    ReceiverSelectorReceiverMessage
} from "./background/ReceiverSelector";

import type {
    CastSessionCreatedDetails,
    CastSessionUpdatedDetails,
    MediaStatus,
    ReceiverStatus,
    SenderMediaMessage,
    SenderMessage
} from "./cast/sdk/types";
import type { ApiConfig, Receiver, SessionRequest } from "./cast/sdk/classes";
import type { MediaInfo } from "./cast/sdk/media/classes";

import type {
    ReceiverDevice,
    ReceiverSelectorAppInfo,
    ReceiverSelectorMediaType,
    ReceiverSelectorPageInfo
} from "./types";
import type { ReceiverAction } from "./cast/sdk/enums";

import type { PongReport } from "../../shared/pongReport";

/**
 * Messages are JSON objects with a `subject` string key and a
 * generic `data` key:
 *   { subject: "...", data: ... }
 *
 * Message subjects may include an optional destination and
 * response name formatted like this:
 *   ^(destination:)?messageName(\/responseName)?$
 *
 * Message formats are specified with subject as a key and data
 * as the value in the message tables.
 */

/**
 * Messages exclusively used internally between extension
 * components.
 */
type ExtensionMessageDefinitions = {
    /** Initial data to send to selector popup. */
    "popup:init": {
        tabId: number;
        appInfo?: ReceiverSelectorAppInfo;
        pageInfo?: ReceiverSelectorPageInfo;
        devices: ReceiverDevice[];
        isBridgeCompatible: boolean;
        connectedTransportIds?: string[];
        defaultMediaType?: ReceiverSelectorMediaType;
        availableMediaTypes?: ReceiverSelectorMediaType;
    };
    /** Updates selector popup with new data. */
    "popup:update": {
        devices: ReceiverDevice[];
        isBridgeCompatible: boolean;
        connectedTransportIds?: string[];
        defaultMediaType?: ReceiverSelectorMediaType;
        availableMediaTypes?: ReceiverSelectorMediaType;
    };

    /**
     * Sent from the selector popup when a receiver has been
     * selected.
     */
    "main:receiverSelected": ReceiverSelection;
    /**
     * Sent from the selector popup when a receiver has been
     * stopped. Used to provide cast API receiver action updates.
     */
    "main:receiverStopped": { deviceId: string };

    /**
     * Tells the cast manager to provide the cast API instance with
     * receiver data.
     */
    "main:initializeCastSdk": { apiConfig: ApiConfig };
    "cast:initialized": { isAvailable: boolean };

    /**
     * Sent to the cast API when a session is requested or stopped via
     * the extension UI.
     */
    "cast:receiverAction": { receiver: Receiver; action: ReceiverAction };

    /**
     * Sent from the cast API to trigger receiver selection on session
     * request.
     */
    "main:requestSession": {
        sessionRequest: SessionRequest;
        /** Skip receiver selection (allowed for trusted instances only). */
        receiverDevice?: ReceiverDevice;
    };
    /** Return message to the cast API when a selection is cancelled. */
    "cast:sessionRequestCancelled": undefined;

    "main:requestSessionById": { sessionId: string };
    "main:leaveSession": void;

    "cast:instanceCreated": { isAvailable: boolean };
    "cast:receiverAvailabilityUpdated": { isAvailable: boolean };

    "cast:sessionCreated": CastSessionCreatedDetails & {
        receiver: Receiver;
        media?: MediaStatus;
    };
    "cast:sessionUpdated": CastSessionUpdatedDetails;
    "cast:sessionDisconnected": { sessionId: string };

    /** Allows the selector popup to send cast NS_RECEIVER messages. */
    "main:sendReceiverMessage": ReceiverSelectorReceiverMessage;
    /** Allows the selector popup to send cast NS_MEDIA messages. */
    "main:sendMediaMessage": ReceiverSelectorMediaMessage;

    /**
     * Tells the device manager to clear its device list and re-connect
     * to the bridge.
     */
    "main:refreshDeviceManager": void;

    "mirroringPopup:init": { device: ReceiverDevice };
};

/**
 * IMPORTANT:
 * Messages that cross the native messaging channel. MUST keep
 * in-sync with the bridge's version at:
 *   app/src/bridge/messaging.ts > MessageDefinitions
 */
type BridgeMessageDefinitions = {
    /**
     * First message sent by the extension to the bridge.Responds directly with
     * version string of the bridge to compare.
     *
     * Still uses `:/` message separator for compat talking to older bridge
     * versions.
     */
    "bridge:getInfo": undefined;
    "bridge:/getInfo": undefined;

    /**
     * Tells a bridge to begin service discovery (and whether to
     * establish connections to monitor the status of the receiver
     * devices).
     */
    "bridge:startDiscovery": {
        shouldWatchStatus: boolean;
        /**
         * Half-dead watchdog timeouts (ms) for the bridge. Optional so older
         * bridges ignore them and the bridge falls back to its own defaults.
         *   - remote: platform status connection (remote.ts)
         *   - session: active cast session socket (Session.ts)
         */
        remoteHeartbeatStaleMs?: number;
        sessionHeartbeatStaleMs?: number;
    };

    /**
     * Sent to extension from the bridge whenever a receiver device is
     * found.
     */
    "main:deviceUp": { deviceId: string; deviceInfo: ReceiverDevice };
    /**
     * Sent to extension from the bridge whenever a previously found
     * receiver device is lost.
     */
    "main:deviceDown": { deviceId: string };

    /**
     * Sent to the extension from the bridge whenever a
     * `RECEIVER_STATUS` message (`NS_RECEIVER`) is received.
     */
    "main:receiverDeviceStatusUpdated": {
        deviceId: string;
        status: ReceiverStatus;
    };
    /**
     * Device-level media status emitted by a receiver remote.
     *
     * RokuRemote emits fresh ECP poll observations AND locally synthesized or
     * cached status updates through this message; the former doc comment
     * ("whenever a MEDIA_STATUS message is received") described only one of its
     * seven emit sites. Consumers must inspect `provenance`: only
     * `source === "ecp-poll"` is eligible to confirm receiver state, while
     * command-echo, seek-echo, volume-key-echo, status-probe,
     * session-media-refresh and startup-synthetic may update UI state but are
     * not observations.
     */
    "main:receiverDeviceMediaStatusUpdated": {
        deviceId: string;
        status: MediaStatus;
        /**
         * Present for Roku receivers only; the Chromecast push path has a
         * single source (a real MEDIA_STATUS) and omits it. A consumer that
         * needs a confirmable observation must skip messages without
         * provenance rather than assume one.
         */
        provenance?: RokuMediaStatusProvenance;
    };

    /**
     * Sent to the bridge when non-session related receiver messages
     * need to be sent (e.g. volume control, application stop, etc...).
     */
    "bridge:sendReceiverMessage": {
        deviceId: string;
        message: SenderMessage;
    };
    /**
     * Sent to the bridge when the receiver selector media UI is used
     * to control media playback.
     */
    "bridge:sendMediaMessage": {
        deviceId: string;
        message: SenderMediaMessage;
    };

    /**
     * Sent to bridge from cast API instance when a session request is
     * initiated.
     */
    "bridge:createCastSession": {
        appId: string;
        receiverDevice: ReceiverDevice;
    };
    /**
     * Connects to, and sends a `STOP` message on the `NS_RECEIVER`
     * channel for the given receiver device.
     */
    "bridge:stopCastSession": {
        receiverDevice: ReceiverDevice;
    };

    /**
     * Sent to cast API instances whenever a session is created or
     * updates. Updated details is a mutable subset of session details
     * otherwise fixed on creation.
     */
    "main:castSessionCreated": CastSessionCreatedDetails;
    "main:castSessionUpdated": CastSessionUpdatedDetails;

    /**
     * Sent to cast API instances whenever a session is stopped.
     */
    "cast:sessionStopped": {
        sessionId: string;
    };

    /**
     * Heartbeat/PONG timing report from a cast connection's platform
     * socket, emitted ONLY when the live-calibrated threshold diverges from
     * the hard-coded HEARTBEAT_STALE_MS (steady state stays quiet). Logged
     * in the extension background console to tune the half-dead watchdog.
     * `source` identifies which watchdog to adjust:
     *   - "session" -> Session.ts DEFAULT_HEARTBEAT_STALE_MS
     *   - "remote"  -> remote.ts DEFAULT_HEARTBEAT_STALE_MS
     * `report` uses the shared PongReport type (shared/pongReport.d.ts), the
     * single source of truth also imported by the bridge — no longer a
     * hand-duplicated shape.
     */
    "main:pongDiagnostics": {
        source: "session" | "remote";
        sessionId?: string;
        deviceId?: string;
        configuredThresholdMs: number;
        report: PongReport;
    };

    /**
     * Flattened RokuRemote.buildStatusMedia snapshot from the bridge.
     * Logged in the extension background console so duration / customData
     * / branch decisions render inline instead of collapsing as `{…}`.
     * Emitted only when the snapshot changes.
     */
    "main:rokuStatusMediaDebug": {
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
        sessionMedia: string;
        customDataIn: string;
        customDataOut: string;
        result: string;
    };

    /**
     * Roku session-side lifecycle debug from the bridge (consume observation,
     * sessionMedia registration). See bridge/src/bridge/messaging.ts.
     */
    "main:rokuSessionMediaDebug": {
        deviceId: string;
        event: "consumeObserved" | "sessionMediaRegistered";
        host: string;
        clientHost: string;
        title: string;
        duration: string;
        customData: string;
        fallback: string;
    };

    /** DASH remux diagnostics routed through Native Messaging framing. */
    "main:dashRemuxDebug": {
        event: "ffmpeg" | "response" | "playlist" | "segment";
        requestId: string;
        details: string;
    };

    /**
     * Full LOAD media published by the emulated Roku session. The session
     * runs in its own bridge process (every connectNative spawns one), so
     * the bridge's in-process sessionMedia registry is invisible to
     * RokuRemote in the device-discovery process. This message carries the
     * same media over the session connection; castManager forwards it to
     * deviceManager, which merges it into the device media status.
     * `media: null` clears it (session teardown).
     */
    "main:rokuSessionMedia": {
        deviceId: string;
        sessionId: string;
        media: MediaInfo | null;
    };

    /**
     * Sent to bridge from cast API instance whenever an `NS_RECEIVER`
     * message needs to be sent.
     */
    "bridge:sendCastReceiverMessage": {
        sessionId: string;
        messageData: SenderMessage;
        messageId: string;
    };

    /**
     * Sent to bridge from cast API instance whenever a application
     * session message needs to be sent (via
     * `chrome.cast.Session#sendMessage`).
     */
    "bridge:sendCastSessionMessage": {
        sessionId: string;
        namespace: string;
        messageData: object | string;
        messageId: string;
    };
    /**
     * Sent to cast API instance from bridge when session message
     * received from a receiver device.
     */
    "cast:sessionMessageReceived": {
        sessionId: string;
        namespace: string;
        messageData: string;
    };

    /**
     * Sent to cast API instance from bridge whenever a message
     * operation is completed. If an error ocurred, an error string will
     * be passed as the `error` data property.
     */
    "cast:impl_sendMessage": {
        sessionId: string;
        messageId: string;
        error?: string;
    };

    /**
     * Sent to the bridge to start an HTTP media server at a given file
     * path on the given port.
     */
    "bridge:startMediaServer": {
        requestId: string;
        filePath: string;
        port: number;
    };
    "bridge:startRemoteMediaServer": {
        requestId: string;
        mediaUrl: string;
        audioUrl?: string;
        referer: string;
        contentType: string;
        port: number;
        startTime?: number;
        /** Live HLS relay mode (CCTV live): bridge rewrites the playlist and
         *  proxies segments through this machine. */
        hlsLive?: boolean;
        /** Hold Bilibili DASH readiness until Roku startup segments are closed, then drip a complete-only EVENT prefix. */
        rokuDashPrebuffer?: boolean;
        /** Seek remux restart: drop mid-file captured fragments so ffmpeg
         *  cannot start at the previous page position. First play / overflow
         *  omit this so already-buffered ranges stay usable. */
        resetCaptureWindow?: boolean;
        /** Enables verbose bridge relay logging and LAN debug playlist endpoints. */
        cctvDebugEnabled?: boolean;
        /** User-Agent for the bridge's upstream CDN requests (live relay). The
         *  extension resolves the real Chrome UA from docs/ua.json so the CDN
         *  doesn't throttle/serve degraded edges to an unknown client. */
        userAgent?: string;
    };
    /**
     * Sent to media sender from bridge when the media server is ready
     * to serve files.
     */
    "mediaCast:mediaServerStarted": {
        requestId: string;
        mediaPath: string;
        subtitlePaths: string[];
        localAddress: string;
        mode?: "proxy" | "dash-remux";
        /** DASH remux: requested seek target and the probed keyframe the
         *  playlist is actually padded to (diagnostics). */
        startTime?: number;
        padBaseSeconds?: number;
        /** Full source duration reported by ffprobe when available. */
        pageDuration?: number;
        /** Synthetic DVR (CCTV live): offset of the live edge in the VOD
         *  timeline at builtAtMs; it advances with wall clock from there.
         *  Used to clamp forward seeks to published segments. */
        liveEdgeBaseSeconds?: number;
        builtAtMs?: number;
        /** Synthetic DVR (CCTV live): segment cadence in seconds. The receiver
         *  fetches one segment per stepSeconds while alive; the sender keys its
         *  auto-recovery liveness timeout on it. */
        stepSeconds?: number;
    };
    /**
     * Sent to bridge to stop HTTP media server.
     */
    "bridge:stopMediaServer": { requestId?: string; force?: boolean };
    /**
     * Sent to media sender from bridge when the media server has
     * stopped.
     */
    "main:bilibiliPageCaptureReady": {
        requestId: string;
        port: number;
        generation: number;
    };
    /** Content-script: capture HTTP port is listening for this generation. */
    "bilibili:pageCaptureReady": {
        requestId: string;
    };
    /**
     * Asynchronous page-p sender facts for a play/pause command: arm consumed,
     * receiver API called, arm expired. Reported by the page via
     * browser.runtime.sendMessage (the same mechanism as
     * bilibili:pageSeekStarted), because these happen after controlPlayback()
     * has already returned.
     */
    "main:bilibiliPlaybackProgress": {
        commandId: number;
        /**
         * Required: a message crossing a process boundary cannot be trusted to
         * carry it just because today's producer does, and without it the
         * command match would rest on commandId alone. The device is taken from
         * identity.deviceId rather than duplicated here.
         */
        mediaIdentity: RokuMediaIdentity;
        pagePhase?: "transition-requested" | "target-observed" | "timeout";
        receiverPhase?: "requested" | "failed";
        receiverDispatchStartedAt?: number;
        pagePausedSnapshot?: boolean;
        error?: string;
    };

    /**
     * One completed Roku ECP poll sample (see the bridge-side definition).
     * Emitted even for an idle poll, which the device media status feed cannot
     * express, so play/pause confirmation can distinguish "observed idle" from
     * "no observation at all".
     */
    "main:rokuPlaybackObservation": {
        deviceId: string;
        status: MediaStatus;
        provenance: RokuMediaStatusProvenance;
    };

    /** Bridge capture generation terminal condition (see `reason`): buffer
     *  pressure (hard cap, stalled watermark) or a broken media identity
     *  (malformed metadata, bad payload length, conflicting bytes, foreign
     *  init). Both input streams are aborted, so this is forwarded to the tab
     *  so the sender rebuilds the relay at the page's current position.
     *  `kind` is "unknown" when the offending request has no usable kind. */

    "main:bilibiliCaptureOverflow": {
        requestId: string;
        kind: "video" | "audio" | "unknown";
        reason?: string;
    };
    "mediaCast:mediaServerStopped": { requestId: string };
    /** Live HLS relay diagnostics from the bridge, logged in the background
     *  console by handleBridgeMessage (so relay activity is visible without
     *  reading the bridge's stderr). */
    "mediaCast:relayDebug": {
        requestId: string;
        event: string;
        [key: string]: unknown;
    };
    /** Live relay: the receiver was served a media segment (/seg) beyond the
     *  initial prebuffer window. Synthesized by the background from relayDebug
     *  events and pushed to the page sender as the receiver-liveness signal for
     *  auto-recovery: a receiver that keeps being served segments is alive,
     *  whatever its media status says. `durationSeconds` is the slot's measured
     *  content duration, so liveness credit is granted for what was actually
     *  served. */
    "mediaCast:relaySegmentRequested": { durationSeconds?: number };
    /** Live relay: a cached prebuffer segment was served successfully. This is
     *  separate from steady-state liveness because cached request cadence is
     *  arbitrary; it only suppresses the prebuffer-stall fallback. */
    "mediaCast:relayPrebufferSegmentRequested": Record<string, never>;
    /**
     * Sent to media sender from bridge when the media server has
     * encountered an error.
     */
    "mediaCast:mediaServerError": { requestId: string; message: string };
};

type MessageDefinitions = ExtensionMessageDefinitions &
    BridgeMessageDefinitions;

interface MessageBase<K extends keyof MessageDefinitions> {
    subject: K;
    data: MessageDefinitions[K];
}

type Messages = {
    [K in keyof MessageDefinitions]: MessageBase<K>;
};

/**
 * Make message data key optional if specified as blank or with
 * all-optional keys.
 */
type NarrowedMessage<L extends MessageBase<keyof MessageDefinitions>> =
    L extends unknown
        ? undefined extends L["data"]
            ? Omit<L, "data"> & Partial<L>
            : L
        : never;

export type Port = TypedPort<Message>;
export type Message = NarrowedMessage<Messages[keyof Messages]>;

/**
 * Typed WebExtension-style messaging utility class.
 */
export default new (class Messenger {
    connect(connectInfo: { name: string }) {
        return browser.runtime.connect(connectInfo) as Port;
    }

    connectTab(tabId: number, connectInfo: { name: string; frameId: number }) {
        return browser.tabs.connect(tabId, connectInfo) as Port;
    }

    sendMessage(
        message: Message,
        options?: browser.runtime._SendMessageOptions
    ): Promise<any>;
    sendMessage(
        extensionId: string,
        options?: browser.runtime._SendMessageOptions
    ): Promise<any>;
    sendMessage(
        messageOrExtensionId: string | Message,
        options?: browser.runtime._SendMessageOptions
    ) {
        return browser.runtime.sendMessage(messageOrExtensionId, options);
    }

    onConnect = browser.runtime.onConnect as WebExtEvent<(port: Port) => void>;
    onMessage = browser.runtime.onMessage as WebExtEvent<
        (message: Message, sender: browser.runtime.MessageSender) => void
    >;
})();
