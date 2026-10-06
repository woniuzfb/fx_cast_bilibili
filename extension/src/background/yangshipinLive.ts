import logger from "../lib/logger";
import options from "../lib/options";
import { getChromeUserAgentString } from "../lib/userAgents";
import {
    YANGSHIPIN_CHANNELS_BY_PID,
    getYangshipinChannelName,
    getYangshipinChannelInfo
} from "../lib/yangshipinChannels";
import { requestYangshipinDlnaStream } from "./yangshipinApi";
import deviceManager from "./deviceManager";
import { ReceiverSelectorMediaType } from "../types";
import castManager, { CastInstanceDestroyedError } from "./castManager";
import { injectSenderFile } from "./injectSender";
import { flattenInjectionResults } from "./injectLog";

export {
    YANGSHIPIN_CHANNELS_BY_PID,
    getYangshipinChannelName,
    getYangshipinChannelInfo
};

/**
 * Page URLs for Yangshipin live streams,
 * e.g. https://w.yangshipin.cn/video?type=2&pid=610003121
 * or https://www.yangshipin.cn/tv/home?pid=600099502
 */
export const YANGSHIPIN_LIVE_PAGE_RE =
    /^https:\/\/(?:w|m|www)\.yangshipin\.cn\/(?:video\?(?=.*(?:type=2|pid=))|tv(?:\/|\?|$)|live(?:\/|\?|$))/i;

export function isYangshipinLivePage(url?: string): boolean {
    return typeof url === "string" && YANGSHIPIN_LIVE_PAGE_RE.test(url);
}

/** Max time to wait for the player to request an m3u8 playlist. */
const CAPTURE_TIMEOUT_MS = 12000;

const yangshipinLiveTabs = new Set<number>();
const pidByTab = new Map<number, string>();
const cnlidByTab = new Map<number, string>();
const cnlidByPid = new Map<string, string>();
const capturedMediaByTab = new Map<number, { url: string; at: number }>();
const mediaWaitersByTab = new Map<number, Set<(url: string) => void>>();

let cachedYangshipinUseDlna = false;
void options
    .getAll()
    .then(opts => {
        cachedYangshipinUseDlna = opts?.yangshipinUseDlna === true;
    })
    .catch(() => undefined);
options.addEventListener("changed", async () => {
    try {
        const opts = await options.getAll();
        cachedYangshipinUseDlna = opts?.yangshipinUseDlna === true;
    } catch {
        /* ignore */
    }
});

export function isYangshipinLiveTab(tabId: number): boolean {
    return yangshipinLiveTabs.has(tabId);
}

async function resolveChromeUserAgent(): Promise<string | undefined> {
    try {
        const { os } = await browser.runtime.getPlatformInfo();
        return await getChromeUserAgentString(os);
    } catch (err) {
        logger.error("Yangshipin: failed to resolve Chrome UA", err);
        return undefined;
    }
}

export function getYangshipinPlaylistRank(url: string): number {
    if (/\/(\d*4)(?:_web|_dlna)?\.m3u8/i.test(url) || /audio/i.test(url)) {
        return 1;
    }
    if (/\/(\d*3)(?:_web|_dlna)?\.m3u8/i.test(url) || /1080|fhd/i.test(url)) {
        return 100;
    }
    if (/\/(\d*2)(?:_web|_dlna)?\.m3u8/i.test(url) || /720|shd/i.test(url)) {
        return 50;
    }
    if (/\/(\d*1)(?:_web|_dlna)?\.m3u8/i.test(url) || /540|hd/i.test(url)) {
        return 20;
    }
    return 10;
}

