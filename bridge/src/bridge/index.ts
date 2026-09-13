import type { Messenger, Message } from "./messaging";

import { handleCastMessage } from "./components/cast";
import CastDeviceBrowser from "./components/cast/deviceBrowser";
import Remote from "./components/cast/remote";

import { handleRokuMessage, handleRokuSessionMessage } from "./components/roku";
import RokuDeviceBrowser from "./components/roku/deviceBrowser";
import RokuRemote from "./components/roku/remote";
import { RokuSessionMediaSync } from "./components/roku/sessionMediaSync";

import {
    mediaServerRequestId,
    startMediaServer,
    startRemoteMediaServer,
    stopMediaServer
} from "./components/mediaServer";

import { applicationVersion } from "../../config.json";

let deviceBrowser: CastDeviceBrowser | null = null;
const remotes = new Map<string, Remote>();
/** Roku devices discovered alongside cast devices; keyed by device ID. */
let rokuDeviceBrowser: RokuDeviceBrowser | null = null;
const rokuRemotes = new Map<string, RokuRemote>();
/**
 * Mirrors Roku session media onto the device's current LOAD generation.
 *
 * Both the generation and the media are pushed by the extension, in either
 * order, and the media may arrive before discovery has produced the remote for
 * that device. The module owns the resulting decision table (wait for the
 * generation, retire superseded media, ignore stragglers) and the cached
 * generation the remote is created with.
 */
const rokuSessionMediaSync = new RokuSessionMediaSync();

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
    // Keep the serialization queue permanently fulfilled. Callers intentionally
    // fire-and-forget this promise, so allowing the current command rejection to
    // escape becomes an unhandled rejection; Node 22 then terminates the native
    // messaging host and Firefox only reports an empty bridge disconnect.
    mediaServerCommandQueue = mediaServerCommandQueue
        .then(command)
        .catch(err => console.error("Media server command failed", err));
    return mediaServerCommandQueue;
}

/**
 * Last-resort guard for fire-and-forget promises. Node's default
 * `--unhandled-rejections=throw` terminates the native messaging host, and
 * Firefox then only reports an empty bridge disconnect — one escaped rejection
 * would silently kill every active session (Chromecast and Roku alike).
 *
 * Registered at module scope, so it covers both native messaging
 * (one process per connectNative) and daemon/WebSocket mode (daemon.ts runs
 * every connection in one process). This is a safety net, NOT a substitute for
 * local handling: every fire-and-forget call is still expected to consume its
 * own rejection.
 */
process.on("unhandledRejection", reason => {
    console.error(
        "[fx_cast_bilibili] Unhandled promise rejection",
        reason instanceof Error
            ? reason.stack ?? reason.message
            : String(reason)
    );
});

