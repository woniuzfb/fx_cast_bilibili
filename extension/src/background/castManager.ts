import bridge from "../lib/bridge";
import {
    type BaseConfig,
    baseConfigStorage,
    getAppTag
} from "../lib/chromecastConfigApi";
import logger from "../lib/logger";
import messaging, { type Message, type Port } from "../messaging";
import options from "../lib/options";
import type { TypedMessagePort } from "../lib/TypedMessagePort";

import {
    type ReceiverDevice,
    type ReceiverSelectorAppInfo,
    ReceiverSelectorMediaType,
    type ReceiverSelectorPageInfo
} from "../types";

import type { ApiConfig } from "../cast/sdk/classes";
import { AutoJoinPolicy, ReceiverAction } from "../cast/sdk/enums";
import { createReceiver } from "../cast/utils";

import ReceiverSelector, {
    type ReceiverSelection,
    type ReceiverSelectorMediaMessage,
    type ReceiverSelectorReceiverMessage
} from "./ReceiverSelector";

import deviceManager from "./deviceManager";
import { ActionState, updateActionState } from "./action";
import {
    armCctvPageCaptureIngest,
    beginCctvPageCapture,
    endCctvPageCapture,
    isCctvPageCaptureActive,
    pauseCctvPageCaptureIngest
} from "./cctvPageCapture";

type AnyPort = Port | TypedMessagePort<Message>;

export class CastInstanceDestroyedError extends Error {
    constructor(
        public readonly tabId: number,
        public readonly frameId: number
    ) {
        super(`Cast instance was destroyed for tab ${tabId}, frame ${frameId}`);
        this.name = "CastInstanceDestroyedError";
    }
}

export interface ContentContext {
    tabId: number;
    frameId: number;
    origin?: string;
}

/** Checks if two content contexts match. */
function isSameContext(ctx1?: ContentContext, ctx2?: ContentContext) {
    if (!ctx1 || !ctx2) return false;
    return ctx1?.tabId === ctx2?.tabId && ctx1?.frameId === ctx2?.frameId;
}

interface CastSession {
    bridgePort: Port;
    deviceId: string;
    appId: string;
    sessionId?: string;
    transportId?: string;
    autoJoinContexts: Set<ContentContext>;
}

/** Creates a cast session object and sets up messaging. */
async function createCastSession(opts: {
    deviceId: string;
    instance: CastInstance;
    appId?: string;
}) {
    // If not explicitly provided, use session request app ID
    if (!opts.appId) {
        if (!opts.instance.apiConfig?.sessionRequest) {
            throw logger.error(
                "App ID not provided and instance missing valid session request!"
            );
        }
        opts.appId = opts.instance.apiConfig.sessionRequest.appId;
    }

    const session: CastSession = {
        bridgePort: await bridge.connect(),
        deviceId: opts.deviceId,
        appId: opts.appId,
        autoJoinContexts: new Set()
    };

    if (opts.instance.contentContext) {
        session.autoJoinContexts.add(opts.instance.contentContext);
    }

    opts.instance.session = session;
    opts.instance.bridgeMessageListener = message => {
        handleBridgeMessage(opts.instance, message);
    };

    session.bridgePort.onMessage.addListener(
        opts.instance.bridgeMessageListener
    );
    session.bridgePort.onDisconnect.addListener(() =>
        destroyCastInstance(opts.instance)
    );

    if (opts.instance.contentContext?.tabId !== undefined) {
        updateActionState(
            ActionState.Connecting,
            opts.instance.contentContext?.tabId
        );
    }

    return session;
}

function joinSession(instance: CastInstance, session: CastSession) {
    if (!session.sessionId) return;

    instance.session = session;
    instance.bridgeMessageListener = message =>
        handleBridgeMessage(instance, message);

    session.bridgePort.onMessage.addListener(instance.bridgeMessageListener);
    session.bridgePort.onDisconnect.addListener(() =>
        destroyCastInstance(instance)
    );

    const device = deviceManager.getDeviceById(session.deviceId);
    if (!device?.status?.applications?.length) {
        throw logger.error("Invalid device state!");
    }

    /**
     * Re-create sessionCreated message. Since the
     * sender app hasn't requested a session, this
     * will be handled by calling the session
     * listener.
     */
    const application = device?.status?.applications[0];
    instance.contentPort.postMessage({
        subject: "cast:sessionCreated",
        data: {
            appId: application.appId,
            appImages: [],
            displayName: application.displayName,
            namespaces: application.namespaces,
            receiverFriendlyName: device.friendlyName,
            receiverId: device.id,
            senderApps: [],
            sessionId: session.sessionId,
            statusText: application.statusText,
            transportId: session.sessionId,
            volume: device.status.volume,

            receiver: createReceiver(device),
            media: device.mediaStatus
        }
    });

    if (instance.contentContext?.tabId !== undefined) {
        updateActionState(
            ActionState.Connected,
            instance.contentContext?.tabId
        );
    }
}

function leaveSession(instance: CastInstance) {
    if (!instance.session?.sessionId) return;

    instance.contentPort.postMessage({
        subject: "cast:sessionDisconnected",
        data: { sessionId: instance.session.sessionId }
    });

    delete instance.session;
    if (instance.contentContext?.tabId !== undefined) {
        updateActionState(ActionState.Default, instance.contentContext.tabId);
    }
}

export interface CastInstance {
    contentPort: AnyPort;
    contentContext?: ContentContext;

    /** From an extension-source, grants additional permissions. */
    isTrusted: boolean;

    /** ApiConfig provided on initialization. */
    apiConfig?: ApiConfig;
    /** Established session details. */
    session?: CastSession;

