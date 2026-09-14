import { PlayerState } from "./cast/sdk/media/enums";
import type { MediaStatus } from "./cast/sdk/types";
import type { ReceiverDevice } from "./types";
import type {
    PlaybackIntent,
    ReceiverPlaybackView
} from "../../shared/playbackCommand";

/**
 * Pure derivations of the popup's play/pause affordance.
 *
 * Kept out of background/playbackCommand.ts on purpose: the popup and the
 * background coordinator both need these, and importing the coordinator from
 * the popup would build a second copy of its module-level registries (command
 * map, load generations, media identities, page-route callbacks) into the
 * popup bundle — a copy that could never agree with the background's. This
 * module has no module state and no side effects.
 */

/** The intent a click should send for an observed player state. */
export function intentForPlaybackState(
    state: PlayerState | undefined
): PlaybackIntent | undefined {
    switch (state) {
        case PlayerState.PLAYING:
        case PlayerState.BUFFERING:
            return "PAUSE";

        case PlayerState.PAUSED:
            return "PLAY";

        default:
            return undefined;
    }
}

/**
 * The action the play/pause affordance should offer right now: the opposite of
 * an outstanding command's intent (the user asked for that state, so the next
 * click undoes it), otherwise whatever the observed state implies.
 *
 * `undefined` means "no meaningful play/pause action" (IDLE with no command),
 * which disables the affordance.
 */
export function nextPlaybackIntentFor(
    device: ReceiverDevice,
    status?: MediaStatus
): PlaybackIntent | undefined {
    const view = device.playbackCommand;
    if (view?.lifecycle === "active") {
        /**
         * A sample that CONTRADICTS the pending command means the receiver has
         * already moved the other way (the physical remote, another sender):
         * the affordance must follow what was OBSERVED. Offering the inverse of
         * an outstanding request is only right while the receiver has not been
         * seen to disagree - otherwise the popup kept showing PLAY while the
         * device was playing, until the receiver watchdog terminated the command
         * seconds later (measured: the coordinator stays active on `opposite`,
         * and this derivation was the only reason the button lagged).
         */
        if (view.lastObservation === "opposite") {
            return view.intent;
        }
        return view.intent === "PLAY" ? "PAUSE" : "PLAY";
    }
    return intentForPlaybackState(status?.playerState);
}

/** The intent of the device's outstanding command, if any. */
export function activePlaybackIntent(
    device: ReceiverDevice
): PlaybackIntent | undefined {
    const view: ReceiverPlaybackView | undefined = device.playbackCommand;
    return view?.lifecycle === "active" ? view.intent : undefined;
}

/**
 * Whether a receiver-side dispatch is still outstanding. Requires an ACTIVE
 * command: a terminal command may keep `receiverPhase = "requested"` (see
 * `observation-unavailable`), and deriving pending from the phase alone would
 * leave the indicator on forever.
 */
export function isPlaybackReceiverPending(device: ReceiverDevice): boolean {
    const view: ReceiverPlaybackView | undefined = device.playbackCommand;
    return view?.lifecycle === "active" && view.receiverPending === true;
}
