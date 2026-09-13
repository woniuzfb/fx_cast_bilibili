/**
 * Roku-only shared state between the emulated cast session and the
 * device-level remote.
 *
 * The popup consumes receiver media data through the DEVICE status path
 * (`main:receiverDeviceMediaStatusUpdated`, synthesized by RokuRemote), while
 * the LOAD's full MediaInformation (contentId, duration, customData such as
 * the synthetic-DVR hlsDvr/pageDuration anchors) only reaches the emulated
 * RokuSession. This registry hands the session's loaded media to the remote so
 * the popup's seek bar gets the same metadata a Chromecast receiver would echo
 * back — without touching any generic (castv2) status path.
 *
 * Keyed by receiver device ID. The session registers on a successful LOAD and
 * unregisters on teardown; the remote reads on every status emit.
 *
 * The session lives in its own connectNative process, so its call into this
 * module writes an instance the discovery-side remote can never observe. What
 * the remote actually reads is this process's own registry, and this process
 * writes it through RokuSessionMediaSync from the extension's mirror.
 */
import type { MediaInformation } from "../cast/types";

interface RegisteredRokuSessionMedia {
    sessionId: string;
    media: MediaInformation;
}

const sessionMediaByDevice = new Map<string, RegisteredRokuSessionMedia>();
/** LOAD generation each registration belongs to, when the caller knows one. */
const registeredGenerations = new Map<string, number>();

/**
 * Observers receive `undefined` when the media for this device is cleared, so a
 * consumer can drop whatever it synthesised from it. The previous shape
 * (media only) meant a clear was silent, leaving a stale synthesis in place.
 */
type RokuSessionMediaObserver = (media: MediaInformation | undefined) => void;
const sessionMediaObservers = new Map<string, Set<RokuSessionMediaObserver>>();

/** Registers the media a Roku session currently has loaded for a device. */
export function registerRokuSessionMedia(
    deviceId: string,
    sessionId: string,
    media: MediaInformation,
    loadGeneration?: number
) {
    sessionMediaByDevice.set(deviceId, { sessionId, media });
    if (loadGeneration === undefined) registeredGenerations.delete(deviceId);
    else registeredGenerations.set(deviceId, loadGeneration);
    const observers = sessionMediaObservers.get(deviceId);
    if (!observers) return;
    for (const observer of observers) {
        try {
            observer(media);
        } catch {
            // Best-effort notification only; never affect the Roku LOAD path.
        }
    }
}

/** Notify an existing Roku device remote immediately when a session registers
 * media metadata. The callback is Roku-only and never blocks registration. */
export function observeRokuSessionMedia(
    deviceId: string,
    observer: RokuSessionMediaObserver
): () => void {
    let observers = sessionMediaObservers.get(deviceId);
    if (!observers) {
        observers = new Set();
        sessionMediaObservers.set(deviceId, observers);
    }
    observers.add(observer);

    const current = sessionMediaByDevice.get(deviceId);
    if (current) {
        try {
            observer(current.media);
        } catch {
            // Best-effort notification only.
        }
    }

    return () => {
        const currentObservers = sessionMediaObservers.get(deviceId);
        if (!currentObservers) return;
        currentObservers.delete(observer);
        if (currentObservers.size === 0) {
            sessionMediaObservers.delete(deviceId);
        }
    };
}

/** Clears the registered media (session teardown / media end). */
export function unregisterRokuSessionMedia(
    deviceId: string,
    sessionId: string
) {
    const current = sessionMediaByDevice.get(deviceId);
    if (current?.sessionId !== sessionId) return;
    sessionMediaByDevice.delete(deviceId);
    registeredGenerations.delete(deviceId);
    // Tell observers the media is gone: a consumer that synthesised state from
    // it (the HLS DVR startup overlay) must be able to drop it immediately
    // rather than keeping a stale claim until some later poll happens to clear
    // it.
    const observers = sessionMediaObservers.get(deviceId);
    if (!observers) return;
    for (const observer of observers) {
        try {
            observer(undefined);
        } catch {
            // Best-effort notification only.
        }
    }
}

/**
 * Drops the registered media of a superseded LOAD generation, returning
 * whether anything was dropped.
 *
 * Advancing a device from one LOAD generation to the next must retire the
 * previous load's metadata at once: until the new load's media arrives, the
 * remote would keep reading the old duration and synthetic-DVR anchors and
 * synthesise them for a load they do not describe.
 *
 * Media registered without a known generation is left alone — nothing here can
 * tell whether it is stale, and dropping it would be the more damaging guess.
 */
export function retireRokuSessionMediaIfGenerationStale(
    deviceId: string,
    currentLoadGeneration: number
): boolean {
    const registered = registeredGenerations.get(deviceId);
    if (registered === undefined) return false;
    if (registered === currentLoadGeneration) return false;
    const current = sessionMediaByDevice.get(deviceId);
    // Both maps are written together; the delete is a guard against a state
    // that should not occur rather than an expected branch.
    if (!current) {
        registeredGenerations.delete(deviceId);
        return false;
    }
    unregisterRokuSessionMedia(deviceId, current.sessionId);
    return true;
}

/** The media a Roku session currently has loaded on the device, if any. */
export function getRokuSessionMedia(
    deviceId: string
): MediaInformation | undefined {
    return sessionMediaByDevice.get(deviceId)?.media;
}
