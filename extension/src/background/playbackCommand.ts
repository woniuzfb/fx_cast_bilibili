import type {
    PagePlaybackDispatchResult,
    PagePlaybackPhase,
    PlaybackPageCommand,
    PlaybackCommandLifecycle,
    PlaybackCommandTerminalReason,
    PlaybackExecutionOwner,
    PlaybackIntent,
    PlaybackObservationClassification,
    PlaybackRouteAttempt,
    ReceiverPlaybackPhase,
    ReceiverPlaybackView,
    RokuMediaIdentity
} from "../../../shared/playbackCommand";
import type { RokuMediaStatusProvenance } from "../../../shared/rokuMediaStatusProvenance";
import type { ReceiverDevice } from "../types";
import type { MediaStatus, SenderMediaMessage } from "../cast/sdk/types";
import { PlayerState } from "../cast/sdk/media/enums";

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
    /** Last reported failure message, page or receiver side. */
    error?: string;
    /**
     * When the extension STARTED submitting the receiver command to the
     * bridge - sampled before the port call, not after it. postMessage() is an
     * asynchronous submission boundary, so the bridge can begin its own
     * post-command poll while this call is still on the stack; stamping the
     * return time would put receiverDispatchStartedAt AFTER a legitimately
     * post-command sample's pollStartedAt and make the strict gate reject it.
     */
    receiverDispatchStartedAt?: number;
    /**
     * Last confirmable sample: an `ecp-poll` observation whose poll started no
     * earlier than receiverDispatchStartedAt, kept in poll-start order.
     * Echoes and synthetic states never land here - counting them would let a
     * command confirm itself.
     */
    lastObservation?: {
        classification: PlaybackObservationClassification;
        playerState: PlayerState;
        at: number;
        /**
         * When the accepted sample's poll STARTED. Observations are ordered by
         * this, not by arrival: pollOnce's busy timeout lets polls overlap
         * (POLL_BUSY_TIMEOUT_MS exceeds the poll interval), so an older poll can
         * finish last and would otherwise overwrite - or wrongly confirm - a
         * command based on a stale device state.
         */
        pollStartedAt: number;
    };
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
    | ((deviceId: string, command: PlaybackPageCommand) => Promise<unknown>)
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
        command: PlaybackPageCommand
    ) => Promise<unknown>;
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
        receiverDispatchStartedAt: command.receiverDispatchStartedAt,
        pagePhase: command.pagePhase,
        receiverPhase: command.receiverPhase,
        lastObservation: command.lastObservation?.classification
    };
}

function publish(device: ReceiverDevice, command: PlaybackCommand) {
    device.playbackCommand = viewFor(command);
    onViewChanged?.(device.id);
}

/**
 * Single owner invariant. A command may take an owner once; switching owners
 * would mean two execution paths (page and bridge) both driving the receiver.
 */
