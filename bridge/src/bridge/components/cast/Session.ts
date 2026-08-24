import type { Channel } from "castv2";

import type { Messenger } from "../../messaging";

import type { ReceiverDevice } from "../../messagingTypes";
import type { ReceiverMessage } from "./types";

import CastClient, {
    NS_CONNECTION,
    NS_HEARTBEAT,
    HEARTBEAT_INTERVAL_MS
} from "./client";

type OnSessionCreatedCallback = (sessionId: string) => void;
type OnSessionStoppedCallback = (sessionId: string) => void;

// No PONG for this long means the session connection is half-dead: the
// socket never closed (system sleep, receiver dropping idle TCP), so only
// a watchdog can detect it. Mirrors Remote's platform watchdog. Unlike the
// platform connection, the page sender's PLAY/PAUSE/SEEK and episode-change
// loadMedia all ride this session socket, so a silent half-dead session
// swallows them with no error. Detecting it here converts the half-dead
// state into the same `close` -> `cast:sessionStopped` teardown the fully
// dead path already uses, letting the extension clean up and re-cast.
// NOTE: this threshold (3x the 5s heartbeat interval) is a placeholder;
// calibrate against real-device PONG intervals before relying on it. Used
// only when the extension doesn't supply a configured value.
const DEFAULT_HEARTBEAT_STALE_MS = 15000;

// Hard floor for any configured stale timeout. A watchdog threshold below
// 2x the heartbeat interval tears down healthy connections: steady-state
// staleMs is ~(interval - RTT), so after a single dropped PONG it climbs to
// ~(2*interval - RTT) and would already exceed a 1x threshold. Requiring >=
// 2x means "tolerate one missed PONG, tear down on two". Anything the
// extension (or a tampered store) supplies below this is ignored in favour
// of DEFAULT_HEARTBEAT_STALE_MS.
const MIN_HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 2;

export default class Session extends CastClient {
    // Assigned by the receiver once the session is established
    public sessionId?: string;

    // Receiver app messaging
    private transportId?: string;
    private transportConnection?: Channel;
    private transportHeartbeat?: Channel;

    // Liveness tracking for the half-dead watchdog. Refreshed by every
    // inbound platform message (PONG or RECEIVER_STATUS); the watchdog runs
    // on each outgoing heartbeat tick.
    private lastPongAt = Date.now();
    // Set once the watchdog (or an explicit close) has torn the session
    // down, so we never fire the teardown twice.
    private tornDown = false;
    // Effective half-dead watchdog timeout (user-configured or default).
    private heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS;

    // Channels created by `sendCastSessionMessage` messages
    private namespaceChannelMap = new Map<string, Channel>();

    /**
     * Request ID used to correlate the launch request with the
     * RECEIVER_STATUS message associated with session creation.
     */
    private launchRequestId?: number;

    private establishAppConnection(transportId: string) {
        this.transportConnection = this.createChannel(
            NS_CONNECTION,
            this.sourceId,
            transportId
        );
        this.transportHeartbeat = this.createChannel(
            NS_HEARTBEAT,
            this.sourceId,
            transportId
        );

        this.transportConnection.send({ type: "CONNECT" });
    }

    /**
     * Fired on every outgoing heartbeat tick. If no inbound platform
     * message (PONG/RECEIVER_STATUS) has arrived within HEARTBEAT_STALE_MS,
     * the session socket is half-dead: close it so the existing `close`
     * handler emits `cast:sessionStopped` and the extension re-casts.
     */
    private checkHeartbeat() {
        if (this.tornDown) return;

        const staleMs = Date.now() - this.lastPongAt;
        if (staleMs < this.heartbeatStaleMs) return;

        console.warn(
            "[fx_cast_bilibili] Cast session heartbeat watchdog fired " +
                "(no PONG); tearing down half-dead session",
            { sessionId: this.sessionId, staleMs }
        );

        // Converts the silent half-dead socket into a detected close.
        try {
            this.client.close();
        } catch { /* already closed */ }
    }

