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
}

export interface PopupMediaSample {
    mediaId?: string;
    currentTime?: unknown;
    duration?: unknown;
    now: number;
}

/** How long to wait for the receiver to confirm an optimistic seek. */
const SEEK_CONFIRM_WINDOW_MS = 9000;
/** Receiver reports within this distance of the target confirm the seek. */
const SEEK_CONFIRM_TOLERANCE_S = 1.5;

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
        seekExpiresAt: now + SEEK_CONFIRM_WINDOW_MS
    };
}

export function updatePopupMediaTimeline(
    previous: PopupMediaTimeline,
    sample: PopupMediaSample
): PopupMediaTimeline {
    const mediaId = sample.mediaId ?? "";
    const mediaChanged =
        Boolean(previous.mediaId) && Boolean(mediaId) && mediaId !== previous.mediaId;
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

    const currentTime = Number(sample.currentTime);
    if (Number.isFinite(currentTime) && currentTime >= 0) {
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
            }
        } else if (
            next.updatedAt === 0 ||
            currentTime !== next.currentTime
        ) {
            next.currentTime = currentTime;
            next.updatedAt = sample.now;
        }
    }

    if (
        next.mediaId === previous.mediaId &&
        next.currentTime === previous.currentTime &&
        next.updatedAt === previous.updatedAt &&
        next.duration === previous.duration &&
        next.seekTarget === previous.seekTarget &&
        next.seekExpiresAt === previous.seekExpiresAt
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
