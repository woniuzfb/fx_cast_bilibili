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

// How long to wait for a RECEIVER_STATUS reply before considering the
// platform connection half-dead (e.g. silently broken by system sleep).
const STATUS_PROBE_TIMEOUT_MS = 2500;
// No PONG for this long means the connection is half-dead; the socket
// never closed, so only a watchdog can detect it.
const HEARTBEAT_STALE_MS = 15000;

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

    // Platform connection (RECEIVER_STATUS watcher) state. This
    // connection is long-lived and can silently die during idle
    // periods (system sleep, receiver dropping idle TCP), so it is:
    //   1. reconnected with a bounded backoff when closed,
    //   2. probed on demand before casting (`ensureConnected`),
    //   3. watched by a PONG watchdog for half-dead states.
    private destroyed = false;
    private platformConnecting = false;
    private platformConnected = false;
    private platformRetryTimeoutId?: NodeJS.Timeout;
    private lastPongAt = Date.now();
    private statusProbeResolve?: () => void;
    /**
     * Generation token for the platform connection. Incremented on every
     * connectPlatform() so that late-arriving callbacks (the connect
     * Promise's then/catch, or an onClose/onHeartbeat from a superseded
     * socket) can detect they belong to a stale connection and no-op.
     *
     * Defense in depth: today resetClient() calls removeAllListeners() on
     * the old castv2 client, which structurally prevents its callbacks
     * from firing at all — resolve, reject, and close are all registered
     * as EventEmitter listeners ('connect'/'error'/'close') and the
     * socket is destroyed afterwards. The token is not fixing a race
     * that currently exists; it guards against future regressions in
     * that listener cleanup (e.g. if connect()/resetClient() ever stop
     * detaching every entry point).
     */
    private platformGen = 0;

    constructor(private host: string, private options?: CastRemoteOptions) {
        super();
        this.connectPlatform();
    }

    disconnect() {
        this.destroyed = true;
        if (this.platformRetryTimeoutId) {
            clearTimeout(this.platformRetryTimeoutId);
            this.platformRetryTimeoutId = undefined;
        }
        this.resolveStatusProbe();
        super.disconnect();
        this.clearTransport();
    }

    /**
     * Ensure the platform connection is alive, healing it if it died
     * or went stale. Intended to be called right before casting so
     * the popup reliably receives RECEIVER_STATUS updates.
     */
    ensureConnected() {
        if (this.destroyed || this.platformConnecting) return;

        if (this.platformConnected) {
            this.probeStatus();
            return;
        }

        // A reconnect is already scheduled — let the backoff run.
        if (this.platformRetryTimeoutId) return;

        // Dead with no pending retry (backoff exhausted or initial
        // connection lost) — revive immediately.
        console.warn(
            "[fx_cast_bilibili] Remote platform connection is dead; reconnecting on demand",
            { host: this.host }
        );
        this.connectPlatform();
    }

    sendMediaMessage(message: SenderMediaMessage) {
        this.transportClient?.sendMediaMessage(message);
    }

    private connectPlatform(attempt = 0) {
        if (this.destroyed) return;

        // Supersede any prior connection: bump the generation so its in-flight
        // callbacks become no-ops.
        const gen = ++this.platformGen;

        this.platformConnecting = true;
        this.platformConnected = false;
        this.resolveStatusProbe();

        // castv2 clients cannot be reused across connections — rebuild
        // the underlying client and channels on every attempt.
        this.resetClient();

        this.connect(this.host, {
            port: this.options?.port,
            onReceiverMessage: message => {
                if (gen !== this.platformGen) return;
                this.onReceiverMessage(message);
            },
            onHeartbeat: () => {
                if (gen !== this.platformGen) return;
                this.checkHeartbeat();
            },
            onPong: () => {
                if (gen !== this.platformGen) return;
                this.lastPongAt = Date.now();
            },
            onClose: () => {
                if (gen !== this.platformGen) return;
                this.onPlatformClose();
            }
        })
            .then(() => {
                if (gen !== this.platformGen) return;
                this.platformConnecting = false;
                this.platformConnected = true;
                this.lastPongAt = Date.now();

                this.sendReceiverMessage({ type: "GET_STATUS" });
            })
            .catch(err => {
                if (gen !== this.platformGen) return;
                this.platformConnecting = false;

                const retryDelay = TRANSPORT_RETRY_DELAYS_MS[attempt];
                console.warn(
                    "[fx_cast_bilibili] Remote platform connection failed",
                    {
                        host: this.host,
                        attempt: attempt + 1,
                        retryDelay,
                        error:
                            err instanceof Error
                                ? err.message
                                : String(err)
                    }
                );

                if (retryDelay === undefined) {
                    console.warn(
                        "[fx_cast_bilibili] Remote platform connection retries exhausted; will retry on next cast",
                        { host: this.host }
                    );
                    return;
                }

                this.schedulePlatformRetry(attempt + 1, retryDelay);
            });
    }

    private onPlatformClose() {
        if (this.destroyed) return;

        this.platformConnected = false;
        this.resolveStatusProbe();

        console.warn(
            "[fx_cast_bilibili] Remote platform connection closed unexpectedly; reconnecting",
            { host: this.host }
        );
        this.schedulePlatformRetry(0);
    }

    private schedulePlatformRetry(
        attempt: number,
        delay = TRANSPORT_RETRY_DELAYS_MS[0]
    ) {
        if (this.destroyed || this.platformRetryTimeoutId) return;

        this.platformRetryTimeoutId = setTimeout(() => {
            this.platformRetryTimeoutId = undefined;
            if (
                !this.destroyed &&
                !this.platformConnected &&
                !this.platformConnecting
            ) {
                this.connectPlatform(attempt);
            }
        }, delay);
    }

    /**
     * Probe a connected platform connection with `GET_STATUS`. If no
     * `RECEIVER_STATUS` arrives in time, the connection is half-dead
     * and gets rebuilt.
     */
    private probeStatus() {
        if (this.statusProbeResolve) return;

        const timer = setTimeout(() => {
            this.statusProbeResolve = undefined;

            // Connection already dropped or a reconnect is underway —
            // existing logic handles it.
            if (
                this.destroyed ||
                !this.platformConnected ||
                this.platformConnecting ||
                this.platformRetryTimeoutId
            ) {
                return;
            }

            console.warn(
                "[fx_cast_bilibili] Remote status probe timed out; rebuilding platform connection",
                { host: this.host }
            );
            this.connectPlatform();
        }, STATUS_PROBE_TIMEOUT_MS);

        this.statusProbeResolve = () => {
            clearTimeout(timer);
            this.statusProbeResolve = undefined;
        };

        this.sendReceiverMessage({ type: "GET_STATUS" });
    }

    private resolveStatusProbe() {
        this.statusProbeResolve?.();
    }

    private checkHeartbeat() {
        if (this.destroyed) return;

        const staleMs = Date.now() - this.lastPongAt;
        if (staleMs < HEARTBEAT_STALE_MS) return;

        console.warn(
            "[fx_cast_bilibili] Remote heartbeat watchdog fired (no PONG); rebuilding platform connection",
            { host: this.host, staleMs }
        );
        this.connectPlatform();
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

        // A RECEIVER_STATUS reply proves the platform connection is
        // alive — release any pending liveness probe.
        this.resolveStatusProbe();

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
        const transportClient = this.transportClient;
        this.transportClient = undefined;
        this.transportId = undefined;
        transportClient?.disconnect();
    }

    private connectTransport(transportId: string, attempt = 0) {
        const transportClient = new RemoteTransport(
            transportId,
            message => this.onMediaMessage(message)
        );
        this.transportClient = transportClient;
        this.transportId = transportId;

        transportClient
            .connect(this.host, {
                port: this.options?.port,
                onClose: () => {
                    if (this.transportClient !== transportClient) return;

                    this.transportClient = undefined;
                    console.warn("Cast media transport closed unexpectedly", {
                        transportId
                    });
                    this.scheduleTransportRetry(transportId, 0);
                }
            })
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

                this.scheduleTransportRetry(
                    transportId,
                    attempt + 1,
                    retryDelay
                );
            });
    }

    private scheduleTransportRetry(
        transportId: string,
        attempt: number,
        delay = TRANSPORT_RETRY_DELAYS_MS[0]
    ) {
        if (
            this.transportRetryTimeoutId ||
            this.transportId !== transportId
        ) {
            return;
        }

        this.transportRetryTimeoutId = setTimeout(() => {
            this.transportRetryTimeoutId = undefined;
            if (
                this.transportId === transportId &&
                !this.transportClient
            ) {
                this.connectTransport(transportId, attempt);
            }
        }, delay);
    }

    /**
     * Handle `NS_MEDIA` messages from the receiver application.
     * On initial connection. a `GET_STATUS` message is sent that
     * results in a `MEDIA_STATUS` response.
     */
    private onMediaMessage(message: ReceiverMediaMessage) {
        if (message.type === "INVALID_REQUEST") {
            console.warn("Cast media request rejected", {
                requestId: message.requestId,
                mediaSessionId: message.mediaSessionId
            });
            return;
        }

        if (message.type !== "MEDIA_STATUS") return;

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
