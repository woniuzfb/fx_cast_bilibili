import type { TypedMessagePort } from "../lib/TypedMessagePort";
import messaging, { type Message } from "../messaging";
import type { ReceiverDevice } from "../types";

import pageMessaging from "./pageMessaging";

// Ensure extension-side is initialized first
void pageMessaging.extension;

import CastSDK from "./sdk";

export type CastPort = TypedMessagePort<Message>;

let existingPort: CastPort | undefined;
let existingInstance = new CastSDK();

export default existingInstance;

interface EnsureInitOpts {
    /** Skip receiver selection. */
    receiverDevice?: ReceiverDevice;
}

/**
 * To support exporting the API from a module, we need to retain the
 * MessageChannel-based pageMessaging layer despite not crossing any
 * context boundaries.
 *
 * The ensureInit function creates a messaging connection to the
 * cast manager, hooks it up to the pageMessaging layer and also
 * provides a messaging port so consumers of this module can communicate
 * with the cast manager.
 */
export function ensureInit(opts?: EnsureInitOpts): Promise<CastPort> {
    return new Promise(async (resolve, reject) => {
        /**
         * Already initialized on this page.
         *
         * The page<->manager messaging layer and the exported `cast` SDK are
         * effectively one-shot per page load:
         *   - `media.ts` imports the default `cast` ONCE. Because
         *     `export default existingInstance` does not track later
         *     reassignment, importers keep pointing at the original SDK; the
         *     old `existingInstance = new CastSDK()` created an instance the
         *     injected sender never used.
         *   - `pageMessaging` performs a single INIT_MESSAGE handshake, and the
         *     old code closed its page port here and then returned that very
         *     (now-closed) port.
         * The net effect for a same-page re-cast (e.g. Bilibili after Stop) was
         * that the reused SDK's requestSession posted into a closed port, so the
         * background never received `main:requestSession` and the receiver
         * selector never opened (popup stuck on "Preparing receiver selector").
         *
         * Fix: for the non-trusted path (no receiverDevice), REUSE the existing
         * open channel + SDK instead of tearing them down. Combined with the
         * SDK's same-page reinit handling, the reused `cast` replays receiver
         * availability and drives requestSession over the still-connected
         * trusted-cast port, opening the proper App selector.
         */
        if (existingPort && !opts?.receiverDevice) {
            resolve(existingPort);
            return;
        }

        // If already initialized (trusted/mirroring re-init path)
        if (existingPort) {
            existingPort.close();
            existingInstance = new CastSDK();
        }

        const managerPort = messaging.connect({ name: "trusted-cast" });
        let initSettled = false;
        const resolveInit = () => {
            if (initSettled) return;
            initSettled = true;
            resolve(pageMessaging.page.messagePort);
        };
        const rejectInit = (error?: unknown) => {
            if (initSettled) return;
            initSettled = true;
            reject(error);
        };

        // Cast manager -> cast instance
        managerPort.onMessage.addListener(message => {
            if (message.subject === "cast:instanceCreated") {
                if (message.data.isAvailable) {
                    resolveInit();
                } else {
                    rejectInit(new Error("Cast instance unavailable"));
                }
            }

            pageMessaging.extension.sendMessage(message);
        });

        // Cast instance -> cast manager
        pageMessaging.extension.addListener(message => {
            // Skip receiver selection
            if (opts?.receiverDevice) {
                message = rewriteTrustedRequestSession(
                    message,
                    opts.receiverDevice
                );
            }

            managerPort.postMessage(message);
        });

        const openedPort = pageMessaging.page.messagePort;
        managerPort.onDisconnect.addListener(() => {
            pageMessaging.extension.close();
            if (existingPort === openedPort) existingPort = undefined;
            rejectInit(
                new Error("Cast background connection closed during initialization")
            );
        });

        existingPort = openedPort;
    });
}

/**
 * If a receiver device was passed to `ensureInit`, messages to the cast
 * manager will be passed through this function and the receiver device
 * will be added to the message payload. This tells the cast manager to
 * skip receiver selection when requesting a session.
 */
function rewriteTrustedRequestSession(
    message: Message,
    receiverDevice: ReceiverDevice
) {
    if (message.subject !== "main:requestSession") return message;
    message.data.receiverDevice = receiverDevice;
    return message;
}
