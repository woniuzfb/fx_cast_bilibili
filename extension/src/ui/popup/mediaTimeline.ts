export interface PopupMediaTimeline {
    mediaId: string;
    currentTime: number;
    updatedAt: number;
    duration: number;
    /**
     * Optimistic seek confirmation window. While set (and unexpired), the
     * displayed time freezes at the seek target and only receiver reports
     * near the target are accepted (confirmation). This hides the
     * debounce + DASH remux restart window during which the receiver still
     * reports positions from the old stream.
     */
    seekTarget?: number;
    seekExpiresAt?: number;
    /**
     * Raw receiver contentId (with the per-remux cache-busting query intact).
     * The sender appends a fresh `?v=<timestamp>` on every DASH remux restart,
     * so a change here — while the *stripped* mediaId stays the same — means a
     * seek reload just happened. This is the only in-popup signal available for
     * seeks the popup did not initiate (BLE remote or the page's own progress
     * bar), which never go through createSeekedTimeline.
     */
    contentId?: string;
    /**
     * Reload hold for externally-triggered seeks (BLE remote / page). Unlike
     * the optimistic seek above we don't know the target, so instead of
     * freezing at a target we freeze at the last displayed position and reject
     * the transient buffering/IDLE reports (which read ~0) until the receiver
     * settles into PLAYING/PAUSED at the new position. This removes the
     * "snap to 0 then jump to the target" flash on BLE seeks.
     */
    reloadHoldTime?: number;
    reloadExpiresAt?: number;
}

export interface PopupMediaSample {
    mediaId?: string;
    currentTime?: unknown;
    duration?: unknown;
    now: number;
    /** Raw contentId (query preserved) used to detect DASH remux reloads. */
    contentId?: string;
    /**
     * True when the receiver is in a settled state (PLAYING or PAUSED) rather
     * than BUFFERING/IDLE. A settled report during a reload hold is the new
     * stream's real position and releases the hold; unsettled reports are the
     * transient reset that would otherwise flash the bar to 0.
     */
    playerSettled?: boolean;
    /**
     * True when the receiver reports PlayerState=PLAYING. Used together with
     * hlsDvr below to start the estimate clock before the first real position.
     */
    isPlaying?: boolean;
    /**
     * True for the CCTV synthetic DVR (customData.hlsDvr). Its playlist is a
     * 2-hour VOD (~1800 segments), and while the receiver builds the event
     * timeline for it, Chromecast HLS reports currentTime=-1 (see
     * cast/senders/media.ts) even though the receiver is already PLAYING and
     * its clock runs from the LOAD position (always 0 for this media). Only
     * for this media do we seed the timeline at 0 and let the wall-clock
     * estimate advance; other media (e.g. Bilibili DASH remux loading at the
     * page position) keep waiting for the first real report.
     */
    hlsDvr?: boolean;
    /**
     * True for Bilibili DASH remux media (customData.dashRemux). Like the CCTV
     * synthetic DVR it has a synthetic receiver timeline, and during the
     * bridge remux restart the receiver reports transient positions (0) from
     * unsettled states before real playback begins.
     */
    dashRemux?: boolean;
    /**
     * The LOAD position (absolute video time) for Bilibili DASH remux media
     * (customData.dashStart) — the page's playback position when the cast
     * started. Seeds a fresh timeline so the seek bar shows the real position
     * from the moment it appears, instead of 00:00 until the first settled
     * receiver report.
     */
    dashStart?: unknown;
}

/**
 * How long to wait for the receiver to confirm an optimistic seek. Keep in
 * sync with DASH_TIGHTEN_WINDOW_MS in cast/senders/media.ts: this window
 * starts at the user's click, so it must cover the seek debounce, the
 * bridge remux restart (ffprobe keyframe probing can take seconds on a
 * slow CDN) and the receiver reload.
 */
const SEEK_CONFIRM_WINDOW_MS = 15000;
/** Receiver reports within this distance of the target confirm the seek. */
const SEEK_CONFIRM_TOLERANCE_S = 1.5;
/**
 * Safety cap for the reload hold. Same 15s budget as the optimistic seek
 * window: if the receiver never reports a settled position (failed reload),
 * stop freezing so the bar can resume tracking whatever it does report.
 */
