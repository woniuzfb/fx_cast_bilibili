import type { Messenger, Message } from "./messaging";

import { handleCastMessage } from "./components/cast";
import CastDeviceBrowser from "./components/cast/deviceBrowser";
import Remote from "./components/cast/remote";

import {
    mediaServerRequestId,
    startMediaServer,
    startRemoteMediaServer,
    stopMediaServer
} from "./components/mediaServer";

import { applicationVersion } from "../../config.json";

let deviceBrowser: CastDeviceBrowser | null = null;
const remotes = new Map<string, Remote>();
let shutdownPromise: Promise<void> | undefined;
let mediaServerCommandQueue: Promise<void> = Promise.resolve();

/**
 * Half-dead watchdog timeouts (ms) supplied by the extension via
 * `bridge:startDiscovery`. `undefined` means fall back to each component's
 * built-in default. `sessionHeartbeatStaleMs` is latched here at discovery
 * time and applied when a session is later created.
 */
let remoteHeartbeatStaleMs: number | undefined;
let sessionHeartbeatStaleMs: number | undefined;

function queueMediaServerCommand(command: () => Promise<void>) {
    mediaServerCommandQueue = mediaServerCommandQueue
        .catch(err => console.error("Previous media server command failed", err))
        .then(command);
    return mediaServerCommandQueue;
}

function shutdown(exitCode: number) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        deviceBrowser?.stop();
        deviceBrowser = null;
        for (const remote of remotes.values()) remote.disconnect();
        remotes.clear();
        try {
            await stopMediaServer();
        } catch (err) {
            console.error("Error stopping media server!", err);
        }
    })().finally(() => process.exit(exitCode));
    return shutdownPromise;
}

process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));

/**
 * Handle incoming messages from the extension and forward them to the
 * appropriate handlers.
 *
 * Initializes the counterpart objects and is responsible for managing existing
 * ones.
 */
export function run(messaging: Messenger) {
    // StdioMessenger emits this when Firefox closes native-messaging stdin.
    // Websocket messengers do not emit it, so daemon clients are unaffected.
    messaging.once("disconnect", () => void shutdown(0));
    messaging.on("message", (message: Message) => {
        switch (message.subject) {
            case "bridge:getInfo":
            case "bridge:/getInfo": {
                messaging.send(applicationVersion);
                break;
            }

            case "bridge:startDiscovery": {
                const { shouldWatchStatus } = message.data;

                // Latch user-configured watchdog timeouts (if provided) for
                // Remote (used immediately below) and Session (used when a
                // session is later created).
                remoteHeartbeatStaleMs = message.data.remoteHeartbeatStaleMs;
                sessionHeartbeatStaleMs = message.data.sessionHeartbeatStaleMs;

                deviceBrowser = new CastDeviceBrowser();

                deviceBrowser.on("deviceUp", device => {
                    messaging.sendMessage({
                        subject: "main:deviceUp",
                        data: {
                            deviceId: device.id,
                            deviceInfo: device
                        }
                    });

                    if (shouldWatchStatus) {
                        remotes.set(
                            device.id,
                            new Remote(device.host, {
                                port: device.port,
                                heartbeatStaleMs: remoteHeartbeatStaleMs,
                                // RECEIVER_STATUS
                                onReceiverStatusUpdate(status) {
                                    messaging.sendMessage({
                                        subject:
                                            "main:receiverDeviceStatusUpdated",
                                        data: {
                                            deviceId: device.id,
                                            status
                                        }
                                    });
                                },
                                // MEDIA_STATUS
                                onMediaStatusUpdate(status) {
                                    if (!status) return;

                                    messaging.sendMessage({
                                        subject:
                                            "main:receiverDeviceMediaStatusUpdated",
                                        data: {
                                            deviceId: device.id,
                                            status
                                        }
                                    });
                                },
                                // Heartbeat calibration for the platform
                                // watchdog (drift-gated inside Remote).
                                onPongDiagnostics({
                                    configuredThresholdMs,
                                    report
                                }) {
                                    messaging.sendMessage({
                                        subject: "main:pongDiagnostics",
                                        data: {
                                            source: "remote",
                                            deviceId: device.id,
                                            configuredThresholdMs,
                                            report
                                        }
                                    });
                                }
                            })
                        );
                    }
                });

                deviceBrowser.on("deviceDown", deviceId => {
                    messaging.sendMessage({
                        subject: "main:deviceDown",
                        data: { deviceId }
                    });

                    if (shouldWatchStatus) {
                        if (remotes.has(deviceId)) {
                            remotes.get(deviceId)?.disconnect();
                            remotes.delete(deviceId);
                        }
                    }
                });

                deviceBrowser.start();
                break;
            }

            case "bridge:sendReceiverMessage": {
                const { deviceId, message: receiverMessage } = message.data;
                try {
                    remotes
                        .get(deviceId)
                        ?.sendReceiverMessage(receiverMessage);
                } catch (err) {
                    // Sends throw once the underlying connection is gone.
                    console.warn(
                        "[fx_cast_bilibili] Failed to send receiver message",
                        {
                            deviceId,
                            type: receiverMessage.type,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err)
                        }
                    );
                }
                break;
            }
            case "bridge:sendMediaMessage": {
                const { deviceId, message: mediaMessage } = message.data;
                try {
                    remotes.get(deviceId)?.sendMediaMessage(mediaMessage);
                } catch (err) {
                    console.warn(
                        "[fx_cast_bilibili] Failed to send media message",
                        {
                            deviceId,
                            type: mediaMessage.type,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err)
                        }
                    );
                }
                break;
            }

            case "bridge:createCastSession": {
                // Heal the device's status watcher before creating the
                // session: after long idle periods (system sleep, dropped
                // idle TCP) the platform connection can be dead, which
                // would leave the popup stuck at "casting..." with no
                // RECEIVER_STATUS updates.
                remotes
                    .get(message.data.receiverDevice.id)
                    ?.ensureConnected();

                handleCastMessage(messaging, message, sessionHeartbeatStaleMs);
                break;
            }

            // Media server
            case "bridge:startMediaServer": {
                const { requestId, filePath, port } = message.data;
                void queueMediaServerCommand(() =>
                    startMediaServer(messaging, requestId, filePath, port)
                );
                break;
            }
            case "bridge:startRemoteMediaServer": {
                const {
                    requestId,
                    mediaUrl,
                    audioUrl,
                    referer,
                    contentType,
                    port,
                    startTime
                } = message.data;
                console.error("[fx_cast_bilibili] proxy requested", {
                    requestId,
                    host: new URL(mediaUrl).hostname,
                    hasSeparateAudio: Boolean(audioUrl),
                    port,
                    startTime
                });
                void queueMediaServerCommand(() =>
                    startRemoteMediaServer(
                        messaging,
                        requestId,
                        mediaUrl,
                        referer,
                        contentType,
                        port,
                        audioUrl,
                        startTime
                    )
                );
                break;
            }
            case "bridge:stopMediaServer": {
                const { requestId, force } = message.data;
                void queueMediaServerCommand(async () => {
                    if (!force && mediaServerRequestId !== requestId) {
                        console.error(
                            "[fx_cast_bilibili] ignored stale media server stop",
                            { requestId, owner: mediaServerRequestId }
                        );
                        return;
                    }
                    await stopMediaServer();
                });
                break;
            }

            default: {
                handleCastMessage(messaging, message);
            }
        }
    });
}
