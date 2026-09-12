import type {
    PagePlaybackPhase,
    PlaybackCommandLifecycle,
    PlaybackCommandTerminalReason,
    PlaybackExecutionOwner,
    PlaybackIntent,
    PlaybackRouteAttempt,
    ReceiverPlaybackPhase,
    ReceiverPlaybackView,
    RokuMediaIdentity
} from "../../../shared/playbackCommand";
import type { ReceiverDevice } from "../types";
import type { MediaStatus, SenderMediaMessage } from "../cast/sdk/types";

import { Logger } from "../lib/logger";

const logger = new Logger("fx_cast_bilibili [playback command]");

/**
 * How long a command may stay active without reaching a terminal outcome.
 *
 * Until page-route acknowledgements are structured and receiver observations
 * are correlated, a command cannot be confirmed at all, so this watchdog is
 * the only thing standing between a popup click and a permanently pending
 * button. It is deliberately generous: it must outlive a page-sender relay
 * restart, and its expiry is reported as `observation-unavailable` (a
 * diagnostic outcome), never as a receiver failure.
 */
export const PLAYBACK_COMMAND_DEADLINE_MS = 12_000;

/** Internal per-command state. Never exposed to the popup. */
interface PlaybackCommand {
    commandId: number;
    mediaIdentity: RokuMediaIdentity;
    intent: PlaybackIntent;
    routeAttempts: {
        page: PlaybackRouteAttempt;
        device: PlaybackRouteAttempt;
    };
    owner?: PlaybackExecutionOwner;
    lifecycle: PlaybackCommandLifecycle;
    terminalReason?: PlaybackCommandTerminalReason;
    pagePhase: PagePlaybackPhase;
    receiverPhase: ReceiverPlaybackPhase;
    watchdogTimer?: ReturnType<typeof setTimeout>;
}

const commands = new Map<string, PlaybackCommand>();
let nextCommandId = 0;

/** Load generation per device. Monotonic for this background's lifetime. */
const loadGenerations = new Map<string, number>();
/** Current media identity per device, refined as the LOAD's fields arrive. */
const mediaIdentities = new Map<string, RokuMediaIdentity>();

/** Called whenever a device's playback view changes, to re-broadcast it. */
let onViewChanged: ((deviceId: string) => void) | undefined;
/**
 * Asked to hand the command to the page sender. Returns true only when the
 * page sender reported that it accepted the control flow.
 */
let pageRouteAttempt:
    | ((deviceId: string, intent: PlaybackIntent) => Promise<boolean>)
    | undefined;
/**
 * Hands the command to the bridge. Returns true only when the message was
 * actually submitted to the bridge port.
 */
let deviceRouteAttempt:
    | ((deviceId: string, message: SenderMediaMessage) => boolean)
    | undefined;

export function configurePlaybackCommands(options: {
    onViewChanged: (deviceId: string) => void;
    pageRouteAttempt?: (
        deviceId: string,
        intent: PlaybackIntent
    ) => Promise<boolean>;
    deviceRouteAttempt: (
        deviceId: string,
        message: SenderMediaMessage
    ) => boolean;
}) {
    onViewChanged = options.onViewChanged;
    pageRouteAttempt = options.pageRouteAttempt;
    deviceRouteAttempt = options.deviceRouteAttempt;
}

/**
 * Starts (or replaces) the LOAD generation for a device. The generation is the
 * primary media-identity key and is intentionally never reset on device down:
 * a reconnect must not be able to reuse a number while stale messages from the
 * previous incarnation can still arrive.
 */
export function nextRokuLoadGeneration(deviceId: string): number {
    const generation = (loadGenerations.get(deviceId) ?? 0) + 1;
    loadGenerations.set(deviceId, generation);
    mediaIdentities.set(deviceId, { deviceId, loadGeneration: generation });
    return generation;
}

/**
 * Refines the identity of the current generation. Must never create a new
 * generation: the optimistic relay media and the real LOAD media both arrive
 * here for the SAME load, and forking the generation would make the active
 * command look like it belonged to a different cast.
 */
export function setRokuMediaIdentityFields(
    deviceId: string,
    fields: {
        contentId?: string;
        ownerId?: string;
        relayRequestId?: string;
    }
) {
    const identity = mediaIdentities.get(deviceId);
    if (!identity) return;
    if (fields.contentId !== undefined) identity.contentId = fields.contentId;
    if (fields.ownerId !== undefined) identity.ownerId = fields.ownerId;
    // Set only by the optimistic relay media, and never cleared: the real
    // session media that follows legitimately replaces ownerId, but the relay
    // association must survive so a relay stop can still find this command.
    if (fields.relayRequestId !== undefined) {
        identity.relayRequestId = fields.relayRequestId;
    }
}

