import { Logger } from "../../lib/logger";
import MediaSender, {
    type MediaSenderOpts,
    type PagePlaybackDispatchResult,
    type PlaybackPageCommand
} from "./media";

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
        error?: string;
    }

    /**
     * Resolves the live stream URL captured off this tab's network traffic
     * by the background script.
     */
    async function resolveStream(): Promise<{
        mediaUrl: string;
        userAgent?: string;
    }> {
        const response = (await browser.runtime.sendMessage({
            subject: "yangshipin:resolveStreamUrl",
            data: {}
        })) as ResolveResponse | undefined;
        if (!response?.mediaUrl) {
            throw new Error(response?.error || "Live stream URL unavailable");
        }
        return { mediaUrl: response.mediaUrl, userAgent: response.userAgent };
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
                const ys = document.querySelector("ys-player") as any;
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
                const ys = document.querySelector("ys-player") as any;
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

    function buildSenderOpts(
        streamReady: Promise<{ mediaUrl: string; userAgent?: string }>
    ): MediaSenderOpts {
        const mediaElement = pageVideo();
        const rawTitle = document.title || "";
        const mediaTitle =
            rawTitle.replace(/[-_]央视频.*$/i, "").trim() || "央视频直播";
        return {
            mediaUrl: location.href,
            mediaUrlResolver: async () => {
                const resolved = await streamReady;
                // Keep the web page player playing concurrently (do NOT pause).
                logger.info("Yangshipin live stream ready for cast", {
                    mediaUrl: resolved.mediaUrl
                });
                return resolved;
            },
            mediaElement,
            mediaTitle,
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
            }
        };
    }

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
