import { PlayerState } from "../../cast/sdk/media/enums";

/**
 * Playback affordance intent derived from an observed player state.
 *
 * The single source of truth for every play/pause affordance in the popup: the
 * media panel button (icon *and* tooltip), the popup context-menu item (title
 * *and* enabled state) and the command the click actually sends.
 *
 * The semantics are "what the next click should do", NOT "what the player is
 * doing" — the icon of a paused item must be the play glyph. Keeping one
 * helper for all four surfaces is deliberate: they used to derive this
 * independently and disagreed. BUFFERING was treated as "playing" by the
 * button icon but as "not playing" by the button tooltip, and the click
 * handler matched neither, so a click while buffering silently did nothing.
 *
 * BUFFERING maps to PAUSE intent because the receiver is mid-stream, not
 * stopped: the user's meaningful action there is to pause.
 *
 * IDLE returns undefined because no play/pause action is offered while the
 * receiver has no active playback state. Every popup affordance (panel button
 * and context-menu item) stays disabled until a playable state is observed,
 * and the click handler refuses to send anything without an intent. A
 * best-effort PLAY here would be unreachable through the UI but reachable by
 * any other caller, which is exactly the kind of hidden second policy this
 * helper exists to remove.
 */
export function playbackIntentFromState(
    state: PlayerState | undefined
): "PLAY" | "PAUSE" | undefined {
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
