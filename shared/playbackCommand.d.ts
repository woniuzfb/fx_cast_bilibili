/**
 * shared/playbackCommand.d.ts — single source of truth for the play/pause
 * command view that crosses the extension's background→popup boundary.
 *
 * Why a `.d.ts` (copied from shared/pongReport.d.ts, which explains the same
 * constraint): the bridge compiles with `tsc` and an inferred rootDir of
 * `bridge/`. A regular `.ts` here would be pulled into that program, emitted,
 * and shift the common rootDir to the repo root — moving
 * `dist/app/src/main.js` and breaking the launcher. A declaration file is
 * never emitted and never counts toward rootDir.
 *
 * Today only the extension uses these shapes. They live here (rather than in a
 * background-only module) because the popup imports them too, and because the
 * bridge is expected to join the protocol once page-route acknowledgements
 * become structured.
 */

/** What the user asked for when they pressed the play/pause affordance. */
export type PlaybackIntent = "PLAY" | "PAUSE";

/**
 * Which side is executing a command. Exactly one owner per command.
 *
 * - `page-sender`: the Bilibili page sender accepted the command and drives
 *   both the page and the receiver, so the bridge must NOT be commanded
 *   directly as well.
 * - `device-remote`: the page sender declined (no injection, no active cast
 *   media, ...) and the request went to the bridge instead.
 */
export type PlaybackExecutionOwner = "page-sender" | "device-remote";

/** Whether a route has been tried, and what came back. */
export type PlaybackRouteAttempt =
    | "not-tried"
    | "trying"
    | "accepted"
    | "rejected";

/**
 * Media identity of the cast the command belongs to. A command must never be
 * applied to a receiver status belonging to a different load.
 *
 * `loadGeneration` is the primary key and is monotonic per deviceId for the
 * lifetime of the background script (it is deliberately NOT reset on device
 * down, so a reconnect cannot reuse a generation number while stale messages
 * are still in flight). `contentId` and `ownerId` refine it and may arrive
 * slightly later than the generation is created.
 *
 * NOTE: this does not use the Roku `mediaSessionId`, which is a hardcoded 1 in
 * both deviceManager.setRokuSessionMedia and RokuRemote.buildStatusMedia and
 * therefore cannot distinguish loads.
 */
export interface RokuMediaIdentity {
    deviceId: string;
    loadGeneration: number;
    contentId?: string;
    ownerId?: string;
}

/** A command that is executing or has just finished. */
export type PlaybackCommandLifecycle = "active" | "terminal";

/**
 * Why a command stopped. `observation-unavailable` is the honest outcome while
 * no receiver-confirmation producer exists: the command was dispatched and
 * then gave up waiting, without claiming the receiver reached (or failed to
 * reach) the requested state.
 */
export type PlaybackCommandTerminalReason =
    | "completed"
    | "superseded"
    | "media-changed"
    | "stopped"
    | "device-disconnected"
    | "bridge-disconnected"
    | "dispatch-failed"
    | "observation-unavailable";

/**
 * Coarse page-route progress. Deliberately small until the page sender returns
 * a structured result: the current protocol is a bare boolean, which proves
 * only that the page accepted the control flow — not that the page transition
 * happened, nor that the receiver API was called. See
 * PagePlaybackDispatchResult in a later step.
 */
export type PagePlaybackPhase = "not-started" | "requesting";

/**
 * Receiver-side progress. `confirmed` / `not-confirmed` are intentionally
 * absent: they require a verified command-after observation, which does not
 * exist yet.
 */
export type ReceiverPlaybackPhase = "not-started" | "requested";

/**
 * The play/pause view the popup renders, attached to the receiver device
 * record alongside (never instead of) the observed `mediaStatus`.
 *
 * `intent` is the user's outstanding target and is what the button must show
 * while the command is active; `receiverPending` says whether a receiver-side
 * dispatch is still outstanding. It is carried as a sibling of mediaStatus so
 * intent can never leak into the observed player state, which the timeline,
 * the buffering shimmer and the seek-settling logic all read.
 */
export interface ReceiverPlaybackView {
    commandId: number;
    /** The user's intent, valid while lifecycle is `active`. */
    intent: PlaybackIntent;
    /**
     * Present iff the resolved intent differs from the observed state, i.e.
     * the icon/tooltip the popup must show while this command is active.
     */
    nextIntent?: PlaybackIntent;
    lifecycle: PlaybackCommandLifecycle;
    terminalReason?: PlaybackCommandTerminalReason;
    owner?: PlaybackExecutionOwner;
    receiverPending: boolean;
    pagePhase: PagePlaybackPhase;
    receiverPhase: ReceiverPlaybackPhase;
}
