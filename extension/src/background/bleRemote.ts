import logger from "../lib/logger";
import options from "../lib/options";

const RECONNECT_DELAY_MS = 2000;
type BleRemoteAction = "seek_backward" | "seek_forward" | "pause" | "play";
let initialized = false;

async function debugLog(message: string, data?: unknown) {
    if (!(await options.get("bilibiliDebugEnabled"))) return;
    logger.info(`[BLE remote] ${message}`, data ?? {});
}

async function controlActiveBilibiliTab(action: BleRemoteAction) {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab.id === undefined || !tab.url) {
        await debugLog("ignored: no active tab", { action });
        return;
    }
    let hostname: string;
    try { hostname = new URL(tab.url).hostname; } catch {
        await debugLog("ignored: invalid active tab URL", { action, url: tab.url });
        return;
    }
    if (hostname !== "bilibili.com" && !hostname.endsWith(".bilibili.com")) {
        await debugLog("ignored: active tab is not Bilibili", { action, hostname });
        return;
    }

    const backwardSeconds = Math.max(
        1,
        Number(await options.get("bleRemoteSeekBackwardSeconds")) || 30
    );
    const forwardSeconds = Math.max(
        1,
        Number(await options.get("bleRemoteSeekForwardSeconds")) || 30
    );
    const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (
            remoteAction: BleRemoteAction,
            seekBackwardSeconds: number,
            seekForwardSeconds: number
        ) => {
            const castApi = (window as any).__fxCastBilibili;
            if (castApi?.isCasting?.()) {
                return {
                    target: "page-sync",
                    result: castApi.controlFromBleRemote?.(
                        remoteAction,
                        seekBackwardSeconds,
                        seekForwardSeconds
                    )
                        ? "applied"
                        : "rejected"
                };
            }

            const videos = Array.from(document.querySelectorAll("video"));
            const video = videos.sort((left, right) => {
                const l = left.getBoundingClientRect();
                const r = right.getBoundingClientRect();
                return r.width * r.height - l.width * l.height;
            })[0];
            if (!video) return { target: "page", result: "no-video" };
            switch (remoteAction) {
                case "seek_backward":
                    video.currentTime = Math.max(0, video.currentTime - seekBackwardSeconds);
                    break;
                case "seek_forward": {
                    const target = video.currentTime + seekForwardSeconds;
                    video.currentTime = Number.isFinite(video.duration)
                        ? Math.min(video.duration, target) : target;
                    break;
                }
                case "pause": video.pause(); break;
                case "play": void video.play(); break;
            }
            return {
                target: "page",
                result: "applied",
                currentTime: video.currentTime,
                paused: video.paused
            };
        },
        args: [action, backwardSeconds, forwardSeconds]
    });
    await debugLog("action handled", { action, tabId: tab.id, results });
}

let activeStreamController: AbortController | undefined;

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

async function handleStreamLine(line: string) {
    if (!line.trim()) return;
    let message: any;
    try {
        message = JSON.parse(line);
    } catch (error) {
        await debugLog("skipped malformed line", {
            line,
            error: errorMessage(error)
        });
        return;
    }
    await debugLog("message", message);
    if (message?.type !== "BLE_REMOTE") return;
    if (!["seek_backward", "seek_forward", "pause", "play"].includes(message.action)) return;
    try {
        await controlActiveBilibiliTab(message.action as BleRemoteAction);
    } catch (error) {
        await debugLog("action failed", {
            action: message.action,
            error: errorMessage(error)
        });
    }
}

async function consumeEventStream() {
    for (;;) {
        try {
            if (!(await options.get("bleRemoteEnabled"))) {
                await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
                continue;
            }
            const configuredUrl = await options.get("bleRemoteUrl");
            const debug = await options.get("bilibiliDebugEnabled");
            const url = new URL(configuredUrl);
            if (debug) url.searchParams.set("debug", "1");
            const controller = new AbortController();
            activeStreamController = controller;
            try {
                await debugLog("connecting", { url: url.toString() });
                const response = await fetch(url.toString(), {
                    cache: "no-store",
                    signal: controller.signal
                });
                await debugLog("response", { status: response.status, ok: response.ok });
                if (!response.ok || !response.body) {
                    throw new Error(`BLE event stream HTTP ${response.status}`);
                }
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let pending = "";
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) {
                        pending += decoder.decode();
                        await handleStreamLine(pending);
                        break;
                    }
                    pending += decoder.decode(value, { stream: true });
                    const lines = pending.split("\n");
                    pending = lines.pop() ?? "";
                    for (const line of lines) await handleStreamLine(line);
                }
                await debugLog("stream ended");
            } finally {
                if (activeStreamController === controller) {
                    activeStreamController = undefined;
                }
            }
        } catch (error) {
            await debugLog("stream disconnected", { error: errorMessage(error) });
        }
        await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
}

export function initBleRemote() {
    if (initialized) return;
    initialized = true;
    options.addEventListener("changed", event => {
        if (
            event.detail.includes("bleRemoteEnabled") ||
            event.detail.includes("bleRemoteUrl")
        ) {
            activeStreamController?.abort();
        }
    });
    void debugLog("initialized");
    void consumeEventStream();
}
