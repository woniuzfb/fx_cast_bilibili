/**
 * The one place inside `MediaSender` that owns DASH SEEK INTENT, media
 * GENERATION changes, and the attribution of the sender's own page-position
 * writes.
 *
 * ## What this module does NOT own (read before extending it)
 *
 * It is deliberately not a global playback state machine. Play/pause is owned
 * elsewhere, and that split is intentional:
 *
 *   `background/playbackCommand.ts`  the play/pause COMMAND lifecycle: receiver
 *                                    dispatch phase, observation classification,
 *                                    watchdog, and `device.playbackCommand`
 *   `playbackView.ts`                the popup's play/pause AFFORDANCE, derived
 *                                    from that view plus the observed state
 *   THIS module (sender-side)        seek intent, media generation, page-write
 *                                    attribution, receiver-position observation
 *
 * Two owners exist because the two transactions have different scopes: a
 * play/pause command spans popup and receiver, while a seek is a capture-side
 * rebuild that also invalidates the receiver's presentation timeline. What must
 * NOT happen is one of them quietly doing the other's job — which is exactly what
 * the old code did, when a receiver position could become a seek.
 *
 * ## Why this module exists
 *
 * Seek state used to be spread over a set of independent booleans on the sender
 * (a mirror-hold flag, `dashTightenSync`, `dashSeekRunning`,
 * `pendingDashSeekPrime`, the seek-source priming window, the item-transition
 * window, the suppress counters) plus an offset in the background and a timeline
 * in the popup. Each of those could
 * independently decide that the position was wrong and that another remux restart
 * was needed. The result was a feedback loop:
 *
 *     receiver time -> conversion -> popup -> page -> drift -> seek
 *       -> reload -> receiver time -> ...
 *
 * Seek entry points are now funnelled through this coordinator, which holds
 * exactly ONE phase and ONE outstanding seek intent at a time. The rest of the
 * sender keeps its mechanics (capture priming, bridge restart, LOAD identity);
 * the coordinator owns the DECISION of what the current seek transaction is.
 *
 * ## The rules this module enforces
 *
 * 1. Only an explicit USER-side intent restarts the remux:
 *    a popup/page user seek, a BLE skip, an item/quality change, or one
 *    recovery retry. A receiver status report NEVER does.
 * 2. Receiver status only ever updates the observed snapshot. It cannot create
 *    an intent, cannot change `desiredPageTime`, and cannot move the page while
 *    the coordinator holds the page for a transaction.
 * 3. At most one remux restart is in flight. Repeated seeks coalesce onto the
 *    newest target, and the target that was actually restarted is reported back
 *    so a caller can never mistake a coalesced seek for its own.
 * 4. Every intent carries an `intentId`. Anything derived from it (a page write,
 *    a load, a LOG) can be attributed to exactly one intent, so a stale event
 *    from a superseded intent is dropped by identity instead of by a timer.
 *
 * The receiver's presentation clock is deliberately NOT visible here: the
 * coordinator speaks page seconds only. The single crossing lives in
 * `cast/dashPresentation.ts`.
 *
 * STILL NOT UNIFIED (so the next reader is not surprised by what is left):
 * `dashTightenSync`/`dashTightenDeadline` remain separate mechanical state on the
 * sender (post-load settle position and GET_STATUS polling), and the seek's
 * capture-priming window is still a field of its own rather than a member of the
 * transaction below.
 */

/**
 * Who asked for an operation. Only the first five may restart the remux.
 *
 * `receiver-status`, `sync-write` and `page-autonomous` exist so the "who" is
 * recorded even when the answer is "do nothing": a dropped trigger is
 * distinguishable in the trace from a trigger that never arrived.
 */
export type PlaybackIntentOrigin =
    | "popup"
    | "page"
    | "ble"
    | "item"
    | "quality"
    | "recovery"
    | "receiver-status"
    | "sync-write"
    | "page-autonomous";

/** Origins whose requests may start a new remux generation. */
const SEEK_INTENT_ORIGINS: ReadonlySet<PlaybackIntentOrigin> = new Set([
    "popup",
    "page",
    "ble",
    "item",
    "quality",
    "recovery"
]);

export function isSeekIntentOrigin(origin: PlaybackIntentOrigin): boolean {
    return SEEK_INTENT_ORIGINS.has(origin);
}

/**
 * The single state machine for playback. Exactly one phase is current.
 *
 * `seeking` covers the whole remux-restart transaction: priming the page
 * capture, restarting the bridge, and loading the receiver. `switching-item` is
 * the same shape reached by a navigation/quality change rather than by a
 * position request. Collapsing the old parallel booleans into one phase is what
 * makes "is a transaction running?" a single answer instead of a combination.
 */
