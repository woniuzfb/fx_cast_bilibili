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
 */
import type { MediaInformation } from "../cast/types";

interface RegisteredRokuSessionMedia {
    sessionId: string;
    media: MediaInformation;
}

const sessionMediaByDevice = new Map<string, RegisteredRokuSessionMedia>();

type RokuSessionMediaObserver = (media: MediaInformation) => void;
const sessionMediaObservers = new Map<string, Set<RokuSessionMediaObserver>>();

/** Registers the media a Roku session currently has loaded for a device. */
export function registerRokuSessionMedia(
    deviceId: string,
    sessionId: string,
    media: MediaInformation
) {
    sessionMediaByDevice.set(deviceId, { sessionId, media });
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
}

/** The media a Roku session currently has loaded on the device, if any. */
export function getRokuSessionMedia(
    deviceId: string
): MediaInformation | undefined {
    return sessionMediaByDevice.get(deviceId)?.media;
}