    /** Listener for bridge messages. */
    bridgeMessageListener?: (message: Message) => void;
}

/** Creates a cast instance object and associated bridge instance. */
function createCastInstance(opts: {
    contentPort: AnyPort;
    contentContext?: { tabId: number; frameId?: number };
    isTrusted?: boolean;
}) {
    const instance: CastInstance = {
        contentPort: opts.contentPort,
        isTrusted: opts.isTrusted ?? false
    };

    /**
     * Set content context with fallback to extension message sender
     * context for content scripts.
     */
    if (opts.contentContext) {
        instance.contentContext = {
            tabId: opts.contentContext.tabId,
            frameId: opts.contentContext.frameId ?? 0
        };
    } else if (
        !(opts.contentPort instanceof MessagePort) &&
        opts.contentPort.sender?.tab?.id
    ) {
        // Get origin from content port
        let origin: Optional<string>;
        if (opts.contentPort.sender?.tab?.url) {
            try {
                ({ origin } = new URL(opts.contentPort.sender.tab.url));
                // eslint-disable-next-line no-empty
            } catch {}
        }

        instance.contentContext = {
            tabId: opts.contentPort.sender.tab.id,
            frameId: opts.contentPort.sender.frameId ?? 0,
            origin
        };
    }

    return instance;
}

/** Removes cast instance and disconnects messaging ports. */
function destroyCastInstance(instance: CastInstance) {
    if (instance.contentPort instanceof MessagePort) {
        instance.contentPort.close();
    } else {
        instance.contentPort.disconnect();
    }

    if (instance.session && instance.bridgeMessageListener) {
        instance.session.bridgePort.onMessage.removeListener(
            instance.bridgeMessageListener
        );
    }

    // tabId 0 is a valid value and must not be skipped by a truthiness check.
    if (instance.contentContext?.tabId !== undefined) {
        updateActionState(ActionState.Default, instance.contentContext?.tabId);
        // A CCTV live capture session is bound to its cast instance's lifetime.
        if (isCctvPageCaptureActive(instance.contentContext.tabId)) {
            endCctvPageCapture(instance.contentContext.tabId);
        }
    }

    activeInstances.delete(instance);
}

/**
 * Check instance's auto join policy against a content context to
 * determine if it's a valid auto join target.
 */
function isValidAutoJoinContext(
    instance: CastInstance,
    context: ContentContext
) {
    if (!instance.apiConfig?.autoJoinPolicy) return false;

    const { autoJoinPolicy } = instance.apiConfig;
    if (
        autoJoinPolicy === AutoJoinPolicy.ORIGIN_SCOPED ||
        autoJoinPolicy === AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED
    ) {
        // Check origin
        if (context.origin !== instance.contentContext?.origin) return false;
        // If tab-scoped, check context
        if (
            autoJoinPolicy === AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED &&
            !isSameContext(context, instance.contentContext)
        )
            return false;

        return true;
    }

    return false;
}

interface AutoJoinTarget {
    session: CastSession;
    autoJoinContext: ContentContext;
}
function findAutoJoinTarget(instance: CastInstance) {
    for (const [, session] of activeSessions) {
        if (
            !session.sessionId ||
            session.appId !== instance.apiConfig?.sessionRequest.appId
        )
            continue;

        for (const context of session.autoJoinContexts) {
            if (isValidAutoJoinContext(instance, context)) {
                return { session, autoJoinContext: context } as AutoJoinTarget;
            }
        }
    }
}

/** Whitelist of safe message types from content. */
const allowedContentMessages: Array<Message["subject"]> = [
    "main:initializeCastSdk",
    "main:requestSession",
    "main:requestSessionById",
    "main:leaveSession",
    "bridge:sendCastReceiverMessage",
    "bridge:sendCastSessionMessage"
];

/** Chromecast base config to check compatibility with audio devices. */
let baseConfig: BaseConfig;
/** Shared receiver selector. */
const receiverSelectors = new Map<number, ReceiverSelector>();

interface QueuedReceiverSelection {
    selection: ReceiverSelection;
    tabId: number;
    frameId: number;
    expiresAt: number;
}

/** A manual popup selection waiting for a freshly-created page Cast request. */
let queuedReceiverSelection: Optional<QueuedReceiverSelection>;
const QUEUED_RECEIVER_SELECTION_TTL_MS = 10_000;

/** Set of active cast instances.  */
const activeInstances = new Set<CastInstance>();

/** Map of active session IDs to session info objects. */
const activeSessions = new Map<string, CastSession>();