export function getYangshipinStreamKey(url: string): string {
    const match = url.match(/\/(\d{6,})(\d)(?:_web|_dlna)?\.m3u8/i);
    if (match) {
        return match[1];
    }
    const genericMatch = url.match(/\/([^\/?#]+?)\.m3u8/i);
    return genericMatch ? genericMatch[1] : url;
}

interface LiveInfoCacheEntry {
    livepid: string;
    playurl: string;
    data: any;
    timestamp: number;
    ttlMs: number;
}

const liveInfoCacheByPid = new Map<string, LiveInfoCacheEntry>();
const LIVEINFO_CACHE_PREFIX = "fxcast_ysp_liveinfo_";

export function extractYangshipinPid(url?: string): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        return (
            parsed.searchParams.get("pid") ||
            parsed.searchParams.get("livepid") ||
            undefined
        );
    } catch {
        return undefined;
    }
}

function saveLiveInfoCache(
    pid: string,
    playurl: string,
    data?: any,
    vkeyIntervalSeconds?: number
) {
    if (!pid || !playurl) return;
    const existingCache = liveInfoCacheByPid.get(pid);
    if (
        cachedYangshipinUseDlna &&
        playurl.includes("_web.") &&
        existingCache &&
        !existingCache.playurl.includes("_web.") &&
        Date.now() - existingCache.timestamp < existingCache.ttlMs
    ) {
        return;
    }
    const ttlMs = (Number(vkeyIntervalSeconds) || 14400) * 1000;
    const entry: LiveInfoCacheEntry = {
        livepid: pid,
        playurl,
        data: data || {
            iretcode: 0,
            iretdetailcode: 0,
            playurl,
            livepid: pid,
            cnlid: 2050622703,
            defn: "fhd",
            vkey_renew_interval: Math.round(ttlMs / 1000)
        },
        timestamp: Date.now(),
        ttlMs
    };
    liveInfoCacheByPid.set(pid, entry);
    void browser.storage.local
        .set({ [LIVEINFO_CACHE_PREFIX + pid]: entry })
        .catch(() => undefined);
    logger.info("Yangshipin: cached liveinfo stream", {
        pid,
        playurl,
        ttlMinutes: Math.round(ttlMs / 60000)
    });
}

function getLiveInfoCache(pid: string): LiveInfoCacheEntry | undefined {
    const entry = liveInfoCacheByPid.get(pid);
    if (entry && Date.now() - entry.timestamp < entry.ttlMs) {
        return entry;
    }
    return undefined;
}

// Hydrate persistent liveinfo cache on background startup
void browser.storage.local.get(null).then(all => {
    for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(LIVEINFO_CACHE_PREFIX) && value) {
            const entry = value as LiveInfoCacheEntry;
            if (Date.now() - entry.timestamp < entry.ttlMs) {
                liveInfoCacheByPid.set(entry.livepid, entry);
            }
        }
    }
});

function publishCapturedMedia(tabId: number, url: string) {
    const pid =
        extractYangshipinPid(url) ||
        (tabId >= 0 ? pidByTab.get(tabId) : undefined);
    if (pid) {
        saveLiveInfoCache(pid, url);
    }
    const existing = capturedMediaByTab.get(tabId);
    if (
        cachedYangshipinUseDlna &&
        url.includes("_web.") &&
        existing &&
        !existing.url.includes("_web.")
    ) {
        return;
    }
    const newRank = getYangshipinPlaylistRank(url);
    if (existing) {
        const isSameStream =
            getYangshipinStreamKey(existing.url) ===
            getYangshipinStreamKey(url);
        if (isSameStream) {
            const existingRank = getYangshipinPlaylistRank(existing.url);
            // If existing playlist is higher quality and was captured recently (< 30s),
            // do not downgrade to a lower quality playlist for the same stream.
            if (existingRank > newRank && Date.now() - existing.at < 30000) {
                logger.info("Yangshipin: keeping higher quality playlist", {
                    tabId,
                    existingUrl: existing.url,
                    ignoredUrl: url
                });
                return;
            }
        }
    }

    capturedMediaByTab.set(tabId, { url, at: Date.now() });
    if (existing && existing.url !== url && tabId >= 0) {
        void browser.tabs
            .sendMessage(tabId, {
                subject: "yangshipin:streamChanged",
                data: { url }
            })
            .catch(() => undefined);
    }
    const waiters = mediaWaitersByTab.get(tabId);
    if (!waiters) return;
    mediaWaitersByTab.delete(tabId);
    for (const resolve of waiters) resolve(url);
}

function captureLivePlaylist(tabId: number): Promise<string> {
    const cached = capturedMediaByTab.get(tabId);
    if (cached && Date.now() - cached.at < 60000) {
        return Promise.resolve(cached.url);
    }
    return new Promise((resolve, reject) => {
        const waiters = mediaWaitersByTab.get(tabId) ?? new Set();
        const timer = setTimeout(() => {
            const current = mediaWaitersByTab.get(tabId);
            current?.delete(wrappedResolve);
            if (current?.size === 0) mediaWaitersByTab.delete(tabId);
            reject(
                new Error(
                    "No media playlist (.m3u8) captured for this Yangshipin page"
                )
            );
        }, CAPTURE_TIMEOUT_MS);
        const wrappedResolve = (url: string) => {
            clearTimeout(timer);
            resolve(url);
        };
        waiters.add(wrappedResolve);
        mediaWaitersByTab.set(tabId, waiters);
    });
}

