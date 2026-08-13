<script lang="ts">
    import { createEventDispatcher, onMount } from "svelte";

    import type { ReceiverDevice } from "../../types";

    import type { MediaStatus } from "../../cast/sdk/types";
    import { _MediaCommand } from "../../cast/sdk/types";
    import type { Volume } from "../../cast/sdk/classes";
    import {
        MetadataType,
        PlayerState,
        StreamType
    } from "../../cast/sdk/media/enums";
    import type { Track } from "../../cast/sdk/media/classes";
    import {
        clampPopupSeek,
        createSeekedTimeline,
        estimatePopupMediaTime,
        updatePopupMediaTimeline,
        type PopupMediaTimeline
    } from "./mediaTimeline";

    const _ = browser.i18n.getMessage;

    const dispatch = createEventDispatcher<{
        togglePlayback: void;
        seek: { position: number };
        previous: void;
        next: void;
        trackChanged: { activeTrackIds: number[] };
        volumeChanged: Partial<Volume>;
    }>();

    export let status: MediaStatus;
    export let device: ReceiverDevice;
    export let textTracks: Track[] = [];
    export let showImage = false;

    $: isPlayingOrPaused =
        status.playerState === PlayerState.PLAYING ||
        status.playerState === PlayerState.PAUSED;

    // DASH remux sessions (Bilibili) report a live-style event playlist: the
    // receiver may omit media.duration and the SEEK capability even though
    // the page sender can seek by restarting the remux. The sender passes the
    // real duration through customData.
    $: dashRemuxData = ((): {
        dashRemux?: boolean;
        pageDuration?: number;
    } => {
        const customData = status.media?.customData;
        return customData && typeof customData === "object"
            ? (customData as {
                  dashRemux?: boolean;
                  pageDuration?: number;
              })
            : {};
    })();
    // contentId carries a cache-busting query that changes on every remux
    // restart; strip it so the timeline isn't reset across seeks.
    $: mediaId = status.media?.contentId?.split("?")[0];
    // The receiver reports duration -1 (live sentinel) once playback of the
    // event playlist starts, and -1 is not nullish, so `??` alone never
    // falls back to pageDuration. Only trust positive durations.
    $: reportedDuration =
        status.media?.duration != null && status.media.duration > 0
            ? status.media.duration
            : dashRemuxData.pageDuration;

    let timeline: PopupMediaTimeline = {
        mediaId: "",
        currentTime: 0,
        updatedAt: 0,
        duration: 0
    };
    $: {
        const nextTimeline = updatePopupMediaTimeline(timeline, {
            mediaId,
            currentTime: device.mediaStatus?.currentTime,
            duration: reportedDuration,
            now: Date.now()
        });
        if (nextTimeline !== timeline) timeline = nextTimeline;
    }
    $: hasDuration = timeline.duration > 0;
    $: isSeekable =
        (status.supportedMediaCommands & _MediaCommand.SEEK) !== 0 ||
        Boolean(dashRemuxData.dashRemux);
    $: isLive = status.media?.streamType === StreamType.LIVE;

    // Diagnose seek bar visibility across popup reopens (gated behind the
    // Bilibili debug option by the background popup:debugLog listener).
    let lastSeekBarDebug = "";
    $: {
        const seekBarDebug = JSON.stringify({
            showsSeekBar: Boolean(status.media && hasDuration && isSeekable),
            hasMedia: Boolean(status.media),
            mediaDuration: status.media?.duration,
            pageDuration: dashRemuxData.pageDuration,
            timelineDuration: timeline.duration,
            supportedMediaCommands: status.supportedMediaCommands
        });
        if (seekBarDebug !== lastSeekBarDebug) {
            lastSeekBarDebug = seekBarDebug;
            void browser.runtime
                .sendMessage({
                    subject: "popup:debugLog",
                    data: {
                        message: "[ReceiverMedia] seek bar state",
                        data: JSON.parse(seekBarDebug)
                    }
                })
                .catch(() => {});
        }
    }

    let mediaTitle: Optional<string>;
    let mediaSubtitle: Optional<string>;
    let mediaImageSet: Optional<string>;

    // Choose subset of metadata depending on metadata type
    $: {
        const metadata = status?.media?.metadata;

        mediaTitle = metadata?.title;
        mediaSubtitle = undefined;

        if (metadata) {
            switch (metadata.metadataType) {
                case MetadataType.AUDIOBOOK_CHAPTER:
                    if (metadata.bookTitle) {
                        metadata.title = metadata.bookTitle;
                    }
                    metadata.subtitle = metadata.chapterTitle;
                    break;
                case MetadataType.MUSIC_TRACK:
                    mediaSubtitle = metadata.artist;
                    break;
                case MetadataType.TV_SHOW:
                    if (metadata.seriesTitle) {
                        mediaTitle = metadata.seriesTitle;
                        mediaSubtitle = metadata.title;
                    }
                    break;

                case MetadataType.MOVIE:
                case MetadataType.GENERIC:
                    mediaSubtitle = metadata.subtitle;
            }
        }

        if (showImage && metadata?.images?.length) {
            let imageSet: string[] = [];
            for (const image of metadata.images) {
                let sizeString = image.url;
                if (image.width) sizeString += ` ${image.width}w`;
                imageSet.push(sizeString);
            }
            mediaImageSet = imageSet.join(",");
        } else {
            mediaImageSet = undefined;
        }
    }

    let currentTime = 0;
    $: currentTime = getEstimatedMediaTime();

    // Update estimated time every second
    onMount(() => {
        const intervalId = window.setInterval(() => {
            if (currentTime !== getEstimatedMediaTime()) {
                currentTime = getEstimatedMediaTime();
            }
        }, 1000);

        return () => {
            window.clearInterval(intervalId);
        };
    });

    /**
     * Estimates the current playback position based on the last status
     * update.
     */
    function getEstimatedMediaTime() {
        return estimatePopupMediaTime(
            timeline,
            status.playerState === PlayerState.PLAYING,
            Date.now()
        );
    }

    function seekTo(position: number) {
        const target = clampPopupSeek(position, timeline.duration);
        // Optimistic update with a confirmation window: the receiver keeps
        // reporting old-stream positions during the debounce + remux
        // restart, and plain optimistic updates would bounce back.
        timeline = createSeekedTimeline(timeline, target, Date.now());
        currentTime = target;
        dispatch("seek", { position: target });
    }

    /** Formats seconds into HH:MM:SS */
    function formatTime(seconds: number) {
        const date = new Date(seconds * 1000);
        const hours = date.getUTCHours();

        let ret = "";
        if (hours) ret += `${hours}:`;
        ret += `${date
            .getUTCMinutes()
            .toString()
            .padStart(hours ? 2 : 1, "0")}:`;
        ret += date.getUTCSeconds().toString().padStart(2, "0");
        return ret;
    }

    let seekHoverPosition: Nullable<number> = null;
    function onSeekMouseMove(node: HTMLInputElement) {
        if (node.type !== "range") {
            throw new Error("Wrong type of input!");
        }

        function onMouseMove(ev: MouseEvent) {
            const clientRect = node.getBoundingClientRect();
            seekHoverPosition =
                ((ev.clientX - clientRect.left) / clientRect.width) * 100;
        }

        const onMouseLeave = () => (seekHoverPosition = null);

        node.addEventListener("mousemove", onMouseMove);
        node.addEventListener("mouseleave", onMouseLeave);

        return {
            destroy() {
                seekHoverPosition = null;
                node.removeEventListener("mousemove", onMouseMove);
                node.removeEventListener("mouseleave", onMouseLeave);
            }
        };
    }