/** Keeps track of cast API instances and provides bridge messaging. */
const castManager = new (class {
    async init() {
        // Handle incoming instance connections
        messaging.onConnect.addListener(async port => {
            if (port.name === "cast") {
                this.createInstance(port);
            } else if (port.name === "trusted-cast") {
                // Create trusted instance
                this.createInstance(port, undefined, true);
            }
        });

        // Pass receiver availability updates to cast API
        const updateReceiverAvailability = () => {
            const isAvailable = deviceManager.getDevices().length > 0;

            for (const instance of activeInstances) {
                instance.contentPort.postMessage({
                    subject: "cast:receiverAvailabilityUpdated",
                    data: { isAvailable }
                });
            }
        };

        deviceManager.addEventListener("deviceUp", updateReceiverAvailability);
        deviceManager.addEventListener(
            "deviceDown",
            updateReceiverAvailability
        );

        deviceManager.addEventListener("applicationClosed", ev => {
            const session = activeSessions.get(ev.detail.sessionId);
            if (!session?.sessionId) return;

            // Remove session from instances and notify SDK
            for (const instance of activeInstances) {
                if (instance.session === session) {
                    instance.contentPort.postMessage({
                        subject: "cast:sessionStopped",
                        data: { sessionId: session.sessionId }
                    });

                    delete instance.session;

                    if (instance.contentContext?.tabId !== undefined) {
                        updateActionState(
                            ActionState.Default,
                            instance.contentContext.tabId
                        );
                    }
                }
            }

            activeSessions.delete(session.sessionId);
        });
    }

    /**
     * Finds a cast instance at the given tab (and optionally frame) ID.
     */
    getInstanceAt(tabId: number, frameId?: number) {
        for (const instance of activeInstances) {
            if (instance.contentContext?.tabId === tabId) {
                // If frame ID doesn't match go to next instance
                if (frameId && instance.contentContext.frameId !== frameId) {
                    continue;
                }

                return instance;
            }
        }
    }

    getInstanceByDeviceId(deviceId: string) {
        for (const instance of activeInstances) {
            if (instance.session?.deviceId === deviceId) return instance;
        }
    }

    /**
     * Creates a cast instance with a given port and connects messaging
     * correctly depending on the type of port.
     */
    async createInstance(
        port: AnyPort,
        contentContext?: ContentContext,
        isTrusted?: boolean
    ) {
        const instance = await (port instanceof MessagePort
            ? this.createInstanceFromBackground(port, contentContext)
            : this.createInstanceFromContent(port, isTrusted));

        activeInstances.add(instance);

        instance.contentPort.postMessage({
            subject: "cast:instanceCreated",
            data: { isAvailable: (await bridge.getInfo()).isVersionCompatible }
        });

        return instance;
    }

    /** Creates a cast instance with a `MessagePort` content port. */
    private async createInstanceFromBackground(
        contentPort: MessagePort,
        contentContext?: ContentContext
    ): Promise<CastInstance> {
        const instance = createCastInstance({
            contentPort,
            contentContext,
            isTrusted: true
        });

        // Ensure only one instance per context
        if (contentContext) {
            for (const instance of activeInstances) {
                if (isSameContext(instance.contentContext, contentContext)) {
                    destroyCastInstance(instance);
                    break;
                }
            }
        }

        // cast instance -> (any)
        contentPort.addEventListener("message", ev => {
            handleContentMessage(instance, ev.data);
        });
        contentPort.start();

        return instance;
    }

    /**
     * Creates a cast instance with a WebExtension `Port` content port.
     */
    private async createInstanceFromContent(
        contentPort: Port,
        isTrusted?: boolean
    ): Promise<CastInstance> {
        if (
            contentPort.sender?.tab?.id === undefined ||
            contentPort.sender?.frameId === undefined
        ) {
            throw logger.error(
                "Cast instance created from content with an invalid port context."
            );
        }

        const instance = createCastInstance({ contentPort, isTrusted });

        // cast instance -> (any)
        const onContentPortMessage = (message: Message) => {
            handleContentMessage(instance, message);
        };

        contentPort.onMessage.addListener(onContentPortMessage);
        contentPort.onDisconnect.addListener(() => {
            destroyCastInstance(instance);
        });

        return instance;
    }

    /**
     * Queues a receiver chosen in a control-only popup for the next Cast request
     * created by the same tab. This bridges Stop -> Cast without reusing the
     * selector Promise that created the stopped session.
     */
    queueReceiverSelection(
        tabId: number,
        selection: ReceiverSelection,
        frameId = 0
    ) {
        queuedReceiverSelection = {
            selection,
            tabId,
            frameId,
            expiresAt: Date.now() + QUEUED_RECEIVER_SELECTION_TTL_MS
        };
    }

    /**
     * Gets a receiver selection and loads the appropriate sender for a
     * given context.
     */
    async triggerCast(tabId: number, frameId = 0) {
        let selection: Nullable<ReceiverSelection>;
        try {
            selection = await getReceiverSelection({ tabId, frameId });
        } catch (err) {
            if (err instanceof CastInstanceDestroyedError) throw err;
            logger.error("Failed to get receiver selection (triggerCast)", err);
            return;
        }

        if (!selection) return;

        // Await + catch so a failing loadSender (e.g. App media type selected but
        // no cast instance exists for the tab) is surfaced instead of silently
        // swallowed. Previously the unhandled rejection left the popup stuck on
        // "Casting..." forever.
        try {
            await loadSender(selection, { tabId, frameId });
        } catch (err) {
            logger.error("loadSender failed (triggerCast)", {
                mediaType: selection.mediaType,
                tabId,
                frameId,
                err: err instanceof Error ? err.message : String(err)
            });
        }
    }
})();

export default castManager;