export type PlaybackPhase = "idle" | "seeking" | "switching-item" | "failed";

export interface PlaybackIntent {
    intentId: number;
    origin: PlaybackIntentOrigin;
    /** Page seconds. The only time domain that crosses this API. */
    targetPageSeconds: number;
    /**
     * Which media this intent was asked FOR, when the caller knows.
     *
     * A seek that an item load coalesced must not be served on the NEXT item: the
     * user asked for 120s of video B, and applying it to video C would start
     * playback where nobody asked. Undefined means "the caller did not say", which
     * keeps the intent rather than guessing.
     */
    mediaIdentity?: string;
    requestedAt: number;
}

/**
 * What the receiver last reported, in PAGE seconds. Written by
 * `observeReceiverPosition` only — never by an intent — so displaying it can
 * never be confused with asking for it.
 */
export interface PlaybackObservation {
    pageSeconds: number;
    playerState: string;
    mediaSessionId?: number;
    observedAt: number;
}

/**
 * What a caller gets back from a request. `restart` says whether this call is
 * the one that should rebuild the remux, and `targetPageSeconds` is the target
 * that WILL be restarted (the newest one when requests coalesced). A caller must
 * never assume its own target won: with rapid ±5s clicks, the last one does.
 */
export interface PlaybackRequestResult {
    accepted: boolean;
    restart: boolean;
    intentId: number;
    targetPageSeconds: number;
    /** Why nothing is going to happen, when that is the answer. */
    reason?: "not-a-seek-intent" | "not-ready" | "already-there" | "released";
}

/**
 * A page write made by the extension, not by the user.
 *
 * `syncFromReceiver`/priming moving `mediaElement.currentTime` fires a `seeked`
 * event on the page. That event is the page's own report of a position change
 * and must NOT be read as "the user asked to seek here" — that confusion is what
 * turned a drift correction into another remux restart. Each write registers
 * here with the deadline the element is expected to acknowledge it by; a
 * `seeked` inside that deadline belongs to the write, one after it does not.
 */
interface PendingPageWrite {
    intentId?: number;
    origin: PlaybackIntentOrigin;
    /** Epoch ms after which a `seeked` is no longer attributable to this write. */
    expiresAt: number;
}

/**
 * How long a programmatic page write may take to produce its `seeked`. A real
 * media element fires it within microseconds (the spec queues it as a task);
 * the window only has to be long enough for the element's own event loop, and
 * short enough that a user's later seek on the site's progress bar is still read
 * as the user's. For DASH sites the user's own `seeking` is armed separately, so
 * a slow fetch never lands here.
 */
export const PAGE_WRITE_ACK_WINDOW_MS = 1000;

export default class PlaybackCoordinator {
    /**
     * Bumped for every operation that invalidates everything before it: a
     * remux restart, an item change, a recovery retry, a stop. Events carrying
     * an older generation are dropped by identity rather than by timing.
     */
    private generation = 0;
    private phase: PlaybackPhase = "idle";
    private nextIntentId = 1;
    private intents: PlaybackIntent[] = [];
    private observation?: PlaybackObservation;
    private pendingPageWrite?: PendingPageWrite;
    /** Set while a load this coordinator asked for is in flight. */
    private loadInFlight = false;
    /** Reason the last transaction ended, for the trace and the popup. */
    private lastEndReason?: string;

    /** The current generation. Old events compared against it are dropped. */
    getGeneration(): number {
        return this.generation;
    }

    getPhase(): PlaybackPhase {
        return this.phase;
    }

    /** True while a remux restart this coordinator owns is running. */
    isTransactionActive(): boolean {
        return this.phase === "seeking" || this.phase === "switching-item";
    }

    /**
     * True while the coordinator is driving the page for a transaction that has
     * not reached the receiver yet. Page events that this window would otherwise
     * forward are not the user's: they are the echoes of the writes below.
     */
    isHoldingPage(): boolean {
        return this.isTransactionActive() || this.loadInFlight;
    }

    getLastEndReason(): string | undefined {
        return this.lastEndReason;
    }

    /** The newest intent that has not been satisfied or dropped. */
    peekIntent(): PlaybackIntent | undefined {
        return this.intents[this.intents.length - 1];
    }

    /** The observed position, in page seconds. Display only. */
    getObservation(): PlaybackObservation | undefined {
        return this.observation;
    }