export function currentRokuMediaIdentity(
    deviceId: string
): RokuMediaIdentity | undefined {
    return mediaIdentities.get(deviceId);
}

function sameMediaIdentity(
    left: RokuMediaIdentity,
    right: RokuMediaIdentity | undefined
): boolean {
    return (
        right !== undefined &&
        left.deviceId === right.deviceId &&
        left.loadGeneration === right.loadGeneration
    );
}

function viewFor(command: PlaybackCommand): ReceiverPlaybackView {
    return {
        commandId: command.commandId,
        intent: command.intent,
        lifecycle: command.lifecycle,
        terminalReason: command.terminalReason,
        owner: command.owner,
        receiverPending:
            command.lifecycle === "active" &&
            command.receiverPhase === "requested",
        pagePhase: command.pagePhase,
        receiverPhase: command.receiverPhase
    };
}

function publish(device: ReceiverDevice, command: PlaybackCommand) {
    device.playbackCommand = viewFor(command);
    onViewChanged?.(device.id);
}

function clearWatchdog(command: PlaybackCommand) {
    if (command.watchdogTimer !== undefined) {
        clearTimeout(command.watchdogTimer);
        command.watchdogTimer = undefined;
    }
}

/** Terminal transition. Idempotent. */
function terminate(
    device: ReceiverDevice,
    command: PlaybackCommand,
    reason: PlaybackCommandTerminalReason
) {
    if (command.lifecycle === "terminal") return;
    command.lifecycle = "terminal";
    command.terminalReason = reason;
    clearWatchdog(command);
    logger.info("Playback command finished", {
        deviceId: device.id,
        commandId: command.commandId,
        intent: command.intent,
        owner: command.owner,
        reason,
        pagePhase: command.pagePhase,
        receiverPhase: command.receiverPhase,
        routeAttempts: command.routeAttempts
    });
    publish(device, command);
}

function terminateIfCurrent(
    deviceId: string,
    command: PlaybackCommand,
    reason: PlaybackCommandTerminalReason
) {
    if (commands.get(deviceId)?.commandId !== command.commandId) return;
    const device = deviceLookup?.(deviceId);
    if (device) terminate(device, command, reason);
}

/**
 * Resolves the device record. Injected because the coordinator must not import
 * the device manager (which imports this module).
 */
let deviceLookup:
    | ((deviceId: string) => ReceiverDevice | undefined)
    | undefined;

export function setPlaybackDeviceLookup(
    lookup: (deviceId: string) => ReceiverDevice | undefined
) {
    deviceLookup = lookup;
}

function armWatchdog(device: ReceiverDevice, command: PlaybackCommand) {
    clearWatchdog(command);
    command.watchdogTimer = setTimeout(() => {
        command.watchdogTimer = undefined;
        if (command.lifecycle !== "active") return;
        if (
            command.owner === undefined &&
            command.routeAttempts.device === "not-tried"
        ) {
            // No execution owner could be established at all.
            terminate(device, command, "dispatch-failed");
            return;
        }
        // Dispatched, but this build has no receiver-confirmation producer, so
        // the command must not claim the receiver reached any state. It is
        // reported as an unavailable observation and, crucially, does not
        // rewrite receiverPhase: the popup stops showing a pending dispatch
        // and falls back to the observed state.
        terminate(device, command, "observation-unavailable");
    }, PLAYBACK_COMMAND_DEADLINE_MS);
    command.watchdogTimer.unref?.();
}

/**
 * Handles a play/pause command from the popup. Latest wins: a new command
 * supersedes the device's active one, whose UI overlay is dropped immediately.
 *
 * Returns the command view for the popup, or undefined when there is no
 * receiver to command.
 */