/** Handles messages to cast instances from bridge. */
async function handleBridgeMessage(instance: CastInstance, message: Message) {
    // Surface live HLS relay diagnostics in the background console. These are
    // purely informational and are not forwarded to the content port.
    if (message.subject === "mediaCast:relayDebug") {
        // requestId is required on the bridge protocol envelope, but repeating the
        // full UUID in every high-volume segment log wastes the Firefox console
        // preview budget and hides the actual decrypt diagnostics.
        const { event, requestId: _requestId, ...rest } = message.data;
        void _requestId;
        const stored = (await browser.storage.sync.get("options")) as {
            options?: { cctvDebugEnabled?: boolean };
        };
        if (stored.options?.cctvDebugEnabled)
            logger.info(`[relay] ${event}`, rest);
        // Push /seg serves PAST the initial prebuffer window to the page sender.
        // The event fires only after the slot resolved, so a receiver that keeps
        // being served content is alive; one that requests but starves (bridge
        // waiting on the page watermark forever) correctly gets no credit. Slots
        // carry their measured duration so the sender's liveness credit matches
        // the content actually served instead of the nominal segment cadence.
        if (event === "receiver segment served") {
            instance.contentPort.postMessage({
                subject: "mediaCast:relaySegmentRequested",
                data: {
                    durationSeconds:
                        typeof rest.durationSeconds === "number"
                            ? rest.durationSeconds
                            : undefined
                }
            });
        } else if (event === "receiver prebuffer segment served") {
            // Keep cached prebuffer activity separate from steady-state liveness
            // because its cadence is arbitrary.
            instance.contentPort.postMessage({
                subject: "mediaCast:relayPrebufferSegmentRequested",
                data: {}
            });
        }
        return;
    }

    // Intercept messages to store relevant info
    switch (message.subject) {
        case "mediaCast:mediaServerStarted": {
            // Synthetic-DVR live relay is listening: switch the tab's page TS
            // capture from buffering to POST-ingest and flush the restart gap.
            // liveEdgeBaseSeconds is only ever set by the live relay path.
            const tabId = instance.contentContext?.tabId;
            if (
                tabId !== undefined &&
                isCctvPageCaptureActive(tabId) &&
                typeof message.data.liveEdgeBaseSeconds === "number"
            ) {
                armCctvPageCaptureIngest(tabId, message.data.requestId);
            }
            break;
        }

        case "mediaCast:mediaServerStopped":
        case "mediaCast:mediaServerError": {
            const tabId = instance.contentContext?.tabId;
            if (tabId !== undefined && isCctvPageCaptureActive(tabId)) {
                pauseCctvPageCaptureIngest(tabId, message.data.requestId);
            }
            break;
        }

        case "main:castSessionCreated": {
            // Keep the receiver selector alive as the browser-action
            // control channel for the lifetime of the Cast session.
            const { receiverId: deviceId } = message.data;

            if (!instance.session) {
                logger.error("Instance is missing session!");
                break;
            }

            instance.session.sessionId = message.data.sessionId;
            instance.session.transportId = message.data.transportId;
            activeSessions.set(message.data.sessionId, instance.session);
            refreshReceiverSelector();

            const device = deviceManager.getDeviceById(deviceId);
            if (!device) {
                logger.error(
                    "[on main:castSessionCreated]: Could not find device with ID:",
                    deviceId
                );
                break;
            }

            instance.contentPort.postMessage({
                subject: "cast:sessionCreated",
                data: {
                    ...message.data,
                    receiver: createReceiver(device)
                }
            });

            if (instance.contentContext?.tabId !== undefined) {
                updateActionState(
                    ActionState.Connected,
                    instance.contentContext?.tabId
                );
            }

            break;
        }

        case "main:castSessionUpdated":
            instance.contentPort.postMessage({
                subject: "cast:sessionUpdated",
                data: message.data
            });
    }

    instance.contentPort.postMessage(message);
}

/**
 * Handle content messages from the cast instance. These will either
 * be handled here in the background script or forwarded to the
 * bridge associated with the cast instance.
 */
