import type { Messenger, Message } from "./messaging";

import { handleCastMessage } from "./components/cast";
import CastDeviceBrowser from "./components/cast/deviceBrowser";
import Remote from "./components/cast/remote";

import { startMediaServer, startRemoteMediaServer, stopMediaServer } from "./components/mediaServer";

import { applicationVersion } from "../../config.json";

let deviceBrowser: CastDeviceBrowser | null = null;
const remotes = new Map<string, Remote>();
let shutdownPromise: Promise<void> | undefined;

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
                remotes.get(deviceId)?.sendReceiverMessage(receiverMessage);
                break;
            }
            case "bridge:sendMediaMessage": {
                const { deviceId, message: mediaMessage } = message.data;
                remotes.get(deviceId)?.sendMediaMessage(mediaMessage);
                break;
            }

            // Media server
            case "bridge:startMediaServer": {
                const { filePath, port } = message.data;
                startMediaServer(messaging, filePath, port);
                break;
            }
            case "bridge:startRemoteMediaServer": {
                const { mediaUrl, audioUrl, referer, contentType, port, startTime } = message.data;
                console.error("[fx_cast Bilibili] proxy requested", {
                    host: new URL(mediaUrl).hostname,
                    hasSeparateAudio: Boolean(audioUrl),
                    port,
                    startTime
                });
                startRemoteMediaServer(
                    messaging,
                    mediaUrl,
                    referer,
                    contentType,
                    port,
                    audioUrl,
                    startTime
                );
                break;
            }
            case "bridge:stopMediaServer": {
                stopMediaServer();
                break;
            }

            default: {
                handleCastMessage(messaging, message);
            }
        }
    });
}
