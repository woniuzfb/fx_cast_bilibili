export interface PopupMediaTimeline {
    mediaId: string;
    currentTime: number;
    updatedAt: number;
    duration: number;
}

export interface PopupMediaSample {
    mediaId?: string;
    currentTime?: unknown;
    duration?: unknown;
    now: number;
}

export function updatePopupMediaTimeline(
    previous: PopupMediaTimeline,
    sample: PopupMediaSample
): PopupMediaTimeline {
    const mediaId = sample.mediaId ?? "";
    const mediaChanged =
        Boolean(previous.mediaId) && Boolean(mediaId) && mediaId !== previous.mediaId;
    let next: PopupMediaTimeline = mediaChanged
        ? { mediaId, currentTime: 0, updatedAt: 0, duration: 0 }
        : { ...previous, mediaId: mediaId || previous.mediaId };

    const duration = Number(sample.duration);
    if (Number.isFinite(duration) && duration > 0) {
        next.duration = duration;
    }

    const currentTime = Number(sample.currentTime);
    if (
        Number.isFinite(currentTime) &&
        currentTime >= 0 &&
        (next.updatedAt === 0 || currentTime !== next.currentTime)
    ) {
        next.currentTime = currentTime;
        next.updatedAt = sample.now;
    }

    if (
        next.mediaId === previous.mediaId &&
        next.currentTime === previous.currentTime &&
        next.updatedAt === previous.updatedAt &&
        next.duration === previous.duration
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
