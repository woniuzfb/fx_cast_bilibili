/**
 * Roku integration entry point. Mirrors components/cast/index.ts: message
 * handlers for session creation/stop targeted at Roku devices. Everything
 * else (discovery events, status polling, media control translation) lives
 * in the sibling modules and is wired up by the bridge root (index.ts).
 */
import type { Messenger, Message } from "../../messaging";

import RokuSession from "./session";
import { keypress } from "./ecp";

const rokuSessions = new Map<string, RokuSession>();

/** Finds a tracked Roku session by ID. */
export function getRokuSession(sessionId: string) {
    return rokuSessions.get(sessionId);
}

/** True when the given session ID belongs to an emulated Roku session. */
export function isRokuSession(sessionId: string) {
    return rokuSessions.has(sessionId);
}

export function handleRokuMessage(messaging: Messenger, message: Message) {
    switch (message.subject) {
        case "bridge:createCastSession": {
            const { appId, receiverDevice } = message.data;

            const session = new RokuSession(
                appId,
                receiverDevice,
                messaging,
                sessionId => rokuSessions.delete(sessionId)
            );

            // Register by ID only after the constructor returns: the
            // constructor emits main:castSessionCreated synchronously and
            // any tracking callback closing over `session` would run before
            // initialization (TDZ) and kill the bridge process. Session-
            // scoped messages can only arrive in later stdin frames, so
            // registering here is race-free.
            rokuSessions.set(session.sessionId, session);

            break;
        }

        case "bridge:stopCastSession": {
            const { receiverDevice } = message.data;

            // Either stop the tracked session or fire a blind Home keypress.
            const tracked = [...rokuSessions.values()].find(session =>
                session.sessionId.startsWith(`roku-${receiverDevice.host}`)
            );
            if (tracked) {
                tracked.stop();
            } else {
                void keypress(receiverDevice.host, "Home").catch(err => {
                    console.warn(
                        "[fx_cast_bilibili] Roku stopCastSession failed",
                        {
                            host: receiverDevice.host,
                            error:
                                err instanceof Error ? err.message : String(err)
                        }
                    );
                });
            }

            break;
        }
    }
}

/**
 * Session-scoped message routing for emulated Roku sessions. Returns true
 * when the message was handled (the caller must not fall through to the
 * castv2 handler).
 */
export function handleRokuSessionMessage(
    messaging: Messenger,
    message: Message
): boolean {
    switch (message.subject) {
        case "bridge:sendCastReceiverMessage": {
            const { sessionId, messageData, messageId } = message.data;
            const session = rokuSessions.get(sessionId);
            if (!session) return false;

            try {
                session.sendReceiverMessage(messageData);
            } catch (err) {
                messaging.sendMessage({
                    subject: "cast:impl_sendMessage",
                    data: {
                        error: `Failed to send message (${err})`,
                        sessionId,
                        messageId
                    }
                });
                return true;
            }

            messaging.sendMessage({
                subject: "cast:impl_sendMessage",
                data: { sessionId, messageId }
            });
            return true;
        }

        case "bridge:sendCastSessionMessage": {
            const { sessionId, namespace, messageId } = message.data;
            const session = rokuSessions.get(sessionId);
            if (!session) return false;

            try {
                // Handle string messages like the castv2 handler does.
                let { messageData } = message.data;
                if (typeof messageData === "string") {
                    messageData = JSON.parse(messageData);
                }

                session.sendMessage(namespace, messageData);
            } catch (err) {
                messaging.sendMessage({
                    subject: "cast:impl_sendMessage",
                    data: {
                        error: `Failed to send message (${err})`,
                        sessionId,
                        messageId
                    }
                });
                return true;
            }

            messaging.sendMessage({
                subject: "cast:impl_sendMessage",
                data: { sessionId, messageId }
            });
            return true;
        }

        default:
            return false;
    }
}