async function handleContentMessage(instance: CastInstance, message: Message) {
    // Limit untrusted instances to allowed messages subset
    if (
        !allowedContentMessages.includes(message.subject) &&
        !instance.isTrusted
    ) {
        logger.error(`Forbidden message type! (${message.subject})`);
        destroyCastInstance(instance);
        return;
    }

    const [destination] = message.subject.split(":");
    if (destination === "bridge") {
        instance.session?.bridgePort.postMessage(message);
    }

    switch (message.subject) {
        case "bridge:startRemoteMediaServer": {
            // CCTV live relay (initial cast AND every recovery rebuild): start the
            // page TS capture session for this tab. The endpoint is armed only when
            // the relay reports listening (mediaServerStarted). cdrmld-seeded relays
            // run heartbeat-only capture: the page plays the enc1/AV1 tree while
            // the relay serves cdrmld H.264, so only the request timestamps (the
            // page download progress watermark) matter, never the bytes.
            if (
                message.data.hlsLive &&
                instance.contentContext?.tabId !== undefined
            ) {
                beginCctvPageCapture(
                    instance.contentContext.tabId,
                    {
                        port: message.data.port,
                        requestId: message.data.requestId
                    },
                    /cdrmld/i.test(message.data.mediaUrl)
                );
            }
            break;
        }

        case "main:initializeCastSdk": {
            instance.apiConfig = message.data.apiConfig;
            instance.contentPort.postMessage({
                subject: "cast:receiverAvailabilityUpdated",
                data: {
                    isAvailable: deviceManager.getDevices().length > 0
                }
            });

            // No need to check for existing sessions if page-scoped
            if (
                instance.apiConfig.autoJoinPolicy === AutoJoinPolicy.PAGE_SCOPED
            ) {
                break;
            }

            // Check existing sessions for a valid auto join target
            const target = findAutoJoinTarget(instance);
            if (target) joinSession(instance, target.session);

            break;
        }

        // User has triggered receiver selection via the cast API
        case "main:requestSession": {
            const { sessionRequest, receiverDevice } = message.data;

            // Handle trusted instance receiver selection bypass
            if (receiverDevice) {
                const contextSelector = instance.contentContext
                    ? receiverSelectors.get(instance.contentContext.tabId)
                    : undefined;
                if (contextSelector?.isOpen && instance.contentContext) {
                    contextSelector.pageInfo = {
                        ...instance.contentContext,
                        url: (
                            await browser.webNavigation.getFrame({
                                tabId: instance.contentContext?.tabId,
                                frameId: instance.contentContext?.frameId
                            })
                        ).url
                    };
                }

                if (!instance.isTrusted) {
                    logger.error(
                        "Cast instance not trusted to bypass receiver selection!"
                    );
                    destroyCastInstance(instance);
                    break;
                }

                const session = await createCastSession({
                    instance,
                    deviceId: receiverDevice.id,
                    appId: sessionRequest.appId
                });

                session.bridgePort.postMessage({
                    subject: "bridge:createCastSession",
                    data: {
                        appId: sessionRequest.appId,
                        receiverDevice
                    }
                });

                break;
            }

            try {
                logger.info("Waiting for receiver selection", {
                    tabId: instance.contentContext?.tabId,
                    frameId: instance.contentContext?.frameId,
                    appId: sessionRequest.appId
                });
                const selection = await getReceiverSelection({
                    castInstance: instance
                });
                // Distinguish a real selection from the popup being closed
                // without clicking Cast (selector cancelled -> null), instead
                // of logging `selected: false` plus two undefined fields.
                if (selection) {
                    logger.info("Receiver selection completed", {
                        tabId: instance.contentContext?.tabId,
                        deviceId: selection.device.id,
                        mediaType: selection.mediaType
                    });
                } else {
                    logger.info("Receiver selection cancelled", {
                        tabId: instance.contentContext?.tabId
                    });
                }

                // Handle cancellation
                if (!selection) {
                    instance.contentPort.postMessage({
                        subject: "cast:sessionRequestCancelled"
                    });

                    break;
                }

                /**
                 * If the media type returned from the selector has
                 * been changed, we need to cancel the current
                 * sender and switch it out for the right one.
                 */
                if (selection.mediaType !== ReceiverSelectorMediaType.App) {
                    instance.contentPort.postMessage({
                        subject: "cast:sessionRequestCancelled"
                    });

                    if (!instance.contentContext) {
                        throw logger.error("Missing content context");
                    }
                    loadSender(selection, instance.contentContext);

                    break;
                }

                instance.contentPort.postMessage({
                    subject: "cast:receiverAction",
                    data: {
                        receiver: createReceiver(selection.device),
                        action: ReceiverAction.CAST
                    }
                });

                logger.info("Creating Cast session", {
                    deviceId: selection.device.id,
                    appId: sessionRequest.appId
                });
                const session = await createCastSession({
                    instance,
                    deviceId: selection.device.id,
                    appId: sessionRequest.appId
                });
                logger.info("Cast bridge channel ready; launching receiver", {
                    deviceId: selection.device.id,
                    appId: sessionRequest.appId
                });

                session.bridgePort.postMessage({
                    subject: "bridge:createCastSession",
                    data: {
                        appId: sessionRequest.appId,
                        receiverDevice: selection.device
                    }
                });
            } catch (err) {
                logger.error("Session request failed in cast manager", err);
                instance.contentPort.postMessage({
                    subject: "cast:sessionRequestCancelled"
                });
            }

            break;
        }

        case "main:requestSessionById": {
            const session = activeSessions.get(message.data.sessionId);
            if (!session) {
                logger.log(
                    `Session not found! (id: ${message.data.sessionId})`
                );
                break;
            }

            if (instance.apiConfig?.sessionRequest.appId === session.appId) {
                joinSession(instance, session);

                // If requesting by ID, add to the list of auto join contexts
                if (instance.contentContext) {
                    session.autoJoinContexts.add(instance.contentContext);
                }
            }

            break;
        }

        case "main:leaveSession": {
            if (!instance.contentContext || !instance.session?.sessionId) {
                logger.error("Cannot leave session, instance invalid!");
                break;
            }

            // Find auto join target for this instance
            const target = findAutoJoinTarget(instance);
            if (target) {
                // Remove auto join context for future instances
                instance.session.autoJoinContexts.delete(
                    target.autoJoinContext
                );

                const sessionAppId = instance.session.appId;
                leaveSession(instance);

                /**
                 * Disconnect other instances within the scope of this
                 * instances's auto join policy.
                 */
                for (const activeInstance of activeInstances) {
                    if (
                        (activeInstance === instance ||
                            activeInstance.session?.appId) !== sessionAppId
                    )
                        continue;

                    if (
                        isValidAutoJoinContext(
                            activeInstance,
                            target.autoJoinContext
                        )
                    ) {
                        leaveSession(activeInstance);
                    }
                }
            } else {
                leaveSession(instance);
            }
        }
    }
}

/**
 * Loads the appropriate sender for a given receiver selector response.
 */
async function loadSender(
    selection: ReceiverSelection,
    contentContext: ContentContext
) {
    // Cancelled
    if (!selection) {
        return;
    }

    logger.info("loadSender", {
        mediaType: selection.mediaType,
        isApp: selection.mediaType === ReceiverSelectorMediaType.App,
        isScreen: selection.mediaType === ReceiverSelectorMediaType.Screen,
        tabId: contentContext.tabId,
        frameId: contentContext.frameId
    });

    switch (selection.mediaType) {
        case ReceiverSelectorMediaType.App: {
            const instance = castManager.getInstanceAt(
                contentContext.tabId,
                contentContext.frameId
            );
            logger.info("loadSender App branch", {
                instanceFound: Boolean(instance),
                hasApiConfig: Boolean(
                    instance?.apiConfig?.sessionRequest.appId
                ),
                tabId: contentContext.tabId,
                frameId: contentContext.frameId
            });
            if (!instance) {
                throw logger.error(
                    `Cast instance not found at tabId ${contentContext.tabId} / frameId ${contentContext.frameId}`
                );
            }

            if (!instance.apiConfig?.sessionRequest.appId) {
                throw logger.error("Invalid session request");
            }

            instance.contentPort.postMessage({
                subject: "cast:receiverAction",
                data: {
                    receiver: createReceiver(selection.device),
                    action: ReceiverAction.CAST
                }
            });

            const session = await createCastSession({
                instance,
                deviceId: selection.device.id
            });

            session.bridgePort.postMessage({
                subject: "bridge:createCastSession",
                data: {
                    appId: session.appId,
                    receiverDevice: selection.device
                }
            });

            break;
        }

        case ReceiverSelectorMediaType.Screen:
            await createMirroringPopup(selection.device);
            break;
    }
}