const RELOAD_HOLD_WINDOW_MS = SEEK_CONFIRM_WINDOW_MS;
/**
 * A DASH remux restart is a receiver-side race: once the new stream starts the
 * receiver SOMETIMES reports PlayerState=PLAYING while its position is still
 * the reset value (~0) for a beat, THEN catches up to the real (padded) target
 * a moment later. Treat a settled report at or below this many seconds as that
 * transient reset, not the true position, and keep the bar frozen. Without
 * this the hold releases on the ~0 report and the bar flashes/jumps to the
 * start (the intermittent "sometimes jumps to 0" + the sub-second flicker are
 * the same artifact — fast catch-up looks like a flicker, slow catch-up looks
 * like a jump).
 */
const REMUX_RESET_EPSILON_S = 3;
/**
 * Escape hatch so a genuine seek to the very start still works: if the settled
 * position stays at/below the reset epsilon for this long, accept it as a real
 * near-zero seek and release. Must exceed the receiver's catch-up latency (the
 * ~1s bridge/receiver snap seen in logs) so a large-target seek always reports
 * its real position well before this fires.
 */
const NEAR_ZERO_RELEASE_MS = 3000;

export function createSeekedTimeline(
    previous: PopupMediaTimeline,
    target: number,
    now: number
): PopupMediaTimeline {
    return {
        ...previous,
        currentTime: target,
        updatedAt: now,
        seekTarget: target,
        seekExpiresAt: now + SEEK_CONFIRM_WINDOW_MS,
        // A popup-initiated seek supersedes any external reload hold: it knows
        // the exact target, so drop the target-less hold to avoid two freeze
        // modes fighting over the same reload.
        reloadHoldTime: undefined,
        reloadExpiresAt: undefined
    };
}

