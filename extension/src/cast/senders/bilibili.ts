import { Logger } from "../../lib/logger";
import MediaSender, { type MediaSenderOpts } from "./media";
import type {
    PagePlaybackDispatchResult,
    PlaybackPageCommand
} from "../../../../shared/playbackCommand";

declare global {
    interface Window {
        __fxCastBilibiliNavigationInterval?: number;
        __fxCastBilibili?: {
            reinject: () => {
                status: "started" | "debounced";
                retryAfterMs?: number;
            };
            isCasting: () => boolean;
            setQuality: (quality: number) => void;
            setDebug: (enabled: boolean) => void;
            /**
             * Popup-initiated seek for the DASH remux session. Returns true when a
             * cast is running and the seek was handled (so the background does not
             * forward a native seek to the receiver, which cannot seek the
             * sequentially-remuxed stream).
             */
            dashSeek: (time: number) => boolean;
            /**
             * Popup-initiated play/pause. Applied to the page first so capture
             * and the receiver move together; returns true when a cast is
             * running so the background does not also send a native PLAY/PAUSE
             * (which would pause Roku first and the page later).
             */
            /**
             * Popup-initiated play/pause. Returns a structured result so the
             * background can tell already-target from a page transition and
             * take the receiver-dispatch timestamp from the page (the only
             * place that knows when the Cast API was called).
             */
            controlPlayback: (
                command: PlaybackPageCommand
            ) => PagePlaybackDispatchResult | false;
            controlFromBleRemote: (
                action: "seek_backward" | "seek_forward" | "pause" | "play",
                seekBackwardSeconds: number,
                seekForwardSeconds: number
            ) => boolean;
        };
        __fxCastBilibiliInitialQuality?: number;
        __fxCastBilibiliInitialDebug?: boolean;
    }
}

// The background normally detects an existing injection (via the
// window.__fxCastBilibili marker) and re-opens the receiver selector instead
// of re-injecting. This guard is a defensive fallback for the rare case the
// script is injected twice anyway: trigger a re-cast and return WITHOUT
// throwing. Throwing would make browser.scripting.executeScript report an
// injection error, aborting the flow and leaving the popup stuck on
// "Preparing receiver selector...".
if (window.__fxCastBilibili) {
    window.__fxCastBilibili.reinject();
} else {
    initBilibiliSender();
}