/**
 * Opens a receiver selector with the specified default/available media
 * types.
 *
 * Returns a promise that:
 *   - Resolves to a ReceiverSelection object if selection is
 *      successful.
 *   - Resolves to null if the selection is cancelled.
 *   - Rejects if the selection fails.
 */
async function getReceiverSelection(selectionOpts: {
    tabId?: number;
    frameId?: number;
    castInstance?: CastInstance;
}): Promise<ReceiverSelection | null> {
    // Normalize the context before the first await and remember whether this
    // request started with a live page Cast instance. If that instance vanishes
    // while options/frame data is loading, do not open a generic selector.
    const initialInstance = selectionOpts.castInstance;
    if (selectionOpts.tabId === undefined && initialInstance?.contentContext) {
        selectionOpts.tabId = initialInstance.contentContext.tabId;
        selectionOpts.frameId = initialInstance.contentContext.frameId;
    }
    if (selectionOpts.frameId === undefined) selectionOpts.frameId = 0;
    const instanceAtEntry =
        initialInstance ??
        (selectionOpts.tabId !== undefined
            ? castManager.getInstanceAt(
                  selectionOpts.tabId,
                  selectionOpts.frameId
              )
            : undefined);

    /**
     * If the current context is running the mirroring app, pretend
     * it doesn't exist because it shouldn't be launched like this.
     */
    const ignorePageInstance =
        initialInstance?.apiConfig?.sessionRequest.appId ===
        (await options.get("mirroringAppId"));

    let defaultMediaType = ReceiverSelectorMediaType.Screen;
    let availableMediaTypes = ReceiverSelectorMediaType.Screen;

    const opts = await options.getAll();

    /**
     * If context supplied, but no instance, check for an instance at
     * that context.
     */
    if (
        selectionOpts.tabId !== undefined &&
        selectionOpts.frameId !== undefined
    ) {
        const contextInstance = castManager.getInstanceAt(
            selectionOpts.tabId,
            selectionOpts.frameId
        );
        if (instanceAtEntry && contextInstance !== instanceAtEntry) {
            throw new CastInstanceDestroyedError(
                selectionOpts.tabId,
                selectionOpts.frameId
            );
        }

        // Preserve the exact active instance that initiated requestSession,
        // including trusted page senders such as Bilibili. Trust only controls
        // receiver-selection bypass; it does not make an App selector generic.
        selectionOpts.castInstance = ignorePageInstance
            ? undefined
            : contextInstance;
    }

    let pageInfo: Optional<ReceiverSelectorPageInfo>;
    if (selectionOpts.tabId !== undefined) {
        try {
            pageInfo = {
                tabId: selectionOpts.tabId,
                frameId: selectionOpts.frameId,
                url: (
                    await browser.webNavigation.getFrame({
                        tabId: selectionOpts.tabId,
                        frameId: selectionOpts.frameId
                    })
                ).url
            };
        } catch (err) {
            logger.error("Failed to locate frame!", err);
        }
    }

    let appInfo: Optional<ReceiverSelectorAppInfo>;
    if (selectionOpts.castInstance?.apiConfig) {
        if (!baseConfig) {
            try {
                ({ baseConfig } = await baseConfigStorage.get("baseConfig"));
            } catch (err) {
                throw logger.error("Failed to get Chromecast base config!");
            }
        }

        appInfo = {
            sessionRequest: selectionOpts.castInstance.apiConfig.sessionRequest,
            isRequestAppAudioCompatible: getAppTag(
                baseConfig,
                selectionOpts.castInstance.apiConfig?.sessionRequest.appId
            )?.supports_audio_only
        };

        // Enable app media type if sender application is present
        defaultMediaType = ReceiverSelectorMediaType.App;
        availableMediaTypes |= ReceiverSelectorMediaType.App;
    }

    // Disable mirroring media types if mirroring is not enabled
    if (!opts.mirroringEnabled) {
        availableMediaTypes &= ~ReceiverSelectorMediaType.Screen;
    }

    // Ensure status manager is initialized
    await deviceManager.init();

    const queuedSelection = queuedReceiverSelection;
    if (queuedSelection) {
        const matchesContext =
            queuedSelection.tabId === selectionOpts.tabId &&
            queuedSelection.frameId === selectionOpts.frameId;
        const isCurrent = queuedSelection.expiresAt >= Date.now();
        const isAvailable = Boolean(
            availableMediaTypes & queuedSelection.selection.mediaType
        );
        const deviceStillExists = Boolean(
            deviceManager.getDeviceById(queuedSelection.selection.device.id)
        );

        if (matchesContext || !isCurrent) {
            queuedReceiverSelection = undefined;
        }

        if (matchesContext && isCurrent && isAvailable && deviceStillExists) {
            logger.info("Using queued popup receiver selection", {
                tabId: selectionOpts.tabId,
                frameId: selectionOpts.frameId,
                mediaType: queuedSelection.selection.mediaType,
                deviceId: queuedSelection.selection.device.id
            });
            return queuedSelection.selection;
        }
    }

    return new Promise(async (resolve, reject) => {
        // Close an existing open selector. This is the exact point where a good
        // (App / Cast-button) selector opened by the page's requestSession can be
        // clobbered by a later generic launch. Log it loudly with the incoming
        // context so the race is visible in the background console.
        const selectionContext = {
            hasCastInstance: Boolean(selectionOpts.castInstance),
            tabId: selectionOpts.tabId,
            frameId: selectionOpts.frameId,
            defaultMediaType,
            availableMediaTypes,
            appInfoPresent: Boolean(appInfo),
            t: Date.now()
        };
        const selectorTabId = selectionOpts.tabId ?? -1;
        const previousSelector = receiverSelectors.get(selectorTabId);
        if (previousSelector?.isOpen) {
            logger.info(
                "getReceiverSelection: closing selector for the same tab before replacement",
                selectionContext
            );
            await previousSelector.close();
        } else {
            logger.info(
                "getReceiverSelection: no same-tab selector to close",
                selectionContext
            );
        }
        const selector = createSelector(selectorTabId);
        receiverSelectors.set(selectorTabId, selector);

        // Handle selected return value
        const onSelected = (ev: CustomEvent<ReceiverSelection>) =>
            resolve(ev.detail);
        selector.addEventListener("selected", onSelected);

        // Handle cancelled return value
        const onCancelled = () => resolve(null);
        selector.addEventListener("cancelled", onCancelled);

        const onError = (ev: CustomEvent<string>) => reject(ev.detail);
        selector.addEventListener("error", onError);

        // Cleanup listeners and remove only this tab's exact selector instance.
        selector.addEventListener(
            "close",
            () => {
                selector.removeEventListener("selected", onSelected);
                selector.removeEventListener("cancelled", onCancelled);
                selector.removeEventListener("error", onError);
                if (receiverSelectors.get(selectorTabId) === selector) {
                    receiverSelectors.delete(selectorTabId);
                }
            },
            { once: true }
        );

        const devices = deviceManager.getDevices();
        logger.info("Opening receiver selector", {
            deviceCount: devices.length,
            defaultMediaType,
            availableMediaTypes,
            // availableMediaTypes === 0 means the generic device-only view (no Cast
            // button) — for Bilibili this is the "wrong" selector that indicates no
            // cast instance was found for the tab (session already torn down).
            isGenericDeviceOnly: availableMediaTypes === 0,
            hasCastInstance: Boolean(selectionOpts.castInstance),
            appInfoPresent: Boolean(appInfo),
            pageUrl: pageInfo?.url
        });
        // Include currently-owned session IDs so the popup can show the Stop
        // button for an active session as soon as it connects (e.g. clicking the
        // extension while a Bilibili cast is already running).
        const connectedTransportIds: string[] = [];
        for (const instance of activeInstances) {
            // Popup ownership is keyed by the receiver application's transportId,
            // which is distinct from the Cast sessionId.
            if (instance.session?.transportId) {
                connectedTransportIds.push(instance.session.transportId);
            }
        }
        void selector
            .open({
                devices,
                defaultMediaType,
                availableMediaTypes,
                appInfo,
                pageInfo,
                connectedTransportIds
            })
            .then(() => logger.info("Receiver selector opened"))
            .catch(err => {
                logger.error("Receiver selector failed to open", err);
                onError(
                    new CustomEvent("error", {
                        detail: err instanceof Error ? err.message : String(err)
                    })
                );
            });
    });
}