export function updatePopupMediaTimeline(
    previous: PopupMediaTimeline,
    sample: PopupMediaSample
): PopupMediaTimeline {
    const mediaId = sample.mediaId ?? "";
    const mediaChanged =
        Boolean(previous.mediaId) &&
        Boolean(mediaId) &&
        mediaId !== previous.mediaId;
    const next: PopupMediaTimeline = mediaChanged
        ? { mediaId, currentTime: 0, updatedAt: 0, duration: 0 }
        : { ...previous, mediaId: mediaId || previous.mediaId };

    const duration = Number(sample.duration);
    if (Number.isFinite(duration) && duration > 0) {
        next.duration = duration;
    }

    const seekPending =
        !mediaChanged &&
        previous.seekTarget !== undefined &&
        previous.seekExpiresAt !== undefined &&
        sample.now < previous.seekExpiresAt;

    // Track the raw contentId for reference only. It is NOT a reliable reload
    // trigger: during the IDLE phase of a DASH seek reload the receiver drops
    // `status.media` entirely, so contentId reads `undefined` at exactly the
    // moment we need the signal (this is why the previous contentId-based
    // detection never armed and the bar snapped to 0 on BLE/page seeks).
    const rawContentId = sample.contentId;
    if (rawContentId !== undefined) next.contentId = rawContentId;
    if (mediaChanged) {
        next.contentId = rawContentId;
        next.reloadHoldTime = undefined;
        next.reloadExpiresAt = undefined;
    }

    // Detect an externally-triggered reload (BLE remote or the page's own
    // progress bar) from the PLAYER STATE instead. Every DASH remux restart
    // drives the receiver PLAYING -> IDLE/BUFFERING (position resets to ~0,
    // media dropped) -> PLAYING at the new position. The hallmark: we were
    // showing a real position and now get an UNSETTLED report. A popup seek
    // already owns the freeze via seekPending, and a genuine media change
    // resets everything, so neither arms this hold. This only freezes the
    // displayed position number; it never affects seek-bar visibility.
    // CCTV synthetic DVR / Bilibili DASH remux only: their startup sequences
    // must not arm the hold. The synthetic DVR flaps PLAYING -> BUFFERING ->
    // PLAYING in its first seconds while the receiver is still establishing
    // its event timeline, and the position then is 0 (or the -1 sentinel). A
    // DASH remux load likewise reports transient 0s from unsettled states
    // while the bridge restarts. Freezing at 0 protects nothing, but it does
    // block the wall-clock estimate for the full 15s hold window — exactly the
    // "bar stuck at 00:00 for ~18s, then jumps to ~00:18 when the hold
    // expires" symptom. For these media a real (positive) position is
    // required to arm the hold; other media keep the previous behavior.
    const hadRealPosition =
        !mediaChanged &&
        previous.updatedAt > 0 &&
        ((sample.hlsDvr !== true && sample.dashRemux !== true) ||
            previous.currentTime > 0);
    const sampleSettled = sample.playerSettled === true;
    const contentIdChanged =
        !mediaChanged &&
        rawContentId !== undefined &&
        previous.contentId !== undefined &&
        rawContentId !== previous.contentId;
    const reloadStarting =
        !mediaChanged &&
        !seekPending &&
        hadRealPosition &&
        previous.reloadHoldTime === undefined &&
        // Unsettled report after a real position, OR a fresh remux URL while a
        // report is still coming in (covers page seeks where media lingers).
        (!sampleSettled || contentIdChanged);
    if (reloadStarting) {
        // Freeze at the last known position; the target is unknown for BLE /
        // page seeks, so we hold here until a settled report lands.
        next.reloadHoldTime = previous.currentTime;
        next.reloadExpiresAt = sample.now + RELOAD_HOLD_WINDOW_MS;
    }

    const reloadHoldActive =
        !seekPending &&
        next.reloadHoldTime !== undefined &&
        next.reloadExpiresAt !== undefined &&
        sample.now < next.reloadExpiresAt;

    const currentTime = Number(sample.currentTime);
    // A real, reportable position. Chromecast reports currentTime=-1 while its
    // event timeline is being established (see PopupMediaSample.isPlaying) —
    // that sentinel is not a position and must not seed or move the timeline.
    const hasReportedPosition =
        Number.isFinite(currentTime) && currentTime >= 0;
    // CCTV synthetic DVR / Bilibili DASH remux: a position from an unsettled
    // state (IDLE/BUFFERING) is a startup transient. A 0 reported at IDLE
    // precedes actual playback by the receiver's whole startup, so anchoring
    // on it runs the estimate fast and the first real position then snaps the
    // bar backwards (or leaves it stuck at 00:00 through the load). For these
    // media only settled (PLAYING/PAUSED) reports may anchor; other media keep
    // anchoring from any valid position as before.
    const positionReportUsable =
        hasReportedPosition &&
        (sample.playerSettled === true ||
            (sample.hlsDvr !== true && sample.dashRemux !== true));
    if (positionReportUsable) {
        if (seekPending) {
            // Only a report near the target confirms the seek; older stream
            // positions are stale and must not yank the bar back.
            if (
                Math.abs(currentTime - (previous.seekTarget as number)) <=
                SEEK_CONFIRM_TOLERANCE_S
            ) {
                next.currentTime = currentTime;
                next.updatedAt = sample.now;
                next.seekTarget = undefined;
                next.seekExpiresAt = undefined;
                next.reloadHoldTime = undefined;
                next.reloadExpiresAt = undefined;
            }
        } else if (reloadHoldActive) {
            // Hold the frozen position through the remux reload. A settled
            // (PLAYING/PAUSED) report is normally the new stream's real
            // position — but the receiver often reports PLAYING while its
            // position is still the transient reset (~0) for a beat before it
            // catches up to the padded target. Releasing on that ~0 is exactly
            // the flash/jump-to-start we are fixing, so require the settled
            // report to be a real position (above the reset epsilon) before
            // releasing. Genuine seeks to the very start still release via the
            // near-zero escape hatch below.
            const holdStartedAt =
                (next.reloadExpiresAt as number) - RELOAD_HOLD_WINDOW_MS;
            const heldForMs = sample.now - holdStartedAt;
            const looksLikeRemuxReset = currentTime <= REMUX_RESET_EPSILON_S;
            if (
                sample.playerSettled &&
                (!looksLikeRemuxReset || heldForMs >= NEAR_ZERO_RELEASE_MS)
            ) {
                next.currentTime = currentTime;
                next.updatedAt = sample.now;
                next.reloadHoldTime = undefined;
                next.reloadExpiresAt = undefined;
            }
        } else if (next.updatedAt === 0 || currentTime !== next.currentTime) {
            next.currentTime = currentTime;
            next.updatedAt = sample.now;
            // The hold expired without a settled report (e.g. failed reload);
            // clear it so future ticks track normally.
            next.reloadHoldTime = undefined;
            next.reloadExpiresAt = undefined;
        }
    } else if (
        next.updatedAt === 0 &&
        sample.hlsDvr === true &&
        sample.isPlaying
    ) {
        // CCTV synthetic DVR only: no valid position yet (the -1 sentinel),
        // but the receiver is already playing and its clock started at the
        // LOAD position (always 0 for this media). Seed the timeline there so
        // the wall-clock estimate advances from the start; the first real
        // position report then lands on the estimate instead of producing a
        // 00:00 -> 00:18 jump. Seeding only ever happens on a fresh timeline
        // (updatedAt === 0), so seek confirm windows and reload holds (both
        // require a prior real position) are unaffected.
        next.currentTime = 0;
        next.updatedAt = sample.now;
    } else if (
        next.updatedAt === 0 &&
        sample.dashRemux === true &&
        Number.isFinite(Number(sample.dashStart)) &&
        Number(sample.dashStart) >= 0
    ) {
        // Bilibili DASH remux: seed at the LOAD position (the page's playback
        // position when the cast started) as soon as the media status carries
        // it, so the seek bar shows the real position from the moment it
        // appears. Until the receiver settles into PLAYING the early reports
        // are transient 0s (ignored above), so without this seed the bar sits
        // at 00:00 and then jumps to the real position once playback starts.
        // The estimate does not advance until PLAYING, and the first settled
        // report (≈ dashStart + elapsed) lands on the seed, so there is no
        // jump either way. Seeding only ever happens on a fresh timeline
        // (updatedAt === 0); seeks and reloads keep the timeline fresh and are
        // owned by the seek-confirm / reload-hold logic.
        next.currentTime = Number(sample.dashStart);
        next.updatedAt = sample.now;
    }

    if (
        next.mediaId === previous.mediaId &&
        next.currentTime === previous.currentTime &&
        next.updatedAt === previous.updatedAt &&
        next.duration === previous.duration &&
        next.seekTarget === previous.seekTarget &&
        next.seekExpiresAt === previous.seekExpiresAt &&
        next.contentId === previous.contentId &&
        next.reloadHoldTime === previous.reloadHoldTime &&
        next.reloadExpiresAt === previous.reloadExpiresAt
    ) {
        return previous;
    }
    return next;
}