    // -----------------------------------------------------------------
    // Intents
    // -----------------------------------------------------------------

    /**
     * The ONE entry point for anything that wants playback moved.
     *
     * Returns whether this call should perform the rebuild. Requests that arrive
     * while a rebuild is already running coalesce onto the newest target: they
     * are recorded (so the running transaction retargets) and report
     * `restart: false`, because the in-flight transaction will pick the target up
     * itself. That is what keeps two rapid seeks from producing two remux
     * generations.
     *
     * A `receiver-status` or `sync-write` origin is accepted only as an
     * OBSERVATION request: it updates nothing and always reports
     * `restart: false`. That is the structural guarantee asked for by the
     * refactor — a status report can never restart a remux.
     */
    requestSeek(
        origin: PlaybackIntentOrigin,
        targetPageSeconds: number,
        mediaIdentity?: string
    ): PlaybackRequestResult {
        const intentId = this.nextIntentId++;
        if (!Number.isFinite(targetPageSeconds) || targetPageSeconds < 0) {
            return {
                accepted: false,
                restart: false,
                intentId,
                targetPageSeconds,
                reason: "not-ready"
            };
        }
        if (!isSeekIntentOrigin(origin)) {
            // Not an intent at all: a status report or one of our own writes
            // asking where playback is. Record the question, answer "no".
            return {
                accepted: false,
                restart: false,
                intentId,
                targetPageSeconds,
                reason: "not-a-seek-intent"
            };
        }
        const intent: PlaybackIntent = {
            intentId,
            origin,
            targetPageSeconds,
            ...(mediaIdentity === undefined ? {} : { mediaIdentity }),
            requestedAt: Date.now()
        };
        // The newest explicit intent SUPERSEDES every older one that has not been
        // served yet: only the newest target is going to be restarted. Queueing
        // them all made the transaction loop run one generation per superseded
        // click and end on the OLDEST of them - a user dragging to 5:00 and back
        // to 0:00 inside one debounce window ended up at 5:00, the opposite of
        // the last thing they asked for.
        this.intents = [intent];
        if (this.isTransactionActive() || this.loadInFlight) {
            // Coalesce: the running transaction will read peekIntent() and
            // retarget. No second generation, no second bridge.
            return {
                accepted: true,
                restart: false,
                intentId,
                targetPageSeconds
            };
        }
        return {
            accepted: true,
            restart: true,
            intentId,
            targetPageSeconds
        };
    }

    /**
     * Begin a transaction for `intentId`. Returns false when the intent was
     * already superseded (a newer request arrived in the same tick), in which
     * case the caller must not start a bridge/remux generation for it.
     */
    beginTransaction(intentId: number, phase: PlaybackPhase): boolean {
        const intent = this.intents.find(item => item.intentId === intentId);
        if (!intent) return false;
        if (this.peekIntent()?.intentId !== intentId) return false;
        this.generation++;
        this.phase = phase;
        this.loadInFlight = true;
        this.lastEndReason = undefined;
        return true;
    }

    /** The target the running transaction should use now (newest wins). */
    getTransactionTarget(): number | undefined {
        return this.peekIntent()?.targetPageSeconds;
    }

    /**
     * Retire one intent as handled.
     *
     * Called when the transaction has done the work for it — AFTER the load, not
     * before, so a request that arrives while the remux is rebuilding is still
     * visible to the running transaction and retargets it (see
     * `getTransactionTarget`) instead of being silently swallowed.
     */
    consumeIntent(intentId: number): void {
        this.intents = this.intents.filter(
            intent => intent.intentId !== intentId
        );
    }

    /** The receiver accepted the load this transaction asked for. */
    markLoadSettled(intentId?: number): void {
        if (
            intentId !== undefined &&
            this.pendingPageWrite?.intentId === intentId
        ) {
            this.pendingPageWrite = undefined;
        }
        this.loadInFlight = false;
        if (this.isTransactionActive()) this.phase = "idle";
        this.intents = this.intents.filter(
            intent => intentId === undefined || intent.intentId !== intentId
        );
    }

    /**
     * End the current transaction. `reason` is kept for the trace and for the
     * popup's "failed" presentation; it is never re-read as an instruction.
     *
     */
    endTransaction(reason: string, options: { failed?: boolean } = {}): void {
        this.loadInFlight = false;
        this.pendingPageWrite = undefined;
        this.lastEndReason = reason;
        if (options.failed) {
            this.phase = "failed";
            this.intents = [];
            return;
        }
        this.phase = "idle";
        this.intents = [];
    }