</script>

<div class="media">
    {#if mediaTitle}
        <div class="media__metadata">
            {#if mediaImageSet}
                <img class="media__image" srcset={mediaImageSet} alt="" />
            {/if}
            <div class="media__metadata-text">
                <div class="media__title" title={mediaTitle}>
                    {mediaTitle}
                </div>
                {#if mediaSubtitle}
                    <div class="media__subtitle">
                        {mediaSubtitle}
                    </div>
                {/if}
            </div>
        </div>
    {/if}

    <div class="media__controls">
        <!-- Seek bar -->
        {#if status.media && hasDuration && isSeekable}
            <div class="media__seek">
                {#if isLive}
                    <span class="media__live">
                        {_("popupMediaLive")}
                    </span>
                {/if}
                <span class="media__current-time">
                    {formatTime(currentTime)}
                </span>
                <div class="media__seek-bar-container">
                    <input
                        type="range"
                        class="slider media__seek-bar"
                        class:slider--indeterminate={status.playerState ===
                            PlayerState.BUFFERING}
                        aria-label={_("popupMediaSeek")}
                        max={timeline.duration}
                        value={currentTime}
                        on:change={ev => {
                            if (seekHoverPosition) {
                                ev.preventDefault();
                                return;
                            }
                            seekTo(ev.currentTarget.valueAsNumber);
                        }}
                        on:click={() => {
                            if (seekHoverPosition && timeline.duration) {
                                seekTo(
                                    timeline.duration * (seekHoverPosition / 100)
                                );
                            }
                        }}
                        use:onSeekMouseMove
                    />
                    {#if seekHoverPosition}
                        <div
                            class="media__seek-tooltip"
                            style:--seek-hover-position="{seekHoverPosition}%"
                        >
                            {formatTime(
                                timeline.duration *
                                    (seekHoverPosition / 100)
                            )}
                        </div>
                    {/if}
                </div>
                <span class="media__remaining-time">
                    -{formatTime(Math.max(0, timeline.duration - currentTime))}
                </span>
            </div>
        {/if}

        <div class="media__buttons">
            {#if status.supportedMediaCommands & _MediaCommand.QUEUE_PREV}
                <button
                    class="media__previous-button ghost"
                    title={_("popupMediaSkipPrevious")}
                    on:click={() => dispatch("previous")}
                />
            {/if}
            {#if isSeekable}
                <button
                    class="media__backward-button ghost"
                    title={_("popupMediaSeekBackward")}
                    disabled={status.playerState === PlayerState.IDLE}
                    on:click={() =>
                        seekTo(currentTime - 5)}
                />
            {/if}

            {#if status.supportedMediaCommands & _MediaCommand.PAUSE}
                <button
                    class={`ghost ${
                        status.playerState === PlayerState.PLAYING ||
                        status.playerState === PlayerState.BUFFERING
                            ? "media__pause-button"
                            : "media__play-button"
                    }`}
                    title={isPlayingOrPaused &&
                    status.playerState === PlayerState.PLAYING
                        ? _("popupMediaPause")
                        : _("popupMediaPlay")}
                    on:click={() => dispatch("togglePlayback")}
                />
            {/if}

            {#if isSeekable}
                <button
                    class="media__forward-button ghost"
                    disabled={status.playerState === PlayerState.IDLE}
                    title={_("popupMediaSeekForward")}
                    on:click={() =>
                        seekTo(currentTime + 5)}
                />
            {/if}
            {#if status.supportedMediaCommands & _MediaCommand.QUEUE_NEXT}
                <button
                    class="media__next-button ghost"
                    title={_("popupMediaSkipNext")}
                    on:click={() => dispatch("next")}
                />
            {/if}

            {#if textTracks?.length && status.supportedMediaCommands & _MediaCommand.EDIT_TRACKS}
                {@const activeTextTrackId = status.activeTrackIds?.find(
                    trackId =>
                        textTracks?.find(track => track.trackId === trackId)
                )}

                <select
                    class="media__cc-button ghost"
                    class:media__cc-button--off={activeTextTrackId ===
                        undefined}
                    title={_("popupMediaSubtitlesCaptions")}
                    value={activeTextTrackId}
                    on:change={ev => {
                        if (!status.activeTrackIds) return;

                        let activeTrackIds = status.activeTrackIds.filter(
                            trackId => trackId !== activeTextTrackId
                        );

                        const trackId = parseInt(ev.currentTarget.value);
                        if (!Number.isNaN(trackId)) {
                            activeTrackIds.push(trackId);
                        }

                        dispatch("trackChanged", { activeTrackIds });
                    }}
                >
                    <option value={undefined}>
                        {_("popupMediaSubtitlesCaptionsOff")}
                    </option>
                    {#each textTracks as track}
                        <option value={track.trackId}>
                            {track.name ?? track.trackId}
                        </option>
                    {/each}
                </select>
            {/if}

            {#if isLive && !isSeekable}
                <span class="media__live">
                    {_("popupMediaLive")}
                </span>
            {/if}

            {#if device.status?.volume}
                {@const volume = device.status?.volume}
                {@const isMuted = volume.muted || volume.level === 0}

                <div class="media__volume">
                    <button
                        class="media__mute-button ghost"
                        class:media__mute-button--muted={isMuted}
                        disabled={!("muted" in volume)}
                        title={isMuted
                            ? _("popupMediaUnmute")
                            : _("popupMediaMute")}
                        on:click={() => {
                            /**
                             * If not muted and volume is at 0, max out
                             * volume instead of flipping mute value.
                             */
                            if (!volume.muted && volume.level === 0) {
                                dispatch("volumeChanged", {
                                    level: 1
                                });
                            } else {
                                dispatch("volumeChanged", {
                                    muted: !volume.muted
                                });
                            }
                        }}
                    />
                    <input
                        type="range"
                        class="slider media__volume-slider"
                        aria-label={_("popupMediaVolume")}
                        disabled={!("level" in volume)}
                        step="0.05"
                        max={1}
                        value={volume.muted ? 0 : volume.level}
                        on:change={ev => {
                            dispatch("volumeChanged", {
                                level: ev.currentTarget.valueAsNumber
                            });
                        }}
                    />
                </div>
            {/if}
        </div>
    </div>
</div>
