import bridge from "../lib/bridge";
import {
    type BaseConfig,
    baseConfigStorage,
    fetchBaseConfig,
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
import { MediaInfo } from "../cast/sdk/media/classes";
import { createReceiver } from "../cast/utils";

import ReceiverSelector, {
    type ReceiverSelection,
    type ReceiverSelectorMediaMessage,
    type ReceiverSelectorReceiverMessage
} from "./ReceiverSelector";

import deviceManager from "./deviceManager";
import {
    acceptPagePlaybackProgress,
    acceptReceiverObservation,
    configurePlaybackCommands,
    dispatchPlaybackCommand,
    setPlaybackDeviceLookup,
    terminateActivePlaybackCommand,
    terminateActivePlaybackCommandForRelay
} from "./playbackCommand";
import type { MediaStatus } from "../cast/sdk/types";
import type {
    PlaybackCommandProgress,
    PlaybackPageCommand
} from "../../../shared/playbackCommand";
import type { RokuMediaStatusProvenance } from "../../../shared/rokuMediaStatusProvenance";
import { ActionState, updateActionState } from "./action";
import {
    armCctvPageCaptureIngest,
    beginCctvPageCapture,
    endCctvPageCapture,
    isCctvPageCaptureActive,
    pauseCctvPageCaptureIngest
} from "./cctvPageCapture";
import {
    armBilibiliPageCapture,
    beginBilibiliPageCapture,
    endBilibiliPageCapture
} from "./bilibiliPageCapture";

async function logRokuDebug(message: string, data: unknown) {
    try {
        const opts = await options.getAll();
        if (!opts.cctvDebugEnabled && !opts.bilibiliDebugEnabled) return;
        logger.info(message, data);
    } catch {
        // Debug logging must never affect session message handling.
    }
}

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

    // From here on this call owns a native port, and may have attached it to the
    // instance. Anything that throws below must not leave either behind: the port
    // would keep a native host alive that the device was never told about, and
    // the instance would reference a session that does not exist. Measured before
    // this existed (harness --fail-stage p1/p2): exactly one idle native host
    // stayed alive for the rest of the browser's life.
    //
    // Cleanup is identity-guarded, like the load-generation announcement: a late
    // failure must not detach a NEWER session that has already replaced this one.
    const onBridgeDisconnect = () => destroyCastInstance(opts.instance);
    try {
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
        session.bridgePort.onDisconnect.addListener(onBridgeDisconnect);

        if (opts.instance.contentContext?.tabId !== undefined) {
            updateActionState(
                ActionState.Connecting,
                opts.instance.contentContext?.tabId
            );
        }

        return session;
    } catch (error) {
        // Reference cleanup is best-effort and must never PREVENT the port from
        // being closed, nor replace the error that explains what actually failed:
        // a half-cleaned instance is recoverable, a leaked native host is not.
        try {
            if (opts.instance.session === session) {
                try {
                    if (opts.instance.bridgeMessageListener) {
                        session.bridgePort.onMessage.removeListener(
                            opts.instance.bridgeMessageListener
                        );
                    }
                } catch (cleanupError) {
                    logger.error(
                        "Failed to remove the partial session message listener",
                        cleanupError
                    );
                }
                // Clear the references even if the removal above failed: they
                // point at a port that is about to be closed either way.
                opts.instance.bridgeMessageListener = undefined;
                opts.instance.session = undefined;
                try {
                    if (opts.instance.contentContext?.tabId !== undefined) {
                        updateActionState(
                            ActionState.Default,
                            opts.instance.contentContext.tabId
                        );
                    }
                } catch (cleanupError) {
                    logger.error(
                        "Failed to reset action state after a failed session creation",
                        cleanupError
                    );
                }
            }
        } finally {
            // Remove our own disconnect handler BEFORE closing the port: it calls
            // destroyCastInstance(), which would tear down the whole instance (its
            // content port included) for what is only a half-created session.
            try {
                session.bridgePort.onDisconnect.removeListener(
                    onBridgeDisconnect
                );
            } catch {
                // Best effort: the port may already be gone.
            }
            try {
                session.bridgePort.disconnect();
            } catch {
                // Already disconnected.
            }
        }
        throw error;
    }
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
let baseConfig: BaseConfig | undefined;
let baseConfigLoad: Promise<BaseConfig | undefined> | undefined;

/** CCTV and Bilibili senders already provide concrete video media. Their
 * receiver selector does not need Google's app audio-only compatibility tag,
 * so never start a baseconfig request from those page flows. */
function skipsChromecastBaseConfig(pageUrl?: string): boolean {
    if (!pageUrl) return false;
    try {
        const url = new URL(pageUrl);
        const host = url.hostname.toLowerCase();
        if (host === "tv.cctv.com" && url.pathname.startsWith("/live/")) {
            return true;
        }
        return (
            (host === "www.bilibili.com" || host === "m.bilibili.com") &&
            url.pathname.startsWith("/video/")
        );
    } catch {
        return false;
    }
}

async function loadChromecastBaseConfig(): Promise<BaseConfig | undefined> {
    if (Array.isArray(baseConfig?.app_tags)) return baseConfig;
    if (baseConfigLoad) return baseConfigLoad;

    baseConfigLoad = (async () => {
        try {
            const stored = await baseConfigStorage.get("baseConfig");
            if (Array.isArray(stored.baseConfig?.app_tags)) {
                baseConfig = stored.baseConfig;
                return baseConfig;
            }
        } catch (err) {
            logger.error("Failed to get Chromecast base config!", err);
        }

        const fetched = await fetchBaseConfig();
        if (!fetched) return undefined;
        baseConfig = fetched;
        try {
            await baseConfigStorage.set({
                baseConfig: fetched,
                baseConfigUpdated: Date.now()
            });
        } catch (err) {
            logger.error("Failed to cache Chromecast base config!", err);
        }
        return fetched;
    })().finally(() => {
        baseConfigLoad = undefined;
    });
    return baseConfigLoad;
}
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

/** Firefox may remove a tab without delivering pagehide/beforeunload to the
 * sender. Stop every session owned by that tab through the still-live bridge. */
browser.tabs.onRemoved.addListener(tabId => {
    for (const instance of [...activeInstances]) {
        if (instance.contentContext?.tabId !== tabId || !instance.session) {
            continue;
        }
        const { session } = instance;
        const receiverDevice = deviceManager.getDeviceById(session.deviceId);
        logger.info("Tab closed; stopping owned Cast session", {
            tabId,
            deviceId: session.deviceId,
            sessionId: session.sessionId,
            hasReceiverDevice: Boolean(receiverDevice)
        });
        if (instance.bridgeMessageListener) {
            session.bridgePort.onMessage.removeListener(
                instance.bridgeMessageListener
            );
            delete instance.bridgeMessageListener;
        }
        activeInstances.delete(instance);

        // DeviceManager owns an independent, persistent native connection, so
        // this STOP survives destruction of the page/content port.
        deviceManager.sendReceiverMessage(session.deviceId, {
            type: "STOP",
            requestId: Date.now(),
            sessionId: session.sessionId
        });

        if (receiverDevice) {
            session.bridgePort.postMessage({
                subject: "bridge:stopCastSession",
                data: { receiverDevice }
            });
        }
        session.bridgePort.postMessage({
            subject: "bridge:stopMediaServer",
            data: { force: true }
        });
    }
});

/** Device ownership captured when a live relay request is sent to the bridge.
 * Relay lifecycle messages can arrive after instance.session has been cleared,
 * so optimistic media must not depend on that mutable pointer. */
const liveRelayDeviceByRequestId = new Map<string, string>();

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

/**
 * The coordinator's only observation input: one entry per completed ECP poll,
 * including idle.
 *
 * Registered at module scope, NOT inside createSelector(): a command's
 * confirmation must not depend on a popup being open. Tying this to the
 * selector's lifetime meant that closing the popup (or having no selector at
 * all for a given command) removed the only consumer, so RokuRemote kept
 * polling while the coordinator saw nothing and every command expired as
 * "observation-unavailable".
 *
 * It is deliberately not also fed from deviceMediaUpdated: that message exists
 * once per non-idle poll as well, so consuming both would evaluate the same
 * sample twice, and it cannot express an idle poll at all - an observed idle
 * must end as `not-confirmed` (classification "irrelevant") while only an
 * unobservable device ends as `observation-unavailable`. deviceMediaUpdated
 * therefore stays the UX/media channel, and this feed is the confirmation one.
 */
function onBilibiliPlaybackProgress(ev: CustomEvent<PlaybackCommandProgress>) {
    acceptPagePlaybackProgress(ev.detail);
}
deviceManager.addEventListener(
    "bilibiliPlaybackProgress",
    onBilibiliPlaybackProgress as EventListener
);

function onRokuPlaybackObservation(
    ev: CustomEvent<{
        deviceId: string;
        status: MediaStatus;
        loadGeneration?: number;
        provenance: RokuMediaStatusProvenance;
    }>
) {
    const { deviceId, status, loadGeneration, provenance } = ev.detail;
    acceptReceiverObservation(
        deviceId,
        status,
        provenance,
        Date.now(),
        loadGeneration
    );
}
deviceManager.addEventListener(
    "rokuPlaybackObservation",
    onRokuPlaybackObservation as EventListener
);

export default castManager;

/** Handles messages to cast instances from bridge. */
async function handleBridgeMessage(instance: CastInstance, message: Message) {
    // Surface live HLS relay diagnostics in the background console. These are
    // purely informational and are not forwarded to the content port.
    if (message.subject === "mediaCast:relayDebug") {
        // requestId is required on the bridge protocol envelope, but repeating the
        // full UUID in every high-volume segment log wastes the Firefox console
        // preview budget and hides the actual decrypt diagnostics.
        const { event, requestId, ...rest } = message.data;
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

        // Optimistic early session media for the CCTV synthetic-DVR live
        // relay. The real LOAD media is only published by RokuSession (via
        // main:rokuSessionMedia) once the initial prebuffer has filled AND
        // the Roku has started consuming the relay — seconds to tens of
        // seconds after the cast button was clicked, which is why the popup
        // progress bar used to appear only when playback actually began.
        // The DVR window params are already known the moment the bridge
        // builds the frozen playlist, so register an equivalent MediaInfo
        // now and let deviceManager surface the bar immediately. The real
        // LOAD media replaces this entry once consumption is observed; a
        // relay stop/error clears it (see mediaCast:mediaServerStopped /
        // mediaCast:mediaServerError below).
        if (event === "synthetic DVR playlist constructed") {
            const deviceId = liveRelayDeviceByRequestId.get(requestId);
            const totalDurationSeconds = rest.totalDurationSeconds;
            if (
                deviceId &&
                typeof totalDurationSeconds === "number" &&
                totalDurationSeconds > 0
            ) {
                const media = new MediaInfo("", "application/x-mpegurl");
                media.duration = totalDurationSeconds;
                media.customData = {
                    hlsDvr: true,
                    pageDuration: totalDurationSeconds,
                    // Marks the entry as optimistic so a relay stop/error
                    // can clear it without touching real LOAD media.
                    optimisticRelayMedia: true,
                    ...(typeof rest.liveEdgeBaseSeconds === "number"
                        ? { dvrLiveEdgeBaseSeconds: rest.liveEdgeBaseSeconds }
                        : {}),
                    // The bridge built the playlist as it emitted this
                    // event, so receipt time is within milliseconds of the
                    // real builtAtMs (it only feeds the seek clamp).
                    dvrBuiltAtMs: Date.now()
                };
                deviceManager.setRokuSessionMedia(
                    deviceId,
                    `relay:${requestId}`,
                    media
                );
            }
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

        case "main:bilibiliPageCaptureReady": {
            const tabId = instance.contentContext?.tabId;
            if (tabId !== undefined) {
                armBilibiliPageCapture(
                    tabId,
                    message.data.requestId,
                    message.data.port,
                    message.data.generation
                );
                // The new capture port is listening: tell the page sender to
                // seek/play the real player NOW so target fragments are
                // ingested by this generation (seeking earlier dumps them
                // into the generation that stopMediaServer just tore down).
                void browser.tabs
                    .sendMessage(tabId, {
                        subject: "bilibili:pageCaptureReady",
                        data: { requestId: message.data.requestId }
                    })
                    .catch(() => undefined);
            }
            break;
        }

        case "main:bilibiliCaptureOverflow": {
            // The captured-DASH generation reached a TERMINAL condition: buffer
            // pressure (hard cap / stalled watermark) or a broken media
            // identity (malformed ingest metadata, a payload whose body
            // disagreed with its range, conflicting bytes, a foreign init).
            // In every case dropping un-read bytes would punch permanent holes
            // into the sequential input stream, so the only safe reclaim is a
            // relay rebuild: ask the tab's sender to re-cast at the page's
            // current position (fresh generation, fresh capture window).
            const tabId = instance.contentContext?.tabId;
            if (tabId !== undefined) {
                logger.warn(
                    "Bilibili capture generation terminated; relay rebuild requested",
                    message.data
                );
                void browser.tabs
                    .sendMessage(tabId, {
                        subject: "bilibili:captureOverflow",
                        data: {
                            kind: message.data.kind,
                            requestId: message.data.requestId,
                            reason: message.data.reason
                        }
                    })
                    .catch(() => undefined);
            }
            break;
        }

        case "mediaCast:mediaServerStopped":
        case "mediaCast:mediaServerError": {
            const tabId = instance.contentContext?.tabId;
            if (tabId !== undefined) {
                endBilibiliPageCapture(tabId, message.data.requestId);
            }
            if (tabId !== undefined && isCctvPageCaptureActive(tabId)) {
                pauseCctvPageCaptureIngest(tabId, message.data.requestId);
            }
            // Drop an optimistic early session-media entry (registered from
            // the "synthetic DVR playlist constructed" relay event above)
            // when its relay goes away before the real LOAD media was ever
            // published — otherwise the stale entry keeps merging into
            // future device statuses. Real LOAD-published entries are left
            // untouched.
            const relayDeviceId = liveRelayDeviceByRequestId.get(
                message.data.requestId
            );
            if (relayDeviceId) {
                // A play/pause command for this relay can no longer execute:
                // the relay it would drive is gone. Guarded by the owner so a
                // late stop from a superseded relay cannot terminate the
                // command of a newer LOAD.
                terminateActivePlaybackCommandForRelay(
                    relayDeviceId,
                    message.data.requestId,
                    "stopped"
                );
                deviceManager.clearOptimisticRokuSessionMedia(
                    relayDeviceId,
                    message.data.requestId
                );
                liveRelayDeviceByRequestId.delete(message.data.requestId);
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
            break;

        case "main:dashRemuxDebug": {
            // GATED like every other Roku debug relay in this file: the bridge
            // emits one of these per remuxed segment (and per response), so an
            // ungated `logger.info` fills the background console during ordinary
            // playback even with both debug options off. `cctvDebugEnabled`
            // covers the live-relay path and `bilibiliDebugEnabled` the DASH
            // remux path.
            void logRokuDebug(`DASH remux ${message.data.event}`, {
                requestId: message.data.requestId,
                details: message.data.details
            });
            break;
        }

        case "main:rokuSessionPlaybackTransport": {
            // A page-owned command drove the receiver through the session's
            // Cast media, in the session's own bridge process. Relay the request
            // for a dense observation window to the discovery process, so both
            // routes confirm with the same latency. No command id is involved:
            // the samples are ordinary observations and still have to pass the
            // ecp-poll whitelist and the strict poll-start gate.
            deviceManager.requestRokuConfirmationPoll(message.data.deviceId);
            break;
        }

        case "main:rokuSessionMediaDebug": {
            // RokuSession sends over the SESSION bridge connection, so this
            // message arrives here in castManager — not on the deviceManager
            // connection where the twin handler lives (deviceManager.ts).
            // Without this case the session-side debug was silently dropped
            // and never reached the background console, making the Roku
            // consume/register flow invisible.
            const { deviceId, event, ...rest } = message.data;
            void logRokuDebug(
                `Roku session media [${deviceId}] ${event}`,
                rest
            );
            break;
        }

        case "main:rokuSessionMedia": {
            // The emulated RokuSession runs in its own bridge process
            // (every connectNative spawns one), so the sessionMedia
            // registry it registers into is invisible to RokuRemote's
            // buildStatusMedia in the device-discovery process. The
            // session publishes its LOAD media here instead; the device
            // manager merges it into the device media status.
            deviceManager.setRokuSessionMedia(
                message.data.deviceId,
                message.data.sessionId,
                message.data.media
            );
            break;
        }

        case "cast:sessionStopped": {
            const sessionId = message.data.sessionId;
            const session = instance.session;

            // RokuSession tears itself down directly over ECP and therefore
            // does not produce the Chromecast application's `applicationClosed`
            // event that normally removes background ownership. Clear the
            // instance/active-session state here when the bridge reports the
            // terminal session event so the popup immediately stops treating
            // the receiver as owned (and never reaches Stop timed out - Retry).
            if (session?.sessionId === sessionId) {
                activeSessions.delete(sessionId);
                delete instance.session;
                // A stopped session cannot execute a play/pause command, and
                // this path is NOT covered by mediaCast:mediaServerStopped: a
                // Roku STOP tears the session down over ECP without stopping
                // the DASH relay. Without this the optimistic intent would sit
                // on the button until the command watchdog expired.
                // The session carries the receiver device id (see the same
                // lookup in the session-media handling above).
                terminateActivePlaybackCommand(session.deviceId, "stopped");
                refreshReceiverSelector();

                if (instance.contentContext?.tabId !== undefined) {
                    updateActionState(
                        ActionState.Default,
                        instance.contentContext.tabId
                    );
                }
            }
            break;
        }
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
            if (
                message.data.rokuDashPrebuffer &&
                message.data.audioUrl &&
                instance.contentContext?.tabId !== undefined
            ) {
                // The capture is self-identifying: it has observed this tab
                // since page load, so no media URLs are passed — the bridge
                // consumes whatever the page actually downloads.
                beginBilibiliPageCapture(
                    instance.contentContext.tabId,
                    message.data.requestId,
                    {
                        resetWindow: Boolean(message.data.resetCaptureWindow)
                    }
                );
            }
            if (message.data.hlsLive && instance.session) {
                liveRelayDeviceByRequestId.set(
                    message.data.requestId,
                    instance.session.deviceId
                );
            }

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

                // The bypass creates a real session too, straight from the
                // device the trusted page supplied, so it has to announce the
                // load for the same reason the two paths below do: without a
                // generation the session's media is never mirrored to the
                // discovery host, and nothing fails loudly. The announcement is
                // released below if that session never comes up.
                const bypassAnnouncement = beginRokuSessionLoad(receiverDevice);

                try {
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

                    // Session creation and its create message succeeded, so
                    // this start no longer needs a failure-release handle. This
                    // only drops castManager's entitlement record: the
                    // deviceManager gate stays pending until real session media
                    // releases it.
                    bypassAnnouncement?.commit();
                } catch (err) {
                    bypassAnnouncement?.release();
                    throw err;
                }

                break;
            }

            let pendingRokuMedia: RokuLoadAnnouncement | undefined;
            // This handler invocation is one session start, so the load it
            // announces must be announced exactly once.
            const rokuSessionSeq = beginRokuSessionStart();
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

                if (selection.device.deviceType === "roku") {
                    pendingRokuMedia = beginRokuSessionLoad(
                        selection.device,
                        rokuSessionSeq
                    );
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
                    appId: sessionRequest.appId,
                    deviceType: selection.device.deviceType,
                    preCreatePlayerState: deviceManager.getDeviceById(
                        selection.device.id
                    )?.mediaStatus?.playerState,
                    preCreateCurrentTime: deviceManager.getDeviceById(
                        selection.device.id
                    )?.mediaStatus?.currentTime,
                    preCreateMediaSessionId: deviceManager.getDeviceById(
                        selection.device.id
                    )?.mediaStatus?.mediaSessionId,
                    preCreateContentId: deviceManager.getDeviceById(
                        selection.device.id
                    )?.mediaStatus?.media?.contentId
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

                // Session creation and its create message succeeded, so this
                // start no longer needs a failure-release handle. This only
                // drops castManager's entitlement record: the deviceManager
                // gate stays pending until real session media releases it.
                pendingRokuMedia?.commit();
            } catch (err) {
                // Release only the gate THIS invocation opened: a repeat call
                // does not announce, and a late failure must not clear a newer
                // session start's gate.
                pendingRokuMedia?.release();
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
 * Monotonic session-start counter, and the starts that are currently in flight
 * with their load announced. A token is remembered only for the lifetime of its
 * own start and is dropped at `commit()`/`release()`, so the set is bounded by
 * the number of concurrent starts rather than by how often the user casts.
 *
 * What the Set guarantees is therefore exactly this: while a start is IN FLIGHT,
 * a repeated call carrying its token does not announce twice. It does not (and
 * cannot) guarantee anything about a start that has already finished - after
 * `commit()`/`release()` the token is gone by design, so the call graph, not
 * this Set, is what keeps a completed start from re-entering the shared entry.
 * The counter stays monotonic, so a token is never handed to a different start.
 */
let rokuSessionStartSeq = 0;
const rokuLoadAnnouncedSeqs = new Set<number>();

/**
 * One session start's announcement, and the handle that releases the local
 * pending-media gate it opened.
 *
 * The gate is per DEVICE (`deviceManager.pendingRokuMediaLoads`) while
 * announcements are per session start, so clearing it is only correct when the
 * gate still belongs to this announcement: a start that fails LATE - after a
 * newer start has announced - must not clear the newer start's gate, or ECP
 * evidence the newer start is still waiting to filter gets accepted early.
 */
interface RokuLoadAnnouncement {
    deviceId: string;
    seq: number;
    /**
     * Releases the pending gate if this announcement still owns it. Releasing
     * never rolls the generation back: that is impossible by design (the
     * counter is monotonic and the previous load's media was already retired at
     * discovery when the new generation was relayed).
     */
    release(): boolean;
    /**
     * Ends this start after its session was created and its
     * `bridge:createCastSession` was sent: from here on the start can no longer
     * fail into its catch, so it no longer needs a failure-release entitlement.
     *
     * It does NOT release the pending gate. The gate is released by the
     * session's real media, so between this commit and that media arriving the
     * gate is still set while this map no longer names anyone - which is the
     * truth: nobody is entitled to release it on failure any more.
     */
    commit(): void;
}

/**
 * The in-flight session-start announcement currently entitled to release each
 * device's pending gate if session creation fails. This is NOT ownership of the
 * gate itself: the gate lives in `deviceManager` and is released by the
 * session's real media, or by the entitlement holder when its session never
 * comes up.
 */
const rokuLoadAnnouncements = new Map<string, RokuLoadAnnouncement>();

/**
 * Starts a session-start lifecycle and returns its token. Take one token per
 * lifecycle (one requestSession handling, one queued cast) and pass it to every
 * `beginRokuSessionLoad` call that lifecycle can reach.
 */
function beginRokuSessionStart(): number {
    return ++rokuSessionStartSeq;
}

/**
 * Announces a Roku media load for a session that is about to be created: this
 * is the single entry for "a Roku App session is starting, so it needs a load
 * generation".
 *
 * There is more than one way a session gets created, and for a long time only
 * one of them announced the load:
 *
 *  - `main:requestSession`, i.e. the receiver-selector response, which
 *    announced the load right before dispatching `cast:receiverAction`;
 *  - the queued-selection path, `triggerCast` -> `loadSender`, which is what
 *    the popup's auto-cast takes when it casts on its own because the selector
 *    never reported ready within its timeout;
 *  - the trusted-sender bypass, which creates a session straight from the
 *    receiver device the page supplied.
 *
 * A session created by either of the other two had no generation at all.
 * Session media is published against a generation and the session media sync
 * treats a generation advance as a retirement boundary (`apply()` retires the
 * stale generations first), so such a session's media could never be mirrored
 * to the discovery host - and nothing failed loudly.
 *
 * Exactly one generation per session start: a repeated call carrying the same
 * `seq` is a repeat of the same start and must not advance anything.
 *
 * Returns the announcement, or undefined when nothing was announced (not a
 * Roku device, or a repeat of the same start). Whoever gets an announcement
 * owns it: if the session it announces never comes up, it must `release()` it,
 * otherwise the device's ECP media status stays filtered by the pending gate
 * until some later successful load, a device-down, or a bridge reconnect.
 */
function beginRokuSessionLoad(
    device: ReceiverDevice | undefined,
    seq = beginRokuSessionStart()
): RokuLoadAnnouncement | undefined {
    if (device?.deviceType !== "roku") {
        return undefined;
    }

    if (rokuLoadAnnouncedSeqs.has(seq)) {
        logger.info("Roku media load already announced for this session start", {
            deviceId: device.id,
            seq
        });
        return undefined;
    }

    rokuLoadAnnouncedSeqs.add(seq);
    deviceManager.beginRokuMediaLoad(device.id);

    const announcement: RokuLoadAnnouncement = {
        deviceId: device.id,
        seq,
        release() {
            const owner = rokuLoadAnnouncements.get(device.id);
            // This start ends here either way. A REFUSED release still ends it
            // (the token cannot legitimately re-enter), so the token must not be
            // remembered forever - that would trade an unbounded set for the
            // eviction this code deliberately does not do.
            rokuLoadAnnouncedSeqs.delete(seq);
            if (owner !== announcement) {
                logger.info(
                    // Not necessarily a NEWER start: this start may also have
                    // ended already (its own commit, or an earlier release), in
                    // which case nobody holds the entitlement.
                    "Roku media load release ignored: this start no longer holds the pending gate",
                    {
                        deviceId: device.id,
                        seq,
                        ownerSeq: owner?.seq
                    }
                );
                return false;
            }

            rokuLoadAnnouncements.delete(device.id);
            deviceManager.cancelRokuMediaLoad(device.id);
            return true;
        },
        commit() {
            rokuLoadAnnouncedSeqs.delete(seq);
            if (rokuLoadAnnouncements.get(device.id) === announcement) {
                rokuLoadAnnouncements.delete(device.id);
            }
        }
    };
    rokuLoadAnnouncements.set(device.id, announcement);

    return announcement;
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

            // The queued-selection path creates a real session here too, and it
            // used to be the only one that did not announce the load: the
            // popup's auto-cast casts on its own, `triggerCast` lands in this
            // branch, and the session came up with no load generation - so its
            // media was never mirrored to the discovery host. Announce before
            // the receiver is dispatched and before the session is created,
            // matching the order the receiver-selector path uses.
            //
            // If the session never comes up, this caller must release the gate
            // it opened: the generation stays monotonic (nothing rolls back),
            // but leaving the gate set would filter this device's ECP media
            // status forever, with the UI stuck on the state `beginRokuMediaLoad`
            // left behind.
            const rokuLoad = beginRokuSessionLoad(selection.device);

            try {
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

                // Session creation and its create message succeeded, so this
                // start no longer needs a failure-release handle. This only
                // drops castManager's entitlement record: the deviceManager
                // gate stays pending until real session media releases it.
                rokuLoad?.commit();
            } catch (err) {
                rokuLoad?.release();
                throw err;
            }

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
        // CCTV/Bilibili page senders do not use app_tags. Avoid both storage
        // loading and the external baseconfig request for those click flows.
        const config = skipsChromecastBaseConfig(pageInfo?.url)
            ? undefined
            : await loadChromecastBaseConfig();

        appInfo = {
            sessionRequest: selectionOpts.castInstance.apiConfig.sessionRequest,
            isRequestAppAudioCompatible: getAppTag(
                config,
                selectionOpts.castInstance.apiConfig.sessionRequest.appId
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

    /**
     * The page-sender leg of a play/pause command. Returns true only when the
     * injected sender accepted the control flow; false means the coordinator
     * should fall back to the bridge. The page sender drives both sides, so a
     * true result must suppress the bridge dispatch entirely.
     */
    const pagePlaybackRoute = async (
        deviceId: string,
        command: PlaybackPageCommand
    ): Promise<unknown> => {
        const instance = castManager.getInstanceByDeviceId(deviceId);
        const tabId = instance?.contentContext?.tabId;
        if (tabId === undefined) return undefined;
        try {
            const results = await browser.scripting.executeScript({
                target: { tabId },
                // The page returns the structured result itself. It must NOT be
                // collapsed to a boolean here: `=== true` would always be false
                // for an object, and a plain truthiness test would accept
                // `{ accepted: false }` and strand the command on the page
                // route. Validation happens in the coordinator.
                func: ((pageCommand: PlaybackPageCommand) =>
                    (window as any).__fxCastBilibili?.controlPlayback?.(
                        pageCommand
                    )) as any,
                args: [command]
            });
            return results
                .map(result => result.result)
                .find(v => v !== undefined);
        } catch (err) {
            logger.error("Failed to route popup playback to page sender", err);
            return undefined;
        }
    };

    // The page route is owned by the popup's tab context, so the coordinator
    // is only told how to ask for it.
    configurePlaybackCommands({
        onViewChanged: deviceId =>
            deviceManager.notifyPlaybackCommandChanged(deviceId),
        pageRouteAttempt: pagePlaybackRoute,
        deviceRouteAttempt: (deviceId, message) =>
            deviceManager.sendMediaMessage(deviceId, message)
    });
    setPlaybackDeviceLookup(deviceId => deviceManager.getDeviceById(deviceId));

    // Forward media messages
    const onMediaMessage = async (
        ev: CustomEvent<ReceiverSelectorMediaMessage>
    ) => {
        const { deviceId, message } = ev.detail;
        // DASH remux sessions (Bilibili) cannot seek on the receiver: the remuxed
        // HLS only exists up to the ffmpeg download frontier, so a native seek
        // buffers forever. Route popup seeks to the page sender instead, which
        // restarts the remux at the target position. Play/pause is routed the
        // same way so the page (capture source) and Roku move together instead
        // of the page lagging the 2.5s ECP poll.
        //
        // Play/pause is coordinated only for Roku receivers, because only they
        // have a page sender to defer to and a bridge route to fall back on.
        // Every other receiver keeps the generic path at the end of this
        // handler — routing them here would strand the command, since the
        // coordinator requires a Roku LOAD identity that a Chromecast never
        // has.
        const rokuDevice =
            message.type === "PAUSE" || message.type === "PLAY"
                ? deviceManager.getDeviceById(deviceId)
                : undefined;
        if (rokuDevice?.deviceType === "roku") {
            await dispatchPlaybackCommand(
                rokuDevice,
                message.type as "PLAY" | "PAUSE",
                rokuDevice.mediaStatus
            );
            return;
        }
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
    // UI refresh, scoped to this selector. Distinct from the module-scope
    // observation consumer in playbackCommand: that one confirms commands for
    // the background's lifetime, this one repaints an open popup (progress,
    // playerState, buffering shimmer, media merges). Dropping it left open
    // popups frozen on stale media status while commands still confirmed.
    deviceManager.addEventListener("deviceMediaUpdated", onDeviceChange);
    deviceManager.addEventListener("devicePlaybackUpdated", onDeviceChange);

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
            // Symmetry: registered above, so it must be released here too.
            deviceManager.removeEventListener(
                "devicePlaybackUpdated",
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