function shutdown(exitCode: number) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        deviceBrowser?.stop();
        deviceBrowser = null;
        rokuDeviceBrowser?.stop();
        rokuDeviceBrowser = null;
        for (const remote of remotes.values()) remote.disconnect();
        remotes.clear();
        for (const remote of rokuRemotes.values()) remote.disconnect();
        rokuRemotes.clear();
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

                // Roku discovery runs in parallel; devices surface through
                // the same main:deviceUp/main:deviceDown messages with
                // deviceType: "roku" so the extension treats them uniformly.
                rokuDeviceBrowser = new RokuDeviceBrowser();

                rokuDeviceBrowser.on("deviceUp", device => {
                    messaging.sendMessage({
                        subject: "main:deviceUp",
                        data: {
                            deviceId: device.id,
                            deviceInfo: device
                        }
                    });

                    if (shouldWatchStatus) {
                        const remote = new RokuRemote(device, {
                            // Must be a constructor option: the remote starts
                            // polling inside its constructor, so a later
                            // setLoadGeneration would miss the first sample.
                            initialLoadGeneration:
                                rokuSessionMediaSync.currentLoadGeneration(
                                    device.id
                                ),
                            onReceiverStatusUpdate(status) {
                                messaging.sendMessage({
                                    subject: "main:receiverDeviceStatusUpdated",
                                    data: {
                                        deviceId: device.id,
                                        status
                                    }
                                });
                            },
                            onPlaybackObservation(
                                loadGeneration,
                                status,
                                provenance
                            ) {
                                messaging.sendMessage({
                                    subject: "main:rokuPlaybackObservation",
                                    data: {
                                        deviceId: device.id,
                                        status,
                                        loadGeneration,
                                        provenance
                                    }
                                });
                            },
                            onMediaStatusUpdate(emission) {
                                // The clear arm is a local notification and
                                // never crosses the bridge (the extension
                                // would find no status to apply).
                                if (!emission.status) return;
                                messaging.sendMessage({
                                    subject:
                                        "main:receiverDeviceMediaStatusUpdated",
                                    data: {
                                        deviceId: device.id,
                                        status: emission.status,
                                        provenance: emission.provenance
                                    }
                                });
                            },
                            // Flattened buildStatusMedia snapshot: the
                            // nested MediaInformation/customData would
                            // otherwise collapse as `{…}` in the Firefox
                            // background console preview.
                            onStatusMediaDebug(debug) {
                                messaging.sendMessage({
                                    subject: "main:rokuStatusMediaDebug",
                                    data: debug
                                });
                            }
                        });

                        // Session media needs no replay here: the registry
                        // applies it as soon as the generation agrees, and
                        // observeRokuSessionMedia hands whatever is already
                        // registered to the observer the constructor installed.
                        rokuRemotes.set(device.id, remote);
                    }
                });

                rokuDeviceBrowser.on("deviceDown", deviceId => {
                    messaging.sendMessage({
                        subject: "main:deviceDown",
                        data: { deviceId }
                    });

                    if (shouldWatchStatus) {
                        if (rokuRemotes.has(deviceId)) {
                            rokuRemotes.get(deviceId)?.disconnect();
                            rokuRemotes.delete(deviceId);
                        }
                    }
                });

                rokuDeviceBrowser.start();
                break;
            }

            case "bridge:rokuSetSessionMedia": {
                // The payload carries the LOAD generation because that, not the
                // owner (whoever published last), is the media-identity key;
                // the module decides whether it may be applied yet.
                rokuSessionMediaSync.setSessionMedia(message.data);
                break;
            }

            case "bridge:rokuSetLoadGeneration": {
                const { deviceId, loadGeneration } = message.data;
                // The module caches the generation and applies any session
                // media that was waiting for it; whichever of the generation
                // and the remote arrives second wins the race.
                rokuSessionMediaSync.setLoadGeneration(
                    deviceId,
                    loadGeneration
                );
                rokuRemotes.get(deviceId)?.setLoadGeneration(loadGeneration);
                break;
            }

            case "bridge:rokuRequestConfirmationPoll": {
                const { deviceId } = message.data;
                rokuRemotes.get(deviceId)?.requestPlaybackConfirmationPoll();
                break;
            }

            case "bridge:sendReceiverMessage": {
                const { deviceId, message: receiverMessage } = message.data;

                // Roku devices route their NS_RECEIVER translations through
                // the ECP-backed remote.
                const rokuRemote = rokuRemotes.get(deviceId);
                if (rokuRemote) {
                    rokuRemote.sendReceiverMessage(receiverMessage);
                    break;
                }

                try {
                    remotes.get(deviceId)?.sendReceiverMessage(receiverMessage);
                } catch (err) {
                    // Sends throw once the underlying connection is gone.
                    console.warn(
                        "[fx_cast_bilibili] Failed to send receiver message",
                        {
                            deviceId,
                            type: receiverMessage.type,
                            error:
                                err instanceof Error ? err.message : String(err)
                        }
                    );
                }
                break;
            }
            case "bridge:sendMediaMessage": {
                const { deviceId, message: mediaMessage } = message.data;

                const rokuRemote = rokuRemotes.get(deviceId);
                if (rokuRemote) {
                    rokuRemote.sendMediaMessage(mediaMessage);
                    break;
                }

                try {
                    remotes.get(deviceId)?.sendMediaMessage(mediaMessage);
                } catch (err) {
                    console.warn(
                        "[fx_cast_bilibili] Failed to send media message",
                        {
                            deviceId,
                            type: mediaMessage.type,
                            error:
                                err instanceof Error ? err.message : String(err)
                        }
                    );
                }
                break;
            }

            case "bridge:createCastSession": {
                // Roku targets never speak the castv2 protocol; the Roku
                // components emulate the session surface over ECP instead.
                if (message.data.receiverDevice.deviceType === "roku") {
                    handleRokuMessage(messaging, message);
                    break;
                }

                // Heal the device's status watcher before creating the
                // session: after long idle periods (system sleep, dropped
                // idle TCP) the platform connection can be dead, which
                // would leave the popup stuck at "casting..." with no
                // RECEIVER_STATUS updates.
                remotes.get(message.data.receiverDevice.id)?.ensureConnected();

                handleCastMessage(messaging, message, sessionHeartbeatStaleMs);
                break;
            }

            case "bridge:stopCastSession": {
                if (message.data.receiverDevice.deviceType === "roku") {
                    handleRokuMessage(messaging, message);
                    break;
                }

                handleCastMessage(messaging, message);
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
                    startTime,
                    hlsLive,
                    rokuDashPrebuffer,
                    cctvDebugEnabled,
                    userAgent
                } = message.data;
                if (cctvDebugEnabled)
                    console.error("[fx_cast_bilibili] proxy requested", {
                        requestId,
                        host: new URL(mediaUrl).hostname,
                        hasSeparateAudio: Boolean(audioUrl),
                        port,
                        startTime,
                        hlsLive,
                        hasUserAgent: Boolean(userAgent)
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
                        startTime,
                        hlsLive,
                        userAgent,
                        cctvDebugEnabled,
                        rokuDashPrebuffer
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
                // Session-scoped messages for emulated Roku sessions are
                // routed first; castv2 sessions are the fallback.
                if (!handleRokuSessionMessage(messaging, message)) {
                    handleCastMessage(messaging, message);
                }
            }
        }
    });
}
