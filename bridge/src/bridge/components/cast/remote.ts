import CastClient from "./client";

import type {
    MediaStatus,
    ReceiverMessage,
    ReceiverMediaMessage,
    ReceiverStatus,
    SenderMediaMessage
} from "./types";

const NS_MEDIA = "urn:x-cast:com.google.cast.media";
const TRANSPORT_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

interface CastRemoteOptions {
    onApplicationFound?: () => void;
    onApplicationClose?: () => void;
    onReceiverStatusUpdate?: (status: ReceiverStatus) => void;
    onMediaStatusUpdate?: (status?: MediaStatus) => void;
    port?: number;
}

/**
 * castv2 client for receiver tracking.
 */
export default class Remote extends CastClient {
    private transportClient?: RemoteTransport;
    private transportId?: string;
    private transportRetryTimeoutId?: NodeJS.Timeout;

    constructor(private host: string, private options?: CastRemoteOptions) {
        super();
        super
            .connect(host, {
                port: options?.port,
                onReceiverMessage: message => {
                    this.onReceiverMessage(message);
                }
            })
            .then(() => {
                this.sendReceiverMessage({ type: "GET_STATUS" });
            })
            .catch(() => { /* connection retries itself */ });
    }

    disconnect() {
        super.disconnect();
        this.clearTransport();
    }

    sendMediaMessage(message: SenderMediaMessage) {
        this.transportClient?.sendMediaMessage(message);
    }

    /**
     * Handle `NS_RECEIVER` messages from the receiver device.
     * On initial connection, a `GET_STATUS` message is sent that
     * results in a `RECEIVER_STATUS` response. If an application
     * is running, get the transport ID and make a connection to
     * receive media status updates.
     */
    private onReceiverMessage(message: ReceiverMessage) {
        if (message.type !== "RECEIVER_STATUS") {
            return;
        }

        const application = message.status.applications?.[0];
        if (!application || application.isIdleScreen) {
            // Handle app close
            if (this.transportClient || this.transportRetryTimeoutId) {
                this.clearTransport();
                this.options?.onApplicationClose?.();
            }

            this.options?.onReceiverStatusUpdate?.(message.status);
            return;
        }

        // Update status before possible transport init
        this.options?.onReceiverStatusUpdate?.(message.status);

        // Recreate the app transport if the receiver relaunched the app with
        // a different transport ID.
        if (
            this.transportId &&
            this.transportId !== application.transportId
        ) {
            this.clearTransport();
        }

        // Handle app creation/discovery. A failed connection is retried with a
        // short bounded backoff instead of waiting for another RECEIVER_STATUS.
        if (!this.transportClient && !this.transportRetryTimeoutId) {
            this.connectTransport(application.transportId);
            this.options?.onApplicationFound?.();
        }
    }

    private clearTransport() {
        if (this.transportRetryTimeoutId) {
            clearTimeout(this.transportRetryTimeoutId);
            this.transportRetryTimeoutId = undefined;
        }
        this.transportClient?.disconnect();
        this.transportClient = undefined;
        this.transportId = undefined;
    }

    private connectTransport(transportId: string, attempt = 0) {
        const transportClient = new RemoteTransport(
            transportId,
            message => this.onMediaMessage(message)
        );
        this.transportClient = transportClient;
        this.transportId = transportId;

        transportClient
            .connect(this.host, { port: this.options?.port })
            .then(() => {
                if (this.transportClient !== transportClient) return;

                transportClient.sendMediaMessage({
                    type: "GET_STATUS",
                    requestId: 0
                });
            })
            .catch(err => {
                if (this.transportClient !== transportClient) return;

                transportClient.disconnect();
                this.transportClient = undefined;

                const retryDelay = TRANSPORT_RETRY_DELAYS_MS[attempt];
                console.warn("Cast media transport connection failed", {
                    transportId,
                    attempt: attempt + 1,
                    retryDelay,
                    error: err instanceof Error ? err.message : String(err)
                });

                if (retryDelay === undefined || this.transportId !== transportId) {
                    this.transportId = undefined;
                    return;
                }

                this.transportRetryTimeoutId = setTimeout(() => {
                    this.transportRetryTimeoutId = undefined;
                    if (
                        this.transportId === transportId &&
                        !this.transportClient
                    ) {
                        this.connectTransport(transportId, attempt + 1);
                    }
                }, retryDelay);
            });
    }

    /**
     * Handle `NS_MEDIA` messages from the receiver application.
     * On initial connection. a `GET_STATUS` message is sent that
     * results in a `MEDIA_STATUS` response.
     */
    private onMediaMessage(message: ReceiverMediaMessage) {
        if (message.type !== "MEDIA_STATUS") {
            return;
        }

        this.options?.onMediaStatusUpdate?.(message.status[0]);
    }
}

/**
 * castv2 client for receiver application tracking.
 */
class RemoteTransport extends CastClient {
    private mediaChannel = this.createChannel(NS_MEDIA);

    constructor(
        transportId: string,
        onMediaMessage: (message: ReceiverMediaMessage) => void
    ) {
        super(undefined, transportId);
        this.mediaChannel.on("message", message => onMediaMessage(message));
    }

    sendMediaMessage(message: SenderMediaMessage) {
        this.mediaChannel.send(message);
    }
}