export async function dispatchPlaybackCommand(
    device: ReceiverDevice,
    intent: PlaybackIntent,
    status?: MediaStatus
): Promise<ReceiverPlaybackView | undefined> {
    const previous = commands.get(device.id);
    if (previous) terminate(device, previous, "superseded");

    const identity = mediaIdentities.get(device.id);
    if (!identity) {
        // No LOAD generation recorded for this device: it is not currently
        // casting through this extension, so there is nothing to command.
        logger.warn("Playback command ignored: no media identity", {
            deviceId: device.id,
            intent
        });
        return undefined;
    }

    const command: PlaybackCommand = {
        commandId: ++nextCommandId,
        mediaIdentity: { ...identity },
        intent,
        routeAttempts: { page: "not-tried", device: "not-tried" },
        lifecycle: "active",
        pagePhase: "not-started",
        receiverPhase: "not-started"
    };
    commands.set(device.id, command);
    publish(device, command);
    armWatchdog(device, command);

    // Page first: it owns the page and the receiver together, so the bridge
    // must not also be driven when the page sender accepts. Only a rejected
    // page route falls through, and only once.
    if (pageRouteAttempt) {
        command.routeAttempts.page = "trying";
        command.pagePhase = "requesting";
        let accepted = false;
        try {
            accepted = await pageRouteAttempt(device.id, intent);
        } catch (err) {
            logger.error("Page playback route threw", err);
            accepted = false;
        }
        if (command.lifecycle !== "active") {
            // Superseded or terminated while the page route was in flight.
            return viewFor(command);
        }
        if (accepted) {
            command.routeAttempts.page = "accepted";
            command.owner = "page-sender";
            // The bare boolean protocol proves only that the page accepted the
            // control flow: not that the page transition happened, and not
            // that the receiver API was called. receiverPhase therefore stays
            // "not-started" until structured page acknowledgements exist.
            logger.info("Playback command handed to the page sender", {
                deviceId: device.id,
                commandId: command.commandId,
                intent
            });
            publish(device, command);
            return viewFor(command);
        }
        command.routeAttempts.page = "rejected";
        command.pagePhase = "failed";
        logger.info("Page playback route declined; falling back to bridge", {
            deviceId: device.id,
            commandId: command.commandId,
            intent
        });
    }

    command.routeAttempts.device = "trying";
    // The popup's own media commands always carry requestId 0 and the current
    // media session (see Receiver.svelte sendMediaMessage): this is a
    // fire-and-forget control message, not a request awaiting a tracked reply.
    const mediaSessionId = status?.mediaSessionId;
    if (mediaSessionId === undefined) {
        command.routeAttempts.device = "rejected";
        terminate(device, command, "dispatch-failed");
        return viewFor(command);
    }
    const dispatched =
        deviceRouteAttempt?.(device.id, {
            type: intent,
            requestId: 0,
            mediaSessionId
        } satisfies SenderMediaMessage) ?? false;
    if (command.lifecycle !== "active") return viewFor(command);
    if (!dispatched) {
        command.routeAttempts.device = "rejected";
        terminate(device, command, "dispatch-failed");
        return viewFor(command);
    }
    command.routeAttempts.device = "accepted";
    command.owner = "device-remote";
    command.receiverPhase = "requested";
    logger.info("Playback command handed to the bridge", {
        deviceId: device.id,
        commandId: command.commandId,
        intent
    });
    publish(device, command);
    return viewFor(command);
}

/** Terminates the device's active command, if any. */
export function terminateActivePlaybackCommand(
    deviceId: string,
    reason: PlaybackCommandTerminalReason
) {
    const command = commands.get(deviceId);
    if (!command || command.lifecycle !== "active") return;
    terminateIfCurrent(deviceId, command, reason);
}

/**
 * Terminates the device's active command only when this relay started the LOAD
 * it belongs to. Used by relay lifecycle messages, where a late stop from a
 * superseded relay must not touch a newer relay's command.
 *
 * Matches on `relayRequestId`, not `ownerId`: ownerId names whoever published
 * media last and is overwritten once the real session media replaces the
 * optimistic relay media, so a command issued after that point would never
 * match a relay stop.
 */
export function terminateActivePlaybackCommandForRelay(
    deviceId: string,
    relayRequestId: string,
    reason: PlaybackCommandTerminalReason
) {
    const command = commands.get(deviceId);
    if (!command || command.lifecycle !== "active") return;
    if (command.mediaIdentity.relayRequestId !== relayRequestId) return;
    terminateIfCurrent(deviceId, command, reason);
}

/** Terminates every active command. Used on bridge disconnect. */
export function terminateAllPlaybackCommands(
    reason: PlaybackCommandTerminalReason
) {
    for (const deviceId of [...commands.keys()]) {
        terminateActivePlaybackCommand(deviceId, reason);
    }
}

/**
 * Drops commands whose media identity no longer matches, i.e. the device
 * started a different LOAD. Called after a new generation is created.
 */
export function terminateCommandsForStaleMedia(deviceId: string) {
    const command = commands.get(deviceId);
    if (!command || command.lifecycle !== "active") return;
    if (sameMediaIdentity(command.mediaIdentity, mediaIdentities.get(deviceId)))
        return;
    terminateIfCurrent(deviceId, command, "media-changed");
}

/** Test/diagnostic view of the command registry. */
export function playbackCommandSnapshot() {
    return [...commands.entries()].map(([deviceId, command]) => ({
        deviceId,
        commandId: command.commandId,
        intent: command.intent,
        owner: command.owner,
        lifecycle: command.lifecycle,
        terminalReason: command.terminalReason,
        routeAttempts: { ...command.routeAttempts },
        pagePhase: command.pagePhase,
        receiverPhase: command.receiverPhase
    }));
}