function assignPlaybackOwner(
    command: PlaybackCommand,
    owner: PlaybackExecutionOwner
) {
    if (command.owner !== undefined && command.owner !== owner) {
        logger.error("Invalid playback owner transition", {
            commandId: command.commandId,
            currentOwner: command.owner,
            requestedOwner: owner
        });
        return false;
    }
    command.owner = owner;
    return true;
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

/**
 * Compares an observed player state against a command's intent.
 *
 * BUFFERING is transitional in both directions: the receiver is mid-stream, so
 * it neither confirms the intent nor contradicts it. Whether specific firmware
 * reports "buffer" while pausing is not something this repo has verified, which
 * is precisely why it must not be treated as evidence either way.
 */
export function classifyObservation(
    intent: PlaybackIntent,
    state: PlayerState
): PlaybackObservationClassification {
    if (state === PlayerState.BUFFERING) return "transitional";
    if (intent === "PLAY" && state === PlayerState.PLAYING) return "matched";
    if (intent === "PAUSE" && state === PlayerState.PAUSED) return "matched";
    if (intent === "PLAY" && state === PlayerState.PAUSED) return "opposite";
    if (intent === "PAUSE" && state === PlayerState.PLAYING) return "opposite";
    // IDLE and anything unknown: the media ended, was dismissed, or moved on.
    return "irrelevant";
}

function acceptObservation(
    device: ReceiverDevice,
    command: PlaybackCommand,
    status: MediaStatus,
    provenance: RokuMediaStatusProvenance,
    receivedAt: number
) {
    if (command.lifecycle !== "active") return;
    if (command.receiverPhase !== "requested") return;
    // Whitelist, not blacklist: every other source either synthesizes state or
    // rebroadcasts the cached one - including the echo of the very intent this
    // command just dispatched (volume-key-echo and status-probe replay it too,
    // so excluding only command-echo would not be enough).
    if (provenance.source !== "ecp-poll") return;
    // Strict causal gate, on when the SAMPLE was taken rather than when the
    // message arrived: a poll that started before the dispatch overlaps the
    // command boundary, so its result cannot be attributed exclusively to this
    // command even if it arrives later. Rejecting it is the conservative
    // choice - `receivedAt` alone would accept such a sample.
    if (
        command.receiverDispatchStartedAt === undefined ||
        provenance.pollStartedAt < command.receiverDispatchStartedAt
    ) {
        return;
    }

    const previous = command.lastObservation;
    if (
        previous !== undefined &&
        provenance.pollStartedAt <= previous.pollStartedAt
    ) {
        // An overlapping poll that started no later than the sample already
        // accepted: its device state is not newer, so it must not re-decide the
        // command (a late older sample could otherwise confirm a command whose
        // newest observation said otherwise, or leave the deadline judging a
        // stale state).
        logger.info("Stale playback observation ignored", {
            deviceId: device.id,
            commandId: command.commandId,
            pollStartedAt: provenance.pollStartedAt,
            previousPollStartedAt: previous.pollStartedAt,
            sequence: provenance.sequence
        });
        return;
    }

    const classification = classifyObservation(
        command.intent,
        status.playerState
    );
    command.lastObservation = {
        classification,
        playerState: status.playerState,
        at: receivedAt,
        pollStartedAt: provenance.pollStartedAt
    };
    logger.info("Playback command observation", {
        deviceId: device.id,
        commandId: command.commandId,
        intent: command.intent,
        playerState: status.playerState,
        classification,
        pollStartedAt: provenance.pollStartedAt,
        sequence: provenance.sequence
    });
    if (classification === "matched") {
        command.receiverPhase = "confirmed";
        terminate(device, command, "completed");
        return;
    }
    publish(device, command);
}

/**
 * Consumes the dedicated Roku ECP playback-observation feed (bridge:
 * main:rokuPlaybackObservation), which reports every completed poll including
 * idle. Confirmation has exactly one input; the device media status feed is
 * the UX/media channel and is not consumed here.
 */
export function acceptReceiverObservation(
    deviceId: string,
    status: MediaStatus,
    provenance: RokuMediaStatusProvenance,
    receivedAt = Date.now()
) {
    const command = commands.get(deviceId);
    if (!command) return;
    const device = deviceLookup?.(deviceId);
    if (!device) return;
    acceptObservation(device, command, status, provenance, receivedAt);
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
        if (command.receiverPhase === "requested") {
            // Dispatched, and the deadline is the receiver-confirmation
            // window. With no usable observation we must NOT claim the
            // receiver ended up in the wrong state - only that we could not
            // find out. The popup stops showing a pending dispatch either
            // way; only the diagnostic reason differs.
            if (command.lastObservation === undefined) {
                terminate(device, command, "observation-unavailable");
                return;
            }
            // An observation existed but never matched the intent. A state
            // still transitional at the deadline (e.g. buffering) counts as
            // unconfirmed, since the requested state was never reached.
            command.receiverPhase = "not-confirmed";
            terminate(device, command, "completed");
            return;
        }
        // Page-owned command: the bare boolean protocol cannot report whether
        // the receiver API was ever called, so no receiver verdict is possible.
        terminate(device, command, "observation-unavailable");
    }, PLAYBACK_COMMAND_DEADLINE_MS);
    command.watchdogTimer.unref?.();
}

/**
 * Runtime validation of the page sender's structured reply.
 *
 * Without it a truthy-but-malformed object would be treated as a successful
 * page route. The matrix below is deliberately explicit: each arm of the union
 * has exactly one legal shape, so a field that only makes sense on another arm
 * is rejected rather than ignored.
 */
export function isValidPagePlaybackDispatchResult(
    value: unknown
): value is PagePlaybackDispatchResult {
    if (!value || typeof value !== "object") return false;
    const result = value as Record<string, unknown>;
    if (typeof result.accepted !== "boolean") return false;
    if (result.error !== undefined && typeof result.error !== "string")
        return false;

    if (result.accepted === false) {
        return (
            result.disposition === undefined &&
            result.receiverRequested !== true &&
            result.receiverDispatchStartedAt === undefined &&
            result.armedAt === undefined &&
            result.expiresAt === undefined
        );
    }

    if (result.disposition === "already-target") {
        // The page drove the receiver directly: no page transition, no arm,
        // but a dispatch timestamp the strict gate needs.
        return (
            result.receiverRequested === true &&
            typeof result.receiverDispatchStartedAt === "number" &&
            Number.isFinite(result.receiverDispatchStartedAt) &&
            result.armedAt === undefined &&
            result.expiresAt === undefined
        );
    }

    if (result.disposition === "transition-requested") {
        // The arm is established and the page transition started; the Cast call
        // has not happened yet, so there is no dispatch timestamp.
        return (
            result.receiverRequested === false &&
            result.receiverDispatchStartedAt === undefined &&
            typeof result.armedAt === "number" &&
            typeof result.expiresAt === "number" &&
            result.expiresAt > result.armedAt
        );
    }

    return false;
}

