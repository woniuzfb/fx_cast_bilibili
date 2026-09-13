import { TypedEmitter } from "tiny-typed-emitter";

import { DecodeTransform, EncodeTransform } from "../transforms";

import type { RokuMediaStatusProvenance } from "../../../shared/rokuMediaStatusProvenance";
import type {
    MediaInformation,
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
     * One completed ECP poll sample, forwarded for command confirmation.
     *
     * Emitted for EVERY successful /query/media-player poll, including one that
     * reports idle - which main:receiverDeviceMediaStatusUpdated cannot carry,
     * because its RokuRemote producer suppresses the "nothing to report" idle
     * state. Consumers use this only to correlate a play/pause command with a
     * post-command observation; it deliberately does not drive the device media
     * status (that stays with main:receiverDeviceMediaStatusUpdated).
     */
    "main:rokuPlaybackObservation": {
        deviceId: string;
        status: MediaStatus;
        /**
         * The LOAD generation this sample was taken under, snapshotted when the
         * poll STARTED (undefined when the bridge has not been told one yet).
         */
        loadGeneration?: number;
        provenance: RokuMediaStatusProvenance;
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
    /**
     * A play/pause transport completed inside a cast SESSION process.
     *
     * The session lives in its own connectNative process and has no access to
     * the discovery process's remotes, so it cannot start the dense sampling
     * itself. It reports the transport instead and the extension relays
     * bridge:rokuRequestConfirmationPoll to the right process.
     */
    "main:rokuSessionPlaybackTransport": {
        deviceId: string;
    };

    /**
     * Mirrors one Roku session-media state into the discovery process.
     *
     * RokuSession and RokuRemote live in different connectNative processes, so
     * the session's own registerRokuSessionMedia() call writes a module
     * instance the remote can never observe. The extension sees both and
     * forwards it here; the discovery side keeps owner-aware semantics and
     * ignores a generation that is no longer current.
     */
    "bridge:rokuSetSessionMedia": {
        deviceId: string;
        loadGeneration: number;
        ownerId: string;
        media: MediaInformation | null;
    };

    /**
     * Tells the discovery bridge which LOAD generation the extension considers
     * current for this device.
     *
     * The load generation is created by the extension (beginRokuMediaLoad), and
     * only the discovery process runs the polling loop, so the extension must
     * push it across; the bridge can neither derive it from mediaSessionId
     * (which is a constant 1 for Roku) nor from contentId (the same URL can be
     * loaded twice). Each poll sample snapshots the generation it STARTED
     * under, so a sample that spans a LOAD boundary is not attributed to the
     * new load.
     */
    "bridge:rokuSetLoadGeneration": {
        deviceId: string;
        loadGeneration: number;
    };

    /**
     * Asks the device-discovery bridge to sample this Roku densely for a short
     * window, because a play/pause transport was just submitted to it.
     *
     * Needed because the two paths that submit such a transport live in
     * different processes: the discovery process issues its own keypress, while
     * a page-owned command issues one inside the cast SESSION process (a
     * different connectNative). The session process has no access to the
     * discovery process's remotes, so the extension - which sees both - relays
     * the request. It carries no command id: the bridge only learns "this
     * device deserves denser sampling now", and every sample still has to pass
     * the extension's ecp-poll whitelist and strict poll-start gate.
     */
    "bridge:rokuRequestConfirmationPoll": {
        deviceId: string;
    };

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
     * Flattened RokuRemote.buildStatusMedia snapshot. Logged in the
     * extension background console so duration / customData / branch
     * decisions render inline instead of collapsing as `{…}`. Emitted
     * only when the snapshot changes (the 3s ECP poll stays quiet).
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
     * Roku session-side lifecycle debug (consume observation, sessionMedia
     * registration). Flattened primitives, logged in the extension background
     * console — the bridge process's own console is not captured by the
     * extension console export, so diagnostics MUST travel through messaging.
     */
    "main:rokuSessionMediaDebug": {
        deviceId: string;
        event: "consumeObserved" | "sessionMediaRegistered";
        host: string;
        clientHost?: string;
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
     * the in-process sessionMedia registry is invisible to RokuRemote in
     * the device-discovery process. This message carries the same media
     * over the session connection; the extension merges it into the device
     * media status (deviceManager). `media: null` clears it (teardown).
     */
    "main:rokuSessionMedia": {
        deviceId: string;
        sessionId: string;
        media: MediaInformation | null;
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
        hlsLive?: boolean;
        /** Hold Bilibili DASH readiness until Roku startup segments are closed, then drip a complete-only EVENT prefix. */
        rokuDashPrebuffer?: boolean;
        /** Seek remux restart: drop mid-file captured fragments so ffmpeg
         *  cannot start at the previous page position. */
        resetCaptureWindow?: boolean;
        cctvDebugEnabled?: boolean;
        userAgent?: string;
    };
    /** Live HLS relay diagnostics, surfaced in the extension background
     *  console via handleBridgeMessage. */
    "mediaCast:relayDebug": {
        requestId: string;
        event: string;
        [key: string]: unknown;
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
    /**
     * The captured-DASH generation reached a TERMINAL condition, i.e. every
     * reason under which continuing to ingest would either exhaust memory or
     * feed ffmpeg bytes that contradict the generation's media identity:
     * resource limits ("hard-cap"), an unfillable consumption gap
     * ("watermark-stalled"), inconsistent identity ("init-total-mismatch"),
     * malformed metadata ("invalid-ingest-metadata"), a body disagreeing with
     * its declared range ("payload-length-mismatch") or conflicting bytes for
     * an already-captured range ("overlap-mismatch"). In every case BOTH
     * kinds' input streams are aborted, so the only safe reclaim is a relay
     * rebuild at the page's current position: the background forwards this to
     * the tab's sender, which re-casts (fresh generation, fresh capture
     * window). `kind` is "unknown" when the offending request could not be
     * attributed to a kind.
     */
    "main:bilibiliCaptureOverflow": {
        requestId: string;
        kind: "video" | "audio" | "unknown";
        reason?: string;
    };
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