/**
 * MAIN-world hook script injected into Yangshipin pages:
 * 1. Blocks localStorage["live-history-playtime"] to prevent preview duration accumulation.
 * 2. Intercepts setInterval to drop the 3-second preview timer in preview.modern.js.
 * 3. Injects anti-preview CSS overlay styles.
 */
function installYangshipinPageHook() {
    if ((window as any).__fxCastYangshipinHookInstalled) return;
    (window as any).__fxCastYangshipinHookInstalled = true;

    // 1. Neutralize localStorage live-history-playtime and enforce default fhd definition
    try {
        window.localStorage?.removeItem("live-history-playtime");
        const rawDefn = window.localStorage?.getItem("player-defn");
        if (
            !rawDefn ||
            rawDefn === '"auto"' ||
            rawDefn === "auto" ||
            rawDefn === '"hd"' ||
            rawDefn === "hd"
        ) {
            window.localStorage?.setItem("player-defn", JSON.stringify("fhd"));
        }

        const rawGetItem = Storage.prototype.getItem;
        const rawSetItem = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key: string, ...rest: any[]) {
            if (key === "live-history-playtime") {
                return "{}";
            }
            if (key === "player-defn") {
                const val = Reflect.apply(rawGetItem, this, [key, ...rest]);
                if (
                    !val ||
                    val === '"auto"' ||
                    val === "auto" ||
                    val === '"hd"' ||
                    val === "hd"
                ) {
                    return JSON.stringify("fhd");
                }
                return val;
            }
            return Reflect.apply(rawGetItem, this, [key, ...rest]);
        };
        Storage.prototype.setItem = function (
            key: string,
            _value: string,
            ...rest: any[]
        ) {
            if (key === "live-history-playtime") {
                return;
            }
            return Reflect.apply(rawSetItem, this, [key, _value, ...rest]);
        };
    } catch {
        /* storage hook unavailable */
    }

    // 2. Intercept setInterval to drop preview timer (handleLiveLimit)
    try {
        const rawSetInterval = window.setInterval;
        window.setInterval = function (
            handler: any,
            timeout?: any,
            ...args: any[]
        ) {
            if (typeof handler === "function") {
                try {
                    const fnStr = Function.prototype.toString.call(handler);
                    if (
                        fnStr.includes("handleLimitPreview") ||
                        fnStr.includes("setLSHistoryPlayTime")
                    ) {
                        return 999999 as any;
                    }
                } catch {
                    /* inspect failed */
                }
            }
            return Reflect.apply(rawSetInterval, window, [
                handler,
                timeout,
                ...args
            ]);
        } as typeof window.setInterval;
    } catch {
        /* timer hook unavailable */
    }

    // 3. Hide preview / VIP limit UI overlays via CSS
    try {
        const styleId = "fx-cast-ysp-anti-preview";
        if (!document.getElementById(styleId)) {
            const style = document.createElement("style");
            style.id = styleId;
            style.textContent = `
                .preview,
                .ui-vip-guide,
                .vip-guide,
                .preview-title,
                .player-preview-wrapper {
                    display: none !important;
                    visibility: hidden !important;
                    pointer-events: none !important;
                }
            `;
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {
        /* css hook unavailable */
    }

    // 4. Ensure ys-player custom element defaults to fhd
    try {
        const upgradePlayer = (player: any) => {
            if (!player) return;
            if (player.defn === "auto" || player.defn === "hd") {
                player.defn = "fhd";
            }
            if (
                player.config &&
                (player.config.defn === "auto" || player.config.defn === "hd")
            ) {
                player.config.defn = "fhd";
            }
        };

        const existing = document.querySelector("ys-player");
        if (existing) upgradePlayer(existing);

        if (typeof MutationObserver !== "undefined") {
            const observer = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (
                            node instanceof HTMLElement &&
                            node.tagName.toLowerCase() === "ys-player"
                        ) {
                            upgradePlayer(node);
                        }
                    }
                }
            });
            observer.observe(document.documentElement || document, {
                childList: true,
                subtree: true
            });
        }
    } catch {
        /* player hook unavailable */
    }
}

