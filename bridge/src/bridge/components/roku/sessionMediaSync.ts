/**
 * Binds mirrored Roku session media to the device's current LOAD generation.
 *
 * Two independent messages describe a load on the discovery side — the
 * generation (`bridge:rokuSetLoadGeneration`) and the session's media
 * (`bridge:rokuSetSessionMedia`) — and either may arrive first. Registering
 * media the moment it arrives is therefore wrong whenever the generation is
 * still unknown: the media would stand as if it described the load that follows
 * it, handing RokuRemote a superseded load's duration and synthetic-DVR
 * anchors (which it uses to synthesise the startup BUFFERING state).
 *
 * This class is the single decision point: media waits until it can be
 * attributed to the current generation, media from a superseded generation is
 * retired as soon as the generation advances, and a straggler message from an
 * older load never displaces a newer one. Nothing else may register session
 * media, so the rule cannot drift between call paths.
 */
import type { MediaInformation } from "../cast/types";
import {
    registerRokuSessionMedia,
    retireRokuSessionMediaIfGenerationStale,
    unregisterRokuSessionMedia
} from "./sessionMedia";

export interface RokuSessionMediaMirrorUpdate {
    deviceId: string;
    loadGeneration: number;
    ownerId: string;
    media: MediaInformation | null;
}

interface PendingSessionMedia {
    loadGeneration: number;
    ownerId: string;
    media: MediaInformation | null;
}

/**
 * Whether a generation arriving from the extension may be used at all.
 *
 * The producer is a monotonic counter that starts at 1, so anything else has
 * crossed a process boundary as a malformed value. Mirrors the check in
 * RokuRemote.setLoadGeneration: two consumers of the same message must not
 * disagree about which values are real.
 */
function isUsableLoadGeneration(loadGeneration: unknown): boolean {
    return (
        typeof loadGeneration === "number" &&
        Number.isSafeInteger(loadGeneration) &&
        loadGeneration > 0
    );
}

export class RokuSessionMediaSync {
    /** LOAD generation the extension considers current, per device. */
    private readonly loadGenerations = new Map<string, number>();
    /** The newest mirrored media per device, waiting for its generation. */
    private readonly pending = new Map<string, PendingSessionMedia>();

    /**
     * The generation a newly created remote must start polling under. It has to
     * be read here rather than in the remote because the push can precede the
     * remote's creation.
     */
    currentLoadGeneration(deviceId: string): number | undefined {
        return this.loadGenerations.get(deviceId);
    }

    /**
     * Records the extension's current LOAD generation for a device.
     *
     * Validated BEFORE anything is written or retired, because this value is a
     * cross-process input and the failure mode is not "the value is ignored"
     * but "the value is used": a bad generation would retire the current load's
     * media (the registry is keyed on the generation it was applied under) and
     * leave this module disagreeing with the remote, which rejects the same
     * message.
     */
    setLoadGeneration(deviceId: string, loadGeneration: number) {
        if (!deviceId || !isUsableLoadGeneration(loadGeneration)) return;

        const current = this.loadGenerations.get(deviceId);
        // Generations are monotonic per device, so a late message from an older
        // load must not roll this back - and must not retire the newer load's
        // media.
        if (current !== undefined && loadGeneration < current) return;

        if (current === loadGeneration) {
            // A replay of the current generation is still meaningful: it may be
            // exactly what session media already pending was waiting for.
            this.apply(deviceId);
            return;
        }

        // Record first, then apply: session media that arrived before this
        // message was waiting for exactly this, and media registered under the
        // previous generation is retired by the same call.
        this.loadGenerations.set(deviceId, loadGeneration);
        this.apply(deviceId);
    }

    setSessionMedia(update: RokuSessionMediaMirrorUpdate) {
        // Same rule as the generation: reject before the value can occupy
        // `pending` and skew the straggler comparison below. An empty owner is
        // rejected too - it would make an owner-aware clear match a
        // registration whose owner was never named.
        if (
            !update.deviceId ||
            !update.ownerId ||
            !isUsableLoadGeneration(update.loadGeneration)
        ) {
            return;
        }
        const pending = this.pending.get(update.deviceId);
        // Generations are monotonic per device, so a message for an older load
        // than the one already pending is a straggler (a delayed replay from a
        // replaced session) and must not displace the newer entry.
        if (pending && pending.loadGeneration > update.loadGeneration) return;
        this.pending.set(update.deviceId, {
            loadGeneration: update.loadGeneration,
            ownerId: update.ownerId,
            media: update.media
        });
        this.apply(update.deviceId);
    }

    private apply(deviceId: string) {
        const currentGeneration = this.loadGenerations.get(deviceId);

        // Advance-time retirement: the previous load's metadata must go now,
        // not when the new load's media happens to arrive.
        if (currentGeneration !== undefined) {
            retireRokuSessionMediaIfGenerationStale(
                deviceId,
                currentGeneration
            );
        }

        const pending = this.pending.get(deviceId);
        if (!pending) return;
        // No generation for this device yet: registering now would bind the
        // media to whichever load is announced next.
        if (currentGeneration === undefined) return;
        if (pending.loadGeneration !== currentGeneration) return;

        this.pending.delete(deviceId);
        if (pending.media) {
            registerRokuSessionMedia(
                deviceId,
                pending.ownerId,
                pending.media,
                pending.loadGeneration
            );
        } else {
            // Owner-aware inside the registry: a late clear from a replaced
            // session must not drop the current one's metadata.
            unregisterRokuSessionMedia(deviceId, pending.ownerId);
        }
    }
}