    /**
     * Handle incoming receiver messages.
     */
    private onReceiverMessage = (message: ReceiverMessage) => {
        switch (message.type) {
            case "RECEIVER_STATUS": {
                const { status } = message;
                const application = status.applications?.find(
                    app => app.appId === this.appId
                );

                /**
                 * If application isn't set, still waiting on the launch
                 * request response.
                 */
                if (!this.sessionId) {
                    // Match request ID on the response to the launch request ID.
                    if (message.requestId !== this.launchRequestId) {
                        break;
                    }

                    if (application) {
                        this.sessionId = application.sessionId;
                        this.transportId = application.transportId;

                        this.establishAppConnection(this.transportId);
                        this.onSessionCreated?.(this.sessionId);

                        this.messaging.sendMessage({
                            subject: "main:castSessionCreated",
                            data: {
                                sessionId: this.sessionId,
                                statusText: application.statusText,
                                namespaces: application.namespaces,
                                volume: status.volume,
                                appId: application.appId,
                                displayName: application.displayName,
                                receiverId: this.receiverDevice.id,
                                receiverFriendlyName:
                                    this.receiverDevice.friendlyName,
                                transportId: this.transportId,

                                // TODO: Fix this
                                senderApps: [],
                                appImages: []
                            }
                        });
                    }

                    break;
                }

                // Handle session stop
                if (!application) {
                    this.client.close();
                    break;
                }

                this.messaging.sendMessage({
                    subject: "main:castSessionUpdated",
                    data: {
                        sessionId: this.sessionId,
                        statusText: application.statusText,
                        namespaces: application.namespaces,
                        volume: message.status.volume
                    }
                });

                break;
            }

            case "LAUNCH_ERROR": {
                console.error(`err: LAUNCH_ERROR, ${message.reason}`);
                this.client.close();
                break;
            }
        }
    };

    sendMessage(namespace: string, message: unknown) {
        let channel = this.namespaceChannelMap.get(namespace);
        if (!channel) {
            channel = this.createChannel(
                namespace,
                this.sourceId,
                this.transportId
            );

            channel.on("message", messageData => {
                if (!this.sessionId) {
                    return;
                }

                messageData = JSON.stringify(messageData);

                this.messaging.sendMessage({
                    subject: "cast:sessionMessageReceived",
                    data: {
                        sessionId: this.sessionId,
                        namespace,
                        messageData
                    }
                });
            });

            this.namespaceChannelMap.set(namespace, channel);
        }

        channel.send(message);
    }

    constructor(
        private appId: string,
        private receiverDevice: ReceiverDevice,
        private messaging: Messenger,
        private onSessionCreated?: OnSessionCreatedCallback,
        private onSessionStopped?: OnSessionStoppedCallback,
        heartbeatStaleMs?: number
    ) {
        super();

        if (
            typeof heartbeatStaleMs === "number" &&
            heartbeatStaleMs >= MIN_HEARTBEAT_STALE_MS
        ) {
            this.heartbeatStaleMs = heartbeatStaleMs;
        }

        super
            .connect(receiverDevice.host, {
                port: receiverDevice.port,
                onHeartbeat: () => {
                    // Include transport heartbeat with platform heartbeat
                    if (this.transportHeartbeat) {
                        this.transportHeartbeat.send({ type: "PING" });
                    }

                    // Watch for a half-dead socket on every tick.
                    this.checkHeartbeat();
                },
                onPong: () => {
                    // A PONG proves the session socket is alive.
                    this.lastPongAt = Date.now();
                },
                onReceiverMessage: message => {
                    // Any inbound platform message also proves liveness.
                    this.lastPongAt = Date.now();
                    this.onReceiverMessage(message);
                },
                onPongStats: report => {
                    // Only surface when the live-calibrated threshold
                    // diverges from the hard-coded one — steady state stays
                    // quiet. Logged in the extension background console (and
                    // echoed locally for a standalone bridge) so this
                    // Session.ts DEFAULT_HEARTBEAT_STALE_MS can be tuned from
                    // live data.
                    if (
                        report.suggestedThresholdMs === this.heartbeatStaleMs
                    ) {
                        return;
                    }
                    console.warn(
                        "[fx_cast_bilibili] session pong stats " +
                            "(threshold drift)",
                        report
                    );
                    this.messaging.sendMessage({
                        subject: "main:pongDiagnostics",
                        data: {
                            source: "session",
                            sessionId: this.sessionId,
                            configuredThresholdMs: this.heartbeatStaleMs,
                            report
                        }
                    });
                }
            })
            .then(() => {
                // Avoid a stale-timestamp false positive between construction
                // and the first PONG.
                this.lastPongAt = Date.now();

                // Send a launch request and store the request ID for reference
                this.launchRequestId = this.sendReceiverMessage({
                    type: "LAUNCH",
                    appId: this.appId
                });
            })
            .catch(() => {
                // Initial platform connection failed. A Session is one-shot
                // (no reconnect loop lives here — that's Remote's job), so
                // there is nothing to retry; the cast attempt simply fails.
                // TODO: surface this to the extension so the popup doesn't
                // stay stuck on "casting..." (e.g. emit cast:sessionStopped
                // or a dedicated launch-failed message).
            });

        // Handle client connection closed
        this.client.on("close", () => {
            if (this.tornDown) return;
            this.tornDown = true;

            if (this.sessionId) {
                messaging.sendMessage({
                    subject: "cast:sessionStopped",
                    data: { sessionId: this.sessionId }
                });

                // Let the owner drop this session from its registry so the
                // sessions map can't leak (see cast/index.ts).
                this.onSessionStopped?.(this.sessionId);
            }
        });
    }
}