/** Pushes the current device/session state to the receiver selector. */
function refreshReceiverSelector() {
    if (receiverSelectors.size === 0) return;
    const connectedTransportIds: string[] = [];
    for (const instance of activeInstances) {
        // Popup ownership is keyed by the receiver application's transportId,
        // which is distinct from the Cast sessionId.
        if (instance.session?.transportId) {
            connectedTransportIds.push(instance.session.transportId);
        }
    }
    for (const selector of receiverSelectors.values()) {
        selector.update(
            deviceManager.getDevices(),
            deviceManager.getBridgeInfo()?.isVersionCompatible ?? false,
            connectedTransportIds
        );
    }
}

/**
 * Creates new ReceiverSelector object and adds listeners for
 * updates/messages.
 */
function createSelector(tabId: number) {
    // Get a new selector for each tab-scoped selection.
    const selector = new ReceiverSelector(
        deviceManager.getBridgeInfo()?.isVersionCompatible ?? false,
        tabId
    );

    /**
     * Sends message to cast instance to trigger stopped receiver action
     * (if applicable).
     */
    const onStop = (ev: CustomEvent<{ deviceId: string }>) => {
        const tabInstance = castManager.getInstanceAt(selector.tabId);
        const castInstance =
            tabInstance?.session?.deviceId === ev.detail.deviceId
                ? tabInstance
                : castManager.getInstanceByDeviceId(ev.detail.deviceId);
        if (!castInstance) return;

        logger.info("Routing receiver Stop", {
            selectorTabId: selector.tabId,
            instanceTabId: castInstance.contentContext?.tabId,
            deviceId: ev.detail.deviceId,
            usedDeviceFallback: castInstance !== tabInstance
        });

        const device = deviceManager.getDeviceById(ev.detail.deviceId);
        if (!device) return;

        castInstance.session?.bridgePort.postMessage({
            subject: "bridge:stopMediaServer",
            data: { force: true }
        });
        castInstance.contentPort.postMessage({
            subject: "cast:receiverAction",
            data: {
                receiver: createReceiver(device),
                action: ReceiverAction.STOP
            }
        });
    };
    selector.addEventListener("stop", onStop);

    // Forward receiver messages
    const onReceiverMessage = (
        ev: CustomEvent<ReceiverSelectorReceiverMessage>
    ) =>
        deviceManager.sendReceiverMessage(
            ev.detail.deviceId,
            ev.detail.message
        );
    selector.addEventListener("receiverMessage", onReceiverMessage);

    // Forward media messages
    const onMediaMessage = async (
        ev: CustomEvent<ReceiverSelectorMediaMessage>
    ) => {
        const { deviceId, message } = ev.detail;
        // DASH remux sessions (Bilibili) cannot seek on the receiver: the remuxed
        // HLS only exists up to the ffmpeg download frontier, so a native seek
        // buffers forever. Route popup seeks to the page sender instead, which
        // restarts the remux at the target position.
        if (
            message.type === "SEEK" &&
            typeof message.currentTime === "number"
        ) {
            const instance = castManager.getInstanceByDeviceId(deviceId);
            const tabId = instance?.contentContext?.tabId;
            if (tabId !== undefined) {
                try {
                    const results = await browser.scripting.executeScript({
                        target: { tabId },
                        func: ((time: number) =>
                            (window as any).__fxCastBilibili?.dashSeek?.(
                                time
                            ) === true) as any,
                        args: [message.currentTime]
                    });
                    if (results.some(result => result.result === true)) return;
                } catch (err) {
                    logger.error(
                        "Failed to route popup seek to page sender",
                        err
                    );
                }
            }
            const customData =
                deviceManager.getDeviceById(deviceId)?.mediaStatus?.media
                    ?.customData;
            // Synthetic DVR (CCTV live): the playlist is a frozen VOD extrapolated
            // hours past the snapshot, so a forward seek can target segments the
            // CDN hasn't published yet. Clamp it to stay behind the live edge
            // (which advances with wall clock from the anchor embedded in
            // customData). Keep the margin in sync with
            // MediaSender.DVR_FORWARD_SEEK_MARGIN_SECONDS.
            if (
                customData &&
                typeof customData === "object" &&
                (customData as { hlsDvr?: unknown }).hlsDvr
            ) {
                const dvr = customData as {
                    dvrLiveEdgeBaseSeconds?: unknown;
                    dvrBuiltAtMs?: unknown;
                };
                if (
                    typeof dvr.dvrLiveEdgeBaseSeconds === "number" &&
                    typeof dvr.dvrBuiltAtMs === "number"
                ) {
                    const liveEdge =
                        dvr.dvrLiveEdgeBaseSeconds +
                        (Date.now() - dvr.dvrBuiltAtMs) / 1000;
                    const clamped = Math.min(
                        message.currentTime,
                        Math.max(0, liveEdge - 60)
                    );
                    if (clamped < message.currentTime) {
                        logger.info(
                            "Clamped DVR forward seek behind live edge",
                            {
                                requested: message.currentTime,
                                clamped,
                                liveEdge
                            }
                        );
                    }
                    deviceManager.sendMediaMessage(deviceId, {
                        ...message,
                        currentTime: clamped
                    });
                    return;
                }
            }
            // The page sender couldn't handle the seek (tab navigated or was
            // refreshed). A DASH remux session must not fall through to a native
            // receiver seek: the remuxed HLS only exists up to the ffmpeg
            // download frontier, so the receiver would buffer forever.
            if (
                customData &&
                typeof customData === "object" &&
                (customData as { dashRemux?: unknown }).dashRemux
            ) {
                logger.error(
                    "Suppressing popup seek: DASH remux page sender unavailable"
                );
                return;
            }
        }
        deviceManager.sendMediaMessage(ev.detail.deviceId, ev.detail.message);
    };
    selector.addEventListener("mediaMessage", onMediaMessage);

    // Update selector data whenever devices change/update
    const onDeviceChange = () => refreshReceiverSelector();

    deviceManager.addEventListener("deviceUp", onDeviceChange);
    deviceManager.addEventListener("deviceDown", onDeviceChange);
    deviceManager.addEventListener("deviceUpdated", onDeviceChange);
    deviceManager.addEventListener("deviceMediaUpdated", onDeviceChange);

    // Cleanup listeners
    selector.addEventListener(
        "close",
        () => {
            deviceManager.removeEventListener("deviceUp", onDeviceChange);
            deviceManager.removeEventListener("deviceDown", onDeviceChange);
            deviceManager.removeEventListener("deviceUpdated", onDeviceChange);
            deviceManager.removeEventListener(
                "deviceMediaUpdated",
                onDeviceChange
            );

            selector.removeEventListener("stop", onStop);
            selector.removeEventListener("receiverMessage", onReceiverMessage);
            selector.removeEventListener("mediaMessage", onMediaMessage);
        },
        { once: true }
    );

    return selector;
}

/** Creates and manages mirroring popup window. */
async function createMirroringPopup(device: ReceiverDevice) {
    let popup: browser.windows.Window;
    try {
        popup = await browser.windows.create({
            url: browser.runtime.getURL("ui/mirroring/index.html"),
            type: "popup",
            width: 400,
            height: 150
        });
    } catch (err) {
        logger.error("Failed to create mirroring popup!", err);
        return;
    }

    const onMirroringPopupMessage = (port: Port) => {
        if (
            port.sender?.tab?.windowId !== popup.id ||
            port.name !== "mirroring"
        ) {
            return;
        }

        port.postMessage({ subject: "mirroringPopup:init", data: { device } });
    };

    messaging.onConnect.addListener(onMirroringPopupMessage);

    browser.windows.onRemoved.addListener(function onWindowRemoved(windowId) {
        if (windowId !== popup.id) return;
        messaging.onConnect.removeListener(onMirroringPopupMessage);
        browser.windows.onRemoved.removeListener(onWindowRemoved);
    });
}