    /**
     * A new item/quality replaced the media the receiver is playing. This is a
     * generation boundary, not a suppressed status window: everything the
     * previous generation reports is dropped by identity from here on.
     */
    beginItemChange(): number {
        this.generation++;
        this.loadInFlight = true;
        this.pendingPageWrite = undefined;
        this.lastEndReason = undefined;
        return this.generation;
    }

    /**
     * The media a generation is being built for.
     *
     * Called when a sender starts loading a DIFFERENT media; intents that named an
     * older one are dropped, because the position they asked for belongs to that
     * other video. Intents that named the same media (or named none at all) stay -
     * this is what lets a seek made DURING an item's own load be served when that
     * item's media becomes live, while a seek left over from the previous video is
     * not applied to the new one.
     */
    noteMediaIdentity(mediaIdentity: string): void {
        this.intents = this.intents.filter(
            intent =>
                intent.mediaIdentity === undefined ||
                intent.mediaIdentity === mediaIdentity
        );
    }

    /**
     * The new item's media is live on the receiver.
     *
     * An intent recorded DURING the item change is NOT satisfied by it. The item
     * change holds the load, so `requestSeek` coalesces instead of restarting,
     * and the LOAD that then runs was taken at a position the user has since
     * left: the page being the position authority is true only on the
     * page-clock-master path (Roku capture), where the user's own drag moved the
     * source the load was taken from — and a page-origin seek does not even
     * reach here, because the reload has the element's listeners detached.
     * Clearing the intent silently dropped the explicit seek instead, so it stays
     * and the sender serves it once the item's own media is live
     * (`serveSeekPendingFromItemChange`).
     */
    markItemSettled(): void {
        this.loadInFlight = false;
        if (this.phase === "switching-item") this.phase = "idle";
    }

    /** The receiver session was stopped. Everything pending is void. */
    reset(reason = "stopped"): void {
        this.generation++;
        this.phase = "idle";
        this.loadInFlight = false;
        this.pendingPageWrite = undefined;
        this.intents = [];
        this.lastEndReason = reason;
    }

    // -----------------------------------------------------------------
    // Observations (never intents)
    // -----------------------------------------------------------------

    /**
     * Record what the receiver reported, in PAGE seconds. Never restarts
     * anything, never changes the desired position: this is the only writer of
     * the observed snapshot and it has no path to `requestSeek`.
     */
    observeReceiverPosition(observation: {
        pageSeconds: number;
        playerState: string;
        mediaSessionId?: number;
    }): boolean {
        if (!Number.isFinite(observation.pageSeconds)) return false;
        this.observation = {
            pageSeconds: observation.pageSeconds,
            playerState: observation.playerState,
            mediaSessionId: observation.mediaSessionId,
            observedAt: Date.now()
        };
        return true;
    }

    // -----------------------------------------------------------------
    // Programmatic page writes
    // -----------------------------------------------------------------

    /**
     * Register a page time write the extension is about to make. The matching
     * `seeked` (which the element fires on a later task) is then attributed to
     * the write instead of to a user.
     */
    notePageWrite(
        origin: PlaybackIntentOrigin,
        intentId?: number,
        windowMs = PAGE_WRITE_ACK_WINDOW_MS
    ): void {
        this.pendingPageWrite = {
            origin,
            intentId,
            expiresAt: Date.now() + windowMs
        };
    }

    /**
     * Is this `seeked` event the acknowledgement of a write we just made?
     * Consumes the registration, so one write absorbs exactly one event.
     *
     * Past its deadline the registration is discarded and the event is treated
     * as the page's own (a user seeking on the site's progress bar), because a
     * write that was never acknowledged must not swallow the user's next seek.
     */
    consumePageWrite(): PendingPageWrite | undefined {
        const pending = this.pendingPageWrite;
        if (!pending) return undefined;
        this.pendingPageWrite = undefined;
        if (Date.now() > pending.expiresAt) return undefined;
        return pending;
    }

    /** Drop a registration that is no longer relevant (stop, item change). */
    clearPageWrite(): void {
        this.pendingPageWrite = undefined;
    }

    /** Diagnostic view, safe to log: page seconds only, no receiver clock. */
    describe(): Record<string, unknown> {
        return {
            generation: this.generation,
            phase: this.phase,
            loadInFlight: this.loadInFlight,
            pendingIntent: this.peekIntent(),
            intentCount: this.intents.length,
            observation: this.observation,
            lastEndReason: this.lastEndReason
        };
    }
}