function initBilibiliSender() {
    const logger = new Logger("fx_cast_bilibili [sender]");
    const MAX_DEBUG_LINES = 200;
    const DEBUG_PANEL_ID = "fx-cast-bilibili-debug";
    const lines: string[] = [];
    let sender: MediaSender | undefined;
    let preferredQuality = Number(window.__fxCastBilibiliInitialQuality) || 0;
    const QUALITY_ORDER = [112, 80, 64, 32, 16];
    let selectedRoku = false;
    let originalMuted: boolean | undefined;
    let mutedElement: HTMLVideoElement | undefined;
    let debugEnabled = Boolean(window.__fxCastBilibiliInitialDebug);

    /**
     * The single owner of "the receiver must be reloaded for the page's current
     * item". Three sources used to start a reload on their own — the capture's
     * per-kind representation commits, the SPA navigation poll, and a relay
     * verdict — and on the device one part switch produced three overlapping
     * relays in one second, each tearing down the previous one (measured:
     * generation 6 -> 8 -> 10, all inside 550ms, none of them ever ready).
     *
     * A source now only reports a FACT (noteRokuItemTransition). This owner
     * decides when a relay is started, and it starts one only while the capture
     * holds a COMPLETE pair (see waitForCapturePair) and only once per capture
     * version.
     */
    let itemTransition:
        | {
              id: number;
              /** The capture version the load was started with; undefined when
               *  no complete pair appeared in time (playurl fallback). */
              captureGeneration?: number;
              /** The pair version the LOAD actually resolved with (the capture
               *  query that carries the target item), or undefined when the load
               *  fell back to the playurl pair. This — not the gate's version —
               *  is what the settle step compares against: it is the pair the
               *  relay is really being fed, and it comes from the same query the
               *  load used, so the two can never disagree. */
              loadedPairVersion?: number;
              loadGeneration?: number;
          }
        | undefined;
    let itemTransitionTimer: number | undefined;
    /** A fact arrived while a transition was already running, or while the
     *  settle window was open: re-evaluated when the current one settles, and
     *  only then allowed to start another load (and only if the capture pair
     *  actually changed, unless the fact is forced). */
    let itemTransitionPending = false;
    let itemTransitionPendingForce = false;
    /** The change generation of the most recent loadCurrentItem(). */
    let lastLoadGeneration = 0;
    /** The capture version the last succeeded load was resolved with. */
    let lastResolvedCaptureGeneration: number | undefined;
    /** The last failed transition, so a failure cannot become a retry loop. */
    let lastItemTransitionFailure:
        | { at: number; captureGeneration?: number }
        | undefined;
    let itemTransitionSequence = 0;

    /** The settle window that turns a burst of facts into one reload. Long
     *  enough to cover the video+audio commit pair and the page's own item
     *  event (all measured inside ~150ms of each other), short enough that a
     *  user-visible switch is not perceptibly delayed. */
    const ITEM_TRANSITION_SETTLE_MS = 250;
    /** How long to wait for the capture to hold a complete pair before falling
     *  back to loading the playurl pair — the pre-capture behaviour, so a
     *  capture that will never answer cannot wedge the cast. */
    const ITEM_TRANSITION_PAIR_WAIT_MS = 8000;
    const ITEM_TRANSITION_PAIR_POLL_MS = 200;
    /** A failed transition waits for a NEW capture version, or this long. */
    const ITEM_TRANSITION_RETRY_COOLDOWN_MS = 5000;

    function ensureDebugPanel() {
        let panel = document.getElementById(
            DEBUG_PANEL_ID
        ) as HTMLPreElement | null;
        if (panel) return panel;
        panel = document.createElement("pre");
        panel.id = DEBUG_PANEL_ID;
        panel.title = "Double-click to close";
        Object.assign(panel.style, {
            position: "fixed",
            right: "12px",
            bottom: "12px",
            zIndex: "2147483647",
            maxWidth: "620px",
            maxHeight: "45vh",
            overflow: "auto",
            padding: "12px",
            margin: "0",
            background: "rgba(0, 0, 0, 0.92)",
            color: "#8ff",
            border: "1px solid #4af",
            font: "12px/1.5 monospace",
            whiteSpace: "pre-wrap"
        });
        panel.addEventListener("dblclick", () => panel?.remove());
        (document.body || document.documentElement).append(panel);
        return panel;
    }
    let activeKey = "";
    let changeGeneration = 0;
    /** Debounce timestamp so rapid/auto re-cast clicks don't fight each other. */
    let lastReinjectAt = 0;

    let debugPanelFlushScheduled = false;
    /**
     * Flush the accumulated debug lines into the panel at most once per animation
     * frame. A single seek fires ~15-20 debug() calls in a burst (dash seek
     * requested, bridge start/stop, post-seek sync state xN, media loaded, controls
     * attached, drift correction...), and the continuous sync loop logs steadily
     * during ordinary playback too. Rewriting the whole <pre> (a fixed-position,
     * overflow:auto, max-height:45vh, up-to-200-line element) synchronously on
     * every call forced that many layout+paint passes per burst — a repaint storm
     * on top of an already heavy Bilibili page. Coalescing to one paint per frame
     * removes the storm while keeping the panel visually live.
     */
    function flushDebugPanel() {
        debugPanelFlushScheduled = false;
        const panel = ensureDebugPanel();
        panel.textContent = `fx_cast_bilibili debug (double-click to close)\n${lines.join(
            "\n"
        )}`;
    }

    function debug(message: string, data?: unknown) {
        if (!debugEnabled) return;
        const suffix =
            data === undefined
                ? ""
                : ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
        const line = `[${new Date().toLocaleTimeString()}] ${message}${suffix}`;
        lines.push(line);
        if (lines.length > MAX_DEBUG_LINES) {
            lines.splice(0, lines.length - MAX_DEBUG_LINES);
        }
        console.info("[fx_cast_bilibili]", message, data ?? "");
        if (!debugPanelFlushScheduled) {
            debugPanelFlushScheduled = true;
            requestAnimationFrame(flushDebugPanel);
        }
    }

    interface ResolvedMedia {
        key: string;
        mediaUrl: string;
        title: string;
        contentType: string;
        audioUrl?: string;
        /** The page's own cid for this item (from its pagelist). Bilibili
         *  addresses every media object under a per-item folder, so this is
         *  what the captured pair is matched against — without it a capture
         *  holding the PREVIOUS item's pair could be handed to the new item's
         *  load (see MediaSender's resolver and the page capture's
         *  pairSnapshot). */
        cid?: number;
    }

    interface PageInfo {
        cid: number;
        page: number;
        part: string;
    }
    async function json<T>(url: URL): Promise<T> {
        debug("fetch", url.pathname);
        const response = await fetch(url.href, {
            credentials: "include",
            referrer: location.href
        });
        debug("response", { status: response.status, path: url.pathname });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<T>;
    }

    function pageIdentity(url = new URL(location.href)) {
        const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
        if (!match) throw new Error("Unsupported Bilibili URL");
        const bvid = match[1];
        const page = Math.max(1, Number(url.searchParams.get("p")) || 1);
        return { bvid, page, key: `${bvid}:${page}` };
    }

    async function resolveMedia(): Promise<ResolvedMedia> {
        const { bvid, page: requested, key } = pageIdentity();
        debug("parsed", { bvid, requested, key });
        const pageUrl = new URL("https://api.bilibili.com/x/player/pagelist");
        pageUrl.searchParams.set("bvid", bvid);
        pageUrl.searchParams.set("jsonp", "jsonp");
        const pages = await json<{
            code: number;
            message?: string;
            data?: PageInfo[];
        }>(pageUrl);
        const page = pages.data?.find(item => item.page === requested);
        debug("pagelist", {
            code: pages.code,
            count: pages.data?.length ?? 0,
            cid: page?.cid
        });
        if (pages.code !== 0 || !page)
            throw new Error(pages.message || "CID unavailable");

        const playUrl = new URL("https://api.bilibili.com/x/player/playurl");
        for (const [name, value] of Object.entries({
            bvid,
            cid: String(page.cid),
            qn: String(preferredQuality || 112),
            fnval: "16",
            fnver: "0",
            fourk: "0",
            try_look: "1"
        }))
            playUrl.searchParams.set(name, value);
        interface DashStream {
            id: number;
            baseUrl?: string;
            base_url?: string;
            bandwidth?: number;
            codecs?: string;
            mimeType?: string;
            mime_type?: string;
            width?: number;
            height?: number;
            frameRate?: string;
            frame_rate?: string;
        }
        const play = await json<{
            code: number;
            message?: string;
            data?: {
                quality?: number;
                accept_quality?: number[];
                accept_description?: string[];
                dash?: { video?: DashStream[]; audio?: DashStream[] };
            };
        }>(playUrl);
        const videos = play.data?.dash?.video ?? [];
        const audios = play.data?.dash?.audio ?? [];
        const streamUrl = (stream?: DashStream) =>
            stream?.baseUrl ?? stream?.base_url;
        const avcVideos = videos.filter(stream =>
            (stream.codecs ?? "").toLowerCase().startsWith("avc")
        );
        const candidates = avcVideos.length ? avcVideos : videos;
        const targetQuality =
            preferredQuality ||
            QUALITY_ORDER.find(quality =>
                candidates.some(stream => stream.id === quality)
            );
        const fallbackOrder = preferredQuality
            ? QUALITY_ORDER.filter(quality => quality <= preferredQuality)
            : QUALITY_ORDER;
        const selectedQuality =
            (targetQuality &&
            candidates.some(stream => stream.id === targetQuality)
                ? targetQuality
                : fallbackOrder.find(quality =>
                      candidates.some(stream => stream.id === quality)
                  )) ?? candidates[0]?.id;
        const video =
            [...candidates]
                .filter(stream => stream.id === selectedQuality)
                .sort(
                    (left, right) =>
                        (right.bandwidth ?? 0) - (left.bandwidth ?? 0) ||
                        (right.height ?? 0) - (left.height ?? 0)
                )[0] ?? candidates[0];
        const audio = [...audios].sort(
            (left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
        )[0];
        const mediaUrl = streamUrl(video);
        const audioUrl = streamUrl(audio);
        debug("playurl DASH", {
            code: play.code,
            requestedQuality: preferredQuality || "auto",
            actualQuality: video?.id ?? play.data?.quality,
            acceptedQualities: play.data?.accept_quality,
            acceptedDescriptions: play.data?.accept_description,
            video: video
                ? {
                      id: video.id,
                      width: video.width,
                      height: video.height,
                      bandwidth: video.bandwidth,
                      codecs: video.codecs,
                      frameRate: video.frameRate ?? video.frame_rate
                  }
                : undefined,
            audio: audio
                ? {
                      id: audio.id,
                      bandwidth: audio.bandwidth,
                      codecs: audio.codecs
                  }
                : undefined
        });
        if (play.code !== 0 || !mediaUrl || !audioUrl) {
            throw new Error(
                play.message || "No playable DASH video/audio pair"
            );
        }
        return {
            key,
            mediaUrl,
            audioUrl,
            title: page.part || document.title,
            contentType: "application/x-mpegURL",
            cid: page.cid
        };
    }

    /**
     * Roku passive capture: resolve the page-captured video/audio pair for
     * the CURRENT representation. Only called when the receiver is confirmed
     * as Roku — Chromecast never goes through this path. Reads exactly ONCE:
     * the capture observes the page continuously, so a committed pair is
     * either ready now or not coming in any reasonable wait (page predates
     * the extension, or its buffer is already full). When not ready, fall
     * back to the playurl pair — the bridge proxies that representation
     * directly (the pre-capture behavior), so the cast still works in
     * pure-proxy mode instead of failing the load.
     */
    async function resolveCapturedMedia(
        fallback: { mediaUrl: string; audioUrl?: string },
        /** The item this load is for (the page's cid): the capture only hands
         *  out a pair that belongs to it. */
        item?: string
    ): Promise<{
        mediaUrl: string;
        audioUrl?: string;
    }> {
        const captured = (await browser.runtime.sendMessage({
            subject: "bilibili:getCapturedMedia",
            data: { item }
        })) as
            | {
                  videoUrl?: string;
                  audioUrl?: string;
                  captureGeneration?: number;
                  itemKey?: string;
              }
            | undefined;
        // Published in BOTH branches: the post-`input-listening` check compares
        // the version this load was resolved with against the capture's current
        // one, and "fell back to playurl" is a resolved state too (undefined).
        lastResolvedCaptureGeneration = captured?.captureGeneration;
        if (captured?.videoUrl && captured.audioUrl) {
            debug("using exact page-captured DASH pair", {
                videoPath: new URL(captured.videoUrl).pathname,
                audioPath: new URL(captured.audioUrl).pathname,
                captureGeneration: captured.captureGeneration,
                captureItem: captured.itemKey,
                requestedItem: item
            });
            return {
                mediaUrl: captured.videoUrl,
                audioUrl: captured.audioUrl
            };
        }
        debug("page-captured DASH pair not ready; using playurl pair", {
            requestedItem: item,
            videoPath: new URL(fallback.mediaUrl).pathname,
            audioPath: fallback.audioUrl
                ? new URL(fallback.audioUrl).pathname
                : undefined
        });
        return fallback;
    }

    async function waitForVideo(generation: number) {
        for (let attempt = 0; attempt < 20; attempt++) {
            if (generation !== changeGeneration) return undefined;
            const video = document.querySelector("video");
            if (video instanceof HTMLVideoElement && video.readyState > 0)
                return video;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const video = document.querySelector("video");
        return video instanceof HTMLVideoElement ? video : undefined;
    }

    async function loadCurrentItem(isInitial: boolean): Promise<boolean> {
        const generation = ++changeGeneration;
        // Published for the transition owner: it has to know which load its
        // transition produced (and whether a newer one superseded it).
        lastLoadGeneration = generation;
        // Cleared per load so the transition can never read a version the
        // resolver set for a PREVIOUS load: a resolver that does not run (the
        // receiver turned out not to be a Roku) must read as "no pair", not as
        // the last one.
        lastResolvedCaptureGeneration = undefined;
        if (!isInitial) sender?.suspendMediaElementSync();
        let mediaElement =
            document.querySelector<HTMLVideoElement>("video") ?? undefined;
        // Why the page is paused here, and why ONLY on the initial cast:
        //
        //  - Initial cast: the receiver is about to take over playback, and
        //    pausing first is what stops the tab from playing its own audio
        //    while the receiver selection dialog is open.
        //  - Item/quality change (isInitial === false): the page keeps PLAYING.
        //    It is the state source, the progress/control source, and on a Roku
        //    cast the CAPTURE SOURCE — pausing it stalls the very relay being
        //    rebuilt, and on a Chromecast it leaves the tab frozen while the
        //    receiver plays on. Audio is taken instead of playback (the updated
        //    element is muted), which is all the pause was ever needed for.
        //
        // The receiver side of the same boundary is the item-transition window:
        // the OLD session keeps reporting PAUSED/IDLE while the new one loads,
        // and that staleness must not reach the page (see
        // MediaSender#beginDashItemTransition).
        if (mediaElement instanceof HTMLVideoElement && isInitial) {
            mediaElement.pause();
            debug("source paused while receiver selection is pending", {
                currentTime: mediaElement.currentTime
            });
        } else if (mediaElement instanceof HTMLVideoElement) {
            debug("page playback left alone across the item change", {
                currentTime: mediaElement.currentTime,
                paused: mediaElement.paused
            });
        } else {
            mediaElement = undefined;
        }
        const media = await resolveMedia();
        const currentVideo = document.querySelector<HTMLVideoElement>("video");
        mediaElement =
            currentVideo instanceof HTMLVideoElement
                ? currentVideo
                : mediaElement instanceof HTMLVideoElement
                ? mediaElement
                : await waitForVideo(generation);
        if (generation !== changeGeneration) return false;
        // Roku capture is a passive tee. Do not alter page playback here.
        let thisSender: MediaSender | undefined;
        const opts: MediaSenderOpts = {
            mediaUrl: media.mediaUrl,
            mediaTitle: media.title,
            // The page's own key for this video. It is what lets a seek made
            // while this item loads be told apart from a seek left over from the
            // previous video (see MediaSender#adoptMediaIdentity).
            mediaIdentity: media.key,
            mediaContentType: media.contentType,
            mediaElement,
            isVideo: true,
            remoteProxy: { referer: location.href, audioUrl: media.audioUrl },
            // Roku passive capture: MediaSender calls this lazily after the
            // receiver is confirmed as Roku, replacing the playurl pair with
            // the page-captured video/audio when the capture has committed
            // one (otherwise the playurl pair stays and the bridge runs in
            // pure-proxy mode). Never called for Chromecast.
            rokuMediaResolver: async () => {
                const localVideo =
                    document.querySelector<HTMLVideoElement>("video") ??
                    mediaElement;
                if (!(localVideo instanceof HTMLVideoElement)) {
                    throw new Error(
                        "No Bilibili video element for Roku capture"
                    );
                }
                await localVideo.play();
                return resolveCapturedMedia(
                    {
                        mediaUrl: media.mediaUrl,
                        audioUrl: media.audioUrl
                    },
                    media.cid !== undefined ? String(media.cid) : undefined
                );
            },
            // Let the page's own player controls (play/pause button, progress bar)
            // drive the receiver, but gate on real user gestures so Bilibili's
            // autonomous events (autoplay, buffering, quality switches) can't hijack
            // the receiver.
            forwardPageControls: true,
            gestureGatedControls: true,
            onReceiverSelected: isRoku => {
                selectedRoku = isRoku;
                const localVideo =
                    document.querySelector<HTMLVideoElement>("video") ??
                    mediaElement;
                if (!(localVideo instanceof HTMLVideoElement)) return;
                if (!isRoku) {
                    localVideo.pause();
                    localVideo.muted = true;
                    debug("Chromecast selected; source remains paused");
                    return;
                }
                // Silence the local tab so the receiver owns audio. Record
                // the element and its muted state on FIRST audio takeover of
                // this cast lifecycle — a relay rebuild (quality switch,
                // overflow, stall) re-fires onReceiverSelected with muted
                // already true, and overwriting would lose the true original.
                if (mutedElement && mutedElement !== localVideo) {
                    // The player rebuilt mid-cast and replaced the <video>
                    // element: hand ownership over — restore the OLD element's
                    // original muted state (if still connected), then capture
                    // and mute the NEW element so it can be restored too.
                    if (
                        originalMuted !== undefined &&
                        mutedElement.isConnected
                    ) {
                        mutedElement.muted = originalMuted;
                    }
                    mutedElement = undefined;
                    originalMuted = undefined;
                }
                if (!mutedElement) {
                    mutedElement = localVideo;
                    originalMuted = localVideo.muted;
                }
                localVideo.muted = true;
                // loadMedia awaits rokuMediaResolver, which resumes the page
                // before the captured relay starts.
                debug(
                    "Roku selected; muted locally; playback required for capture",
                    {
                        currentTime: localVideo.currentTime,
                        paused: localVideo.paused
                    }
                );
            },
            // Stop (from the popup) tears down the Cast session. Reset local state so
            // the next Cast click starts a fresh session instead of reusing a stopped
            // one (which left the popup stuck on "casting...").
            onStopped: () => {
                // Identity guard: a late onStopped from a REPLACED sender
                // must not restore/clear state that belongs to the current
                // cast lifecycle — including the global sender reference and
                // active key, not just the muted tracking. (Relay rebuilds
                // reuse the same MediaSender instance, so their stop always
                // matches and always restores.)
                if (sender !== thisSender) {
                    debug("stale sender stop ignored");
                    return;
                }
                debug("cast stopped; ready to re-cast");
                const localVideo =
                    document.querySelector<HTMLVideoElement>("video") ??
                    undefined;
                if (selectedRoku) {
                    // Roku casts only muted the page: restore the muted
                    // state on the element captured at first takeover (if
                    // still in the document).
                    if (
                        mutedElement &&
                        originalMuted !== undefined &&
                        mutedElement.isConnected
                    ) {
                        mutedElement.muted = originalMuted;
                    }
                } else if (localVideo instanceof HTMLVideoElement) {
                    if (!localVideo.paused) {
                        // Chromecast stop: keep the source paused (it was
                        // paused at selection) against autoplay.
                        localVideo.pause();
                    }
                }
                mutedElement = undefined;
                originalMuted = undefined;
                sender = undefined;
                activeKey = "";
                // Invalidate any in-flight loadCurrentItem: the generation
                // check inside will fire and the call will exit cleanly.
                changeGeneration++;
            },
            debug
        };
        debug(isInitial ? "creating sender" : "playlist item changed", {
            key: media.key,
            title: media.title,
            hasVideoElement: Boolean(mediaElement),
            currentTime: mediaElement?.currentTime
        });
        activeKey = media.key;
        if (!sender) {
            thisSender = new MediaSender(opts);
            sender = thisSender;
        } else {
            // Relay rebuild on the SAME MediaSender instance: its stop
            // identity is unchanged, and updateMedia's transactional callback
            // swap keeps the installed stop handler matching.
            thisSender = sender;
            // The item changed under a live session: open the transition window
            // BEFORE the reload, so the OLD media session's stale PAUSED/IDLE or
            // previous-item position cannot reach the page while the new stream
            // is prepared, and take audio ownership of the NEW element — the page
            // keeps playing, so an unmuted tab would play over the receiver (on
            // Roku the receiving device is fed by this very page, on Chromecast
            // the same media plays on both).
            //
            // Both calls are no-ops where they do not apply (the transition
            // window is Chromecast-DASH only; the mute is idempotent), and the
            // sender restores the element's own muted state on stop.
            sender.beginDashItemTransition();
            sender.prepareUpdatedMediaElement(mediaElement);
            await sender.updateMedia(opts);
        }
        return true;
    }

    // Re-cast entry point for subsequent extension clicks / script injections
    // (see the guard at the top of this file). Every click on the extension for
    // an already-injected tab lands here. We ALWAYS start a fresh cast: if a cast
    // is already running we tear it down first, then re-run resolve +
    // requestSession. This guarantees the receiver selector opens with real
    // castable media (a Cast button) instead of the empty device-only view the
    // generic background path produces for Bilibili.
    window.__fxCastBilibili = {
        isCasting: () => Boolean(sender),
        dashSeek: (time: number) => {
            if (!sender || !Number.isFinite(time) || time < 0) return false;
            debug("popup seek routed to page sender", { time });
            sender.seekDashRemux(time);
            return true;
        },
        controlPlayback: (command: PlaybackPageCommand) => {
            const intent = command?.intent;
            if (!sender || (intent !== "PLAY" && intent !== "PAUSE")) {
                return false;
            }
            debug("popup playback routed to page sender", { intent });
            return sender.controlPlayback(command);
        },
        controlFromBleRemote: (
            action,
            seekBackwardSeconds,
            seekForwardSeconds
        ) => {
            if (!sender) return false;
            debug("BLE remote routed through page synchronization", {
                action,
                seekBackwardSeconds,
                seekForwardSeconds
            });
            return sender.controlFromBleRemote(
                action,
                seekBackwardSeconds,
                seekForwardSeconds
            );
        },
        setDebug: (enabled: boolean) => {
            debugEnabled = Boolean(enabled);
            if (!debugEnabled)
                document.getElementById(DEBUG_PANEL_ID)?.remove();
            debug("debug logging enabled");
        },
        setQuality: (quality: number) => {
            if (selectedRoku) {
                // Roku passive capture: the page player controls quality; the
                // capture follows it. An extension-side switch does not exist.
                debug(
                    "quality preference ignored (page player controls quality for Roku)",
                    {
                        requested: quality || "auto"
                    }
                );
                return;
            }
            const normalized = QUALITY_ORDER.includes(quality) ? quality : 0;
            if (preferredQuality === normalized) return;
            preferredQuality = normalized;
            debug("quality preference changed", {
                preferredQuality: preferredQuality || "auto",
                isCasting: Boolean(sender)
            });
            if (sender) {
                void loadCurrentItem(false).catch(err => {
                    debug(
                        "quality reload failed",
                        err instanceof Error ? err.message : String(err)
                    );
                    logger.error("Failed to reload Bilibili quality", err);
                });
            }
        },
        reinject: () => {
            // Popup auto-cast (onMount) plus a manual click can fire this twice in
            // quick succession; debounce so the second call doesn't stop the cast the
            // first one just started.
            const now = Date.now();
            debug("reinject() called", {
                hasSender: Boolean(sender),
                sinceLastReinjectMs: now - lastReinjectAt,
                willDebounce: now - lastReinjectAt < 1200
            });
            if (now - lastReinjectAt < 1200) {
                const retryAfterMs = 1200 - (now - lastReinjectAt);
                debug("re-cast ignored; debounced", { retryAfterMs });
                return { status: "debounced", retryAfterMs };
            }
            lastReinjectAt = now;

            if (sender) {
                // Tear down the current cast before starting a fresh one so we don't
                // leave an orphaned receiver session and so requestSession opens a clean
                // selector. stop() invokes onStopped which resets these, but be
                // defensive in case it doesn't fire.
                debug("re-cast: stopping current cast first");
                try {
                    sender.stop();
                } catch (err) {
                    debug(
                        "re-cast stop failed",
                        err instanceof Error ? err.message : String(err)
                    );
                }
                sender = undefined;
                activeKey = "";
            }

            debug("re-cast requested");
            void loadCurrentItem(true).catch(err => {
                debug(
                    "re-cast FAILED",
                    err instanceof Error
                        ? `${err.name}: ${err.message}`
                        : String(err)
                );
                logger.error("Bilibili re-cast failed", err);
            });
            return { status: "started" };
        }
    };

    debug("module loaded");
    void loadCurrentItem(true).catch(err => {
        debug(
            "FAILED",
            err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        );
        logger.error("Bilibili sender failed", err);
    });

    /**
     * The capture's current pair version, or undefined when it has no complete
     * pair for the page's current item right now.
     *
     * `undefined` is NOT a version: it is the absence of one. Treating it as
     * "the pair changed" is what started a second relay on the device after a
     * successful switch (the measured `undefined !== 4`), so every caller here
     * has to say explicitly what it does with an answer it cannot compare.
     *
     * `probe` marks the caller as internal polling, which the capture keeps out
     * of its log (see the getCapturedMedia handler).
     */
    async function capturePairGeneration(
        probe = false
    ): Promise<number | undefined> {
        const snapshot = (await browser.runtime.sendMessage({
            subject: "bilibili:getCapturedMedia",
            data: probe ? { probe: true } : {}
        })) as { captureGeneration?: number } | undefined;
        return snapshot?.captureGeneration;
    }

    /**
     * The atomic gate: wait, bounded, for the capture to hold a COMPLETE pair
     * (one committed video+audio pair with an init for each, both from the same
     * commit) before a relay is started for it.
     *
     * Starting a relay on a half-captured pair is exactly the measured failure:
     * the successor generation had an init for both kinds and not one audio
     * fragment, so the bridge parked waiting for the covering fragment, the
     * readiness gate never closed, no LOAD was ever sent, and the Roku kept
     * polling the previous playlist until it got a 404. `undefined` means the
     * wait expired — the load then proceeds with the playurl pair (the
     * pre-capture behaviour), so a capture that will never answer cannot wedge
     * the cast.
     */
    async function waitForCapturePair(): Promise<number | undefined> {
        const deadline = Date.now() + ITEM_TRANSITION_PAIR_WAIT_MS;
        for (;;) {
            const generation = await capturePairGeneration(true).catch(
                () => undefined
            );
            if (generation !== undefined) return generation;
            if (Date.now() >= deadline) {
                debug(
                    "capture pair never became complete; loading the item anyway"
                );
                return undefined;
            }
            await new Promise(resolve =>
                window.setTimeout(resolve, ITEM_TRANSITION_PAIR_POLL_MS)
            );
        }
    }

    /**
     * Report a FACT that the receiver may need to be reloaded. Nothing here
     * starts a load: the transition owner does, after the settle window and
     * after the capture has a complete pair.
     */
    function noteRokuItemTransition(reason: string, force = false) {
        if (!sender?.isRokuReceiver()) return;
        if (force) itemTransitionPendingForce = true;
        if (itemTransition || itemTransitionTimer !== undefined) {
            // Already owned: a burst (both kinds committing, then the page's own
            // item event) must collapse into ONE reload, and a fact arriving
            // during a running transition is re-evaluated when it settles.
            itemTransitionPending = true;
            return;
        }
        itemTransitionTimer = window.setTimeout(() => {
            itemTransitionTimer = undefined;
            void runRokuItemTransition(reason);
        }, ITEM_TRANSITION_SETTLE_MS);
    }

    async function runRokuItemTransition(reason: string) {
        const transition: NonNullable<typeof itemTransition> = {
            id: ++itemTransitionSequence
        };
        itemTransition = transition;
        try {
            const captureGeneration = await waitForCapturePair();
            // Recorded BEFORE any decision below: the settle step decides
            // whether to run again by comparing the capture's pair against THIS
            // transition's, and an unset value reads as "everything changed" —
            // which made a held-back transition re-arm itself forever. The
            // harness caught that as "a changed pair never earns its one retry".
            transition.captureGeneration = captureGeneration;
            const previous = lastItemTransitionFailure;
            if (
                previous &&
                previous.captureGeneration === captureGeneration &&
                Date.now() - previous.at < ITEM_TRANSITION_RETRY_COOLDOWN_MS
            ) {
                // The last attempt failed with this very pair. Retrying it now
                // would tear down a relay for no new information; the 750ms
                // navigation poll keeps reporting the fact, so the cooldown
                // expiry still retries. This is what stops "failed generation ->
                // immediate rebuild" chains.
                debug(
                    "roku item transition held back; the pair has not changed",
                    {
                        reason,
                        captureGeneration,
                        sinceFailureMs: Date.now() - previous.at
                    }
                );
            } else {
                const loaded = await loadCurrentItem(false);
                transition.loadGeneration = lastLoadGeneration;
                // Read straight after the load: the resolver has just set it for
                // THIS load (undefined when the capture refused this item and the
                // playurl pair was used instead).
                transition.loadedPairVersion = lastResolvedCaptureGeneration;
                if (!loaded) {
                    debug("roku item transition superseded", { reason });
                } else {
                    lastItemTransitionFailure = undefined;
                    debug("roku item transition loaded", {
                        reason,
                        gatePairVersion: captureGeneration,
                        loadedPairVersion: transition.loadedPairVersion,
                        loadGeneration: transition.loadGeneration
                    });
                }
            }
        } catch (err) {
            lastItemTransitionFailure = {
                at: Date.now(),
                captureGeneration: transition.captureGeneration
            };
            logger.error("Bilibili roku item transition failed", err);
            debug("roku item transition failed", {
                reason,
                error: err instanceof Error ? err.message : String(err)
            });
        }
        // Settle. Every path above reaches this — a `return` inside the try used
        // to skip it and leave the transition owning the reload forever, so no
        // later fact could ever start one (the harness's "changed pair earns one
        // more relay" row).
        const pending = itemTransitionPending;
        const forced = itemTransitionPendingForce;
        itemTransition = undefined;
        itemTransitionPending = false;
        itemTransitionPendingForce = false;
        if (!pending && !forced) return;
        // A fact arrived while this transition ran (on the device this was the
        // 750ms navigation poll re-reporting the switch until `activeKey` caught
        // up). Start another load only when the pair really moved on:
        // re-reporting the same pair would restart a relay that is already
        // correct — and restarting it tears the previous one down, which is how
        // a healthy stream became a black screen.
        //
        // The comparison is deliberately three-valued. `now === undefined` means
        // "the capture cannot form a pair for this item right now", which is NOT
        // evidence that the pair changed; treating it as a change is the
        // measured defect. And when the load itself fell back (no captured pair
        // at all), a pair that appears later does not justify a reload either:
        // on the Roku path ffmpeg's inputs are the capture endpoints, so the
        // fallback plays the captured bytes anyway and "upgrading" it would only
        // interrupt a working relay. A later, genuinely new pair announces itself
        // as a new fact (every commit notifies) and gets its own transition.
        const now = await capturePairGeneration(true).catch(() => undefined);
        const changed =
            now !== undefined &&
            transition.loadedPairVersion !== undefined &&
            now !== transition.loadedPairVersion;
        if (!forced && !changed) {
            debug("roku item transition fact merged; no new pair to load", {
                factVersion: now,
                loadedPairVersion: transition.loadedPairVersion
            });
            return;
        }
        debug("roku item transition superseded by a changed pair", {
            from: transition.loadedPairVersion,
            to: now,
            forced
        });
        noteRokuItemTransition("fact-after-transition", forced);
    }

    // Bilibili changes BV/p inside a SPA. Reload the receiver only when the media
    // identity changes; ordinary seeks keep controlling the existing Cast item.
    if (window.__fxCastBilibiliNavigationInterval !== undefined) {
        window.clearInterval(window.__fxCastBilibiliNavigationInterval);
    }
    /**
     * The relay is listening (this message carries its capture port). Re-read
     * the capture version: if the pair moved on between deciding to load it and
     * this moment, the bytes this relay will be fed belong to a different media
     * object, so report a fact instead of letting it starve.
     */
    async function verifyCapturePairUnchanged(requestId: string) {
        if (!sender?.isCurrentMediaServerRequest(requestId)) return;
        const now = await capturePairGeneration(true).catch(() => undefined);
        if (now === undefined || now === lastResolvedCaptureGeneration) return;
        debug("capture pair changed after the relay started listening", {
            requestId,
            resolved: lastResolvedCaptureGeneration,
            now
        });
        noteRokuItemTransition("capture-version-changed", true);
    }

    browser.runtime.onMessage.addListener((message: any) => {
        if (message?.subject === "bilibili:pageCaptureReady") {
            const requestId = message.data?.requestId;
            if (typeof requestId === "string") {
                void verifyCapturePairUnchanged(requestId);
                sender?.primeCaptureSource(requestId);
            }
            return undefined;
        }
        if (
            message?.subject !== "bilibili:capturedRepresentationChanged" &&
            message?.subject !== "bilibili:captureOverflow"
        ) {
            return undefined;
        }
        if (!sender) return undefined;
        if (
            message.subject === "bilibili:captureOverflow" &&
            typeof message.data?.requestId === "string" &&
            !sender.isCurrentMediaServerRequest(message.data.requestId)
        ) {
            // An overflow verdict from a generation this sender has already
            // replaced: rebuilding again would needlessly interrupt the new
            // relay.
            debug("stale capture overflow ignored", message.data);
            return undefined;
        }
        noteRokuItemTransition(
            message.subject === "bilibili:captureOverflow"
                ? "capture-overflow"
                : `representation-changed:${message.data?.kind ?? "unknown"}`,
            // An overflow is a relay that was torn down, not a re-report of the
            // same bytes: it must be rebuilt even when the pair is unchanged.
            message.subject === "bilibili:captureOverflow"
        );
        return undefined;
    });

    window.__fxCastBilibiliNavigationInterval = window.setInterval(() => {
        try {
            const nextKey = pageIdentity().key;
            if (activeKey && nextKey !== activeKey) {
                debug("detected playlist navigation", {
                    from: activeKey,
                    to: nextKey
                });
                if (sender?.isRokuReceiver()) {
                    // A Roku reload is owned by the item transition: it waits
                    // for a complete capture pair and starts at most one relay
                    // per pair. Reloading from here as well is what produced
                    // overlapping generations.
                    noteRokuItemTransition("navigation");
                } else {
                    void loadCurrentItem(false).catch(err => {
                        debug(
                            "playlist reload failed",
                            err instanceof Error ? err.message : String(err)
                        );
                        logger.error(
                            "Failed to reload Bilibili playlist item",
                            err
                        );
                    });
                }
            }
        } catch {
            // Ignore temporary non-video URLs during SPA transitions.
        }
    }, 750);
    window.addEventListener(
        "pagehide",
        () => {
            if (window.__fxCastBilibiliNavigationInterval !== undefined) {
                window.clearInterval(window.__fxCastBilibiliNavigationInterval);
                window.__fxCastBilibiliNavigationInterval = undefined;
            }
        },
        { once: true }
    );
}