async function injectYangshipinHook(tabId: number) {
    try {
        await browser.scripting.executeScript({
            target: { tabId },
            func: installYangshipinPageHook,
            world: "MAIN",
            injectImmediately: true
        } as any);
    } catch (error) {
        logger.warn("Yangshipin page hook injection failed", {
            tabId,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

export function sanitizeLiveInfoUrl(rawUrl: string): {
    url: string;
    changed: boolean;
} {
    try {
        const parsed = new URL(rawUrl);
        let changed = false;
        if (
            parsed.searchParams.has("playdurantion") &&
            parsed.searchParams.get("playdurantion") !== "0"
        ) {
            parsed.searchParams.set("playdurantion", "0");
            changed = true;
        }
        const defn = parsed.searchParams.get("defn");
        if (!defn || defn === "auto" || defn === "hd") {
            parsed.searchParams.set("defn", "fhd");
            changed = true;
        }
        return { url: parsed.href, changed };
    } catch {
        return { url: rawUrl, changed: false };
    }
}

/** Intercept liveinfo API requests, strip preview limit parameter, and enforce highest quality. */
function initLiveInfoRequestSanitizer() {
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            try {
                if (details.tabId >= 0) {
                    yangshipinLiveTabs.add(details.tabId);
                }
                if (details.method === "GET") {
                    const { url, changed } = sanitizeLiveInfoUrl(details.url);
                    if (changed) {
                        logger.info("Yangshipin: sanitized liveinfo params", {
                            tabId: details.tabId,
                            url
                        });
                        return { redirectUrl: url };
                    }
                }

                // If URL was already clean/redirected, inspect and cache/substitute the response
                const filterResponseData = (browser.webRequest as any)
                    .filterResponseData as
                    | ((requestId: string) => {
                          ondata:
                              | ((event: { data: ArrayBuffer }) => void)
                              | null;
                          onstop: (() => void) | null;
                          onerror: (() => void) | null;
                          write(data: ArrayBuffer): void;
                          disconnect(): void;
                      })
                    | undefined;
                if (filterResponseData) {
                    let filter: ReturnType<
                        NonNullable<typeof filterResponseData>
                    >;
                    try {
                        filter = filterResponseData(details.requestId);
                    } catch {
                        return;
                    }
                    const decoder = new TextDecoder();
                    const encoder = new TextEncoder();
                    let responseText = "";

                    filter.ondata = event => {
                        responseText += decoder.decode(event.data, {
                            stream: true
                        });
                    };

                    filter.onstop = () => {
                        responseText += decoder.decode();
                        try {
                            let parsed: any;
                            let isJsonp = false;
                            let cbName = "";
                            const jsonpMatch = responseText.match(
                                /^([a-zA-Z0-9_$]+)\s*\(([\s\S]*)\)\s*;?\s*$/
                            );
                            if (jsonpMatch) {
                                isJsonp = true;
                                cbName = jsonpMatch[1];
                                parsed = JSON.parse(jsonpMatch[2]);
                            } else {
                                try {
                                    parsed = JSON.parse(responseText);
                                } catch {
                                    /* not JSON */
                                }
                            }

                            if (parsed && typeof parsed === "object") {
                                const pid =
                                    extractYangshipinPid(details.url) ||
                                    String(
                                        parsed.data?.livepid ||
                                            parsed.livepid ||
                                            ""
                                    ) ||
                                    (details.tabId >= 0
                                        ? pidByTab.get(details.tabId)
                                        : undefined);

                                const cnlid = String(
                                    parsed.data?.cnlid || parsed.cnlid || ""
                                );
                                if (pid && cnlid) {
                                    cnlidByPid.set(pid, cnlid);
                                    if (details.tabId >= 0) {
                                        cnlidByTab.set(details.tabId, cnlid);
                                    }
                                }

                                const playurl =
                                    parsed.data?.playurl || parsed.playurl;
                                const isSuccess =
                                    (parsed.code === 0 ||
                                        parsed.iretcode === 0) &&
                                    Boolean(playurl);

                                if (isSuccess && playurl) {
                                    const vkeyInterval =
                                        parsed.data?.vkey_renew_interval ||
                                        parsed.vkey_renew_interval;
                                    if (pid) {
                                        saveLiveInfoCache(
                                            pid,
                                            playurl,
                                            parsed,
                                            vkeyInterval
                                        );
                                    }
                                    if (details.tabId >= 0) {
                                        publishCapturedMedia(
                                            details.tabId,
                                            playurl
                                        );
                                    }
                                } else if (
                                    (parsed.code !== undefined &&
                                        parsed.code !== 0) ||
                                    (parsed.iretcode !== undefined &&
                                        parsed.iretcode !== 0)
                                ) {
                                    logger.warn(
                                        "Yangshipin liveinfo reported error; checking cache",
                                        {
                                            pid,
                                            code: parsed.code,
                                            iretcode: parsed.iretcode,
                                            msg: parsed.msg,
                                            errinfo: parsed.errinfo
                                        }
                                    );
                                    if (pid) {
                                        const cached = getLiveInfoCache(pid);
                                        if (cached) {
                                            logger.info(
                                                "Yangshipin: substituting cached liveinfo for preview limit error",
                                                {
                                                    pid,
                                                    ageMinutes: Math.round(
                                                        (Date.now() -
                                                            cached.timestamp) /
                                                            60000
                                                    ),
                                                    playurl: cached.playurl
                                                }
                                            );
                                            let substituted: string;
                                            if (isJsonp) {
                                                substituted = `${cbName}(${JSON.stringify(
                                                    cached.data
                                                )});`;
                                            } else {
                                                substituted = JSON.stringify(
                                                    cached.data
                                                );
                                            }
                                            filter.write(
                                                encoder.encode(substituted)
                                                    .buffer
                                            );
                                            filter.disconnect();
                                            if (details.tabId >= 0) {
                                                publishCapturedMedia(
                                                    details.tabId,
                                                    cached.playurl
                                                );
                                            }
                                            return;
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            logger.warn(
                                "Yangshipin: error in liveinfo response filter",
                                err
                            );
                        }

                        filter.write(encoder.encode(responseText).buffer);
                        filter.disconnect();
                    };

                    filter.onerror = () => {
                        try {
                            filter.disconnect();
                        } catch {
                            /* ignore */
                        }
                    };
                }
            } catch {
                /* invalid URL, ignore */
            }
        },
        {
            urls: [
                "*://liveinfo.yangshipin.cn/*",
                "*://bkliveinfo.yangshipin.cn/*",
                "*://player-api.yangshipin.cn/v1/player/get_live_info*"
            ],
            types: ["xmlhttprequest", "script", "other"]
        },
        ["blocking"]
    );
}

/** Capture live playlist requests (.m3u8) on Yangshipin tabs. */
function initMediaPlaylistCapture() {
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            if (details.tabId < 0 || !/\.m3u8(\?|#|$)/i.test(details.url)) {
                return;
            }
            const isYspDomain = /(?:ysp\.cctv\.cn|yangshipin\.cn)/i.test(
                details.url
            );
            if (!yangshipinLiveTabs.has(details.tabId) && !isYspDomain) {
                return;
            }
            if (isYspDomain) {
                yangshipinLiveTabs.add(details.tabId);
            }
            publishCapturedMedia(details.tabId, details.url);
            logger.info(
                "Yangshipin media playlist captured from page request",
                {
                    tabId: details.tabId,
                    url: details.url
                }
            );
        },
        {
            urls: ["*://*/*.m3u8*"],
            types: ["xmlhttprequest", "media", "other"]
        }
    );

    void browser.tabs.query({}).then(tabs => {
        for (const tab of tabs) {
            if (tab.id !== undefined && isYangshipinLivePage(tab.url)) {
                yangshipinLiveTabs.add(tab.id);
                const pid = extractYangshipinPid(tab.url);
                if (pid) {
                    pidByTab.set(tab.id, pid);
                }
                void injectYangshipinHook(tab.id);
            }
        }
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
            mediaWaitersByTab.delete(tabId);
            const currentUrl = changeInfo.url ?? tab.url;
            const pid = extractYangshipinPid(currentUrl);
            if (pid) {
                pidByTab.set(tabId, pid);
            }
            const cached = pid ? getLiveInfoCache(pid) : undefined;
            if (cached) {
                capturedMediaByTab.set(tabId, {
                    url: cached.playurl,
                    at: cached.timestamp
                });
            } else {
                capturedMediaByTab.delete(tabId);
            }
        }
        if (isYangshipinLivePage(changeInfo.url ?? tab.url)) {
            yangshipinLiveTabs.add(tabId);
            void injectYangshipinHook(tabId);
        } else if (changeInfo.url !== undefined) {
            yangshipinLiveTabs.delete(tabId);
            pidByTab.delete(tabId);
        }
    });

    browser.webNavigation.onCommitted.addListener(details => {
        if (details.frameId === 0 && isYangshipinLivePage(details.url)) {
            yangshipinLiveTabs.add(details.tabId);
            const pid = extractYangshipinPid(details.url);
            if (pid) {
                pidByTab.set(details.tabId, pid);
            }
            void injectYangshipinHook(details.tabId);
        }
    });

    browser.tabs.onRemoved.addListener(tabId => {
        yangshipinLiveTabs.delete(tabId);
        pidByTab.delete(tabId);
        cnlidByTab.delete(tabId);
        capturedMediaByTab.delete(tabId);
        mediaWaitersByTab.delete(tabId);
    });
}

async function resolveLiveStreamUrl(
    tabId: number
): Promise<{ mediaUrl: string; title?: string }> {
    let tabUrl: string | undefined;
    try {
        const tab = await browser.tabs.get(tabId);
        tabUrl = tab.url;
    } catch {
        /* ignore */
    }

    const pid =
        extractYangshipinPid(tabUrl) ||
        (tabId >= 0 ? pidByTab.get(tabId) : undefined);

    const title = getYangshipinChannelName(pid);
    const opts = await options.getAll().catch(() => ({} as any));
    const preferDlna = opts?.yangshipinUseDlna === true;

    if (preferDlna && pid) {
        // DLNA Preferred Mode:
        // 1. Check if we already have a clean unencrypted DLNA stream cached
        const cached = getLiveInfoCache(pid);
        if (
            cached &&
            !cached.playurl.includes("_web.") &&
            (cached.playurl.includes("_dlna") ||
                cached.playurl.includes("from=player"))
        ) {
            logger.info(
                "Yangshipin live stream resolved from clean DLNA cache",
                {
                    tabId,
                    pid,
                    url: cached.playurl
                }
            );
            return { mediaUrl: cached.playurl, title };
        }

        // 2. Try resolving official unencrypted DLNA stream via cKey API
        const chInfo = getYangshipinChannelInfo(pid);
        const cnlid =
            chInfo?.channelId ||
            cnlidByPid.get(pid) ||
            (tabId >= 0 ? cnlidByTab.get(tabId) : undefined);

        if (cnlid) {
            try {
                logger.info("Yangshipin: resolving DLNA stream via cKey API", {
                    pid,
                    cnlid,
                    name: chInfo?.name
                });
                const dlnaRes = await requestYangshipinDlnaStream(
                    cnlid,
                    pid,
                    chInfo?.defn || "fhd"
                );
                saveLiveInfoCache(
                    pid,
                    dlnaRes.playurl,
                    dlnaRes.data,
                    dlnaRes.vkeyIntervalSeconds
                );
                if (tabId >= 0) {
                    capturedMediaByTab.set(tabId, {
                        url: dlnaRes.playurl,
                        at: Date.now()
                    });
                }
                logger.info("Yangshipin DLNA stream resolved successfully", {
                    pid,
                    url: dlnaRes.playurl
                });
                return {
                    mediaUrl: dlnaRes.playurl,
                    title: chInfo?.name || title
                };
            } catch (dlnaErr) {
                logger.warn(
                    "Yangshipin: DLNA stream resolution failed, falling back to page capture",
                    {
                        pid,
                        error:
                            dlnaErr instanceof Error
                                ? dlnaErr.message
                                : String(dlnaErr)
                    }
                );
            }
        }
    }

    // Default Mode: WASM Web Stream Preferred (page capture)
    try {
        const url = await captureLivePlaylist(tabId);
        logger.info(
            "Yangshipin live stream resolved from page capture (WASM descrambling)",
            {
                tabId,
                url
            }
        );
        return { mediaUrl: url, title };
    } catch (err) {
        logger.warn(
            "Yangshipin: page capture timed out, attempting DLNA fallback",
            { tabId, pid }
        );
        if (pid) {
            const chInfo = getYangshipinChannelInfo(pid);
            const cnlid =
                chInfo?.channelId ||
                cnlidByPid.get(pid) ||
                (tabId >= 0 ? cnlidByTab.get(tabId) : undefined);

            if (cnlid) {
                try {
                    const dlnaRes = await requestYangshipinDlnaStream(
                        cnlid,
                        pid,
                        chInfo?.defn || "fhd"
                    );
                    saveLiveInfoCache(
                        pid,
                        dlnaRes.playurl,
                        dlnaRes.data,
                        dlnaRes.vkeyIntervalSeconds
                    );
                    return {
                        mediaUrl: dlnaRes.playurl,
                        title: chInfo?.name || title
                    };
                } catch {
                    /* ignore */
                }
            }

            const cached = getLiveInfoCache(pid);
            if (cached) {
                logger.info(
                    "Yangshipin live stream resolved from fallback persistent cache",
                    { tabId, pid, url: cached.playurl }
                );
                return { mediaUrl: cached.playurl, title };
            }
        }
        throw err;
    }
}

export function initYangshipinLive() {
    initLiveInfoRequestSanitizer();
    initMediaPlaylistCapture();

    browser.runtime.onMessage.addListener((message, sender) => {
        if (message?.subject === "yangshipin:queueReceiver") {
            const tabId = sender.tab?.id;
            const deviceId = message.data?.deviceId;
            if (tabId !== undefined && typeof deviceId === "string") {
                const device = deviceManager.getDeviceById(deviceId);
                if (device) {
                    castManager.queueReceiverSelection(tabId, {
                        device,
                        mediaType: ReceiverSelectorMediaType.App
                    });
                    logger.info("Yangshipin queued Roku receiver for re-cast", {
                        tabId,
                        deviceId
                    });
                }
            }
            return Promise.resolve({ ok: true });
        }
        if (message?.subject !== "yangshipin:resolveStreamUrl") return;
        return (async () => {
            const tabId = sender.tab?.id;
            if (tabId === undefined) {
                return { error: "No tab associated with sender" };
            }
            try {
                const { mediaUrl, title } = await resolveLiveStreamUrl(tabId);
                const userAgent = await resolveChromeUserAgent();
                return { mediaUrl, userAgent, title };
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.error("Yangshipin live stream resolution failed", {
                    tabId,
                    reason
                });
                await browser.notifications.create({
                    type: "basic",
                    title: "fx_cast_bilibili",
                    message: "Failed to capture Yangshipin live stream URL"
                });
                return { error: reason };
            }
        })();
    });
}

async function reinjectYangshipinSender(tabId: number) {
    const [reinjectResult] = await browser.scripting.executeScript({
        target: { tabId },
        func: (() => (window as any).__fxCastYangshipin?.reinject()) as any
    });
    const result = reinjectResult?.result as
        | { status?: "started" | "debounced"; retryAfterMs?: number }
        | undefined;
    if (result?.status === "debounced") {
        const retryAfterMs = Math.max(0, Number(result.retryAfterMs) || 0) + 25;
        await new Promise(resolve => setTimeout(resolve, retryAfterMs));
        await browser.scripting.executeScript({
            target: { tabId },
            func: (() => (window as any).__fxCastYangshipin?.reinject()) as any
        });
    }
}

export async function launchYangshipinSender(tabId: number) {
    logger.info("Yangshipin live cast requested", { tabId });
    try {
        const probe = await browser.scripting.executeScript({
            target: { tabId },
            func: (() => {
                const api = (window as any).__fxCastYangshipin;
                if (!api) return "absent";
                return api.isCasting?.() ? "casting" : "idle";
            }) as any
        });
        const state = probe.find(result => typeof result.result === "string")
            ?.result as "absent" | "casting" | "idle" | undefined;

        if (state === "casting") {
            try {
                await castManager.triggerCast(tabId);
            } catch (error) {
                if (!(error instanceof CastInstanceDestroyedError)) throw error;
                await reinjectYangshipinSender(tabId);
            }
            return;
        }

        if (state === "idle") {
            await reinjectYangshipinSender(tabId);
            return;
        }

        const senderResults = await injectSenderFile(
            tabId,
            "cast/senders/yangshipin.js"
        );
        logger.info(
            "Yangshipin sender execution result",
            flattenInjectionResults(senderResults)
        );
    } catch (err) {
        logger.error("Failed to execute Yangshipin sender", err);
        await browser.notifications.create({
            type: "basic",
            title: "fx_cast_bilibili",
            message: `Injection failed: ${
                err instanceof Error ? err.message : String(err)
            }`
        });
    }
}
