import type { PlaybackCommandProgress } from "../../../shared/playbackCommand";

/**
 * Bridges the RUNTIME channel to the coordinator's page-progress entry.
 *
 * The page sender posts `main:bilibiliPlaybackProgress` with
 * `browser.runtime.sendMessage`, while the coordinator's consumer used to be
 * reachable only from the native discovery bridge port (`onBridgeMessage`). The
 * message was therefore never delivered: a page-route command could not reach
 * `receiverPhase: "requested"`, and it died on the 12s page-dispatch watchdog
 * instead of being confirmed. Measured on a real session, the sender did claim
 * the command and call the receiver while the background still reported
 * `receiverPhase: "not-started"`; after this hop existed, the same gesture
 * completed in 88ms.
 *
 * Its own module, with the target passed IN rather than imported, so the hop is
 * testable without booting the background or dragging `deviceManager`'s module
 * side effects along: see `test/playback/runtimeRelay.js`.
 */
export function registerPagePlaybackProgressRuntimeRelay(target: {
    handlePagePlaybackProgress: (detail: PlaybackCommandProgress) => void;
}) {
    browser.runtime.onMessage.addListener(message => {
        if (message?.subject !== "main:bilibiliPlaybackProgress") return;
        target.handlePagePlaybackProgress(message.data);
    });
}
