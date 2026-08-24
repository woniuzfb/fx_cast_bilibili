import { Channel, Client } from "castv2";

import type { ReceiverMessage, SenderMessage } from "./types";
import PongMeter, { type PongReport } from "./pongMeter";

export const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
export const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
export const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";

const DEFAULT_PORT = 8009;
export const HEARTBEAT_INTERVAL_MS = 5000;

interface CastClientConnectOptions {
    port?: number;
    onReceiverMessage?: (message: ReceiverMessage) => void;
    onHeartbeat?: () => void;
    onPong?: () => void;
    /**
     * Periodic heartbeat/PONG timing report (rate-limited by PongMeter).
     * Owners with a Messenger (e.g. Session) forward this to the extension
     * background log so HEARTBEAT_STALE_MS can be calibrated from live data.
     */
    onPongStats?: (report: PongReport) => void;
    onClose?: () => void;
}

export default class CastClient {
    protected client = new Client();

    protected connectionChannel?: Channel;
    protected heartbeatChannel?: Channel;
    protected heartbeatIntervalId?: NodeJS.Timeout;

    // Platform messaging
    private receiverChannel?: Channel;
    private receiverRequestId = Math.floor(Math.random() * 1e6);

    constructor(
        protected sourceId = "sender-0",
        protected destinationId = "receiver-0"
    ) {}

    /**
     * Create a channel on the client connection with a given
     * namespace.
     */
    protected createChannel(
        namespace: string,
        sourceId = this.sourceId,
        destinationId = this.destinationId
    ) {
        return this.client.createChannel(
            sourceId,
            destinationId,
            namespace,
            "JSON"
        );
    }

    /**
     * Sends a message on the receiver channel with the correct
     * request ID.
     */
    sendReceiverMessage(message: DistributiveOmit<SenderMessage, "requestId">) {
        if (!this.receiverChannel) return;

        const requestId = this.receiverRequestId++;
        this.receiverChannel.send({ ...message, requestId });
        return requestId;
    }

    /**
     * Replace the underlying castv2 client and drop stale channels.
     * castv2 clients cannot safely be reused across connections
     * (socket/PacketStreamWrapper are swapped in place and listeners
     * would accumulate), so reconnection requires a fresh client —
     * subclasses must recreate any channels they hold themselves.
     */
    protected resetClient() {
        const oldClient = this.client;
        this.client = new Client();

        if (this.heartbeatIntervalId) {
            clearInterval(this.heartbeatIntervalId);
            this.heartbeatIntervalId = undefined;
        }

        this.connectionChannel = undefined;
        this.heartbeatChannel = undefined;
        this.receiverChannel = undefined;

        // Detach handlers before closing so the old client's `close`
        // event cannot re-trigger connection logic.
        oldClient.removeAllListeners();
        try {
            oldClient.close();
        } catch { /* never connected */ }
    }

    /**
     * Connects to a cast receiver at a given host, returning a
     * promise that resolves once the client is connected.
     */
    connect(host: string, options?: CastClientConnectOptions) {
        // Always-on heartbeat analyzer for this connection. Cheap in
        // steady state (reports are rate-limited inside PongMeter).
        const pongMeter = new PongMeter(
            `${host}:${options?.port ?? DEFAULT_PORT}/${this.destinationId}`
        );

        return new Promise<void>((resolve, reject) => {
            let connected = false;

            // Handle errors
            this.client.on("error", err => {
                if (!connected) {
                    reject(err);
                } else {
                    try {
                        this.client.close();
                    } catch { /* already closed */ }
                }
            });

            this.client.on("close", () => {
                if (this.heartbeatIntervalId) {
                    clearInterval(this.heartbeatIntervalId);
                    this.heartbeatIntervalId = undefined;
                }
                options?.onClose?.();
            });

            this.client.connect(
                {
                    host,
                    // !! This was the reason it wasn't working for me (aka it was always tried to connect
                    // to the default port, disregarding what is broadcast in mDNS)
                    // - @pato05
                    port: options?.port ?? DEFAULT_PORT
                },
                // On connection callback
                () => {
                    connected = true;
                    this.connectionChannel = this.createChannel(NS_CONNECTION);
                    this.heartbeatChannel = this.createChannel(NS_HEARTBEAT);

                    // Handle receiver messages
                    this.receiverChannel = this.createChannel(NS_RECEIVER);
                    this.receiverChannel.on("message", message => {
                        options?.onReceiverMessage?.(message);
                    });

                    // Track PONG replies for connection liveness checks
                    this.heartbeatChannel.on("message", (message: { type?: string }) => {
                        if (message?.type === "PONG") {
                            const report = pongMeter.onPong();
                            if (report) options?.onPongStats?.(report);
                            options?.onPong?.();
                        }
                    });

                    this.connectionChannel.send({ type: "CONNECT" });
                    pongMeter.onPing();
                    this.heartbeatChannel.send({ type: "PING" });

                    this.heartbeatIntervalId = setInterval(() => {
                        pongMeter.onPing();
                        this.heartbeatChannel?.send({ type: "PING" });
                        options?.onHeartbeat?.();
                    }, HEARTBEAT_INTERVAL_MS);

                    resolve();
                }
            );
        });
    }

    disconnect() {
        if (this.heartbeatIntervalId) {
            clearInterval(this.heartbeatIntervalId);
        }

        // Sends throw once the underlying connection is gone, so a
        // disconnect on a dead client must not propagate.
        try {
            this.connectionChannel?.send({ type: "CLOSE" });
            this.client.close();
        } catch { /* already closed */ }
    }
}
