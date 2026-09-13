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
    /**
     * Request id of the relay (synthetic DVR) that started this LOAD, when the
     * cast went through one. Separate from `ownerId` on purpose: `ownerId`
     * names whoever most recently published media for this LOAD and is
     * overwritten when the real session media replaces the optimistic relay
     * media, so it cannot be used to correlate relay lifecycle messages
     * (mediaCast:mediaServerStopped) with a command.
     */
    relayRequestId?: string;
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
export type PagePlaybackPhase =
    | "not-started"
    /** executeScript is in flight. */
    | "requesting"
    /** Page was already in the target state; it drove the receiver directly. */
    | "already-target"
    /** The page transition is in flight and an armed window exists. */
    | "transition-requested"
    /** The page sub-flow failed (the device route may still take over). */
    | "failed";

/**
 * Receiver-side progress.
 *
 * `confirmed` requires an `ecp-poll` observation whose poll STARTED after the
 * receiver was commanded (see provenance.pollStartedAt) and matched the
 * intent. `not-confirmed` means such an observation existed but never matched,
 * including one still transitional at the deadline.
 *
 * A dispatched command that produced no usable observation keeps
 * receiverPhase `requested` and is distinguished by
 * `terminalReason === "observation-unavailable"`: it never claims the receiver
 * ended up in the wrong state.
 */
export type ReceiverPlaybackPhase =
    | "not-started"
    | "requested"
    | "confirmed"
    | "not-confirmed"
    /**
     * The receiver command itself failed: an explicit failure from the page
     * sender's Cast call (a Promise rejection) rather than a state that was
     * never observed. A terminal outcome with terminalReason "completed" - it
     * is NOT a command-level "dispatch-failed", and it must not wait for the
     * confirmation deadline.
     */
    | "failed";

/**
 * A play/pause command handed to the page sender.
 *
 * Carried from the background coordinator through executeScript into the page,
 * so the asynchronous page facts (arm consumption, receiver dispatch, timeout)
 * can be attributed back to the exact command that asked for them.
 */
export interface PlaybackPageCommand {
    commandId: number;
    mediaIdentity: RokuMediaIdentity;
    intent: PlaybackIntent;
}

/** Sync outcome of a page-route attempt. Only these two values exist. */
export type PageDispatchDisposition = "already-target" | "transition-requested";

/**
 * What the page sender reports synchronously, i.e. before any await.
 *
 * The dispatch timestamp is sampled BY THE PAGE, immediately before it calls
 * the Cast receiver API, and never by the background after executeScript
 * returns: the page calls that API during controlPlayback(), so the bridge can
 * be polling a post-command state while the result is still travelling back.
 * Stamping the return time would put receiverDispatchStartedAt after that
 * poll's pollStartedAt and the strict gate would silently discard a
 * legitimately post-command sample.
 */
export interface PagePlaybackDispatchResult {
    accepted: boolean;
    disposition?: PageDispatchDisposition;
    /** True iff the page called the Cast receiver API on this call. */
    receiverRequested?: boolean;
    /**
     * Page clock, sampled immediately before Cast Media.play/pause.
     * Required iff receiverRequested === true.
     */
    receiverDispatchStartedAt?: number;
    /** Page clock, sampled before the HTMLMediaElement transition. */
    armedAt?: number;
    expiresAt?: number;
    error?: string;
}

/** How an observation compared to the command's intent. */
export type PlaybackObservationClassification =
    | "matched"
    | "transitional"
    | "opposite"
    | "irrelevant";

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
    /**
     * The user's intent, valid while lifecycle is `active`. This is the only
     * source for the affordance: the button shows the OPPOSITE action (see
     * nextPlaybackIntentFor), which is derived rather than stored so the two
     * can never drift.
     */
    intent: PlaybackIntent;
    lifecycle: PlaybackCommandLifecycle;
    terminalReason?: PlaybackCommandTerminalReason;
    owner?: PlaybackExecutionOwner;
    receiverPending: boolean;
    /**
     * When the extension (device route) or the page (page route) started
     * submitting the receiver command. The strict observation gate compares
     * pollStartedAt against this, so it is also the value a diagnosis needs
     * when a command ends as "observation-unavailable".
     */
    receiverDispatchStartedAt?: number;
    pagePhase: PagePlaybackPhase;
    receiverPhase: ReceiverPlaybackPhase;
    /**
     * How the last usable observation compared to the intent. Diagnostics:
     * `opposite` (device settled in the other state), `transitional` (still
     * buffering), `irrelevant` (e.g. IDLE, media ended) point at different
     * failures.
     */
    lastObservation?: PlaybackObservationClassification;
}
