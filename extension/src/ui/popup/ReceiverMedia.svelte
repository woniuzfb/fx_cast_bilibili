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
    import { nextPlaybackIntentFor } from "../../playbackView";

    const _ = browser.i18n.getMessage;

    const dispatch = createEventDispatcher<{
        togglePlayback: void;
        seek: { position: number };
        previous: void;
        next: void;
        trackChanged: { activeTrackIds: number[] };
        volumeChanged: Partial<Volume>;
        volumeUp: void;
        volumeDown: void;
    }>();

    export let status: MediaStatus;
    export let device: ReceiverDevice;
    export let textTracks: Track[] = [];
    export let showImage = false;
    /**
     * Whether Bilibili debug logging is enabled. Used to gate the seek-bar
     * diagnostic below so that, with debug off, this component does NO work per
     * status tick (previously it stringified state and fired a runtime message
     * on every change even when debug was off — dozens/sec during a seek).
     */
    export let debugEnabled = false;

    /**
     * The action the play/pause button offers: the icon, its tooltip and the
     * message the click sends all come from this one derivation, so they can
     * no longer disagree. Previously the icon treated BUFFERING as "playing"
     * while the tooltip treated it as "not playing", and the click handler in
     * Receiver matched neither, so a click while buffering silently did
     * nothing.
     *
     * While a command is active this reflects the user's outstanding intent
     * (the background coordinator's view); otherwise it is derived from the
     * observed state. It does NOT feed the timeline, the buffering shimmer or
     * seek settling — those keep reading `status.playerState`.
     *
     * `undefined` (IDLE, no active command) disables the button: there is no
     * meaningful play/pause action to offer.
     */
    $: nextPlaybackIntent = nextPlaybackIntentFor(device, status);

    // DASH remux sessions (Bilibili) report a live-style event playlist: the
    // receiver may omit media.duration and the SEEK capability even though
    // the page sender can seek by restarting the remux. The sender passes the
    // real duration through customData. The CCTV synthetic DVR uses the same
    // pageDuration fallback (its receiver reports a real VOD duration and
    // SEEK capability, so no flag is needed there).
    $: dashRemuxData = ((): {
        dashRemux?: boolean;
        hlsDvr?: boolean;
        rokuLiveElapsed?: boolean;
        optimisticRelayMedia?: boolean;
        pageDuration?: number;
        dashStart?: number;
        presentationOffsetSeconds?: number;
    } => {
        const customData = status.media?.customData;
        return customData && typeof customData === "object"
            ? (customData as {
                  dashRemux?: boolean;
                  hlsDvr?: boolean;
                  rokuLiveElapsed?: boolean;
                  optimisticRelayMedia?: boolean;
                  pageDuration?: number;
                  dashStart?: number;
                  presentationOffsetSeconds?: number;
              })
            : {};
    })();
    // contentId carries a cache-busting query that changes on every remux
    // restart; strip it so the timeline isn't reset across seeks.
    // Optimistic Roku media deliberately has an empty contentId. Without an
    // explicit generation id, updatePopupMediaTimeline treats it as the same
    // anonymous media that was mounted from Roku's previous ECP status and
    // retains that old currentTime. Give only the optimistic Roku generation a
    // stable synthetic id; the real LOAD URL replaces it on consumption.
    $: mediaId = dashRemuxData.optimisticRelayMedia
        ? "fxcast:roku-optimistic"
        : status.media?.contentId?.split("?")[0];
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
            // ALREADY page time: deviceManager is the single place that converts
            // a receiver position out of its presentation timeline (see
            // dashPageTime there). Converting again here subtracted the pad
            // runway twice, which put the popup 32s behind playback — and every
            // control that reads this timeline (the pause button included) then
            // looked like a position change and restarted the remux.
            currentTime: device.mediaStatus?.currentTime ?? 0,
            duration: reportedDuration,
            now: Date.now(),
            // Raw contentId (cache-buster intact) flags DASH remux reloads that
            // the popup did not initiate (BLE remote / page seek). A settled
            // player state releases the reload hold once the new stream reports
            // its real position.
            contentId: status.media?.contentId,
            playerSettled:
                status.playerState === PlayerState.PLAYING ||
                status.playerState === PlayerState.PAUSED,
            isPlaying: status.playerState === PlayerState.PLAYING,
            hlsDvr: Boolean(dashRemuxData.hlsDvr),
            dashRemux: Boolean(dashRemuxData.dashRemux),
            dashStart: dashRemuxData.dashStart
        });
        if (nextTimeline !== timeline) timeline = nextTimeline;
    }
    $: hasDuration = timeline.duration > 0;
    $: isRokuLiveElapsed = Boolean(dashRemuxData.rokuLiveElapsed);
    $: isOptimisticRelayMedia = Boolean(dashRemuxData.optimisticRelayMedia);
    $: isSeekable =
        !isRokuLiveElapsed &&
        ((status.supportedMediaCommands & _MediaCommand.SEEK) !== 0 ||
            Boolean(dashRemuxData.dashRemux));
    $: isLive =
        status.media?.streamType === StreamType.LIVE || isRokuLiveElapsed;

    // Roku CCTV exposes a sliding HLS window, so its popup bar is display-only.
    // It still uses the finite DVR duration supplied by the sender.
    $: liveSeekBarReady =
        Boolean(status.media) &&
        hasDuration &&
        (isSeekable || isRokuLiveElapsed);

    /**
     * Once the seek bar has been usable this cast session, keep it shown for as
     * long as we still have a known duration. Every seek (popup click, the
     * ±5s / BLE-remote skip, or the page progress bar) triggers a DASH remux
     * restart on Bilibili: the receiver drops to IDLE and `status.media` blinks
     * away for a beat before the new stream reports PLAYING, so
     * `status.media && hasDuration && isSeekable` momentarily flips false.
     *
     * A *timed* visibility hold proved fragile: across stacked/rapid seeks the
     * window could lapse between a fresh seek and the receiver's recovery
     * (a popup seek also jumps the hold clock forward), hiding the bar and
     * making the whole row flicker in and out. Latch instead — visibility
     * becomes monotonic (false -> true, never bouncing back mid-reload). The
     * duration is sticky (mediaTimeline only overwrites it with positive values
     * / the DASH pageDuration), and when playback truly ends the parent
     * unmounts this whole component (device.mediaStatus clears), so the latch
     * can never keep a stale bar on screen. On a genuine media change the
     * duration briefly resets to 0, which hides the bar until the new
     * duration arrives — the correct "new video loading" behaviour.
     */
    let seekBarEverReady = false;
    $: if (liveSeekBarReady) seekBarEverReady = true;

    // Show the bar whenever we have a duration and it has been ready at least
    // once this session — spanning every reload gap without a timer.
    $: showSeekBar = hasDuration && (liveSeekBarReady || seekBarEverReady);

    /**
     * True while a seek is settling — either the popup's optimistic confirm
     * window (seekTarget) or the external BLE/page reload hold (reloadHoldTime)
     * is active. Both are set the instant a seek starts and cleared once the
     * receiver settles at the new position (see mediaTimeline). During a DASH
     * remux restart the receiver rapidly flaps PLAYING -> IDLE -> BUFFERING ->
     * PLAYING several times; without this guard the buffering shimmer on the
     * seek bar strobes on and off with each flap, which is the residual popup
     * flicker after the seek-bar-visibility and title fixes. We keep the bar
     * calm (position already frozen at the target) until the seek settles;
     * genuine, non-seek buffering still shows the shimmer.
     */
    $: seekSettling =
        timeline.seekTarget !== undefined ||
        timeline.reloadHoldTime !== undefined;

    /**
     * Buffering shimmer with both-edge debounce (hysteresis). A Bilibili
     * DASH-remux stream flaps PLAYING <-> BUFFERING frequently, so binding the
     * shimmer straight to `playerState === BUFFERING` either strobes or (with a
     * long single-shot delay) never shows because each burst is short. Instead:
     *  - show only after buffering persists SHOW_DELAY ms (ignores brief blips);
     *  - once shown, keep it until buffering has been gone HIDE_DELAY ms, so the
     *    constant flapping during genuine buffering keeps it steadily ON.
     * This is a pure repaint of the bar's filled portion; it changes no layout,
     * so it cannot cause the popup resize flicker. Seeks are covered by
     * seekSettling.
     */
    const BUFFERING_SHOW_DELAY_MS = 250;
    const BUFFERING_HIDE_DELAY_MS = 600;
    let showBufferingShimmer = false;
    let bufShowTimer: number | undefined;
    let bufHideTimer: number | undefined;
    function updateBufferingShimmer(
        playerState: PlayerState,
        settling: boolean
    ) {
        const buffering = playerState === PlayerState.BUFFERING && !settling;
        if (buffering) {
            if (bufHideTimer !== undefined) {
                window.clearTimeout(bufHideTimer);
                bufHideTimer = undefined;
            }
            if (!showBufferingShimmer && bufShowTimer === undefined) {
                bufShowTimer = window.setTimeout(() => {
                    bufShowTimer = undefined;
                    showBufferingShimmer = true;
                }, BUFFERING_SHOW_DELAY_MS);
            }
        } else {
            if (bufShowTimer !== undefined) {
                window.clearTimeout(bufShowTimer);
                bufShowTimer = undefined;
            }
            if (showBufferingShimmer && bufHideTimer === undefined) {
                bufHideTimer = window.setTimeout(() => {
                    bufHideTimer = undefined;
                    showBufferingShimmer = false;
                }, BUFFERING_HIDE_DELAY_MS);
            }
        }
    }
    $: updateBufferingShimmer(status.playerState, seekSettling);

    // Diagnose seek bar visibility across popup reopens (gated behind the
    // Bilibili debug option by the background popup:debugLog listener).
    let lastSeekBarDebug = "";
    let lastRokuMediaTrace = "";
    $: if (debugEnabled) {
        const seekBarDebug = JSON.stringify({
            showsSeekBar: showSeekBar,
            liveSeekBarReady: liveSeekBarReady,
            heldThroughReload: showSeekBar && !liveSeekBarReady,
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

    // Timeline trace for the media kinds with a SYNTHETIC receiver clock (CCTV
    // live relay, Bilibili DASH remux): those are the ones whose bar depends on
    // reload holds, seek-confirm windows and estimate seeding, so "the bar did
    // not move" cannot be diagnosed from the receiver's position alone. Emitted
    // only on change, so it costs one line per real transition.
    $: if (
        debugEnabled &&
        (isRokuLiveElapsed ||
            isOptimisticRelayMedia ||
            Boolean(dashRemuxData.dashRemux))
    ) {
        const trace = JSON.stringify({
            playerState: status.playerState,
            currentTimeProp: status.currentTime,
            mediaSessionId: status.mediaSessionId,
            contentId: status.media?.contentId,
            duration: status.media?.duration,
            optimisticRelayMedia: isOptimisticRelayMedia,
            dashRemux: Boolean(dashRemuxData.dashRemux),
            dashStart: dashRemuxData.dashStart,
            timelineMediaId: timeline.mediaId,
            timelineCurrentTime: timeline.currentTime,
            timelineUpdatedAt: timeline.updatedAt,
            // The two freeze modes, which is what "the bar stopped" usually is.
            seekTarget: timeline.seekTarget,
            seekExpiresAt: timeline.seekExpiresAt,
            reloadHoldTime: timeline.reloadHoldTime,
            reloadExpiresAt: timeline.reloadExpiresAt,
            estimatedCurrentTime: currentTime,
            seekBarEverReady,
            showSeekBar
        });
        if (trace !== lastRokuMediaTrace) {
            lastRokuMediaTrace = trace;
            void browser.runtime
                .sendMessage({
                    subject: "popup:debugLog",
                    data: {
                        message: "[ReceiverMedia] Roku media chronology",
                        data: JSON.parse(trace)
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

        // During a DASH remux reload `status.media` (and thus its metadata)
        // briefly disappears, then returns. Recomputing unconditionally would
        // blank mediaTitle for that gap and unmount the whole `{#if mediaTitle}`
        // metadata row — the title (e.g. "第四季") flickers out and back in.
        // Only refresh from a present metadata payload; otherwise retain the
        // last-known values through the gap. A genuine stop unmounts this whole
        // component (parent gates on device.mediaStatus), so nothing lingers.
        if (metadata) {
            mediaTitle = metadata?.title;
            mediaSubtitle = undefined;

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

            if (showImage && metadata.images?.length) {
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
    }

    let currentTime = 0;
    // Recompute reactively on every timeline / play-state change — not just
    // once at init. Written as an explicit call so Svelte tracks `timeline`
    // and `status` as dependencies (a bare `getEstimatedMediaTime()` only
    // references the function name, so Svelte saw no deps and ran it a single
    // time, leaving the 1s interval below as the *only* updater). That gap is
    // exactly the "popup opens at 0, then jumps to the real position a beat
    // later" flash: the seeded timeline already holds the true position on
    // mount, so recomputing here makes the very first paint show it. The
    // interval still smooths progress between receiver status reports.
    $: currentTime = estimatePopupMediaTime(
        timeline,
        status.playerState === PlayerState.PLAYING && !isOptimisticRelayMedia,
        Date.now()
    );

    // Update estimated time every second
    onMount(() => {
        const intervalId = window.setInterval(() => {
            // Keep the displayed position ticking during normal playback and
            // refreshing as reload holds expire.
            const estimate = getEstimatedMediaTime();
            if (currentTime !== estimate) {
                currentTime = estimate;
            }
        }, 1000);

        return () => {
            window.clearInterval(intervalId);
            if (bufShowTimer !== undefined) window.clearTimeout(bufShowTimer);
            if (bufHideTimer !== undefined) window.clearTimeout(bufHideTimer);
        };
    });

    /**
     * Estimates the current playback position based on the last status
     * update.
     */
    function getEstimatedMediaTime() {
        return estimatePopupMediaTime(
            timeline,
            status.playerState === PlayerState.PLAYING &&
                !isOptimisticRelayMedia,
            Date.now()
        );
    }

    function seekTo(position: number) {
        const target = clampPopupSeek(position, timeline.duration);
        // Optimistic update with a confirmation window: the receiver keeps
        // reporting old-stream positions during the debounce + remux
        // restart, and plain optimistic updates would bounce back. The media it
        // was showing is handed over too, so those old-generation reports can be
        // recognized instead of fighting the new progress on the bar.
        const seekedAt = Date.now();
        timeline = createSeekedTimeline(timeline, target, seekedAt, {
            contentId: timeline.contentId,
            mediaId: timeline.mediaId
        });
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
        {#if showSeekBar}
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
                    {#if isRokuLiveElapsed}
                        <div
                            class="slider media__seek-bar media__seek-bar--readonly"
                            class:slider--indeterminate={showBufferingShimmer}
                            role="progressbar"
                            aria-label={_("popupMediaLive")}
                            aria-valuemin="0"
                            aria-valuemax={timeline.duration}
                            aria-valuenow={Math.min(
                                timeline.duration,
                                Math.max(0, currentTime)
                            )}
                            style:--media-progress={`${Math.min(
                                100,
                                Math.max(
                                    0,
                                    (currentTime / timeline.duration) * 100
                                )
                            )}%`}
                        >
                            <div class="media__seek-bar-fill" />
                        </div>
                    {:else}
                        <input
                            type="range"
                            class="slider media__seek-bar"
                            class:slider--indeterminate={showBufferingShimmer}
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
                                        timeline.duration *
                                            (seekHoverPosition / 100)
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
                    disabled={status.playerState === PlayerState.IDLE &&
                        !seekSettling}
                    on:click={() => seekTo(currentTime - 5)}
                />
            {/if}

            {#if status.supportedMediaCommands & _MediaCommand.PAUSE}
                <button
                    class={`ghost ${
                        nextPlaybackIntent === "PAUSE" || seekSettling
                            ? "media__pause-button"
                            : "media__play-button"
                    }`}
                    disabled={nextPlaybackIntent === undefined}
                    title={nextPlaybackIntent === "PAUSE"
                        ? _("popupMediaPause")
                        : _("popupMediaPlay")}
                    on:click={() => dispatch("togglePlayback")}
                />
            {/if}

            {#if isSeekable}
                <button
                    class="media__forward-button ghost"
                    disabled={status.playerState === PlayerState.IDLE &&
                        !seekSettling}
                    title={_("popupMediaSeekForward")}
                    on:click={() => seekTo(currentTime + 5)}
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
                    {#if device.deviceType === "roku"}
                        <button
                            type="button"
                            class="media__relative-volume-button"
                            aria-label={`${_("popupMediaVolume")} -`}
                            title={`${_("popupMediaVolume")} -`}
                            on:click={() => dispatch("volumeDown")}>−</button
                        >
                        <button
                            type="button"
                            class="media__relative-volume-button"
                            aria-label={`${_("popupMediaVolume")} +`}
                            title={`${_("popupMediaVolume")} +`}
                            on:click={() => dispatch("volumeUp")}>+</button
                        >
                    {:else}
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
                    {/if}
                </div>
            {/if}
        </div>
    </div>
</div>
