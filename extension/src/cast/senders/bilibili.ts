import { Logger } from "../../lib/logger";
import MediaSender, { type MediaSenderOpts } from "./media";

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
            controlPlayback: (action: "play" | "pause") => boolean;
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
    let rokuReloadRunning = false;
    let rokuReloadQueued = false;
    let debugEnabled = Boolean(window.__fxCastBilibiliInitialDebug);

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
            contentType: "application/x-mpegURL"
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
    async function resolveCapturedMedia(fallback: {
        mediaUrl: string;
        audioUrl?: string;
    }): Promise<{
        mediaUrl: string;
        audioUrl?: string;
    }> {
        const captured = (await browser.runtime.sendMessage({
            subject: "bilibili:getCapturedMedia",
            data: {}
        })) as { videoUrl?: string; audioUrl?: string } | undefined;
        if (captured?.videoUrl && captured.audioUrl) {
            debug("using exact page-captured DASH pair", {
                videoPath: new URL(captured.videoUrl).pathname,
                audioPath: new URL(captured.audioUrl).pathname
            });
            return {
                mediaUrl: captured.videoUrl,
                audioUrl: captured.audioUrl
            };
        }
        debug("page-captured DASH pair not ready; using playurl pair", {
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
        if (!isInitial) sender?.suspendMediaElementSync();
        let mediaElement =
            document.querySelector<HTMLVideoElement>("video") ?? undefined;
        if (mediaElement instanceof HTMLVideoElement) {
            mediaElement.pause();
            debug("source paused while receiver selection is pending", {
                currentTime: mediaElement.currentTime
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
                return resolveCapturedMedia({
                    mediaUrl: media.mediaUrl,
                    audioUrl: media.audioUrl
                });
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
        controlPlayback: (action: "play" | "pause") => {
            if (!sender || (action !== "play" && action !== "pause")) {
                return false;
            }
            debug("popup playback routed to page sender", { action });
            return sender.controlPlayback(action);
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
     * Roku capture 恢复（representation 变更 / capture 终态）：重载当前媒体
     * 输入。仅当前 receiver 是 Roku 时生效；同一时间只跑一次重载，运行期间
     * 到达的事件合并为最多一次后续重载。失败等待下一个事件自然重试。
     */
    function reloadRokuCapture(reason: string) {
        if (!sender?.isRokuReceiver()) return;
        if (rokuReloadRunning) {
            // Merge rapid events (video+audio commit, overflow+representation)
            // into at most one follow-up reload.
            rokuReloadQueued = true;
            return;
        }
        rokuReloadRunning = true;
        void loadCurrentItem(false)
            .then(loaded => {
                if (!loaded) {
                    debug("roku capture reload superseded", { reason });
                    return;
                }
                debug("roku capture reload completed", { reason });
            })
            .catch(err => {
                logger.error("Bilibili roku capture reload failed", err);
                debug("roku capture reload failed", {
                    reason,
                    error: err instanceof Error ? err.message : String(err)
                });
                // Single retry for terminal conditions (overflow) where no
                // future event is guaranteed to trigger a new rebuild. The
                // retry is invalidated if any newer load starts.
                if (reason === "capture-overflow") {
                    const retryGeneration = changeGeneration;
                    setTimeout(() => {
                        if (
                            changeGeneration !== retryGeneration ||
                            !sender?.isRokuReceiver()
                        ) {
                            return;
                        }
                        void loadCurrentItem(false).catch(reloadErr => {
                            logger.error(
                                "Bilibili roku capture retry failed",
                                reloadErr
                            );
                            debug("roku capture retry failed", {
                                reason,
                                error:
                                    reloadErr instanceof Error
                                        ? reloadErr.message
                                        : String(reloadErr)
                            });
                        });
                    }, 2000);
                }
            })
            .finally(() => {
                rokuReloadRunning = false;
                if (rokuReloadQueued) {
                    rokuReloadQueued = false;
                    reloadRokuCapture("queued");
                }
            });
    }

    // Bilibili changes BV/p inside a SPA. Reload the receiver only when the media
    // identity changes; ordinary seeks keep controlling the existing Cast item.
    if (window.__fxCastBilibiliNavigationInterval !== undefined) {
        window.clearInterval(window.__fxCastBilibiliNavigationInterval);
    }
    browser.runtime.onMessage.addListener((message: any) => {
        if (message?.subject === "bilibili:pageCaptureReady") {
            const requestId = message.data?.requestId;
            if (typeof requestId === "string") {
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
        reloadRokuCapture(
            message.subject === "bilibili:captureOverflow"
                ? "capture-overflow"
                : "representation-changed"
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
