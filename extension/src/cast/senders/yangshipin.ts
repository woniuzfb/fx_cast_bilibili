import { Logger } from "../../lib/logger";
import { getYangshipinChannelName } from "../../lib/yangshipinChannels";
import MediaSender, { type MediaSenderOpts } from "./media";
import type {
    PagePlaybackDispatchResult,
    PlaybackPageCommand
} from "../../../../shared/playbackCommand";

declare global {
    interface Window {
        __fxCastYangshipin?: {
            reinject: () => {
                status: "started" | "debounced";
                retryAfterMs?: number;
            };
            isCasting: () => boolean;
            controlPlayback?: (
                command: PlaybackPageCommand
            ) => PagePlaybackDispatchResult;
        };
    }
}

if (window.__fxCastYangshipin) {
    window.__fxCastYangshipin.reinject();
} else {
    initYangshipinSender();
}

function initYangshipinSender() {
    const logger = new Logger("fx_cast_bilibili [yangshipin sender]");
    let sender: MediaSender | undefined;
    /** Debounce timestamp so rapid re-cast clicks don't fight each other. */
    let lastReinjectAt = 0;

    interface ResolveResponse {
        mediaUrl?: string;
        /** Real Chrome UA (from docs/ua.json) for the bridge's upstream fetches. */
        userAgent?: string;
        title?: string;
        error?: string;
    }

    /**
     * Resolves the live stream URL captured off this tab's network traffic
     * by the background script.
     */
    async function resolveStream(): Promise<{
        mediaUrl: string;
        userAgent?: string;
        title?: string;
    }> {
        const response = (await browser.runtime.sendMessage({
            subject: "yangshipin:resolveStreamUrl",
            data: {}
        })) as ResolveResponse | undefined;
        if (!response?.mediaUrl) {
            throw new Error(response?.error || "Live stream URL unavailable");
        }
        return {
            mediaUrl: response.mediaUrl,
            userAgent: response.userAgent,
            title: response.title
        };
    }

    function findVideoElement(
        root: Document | ShadowRoot | Element = document
    ): HTMLVideoElement | undefined {
        const direct = root.querySelector("video");
        if (direct instanceof HTMLVideoElement) return direct;

        const ysPlayer = root.querySelector("ys-player") as any;
        if (ysPlayer) {
            if (ysPlayer.video instanceof HTMLVideoElement) {
                return ysPlayer.video;
            }
            if (ysPlayer.shadowRoot) {
                const shadowVideo = ysPlayer.shadowRoot.querySelector("video");
                if (shadowVideo instanceof HTMLVideoElement) return shadowVideo;
            }
        }

        const livePlayer = root.querySelector("live-player") as any;
        if (livePlayer) {
            if (livePlayer.video instanceof HTMLVideoElement) {
                return livePlayer.video;
            }
            if (livePlayer.shadowRoot) {
                const shadowVideo =
                    livePlayer.shadowRoot.querySelector("video");
                if (shadowVideo instanceof HTMLVideoElement) return shadowVideo;
            }
        }

        for (const child of root.querySelectorAll("*")) {
            if (child.shadowRoot) {
                const found = findVideoElement(child.shadowRoot);
                if (found) return found;
            }
        }
        return undefined;
    }

    function hookMediaElement(video: HTMLVideoElement): HTMLVideoElement {
        if ((video as any).__fxCastHooked) return video;
        (video as any).__fxCastHooked = true;

        const origPause = video.pause;
        video.pause = function (this: HTMLVideoElement) {
            try {
                const ys = document.querySelector(
                    "ys-player, live-player"
                ) as any;
                if (ys && typeof ys.pause === "function") {
                    ys.pause();
                }
            } catch {
                /* ignore */
            }
            return origPause.apply(this);
        };

        const origPlay = video.play;
        video.play = function (this: HTMLVideoElement) {
            try {
                const ys = document.querySelector(
                    "ys-player, live-player"
                ) as any;
                if (ys && typeof ys.play === "function") {
                    return ys.play();
                }
            } catch {
                /* ignore */
            }
            return origPlay.apply(this);
        };

        return video;
    }

    function pageVideo(): HTMLVideoElement | undefined {
        const video = findVideoElement();
        return video ? hookMediaElement(video) : undefined;
    }

    function getActiveCameraAngle(): string | undefined {
        const borderEl = document.querySelector(".streams-item .border");
        if (borderEl && borderEl.parentElement) {
            const text =
                borderEl.parentElement.querySelector(".overflow-1")
                    ?.textContent || borderEl.parentElement.textContent;
            const clean = text?.trim();
            if (clean) return clean;
        }

        const activeItem = document.querySelector(
            ".streams-item.active, .streams-item.selected, .streams-item[class*='active'], .streams-item[class*='select']"
        );
        if (activeItem) {
            const text =
                activeItem.querySelector(".overflow-1")?.textContent ||
                activeItem.textContent;
            const clean = text?.trim();
            if (clean) return clean;
        }

        return undefined;
    }

    function getLiveDetailEventTitle(): string | undefined {
        const el = document.querySelector(
            ".live-main-l-title .overflow-1, .live-main-l-title, .live-detail-title, .live-title"
        );
        const text = el?.textContent?.trim();
        if (text) return text;
        return undefined;
    }

    function resolveMediaTitle(resolvedTitle?: string): string {
        // 1. Check live/detail multi-camera page
        const eventTitle = getLiveDetailEventTitle();
        const cameraAngle = getActiveCameraAngle();
        if (eventTitle && cameraAngle) {
            return `${eventTitle} - ${cameraAngle}`;
        }
        if (cameraAngle) {
            const rawTitle = document.title || "";
            const cleanTitle = rawTitle.replace(/[-_]央视频.*$/i, "").trim();
            return cleanTitle ? `${cleanTitle} - ${cameraAngle}` : cameraAngle;
        }
        if (eventTitle) {
            return eventTitle;
        }

        if (resolvedTitle) return resolvedTitle;

        // 2. Check DOM for active channel on tv/home
        const domTvChannel = document
            .querySelector(
                ".tvSelect span, .tv-main-con-r-list-left-imga.tvSelect span"
            )
            ?.textContent?.replace(/\((?:限免|VIP)\)/g, "")
            .trim();
        if (domTvChannel) return domTvChannel;

        // 3. Check URL query param pid / livepid
        try {
            const url = new URL(location.href);
            const pid =
                url.searchParams.get("pid") || url.searchParams.get("livepid");
            const mappedName = getYangshipinChannelName(pid || undefined);
            if (mappedName) return mappedName;
        } catch {
            /* ignore */
        }

        // 4. Fallback to clean document title or default
        const rawTitle = document.title || "";
        const cleanTitle = rawTitle.replace(/[-_]央视频.*$/i, "").trim();
        return cleanTitle || "央视频直播";
    }

    function buildSenderOpts(
        streamReady: Promise<{
            mediaUrl: string;
            userAgent?: string;
            title?: string;
        }>
    ): MediaSenderOpts {
        const mediaElement = pageVideo();
        let currentTitle = resolveMediaTitle();
        const opts: MediaSenderOpts = {
            mediaUrl: location.href,
            mediaUrlResolver: async () => {
                const resolved = await streamReady;
                activeStreamUrl = resolved.mediaUrl;
                if (resolved.title) {
                    currentTitle = resolved.title;
                } else {
                    currentTitle = resolveMediaTitle();
                }
                opts.mediaTitle = currentTitle;
                if (sender) {
                    (sender as any).mediaTitle = currentTitle;
                }
                // Keep the web page player playing concurrently (do NOT pause).
                logger.info("Yangshipin live stream ready for cast", {
                    mediaUrl: resolved.mediaUrl,
                    title: currentTitle
                });
                return resolved;
            },
            mediaElement,
            mediaTitle: currentTitle,
            mediaContentType: "application/x-mpegURL",
            isVideo: true,
            // The page live player and synthetic VOD use unrelated clocks. Let the
            // receiver drive page play/pause, but never copy currentTime or seeks.
            forwardPageControls: true,
            gestureGatedControls: true,
            syncMediaPosition: false,
            // Live HLS relay: proxies through bridge mediaServer with hlsLive: true.
            remoteProxy: { referer: location.href, hlsLive: true },
            autoRecoverOnIdle: true,
            onStopped: () => {
                sender = undefined;
                activeStreamUrl = undefined;
            }
        };
        return opts;
    }

    let activeStreamUrl: string | undefined;
    let streamChangeToken = 0;

    async function handleStreamChanged(newUrl: string) {
        if (!sender) return;
        if (activeStreamUrl === newUrl) return;
        activeStreamUrl = newUrl;
        const currentToken = ++streamChangeToken;
        logger.info("Yangshipin stream changed; updating media session", {
            newUrl,
            token: currentToken
        });

        // Give the DOM a tiny tick (50ms) to ensure the active camera item (.border) is updated
        await new Promise(resolve => setTimeout(resolve, 50));
        if (currentToken !== streamChangeToken) return;

        const updatedTitle = resolveMediaTitle();
        const streamReady = Promise.resolve({
            mediaUrl: newUrl,
            title: updatedTitle
        });
        const mediaElement = pageVideo();

        if (sender.isRokuReceiver()) {
            logger.info("Yangshipin Roku stream switch: restarting Roku cast", {
                newUrl,
                title: updatedTitle
            });
            const deviceId = (sender as any).session?.receiver?.label;
            try {
                sender.stop();
            } catch (err) {
                logger.error("Yangshipin Roku stop failed", err);
            }
            sender = undefined;
            activeStreamUrl = undefined;

            if (deviceId) {
                try {
                    await browser.runtime.sendMessage({
                        subject: "yangshipin:queueReceiver",
                        data: { deviceId }
                    });
                } catch (err) {
                    logger.error("Yangshipin queueReceiver failed", err);
                }
            }

            // Give Roku ~300ms to process STOP/Home and return to Home screen
            await new Promise(resolve => setTimeout(resolve, 300));
            if (currentToken !== streamChangeToken) return;

            try {
                const nextStreamReady = Promise.resolve({
                    mediaUrl: newUrl,
                    title: updatedTitle
                });
                const nextSender = new MediaSender(
                    buildSenderOpts(nextStreamReady)
                );
                if (currentToken !== streamChangeToken) {
                    nextSender.stop();
                    return;
                }
                sender = nextSender;
                sender.prepareUpdatedMediaElement(mediaElement);
                logger.info("Yangshipin Roku re-cast started", {
                    newUrl,
                    title: updatedTitle
                });
            } catch (err) {
                logger.error("Yangshipin Roku re-cast start failed", err);
            }
            return;
        }

        sender.prepareUpdatedMediaElement(mediaElement);
        try {
            const opts = buildSenderOpts(streamReady);
            opts.mediaUrl = newUrl;
            await sender.updateMedia(opts);
            logger.info("Yangshipin media update succeeded", {
                newUrl,
                title: updatedTitle
            });
        } catch (err) {
            logger.error("Yangshipin media update failed", err);
        }
    }

    browser.runtime.onMessage.addListener(message => {
        if (
            message?.subject === "yangshipin:streamChanged" &&
            typeof message.data?.url === "string"
        ) {
            void handleStreamChanged(message.data.url);
        }
    });

    async function startCast() {
        const streamReady = resolveStream();
        logger.info("casting Yangshipin live; stream capture pending");
        sender = new MediaSender(buildSenderOpts(streamReady));
    }

    window.__fxCastYangshipin = {
        isCasting: () => Boolean(sender),
        controlPlayback: (command: PlaybackPageCommand) => {
            if (!sender) {
                return { accepted: false, error: "no-sender" };
            }
            return sender.controlPlayback(command);
        },
        reinject: () => {
            const now = Date.now();
            if (now - lastReinjectAt < 1200) {
                return {
                    status: "debounced",
                    retryAfterMs: 1200 - (now - lastReinjectAt)
                };
            }
            lastReinjectAt = now;

            if (sender) {
                try {
                    sender.stop();
                } catch (err) {
                    logger.error("Yangshipin re-cast stop failed", err);
                }
                sender = undefined;
                activeStreamUrl = undefined;
            }

            void startCast().catch(err => {
                logger.error("Yangshipin re-cast failed", err);
            });
            return { status: "started" };
        }
    };

    void startCast().catch(err => {
        logger.error("Yangshipin sender failed", err);
    });
}