/** Arms the receiver watchdog from a page-reported dispatch timestamp. */
function markReceiverRequestedFromPage(
    device: ReceiverDevice,
    command: PlaybackCommand,
    dispatchStartedAt: number | undefined,
    hostClockNow: number
) {
    if (dispatchStartedAt === undefined) {
        logger.error("Page reported a receiver request without a timestamp", {
            deviceId: device.id,
            commandId: command.commandId
        });
        return;
    }
    // The page and the background share one browser process clock, so a page
    // timestamp is directly comparable with pollStartedAt. A wildly future or
    // past value is a protocol bug, not a reason to fake a window.
    if (
        !Number.isFinite(dispatchStartedAt) ||
        Math.abs(hostClockNow - dispatchStartedAt) > 60_000
    ) {
        logger.error("Rejecting implausible page dispatch timestamp", {
            deviceId: device.id,
            commandId: command.commandId,
            dispatchStartedAt,
            hostClockNow
        });
        return;
    }
    command.receiverPhase = "requested";
    command.receiverDispatchStartedAt = dispatchStartedAt;
    // Synchronous switch: the dispatch watchdog is replaced by the receiver
    // one with no async gap in between, so an active command is never without
    // a watchdog.
    armWatchdog(device, command);
}

/**
 * Applies a page route result. Returns true when the command reached a
 * terminal state, i.e. the device route must not be tried.
 */
function applyPageRouteResult(
    device: ReceiverDevice,
    command: PlaybackCommand,
    result: PagePlaybackDispatchResult
): boolean {
    command.routeAttempts.page = result.accepted ? "accepted" : "rejected";
    if (!result.accepted) {
        command.pagePhase = "failed";
        command.error = result.error;
        return false;
    }

    assignPlaybackOwner(command, "page-sender");
    command.pagePhase =
        result.disposition === "already-target"
            ? "already-target"
            : "transition-requested";
    if (result.receiverRequested) {
        markReceiverRequestedFromPage(
            device,
            command,
            result.receiverDispatchStartedAt,
            Date.now()
        );
    }
    logger.info("Playback command handed to the page sender", {
        deviceId: device.id,
        commandId: command.commandId,
        intent: command.intent,
        disposition: result.disposition,
        receiverRequested: result.receiverRequested === true
    });
    publish(device, command);
    return false;
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
        let raw: unknown;
        try {
            raw = await pageRouteAttempt(device.id, command);
        } catch (err) {
            logger.error("Page playback route threw", err);
            raw = undefined;
        }
        if (command.lifecycle !== "active") {
            // Superseded or terminated while the page route was in flight.
            return viewFor(command);
        }
        const pageResult = isValidPagePlaybackDispatchResult(raw)
            ? raw
            : undefined;
        if (!pageResult) {
            // Entry point missing, an illegal shape, or a throw: the page never
            // reported executing anything, so the bridge may take over.
            command.routeAttempts.page = "rejected";
            command.pagePhase = "failed";
            logger.info(
                "Page playback route unavailable; falling back to bridge",
                {
                    deviceId: device.id,
                    commandId: command.commandId,
                    intent,
                    rawResult: raw === undefined ? "undefined" : typeof raw
                }
            );
        } else {
            const finished = applyPageRouteResult(device, command, pageResult);
            if (finished || command.owner === "page-sender") {
                return viewFor(command);
            }
            logger.info(
                "Page playback route declined; falling back to bridge",
                {
                    deviceId: device.id,
                    commandId: command.commandId,
                    intent,
                    error: pageResult.error
                }
            );
        }
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
    const dispatchStartedAt = Date.now();
    const dispatched =
        deviceRouteAttempt?.(device.id, {
            type: intent,
            requestId: 0,
            mediaSessionId
        } satisfies SenderMediaMessage) ?? false;
    if (command.lifecycle !== "active") return viewFor(command);
    if (!dispatched) {
        // Nothing was submitted, so nothing may claim a receiver request.
        command.routeAttempts.device = "rejected";
        terminate(device, command, "dispatch-failed");
        return viewFor(command);
    }
    command.routeAttempts.device = "accepted";
    if (!assignPlaybackOwner(command, "device-remote")) {
        terminate(device, command, "dispatch-failed");
        return viewFor(command);
    }
    command.receiverPhase = "requested";
    command.receiverDispatchStartedAt = dispatchStartedAt;
    // The confirmation window starts at the real dispatch boundary, not at
    // command creation: a slow page-route attempt must not eat into the window
    // the receiver observation needs.
    armWatchdog(device, command);
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