export function estimatePopupMediaTime(
    timeline: PopupMediaTimeline,
    isPlaying: boolean,
    now: number
): number {
    // Freeze at the seek target while awaiting receiver confirmation.
    if (
        timeline.seekTarget !== undefined &&
        timeline.seekExpiresAt !== undefined &&
        now < timeline.seekExpiresAt
    ) {
        return timeline.seekTarget;
    }

    // Freeze at the last position while an external (BLE / page) seek reloads,
    // hiding the buffering flash to 0 until a settled report releases the hold.
    if (
        timeline.reloadHoldTime !== undefined &&
        timeline.reloadExpiresAt !== undefined &&
        now < timeline.reloadExpiresAt
    ) {
        return timeline.reloadHoldTime;
    }

    let currentTime = timeline.currentTime;
    if (isPlaying && timeline.updatedAt > 0) {
        currentTime += Math.max(0, now - timeline.updatedAt) / 1000;
    }
    currentTime = Math.max(0, currentTime);
    if (timeline.duration > 0) {
        currentTime = Math.min(currentTime, timeline.duration);
    }
    return currentTime;
}

export function clampPopupSeek(position: number, duration: number): number {
    if (!Number.isFinite(position)) return 0;
    const nonNegative = Math.max(0, position);
    return duration > 0 ? Math.min(nonNegative, duration) : nonNegative;
}
