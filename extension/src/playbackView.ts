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
 * The action the play/pause affordance should offer right now.
 *
 * ## The owner of this answer
 *
 * The OUTSTANDING INTENT owns what the button offers only while the receiver has
 * not been seen to disagree. As soon as an observation contradicts the pending
 * command, the OBSERVED state takes over — immediately, not when the receiver
 * watchdog finally terminates the command.
 *
 * Measured on a real session: with a PAUSE still pending, a press of PLAY on the
 * physical Roku remote left the popup offering PLAY for several seconds, because
 * the pending intent kept owning the affordance while the device was already
 * playing. The command legitimately stays active through that window (the
 * coordinator only PUBLISHES an `opposite` sample so its own deadline can still
 * conclude it), which is exactly why the affordance must not read the command
 * lifecycle alone.
 *
 * The decision is taken from the CURRENT observed state rather than from the
 * recorded `lastObservation` classification. The classification records the
 * sample that was accepted when the contradiction was first noticed; `status` is
 * the same object the timeline and the buffering shimmer read, so the button
 * cannot disagree with what the popup is displaying. (In practice the window in
 * which the two answers differ is short, because a sample that MATCHES the intent
 * terminates the command. The point is that the affordance reads the OBSERVATION
 * rather than a stored classification whose lifetime is a coordinator detail.)
 *
 * A pending receiver dispatch does NOT change this answer: `receiverPending` is
 * published separately (see `isPlaybackReceiverPending`) and is what the pending
 * indicator renders, so the button can show the truth while the spinner shows
 * that work is still outstanding.
 *
 * `undefined` means "no meaningful play/pause action" (IDLE with no usable
 * observation), which disables the affordance.
 */
export function nextPlaybackIntentFor(
    device: ReceiverDevice,
    status?: MediaStatus
): PlaybackIntent | undefined {
    const view = device.playbackCommand;
    const observed = intentForPlaybackState(status?.playerState);
    if (view?.lifecycle !== "active") return observed;
    if (view.lastObservation === "opposite") {
        // The receiver contradicted the pending command: what it is doing now
        // decides the affordance. The fallback only covers an observation that
        // classified as opposite against a status whose player state offers no
        // action at all (e.g. IDLE arrived in the same tick), where the user's
        // outstanding request is still the better answer than nothing.
        return observed ?? view.intent;
    }
    // No contradiction on record: the user's request is still the target, so the
    // button offers the action that undoes it.
    return view.intent === "PLAY" ? "PAUSE" : "PLAY";
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
