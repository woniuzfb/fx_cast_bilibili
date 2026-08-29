import { TypedEmitter } from "tiny-typed-emitter";

import { DecodeTransform, EncodeTransform } from "../transforms";

import type {
    MediaStatus,
    ReceiverStatus,
    SenderMediaMessage,
    SenderMessage
} from "./components/cast/types";
import type { PongReport } from "../../../shared/pongReport";

import type {
    ReceiverDevice,
    CastSessionCreatedDetails,
    CastSessionUpdatedDetails
} from "./messagingTypes";
import type { WebSocket } from "ws";

/**
 * IMPORTANT:
 * Messages that cross the native messaging channel. MUST keep
 * in-sync with the extension's version at:
 *   extension/src/messaging.ts > AppMessageDefinitions
 */
type MessageDefinitions = {
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
         * Half-dead watchdog timeouts (ms). Optional so older extensions
         * omit them and the bridge falls back to its own defaults.
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
     * Sent to the extension from the bridge whenever a
     * `MEDIA_STATUS` message (`NS_RECEIVER`) is received.
     */
    "main:receiverDeviceMediaStatusUpdated": {
        deviceId: string;
        status: MediaStatus;
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
     * socket, emitted ONLY when the live-calibrated threshold diverges
     * from the hard-coded HEARTBEAT_STALE_MS (steady state stays quiet).
     * Logged in the extension background console to tune the half-dead
     * watchdog. `source` identifies which watchdog to adjust:
     *   - "session" -> Session.ts DEFAULT_HEARTBEAT_STALE_MS
     *   - "remote"  -> remote.ts DEFAULT_HEARTBEAT_STALE_MS
     */
    "main:pongDiagnostics": {
        source: "session" | "remote";
        sessionId?: string;
        deviceId?: string;
        configuredThresholdMs: number;
        report: PongReport;
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
    "bridge:startRemoteMediaServer": { requestId: string; mediaUrl: string; audioUrl?: string; referer: string; contentType: string; port: number; startTime?: number; hlsLive?: boolean; cctvDebugEnabled?: boolean; userAgent?: string; };
    /** Live HLS relay diagnostics, surfaced in the extension background
     *  console via handleBridgeMessage. */
    "mediaCast:relayDebug": { requestId: string; event: string; [key: string]: unknown; };
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
    "mediaCast:mediaServerStopped": { requestId: string };
    /**
     * Sent to media sender from bridge when the media server has
     * encountered an error.
     */
    "mediaCast:mediaServerError": { requestId: string; message: string };
};

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

export type Message = NarrowedMessage<Messages[keyof Messages]>;

interface MessengerEvents {
    message: (message: Message) => void;
    disconnect: () => void;
}

export abstract class Messenger extends TypedEmitter<MessengerEvents> {
    abstract sendMessage(message: Message): void;
    abstract send(data: unknown): void;
}

export class StdioMessenger
    extends TypedEmitter<MessengerEvents>
    implements Messenger
{
    // Native messaging transforms
    private decodeTransform = new DecodeTransform();
    private encodeTransform = new EncodeTransform();

    constructor() {
        super();

        // Hook up stdin -> stdout
        process.stdin.pipe(this.decodeTransform);
        this.encodeTransform.pipe(process.stdout);

        this.decodeTransform.on("error", err =>
            console.error("err (message decode):", err)
        );
        this.encodeTransform.on("error", err =>
            console.error("err (message encode):", err)
        );

        this.decodeTransform.on("data", (message: Message) => {
            this.emit("message", message);
        });

        // Firefox closes the native host's stdin when the extension port or
        // browser exits. Explicitly surface that lifecycle event so active
        // HTTP/ffmpeg resources cannot keep an orphaned bridge alive.
        let disconnected = false;
        const emitDisconnect = () => {
            if (disconnected) return;
            disconnected = true;
            this.emit("disconnect");
        };
        process.stdin.once("end", emitDisconnect);
        process.stdin.once("close", emitDisconnect);
    }

    /** Sends a message to the extension. */
    sendMessage(message: Message) {
        this.send(message);
    }

    send(data: unknown) {
        this.encodeTransform.write(data);
    }
}

export class WebsocketMessenger
    extends TypedEmitter<MessengerEvents>
    implements Messenger
{
    private socket: WebSocket;

    constructor(socket: WebSocket) {
        super();

        this.socket = socket;
        socket.on("message", (message: string) => {
            try {
                const parsed = JSON.parse(message) as Message;
                this.emit("message", parsed);
            } catch (err) {
                // Catch parse errors and close socket
                socket.close();
            }
        });
    }

    /** Sends a message to the extension. */
    sendMessage(message: Message) {
        this.send(message);
    }

    send(data: unknown) {
        this.socket.send(JSON.stringify(data));
    }
}
