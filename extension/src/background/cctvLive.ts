import logger from "../lib/logger";
import { getChromeUserAgentString } from "../lib/userAgents";

import castManager, { CastInstanceDestroyedError } from "./castManager";
import {
    handleCapturedCctvTsSegment,
    isCctvPageCaptureActive,
    isCctvPageCaptureHeartbeatOnly
} from "./cctvPageCapture";

/**
 * Resolve the real Chrome UA string (from the cached/bundled docs/ua.json)
 * for this platform, to hand to the bridge's live HLS relay. CCTV's CDNs
 * (volcfcdn / kcdnvip / wscdns …) can throttle or route an unrecognized
 * client to slow edges; presenting the same Chrome UA the site expects
 * keeps segment delivery fast. Best-effort: undefined if unavailable.
 */
async function resolveChromeUserAgent(): Promise<string | undefined> {
    try {
        const { os } = await browser.runtime.getPlatformInfo();
        return await getChromeUserAgentString(os);
    } catch (err) {
        logger.error("CCTV: failed to resolve Chrome UA", err);
        return undefined;
    }
}

/**
 * CCTV live (tv.cctv.com/live/*) casting support.
 *
 * The live page resolves its HLS stream through
 * `vdnx.live.cntv.cn/api/v3/vdn/live`, which requires an `auth-key` header
 * computed by the site's obfuscated player JS, so the extension cannot call
 * that API directly. The resulting playlists/segments on the CDN
 * (liveplay.myqcloud.com / v.kcdnvip.com) are served without any auth,
 * though — and the player re-fetches the media playlist every few seconds.
 * So instead of replicating the API signing, we capture the playlist URL
 * straight off the tab's network traffic via webRequest.
 *
 * The captured URL is then cast through the bridge's live HLS relay
 * (`hlsLive` remote proxy): Chromecast devices hardcode public DNS and may
 * resolve the Chinese CDNs to slow/wrong edge nodes, which makes direct
 * playback of a small-window live playlist rebuffer forever. The relay
 * rewrites playlists and proxies segments through this machine.
 */

/** Page URLs this module handles, e.g. https://tv.cctv.com/live/cctv5/ */
export const CCTV_LIVE_PAGE_RE = /^https:\/\/tv\.cctv\.com\/live\//;

/** Max time to wait for the player to request a playlist. */
const CAPTURE_TIMEOUT_MS = 12000;

function isMasterPlaylist(raw: string): boolean {
    return /^#EXT-X-STREAM-INF:.*(?:^|,)RESOLUTION=\d+x\d+(?:,|$)/im.test(raw);
}

/**
 * Requested resolution cap per tab, in lines of height (0 = auto/highest).
 * Stored as the height itself — unlike Bilibili's quality codes, CCTV master
 * playlists advertise plain RESOLUTION values, so the popup's <option> values
 * map 1:1.
 */
const cctvQualityByTab = new Map<number, number>();

interface MasterVariant {
    url: string;
    bandwidth: number;
    height?: number;
}

function parseMasterVariants(raw: string, masterUrl: string): MasterVariant[] {
    const lines = raw.split("\n");
    const variants: MasterVariant[] = [];
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i]?.match(/^#EXT-X-STREAM-INF:(.+)$/i);
        if (!match) continue;
        const attrs = match[1] ?? "";
        const uri = lines
            .slice(i + 1)
            .find(
                candidate =>
                    candidate.trim() && !candidate.trim().startsWith("#")
            );
        if (!uri) continue;
        const bandwidth =
            Number(attrs.match(/(?:^|,)BANDWIDTH=(\d+)/i)?.[1]) || 0;
        const height =
            Number(attrs.match(/(?:^|,)RESOLUTION=\d+x(\d+)/i)?.[1]) ||
            undefined;
        variants.push({
            url: new URL(uri.trim(), masterUrl).href,
            bandwidth,
            height
        });
    }
    return variants;
}

function pickMasterVariant(
    variants: MasterVariant[],
    requestedHeight: number
): MasterVariant | undefined {
    const candidates = requestedHeight
        ? variants.filter(
              variant =>
                  variant.height !== undefined &&
                  variant.height <= requestedHeight
          )
        : variants;
    const pool = (candidates.length ? candidates : variants).sort(
        (a, b) => b.bandwidth - a.bandwidth
    );
    return pool[0];
}

function selectMasterVariant(
    raw: string,
    masterUrl: string,
    requestedHeight: number
): string {
    const best = pickMasterVariant(
        parseMasterVariants(raw, masterUrl),
        requestedHeight
    );
    if (!best) throw new Error("Master playlist has no variants");
    return best.url;
}

/**
 * The page player's quality-menu label for a master variant height. The site
 * labels its rungs 1080/720/540/480/360 — note 1024x576 is called 540, NOT
 * 576 — and the DOM items follow as `resolution_item_<label>_player`.
 */
const PAGE_LABEL_BY_HEIGHT: Record<number, string> = {
    2160: "2160",
    1080: "1080",
    720: "720",
    576: "540",
    480: "480",
    360: "360"
};

function pageQualityLabel(height: number): string {
    return PAGE_LABEL_BY_HEIGHT[height] ?? String(height);
}

/**
 * Listen for .m3u8 requests issued by the given tab and resolve with the
 * playlist the player is actually playing — identified by being requested
 * repeatedly (live playlist refresh), not by its filename. (CCTV's backup
 * CDN serves its MEDIA playlist at `index.m3u8?BR=...`, so filename-based
 * "master playlist" heuristics misfire.) Rejects when nothing shows up
 * within the timeout (e.g. the player has not started or the channel is
 * DRM/rights-blocked).
 */
interface CapturedMasterPlaylist {
    url: string;
    raw: string;
}

const cctvLiveTabs = new Set<number>();
const capturedMasterByTab = new Map<number, CapturedMasterPlaylist>();
const masterWaitersByTab = new Map<
    number,
    Set<(captured: CapturedMasterPlaylist) => void>
>();

function publishCapturedMaster(
    tabId: number,
    captured: CapturedMasterPlaylist
) {
    rememberPlaylistHost(tabId, captured.url);
    rememberCdrmldSeed(tabId, captured.url);
    capturedMasterByTab.set(tabId, captured);
    const waiters = masterWaitersByTab.get(tabId);
    if (!waiters) return;
    masterWaitersByTab.delete(tabId);
    for (const resolve of waiters) resolve(captured);
}

const capturedMediaByTab = new Map<number, { url: string; at: number }>();
const lastLoggedMediaUrlByTab = new Map<number, string>();
/** Playlist hosts the page itself used lately (newest last). */
const capturedHostsByTab = new Map<number, string[]>();

function rememberPlaylistHost(tabId: number, url: string) {
    try {
        const host = new URL(url).host;
        const hosts = capturedHostsByTab.get(tabId) ?? [];
        if (!hosts.includes(host)) {
            hosts.push(host);
            while (hosts.length > 6) hosts.shift();
            capturedHostsByTab.set(tabId, hosts);
        }
    } catch {
        /* not a URL we can use */
    }
}

/**
 * cdrmld delivery bases (host + directory prefix, WITHOUT the channel
 * directory) the page itself used, newest per tab. The CDN serves the whole
 * channel family under one base — swapping the channel directory name in a
 * base observed for any channel yields the working master for the channel
 * being cast. This is how the relay follows the page's CDN instead of a
 * hardcoded one.
 */
const cdrmldSeedByTab = new Map<number, { baseUrl: string; at: number }>();

function rememberCdrmldSeed(tabId: number, url: string) {
    try {
        const parsed = new URL(url);
        // /<dir>/cdrmld<channel>_1/index.m3u8 -> keep everything BEFORE the
        // channel directory; the cast channel's own directory is substituted in.
        const dirMatch = parsed.pathname.match(
            /^(.*\/)cdrmld[a-z0-9]+_1\/index\.m3u8$/i
        );
        if (dirMatch) {
            cdrmldSeedByTab.set(tabId, {
                baseUrl: parsed.origin + dirMatch[1].replace(/\/$/, ""),
                at: Date.now()
            });
        }
    } catch {
        /* not a URL we can use */
    }
}

/**
 * The page player refreshes its MEDIA playlist every few seconds; the latest
 * capture is the variant it is ACTUALLY playing. Its own quality choice (ABR
 * or site default) can differ from the master's max-bandwidth variant, and a
 * mismatched seed makes the relay fetch a variant the page never plays while
 * every page-captured segment is rejected as foreign.
 */
function publishCapturedMedia(tabId: number, url: string) {
    rememberPlaylistHost(tabId, url);
    rememberCdrmldSeed(tabId, url);
    capturedMediaByTab.set(tabId, { url, at: Date.now() });
}

/**
 * Wait for the master response captured while the CCTV channel page loads.
 * No request is issued here: the response listener below tees the page's
 * original response bytes back to the page while retaining a text copy.
 */
function captureLivePlaylist(tabId: number): Promise<CapturedMasterPlaylist> {
    const cached = capturedMasterByTab.get(tabId);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
        const waiters = masterWaitersByTab.get(tabId) ?? new Set();
        const timer = setTimeout(() => {
            const current = masterWaitersByTab.get(tabId);
            current?.delete(wrappedResolve);
            if (current?.size === 0) masterWaitersByTab.delete(tabId);
            reject(
                new Error(
                    "No cached master playlist with RESOLUTION for this CCTV page"
                )
            );
        }, CAPTURE_TIMEOUT_MS);
        const wrappedResolve = (captured: CapturedMasterPlaylist) => {
            clearTimeout(timer);
            resolve(captured);
        };
        waiters.add(wrappedResolve);
        masterWaitersByTab.set(tabId, waiters);
    });
}

const CCTV_MASTER_WINDOW_MESSAGE = "fx-cast-cctv-master-playlist";

function installCctvMasterXhrHook() {
    if ((window as any).__fxCastCctvMasterXhrHook) return;
    (window as any).__fxCastCctvMasterXhrHook = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: any[]
    ) {
        const absoluteUrl = new URL(String(url), location.href).href;
        if (/\.m3u8(?:[?#]|$)/i.test(absoluteUrl)) {
            this.addEventListener("load", () => {
                if (this.responseType && this.responseType !== "text") return;
                const raw = this.responseText;
                // Route by playlist kind: masters carry STREAM-INF+RESOLUTION; media
                // playlists are rolling windows of EXTINF segments. The media
                // playlist is what the page player is actually playing.
                const kind =
                    /^#EXT-X-STREAM-INF:.*(?:^|,)RESOLUTION=\d+x\d+(?:,|$)/im.test(
                        raw
                    )
                        ? "master"
                        : /^#EXTM3U/im.test(raw) && /^#EXTINF/im.test(raw)
                        ? "media"
                        : undefined;
                if (kind) {
                    window.postMessage(
                        {
                            source: CCTV_MASTER_WINDOW_MESSAGE,
                            url: this.responseURL || absoluteUrl,
                            raw,
                            kind
                        },
                        location.origin
                    );
                }
            });
        }
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    } as typeof XMLHttpRequest.prototype.open;
}

function installCctvMasterXhrBridge() {
    if ((window as any).__fxCastCctvMasterXhrBridge) return;
    (window as any).__fxCastCctvMasterXhrBridge = true;
    window.addEventListener("message", event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (
            data?.source !== CCTV_MASTER_WINDOW_MESSAGE ||
            typeof data.url !== "string" ||
            typeof data.raw !== "string" ||
            (data.kind !== "master" && data.kind !== "media")
        ) {
            return;
        }
        void browser.runtime.sendMessage({
            subject: "cctv:capturedMasterPlaylist",
            data: { url: data.url, raw: data.raw, kind: data.kind }
        });
    });
}

async function injectCctvMasterXhrFallback(tabId: number) {
    try {
        await browser.scripting.executeScript({
            target: { tabId },
            func: installCctvMasterXhrBridge,
            world: "ISOLATED",
            injectImmediately: true
        } as any);
        await browser.scripting.executeScript({
            target: { tabId },
            func: installCctvMasterXhrHook,
            world: "MAIN",
            injectImmediately: true
        } as any);
    } catch (error) {
        logger.warn("CCTV master XHR fallback injection failed", {
            tabId,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

function initMasterPlaylistResponseCapture() {
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            if (
                details.tabId < 0 ||
                !cctvLiveTabs.has(details.tabId) ||
                !/\.m3u8(\?|#|$)/i.test(details.url)
            ) {
                return;
            }
            const filterResponseData = (browser.webRequest as any)
                .filterResponseData as
                | ((requestId: string) => {
                      ondata: ((event: { data: ArrayBuffer }) => void) | null;
                      onstop: (() => void) | null;
                      onerror: (() => void) | null;
                      write(data: ArrayBuffer): void;
                      disconnect(): void;
                  })
                | undefined;
            if (!filterResponseData) return;
            let filter: ReturnType<NonNullable<typeof filterResponseData>>;
            try {
                filter = filterResponseData(details.requestId);
            } catch (error) {
                logger.warn(
                    "CCTV response filter unavailable; using XHR fallback",
                    {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    }
                );
                return;
            }
            const decoder = new TextDecoder();
            let raw = "";
            filter.ondata = event => {
                raw += decoder.decode(event.data, { stream: true });
                filter.write(event.data);
            };
            filter.onstop = () => {
                raw += decoder.decode();
                filter.disconnect();
                if (isMasterPlaylist(raw)) {
                    publishCapturedMaster(details.tabId, {
                        url: details.url,
                        raw
                    });
                    logger.info(
                        "CCTV master playlist captured from page response",
                        {
                            tabId: details.tabId,
                            url: details.url
                        }
                    );
                } else if (/^#EXTM3U/im.test(raw) && /^#EXTINF/im.test(raw)) {
                    // The player refreshes this playlist every few seconds: log only
                    // when the URL itself changes (variant/CDN switch), not per refresh.
                    const isNewUrl =
                        lastLoggedMediaUrlByTab.get(details.tabId) !==
                        details.url;
                    publishCapturedMedia(details.tabId, details.url);
                    if (isNewUrl) {
                        lastLoggedMediaUrlByTab.set(details.tabId, details.url);
                        logger.info(
                            "CCTV media playlist captured from page response",
                            {
                                tabId: details.tabId,
                                url: details.url
                            }
                        );
                    }
                }
            };
            filter.onerror = () => filter.disconnect();
        },
        {
            urls: ["*://*/*.m3u8*"],
            types: ["xmlhttprequest", "media", "other"]
        },
        ["blocking"]
    );

    void browser.tabs.query({}).then(tabs => {
        for (const tab of tabs) {
            if (tab.id !== undefined && CCTV_LIVE_PAGE_RE.test(tab.url ?? "")) {
                cctvLiveTabs.add(tab.id);
                void injectCctvMasterXhrFallback(tab.id);
            }
        }
    });
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
            capturedMasterByTab.delete(tabId);
            capturedMediaByTab.delete(tabId);
            lastLoggedMediaUrlByTab.delete(tabId);
            failedSwitchByTab.delete(tabId);
            // NOTE: cdrmldSeedByTab survives navigation on purpose — the base is
            // learned from any cdrmld playlist the page fetched and serves the
            // whole channel family, so switching channels must not drop it.
        }
        if (CCTV_LIVE_PAGE_RE.test(changeInfo.url ?? tab.url ?? "")) {
            cctvLiveTabs.add(tabId);
            if (
                changeInfo.status === "loading" ||
                changeInfo.url !== undefined
            ) {
                void injectCctvMasterXhrFallback(tabId);
            }
        } else if (changeInfo.url !== undefined) {
            cctvLiveTabs.delete(tabId);
        }
    });
    browser.tabs.onRemoved.addListener(tabId => {
        cctvLiveTabs.delete(tabId);
        capturedMasterByTab.delete(tabId);
        capturedMediaByTab.delete(tabId);
        cdrmldSeedByTab.delete(tabId);
        failedSwitchByTab.delete(tabId);
        masterWaitersByTab.delete(tabId);
    });
}

/** Resolve the castable live playlist URL captured from the tab. */
async function resolveLiveStreamUrl(tabId: number): Promise<string> {
    const enc1Error = new Error(
        "此频道使用 CCTV enc1 加密分发（视频轨混淆，音频正常），" +
            "当前解密器无法还原视频，暂不支持投屏。" +
            "The channel uses CCTV's enc1 (VMP-obfuscated video); casting is not supported."
    );

    // The page player's rung decides the cast's rung (media playlist +
    // page-captured segments), so bring the page onto the requested rung
    // BEFORE picking up its media playlist. No-op when the page is already
    // there; auto targets the ladder's highest rung.
    await ensurePageVariant(tabId, cctvQualityByTab.get(tabId) ?? 0);

    // Prefer the media playlist the page player is actually refreshing — when
    // it is NOT the enc1/AV1 delivery (its variant choice can differ from the
    // master's max-bandwidth variant, and a mismatched seed makes the relay
    // fetch a variant the page never plays).
    const media = capturedMediaByTab.get(tabId);
    if (media && !isEnc1Delivery(media.url)) {
        logger.info(
            "CCTV live stream resolved from the page's own media playlist",
            {
                tabId,
                mediaUrl: media.url
            }
        );
        return media.url;
    }

    // enc1 (or nothing captured yet): the same channels are ALSO served by the
    // legacy cdrmld (H.264) family cctvDecrypt fully supports — the web page
    // simply no longer links to it. Seed the relay from there.
    let streamId: string | undefined;
    try {
        const pageUrl = (await browser.tabs.get(tabId)).url;
        streamId = pageUrl ? liveStreamIdFromUrl(pageUrl) : undefined;
    } catch {
        /* tab gone; fall through */
    }
    if (streamId) {
        const pageHosts = [
            ...new Set(
                [
                    capturedMasterByTab.get(tabId)?.url,
                    capturedMediaByTab.get(tabId)?.url
                ]
                    .map(u => {
                        try {
                            return u ? new URL(u).host : undefined;
                        } catch {
                            return undefined;
                        }
                    })
                    .filter((host): host is string => typeof host === "string")
            )
        ];
        // Candidate cdrmld bases, best first: the SAME provider the page is
        // currently using (family-mapped from its playlist hosts), then any
        // cdrmld base the page itself fetched, then the per-channel known host,
        // then the default. Every candidate is probed before it becomes the
        // seed, and every probe is logged.
        const baseCandidates = [
            ...new Set(
                [
                    ...pageHosts.map(host => cdrmldBaseForPageHost(host)),
                    cdrmldSeedByTab.get(tabId)?.baseUrl,
                    CDRMLD_HOST_BY_STREAM_ID[streamId],
                    CDRMLD_DEFAULT_HOST
                ].filter((base): base is string => typeof base === "string")
            )
        ];
        const probes: Array<{ base: string; ok: boolean; detail: string }> = [];
        let resolved: { masterUrl: string; selected: string } | undefined;
        for (const base of baseCandidates) {
            const masterUrl = cdrmldMasterUrl(base, streamId);
            try {
                const response = await fetch(masterUrl, {
                    headers: { Referer: "https://tv.cctv.com/" },
                    cache: "no-store",
                    signal: AbortSignal.timeout(8000)
                });
                if (!response.ok) {
                    probes.push({
                        base,
                        ok: false,
                        detail: `HTTP ${response.status}`
                    });
                    continue;
                }
                const raw = await response.text();
                if (!/^#EXT-X-STREAM-INF/im.test(raw)) {
                    probes.push({
                        base,
                        ok: false,
                        detail: "not a master playlist"
                    });
                    continue;
                }
                probes.push({ base, ok: true, detail: "master playlist" });
                const selected = selectMasterVariant(
                    raw,
                    masterUrl,
                    cctvQualityByTab.get(tabId) ?? 0
                );
                resolved = { masterUrl, selected };
                break;
            } catch (err) {
                probes.push({
                    base,
                    ok: false,
                    detail: err instanceof Error ? err.message : String(err)
                });
            }
        }
        logger.info("cdrmld delivery probe trail", { tabId, streamId, probes });
        if (!resolved) {
            throw new Error(
                `此频道的 cdrmld (H.264) 交付在所有已知 CDN 上都不可用 (probed: ${probes
                    .map(p => p.detail)
                    .join("; ")})`
            );
        }
        logger.info(
            "CCTV live stream resolved via the cdrmld (H.264) delivery",
            {
                tabId,
                streamId,
                masterUrl: resolved.masterUrl,
                selected: resolved.selected
            }
        );
        return resolved.selected;
    }

    if (media) throw enc1Error;

    const captured = await captureLivePlaylist(tabId);
    const selected = selectMasterVariant(
        captured.raw,
        captured.url,
        cctvQualityByTab.get(tabId) ?? 0
    );
    if (isEnc1Delivery(selected)) throw enc1Error;
    logger.info("CCTV live stream resolved", {
        tabId,
        captured: captured.url,
        selected
    });
    return selected;
}

/**
 * CCTV's newer live delivery (hls_cdrm/enc1 on the bdydns CDN) obfuscates
 * the video elementary stream inside otherwise-plain MPEG-TS: the OBU
 * framing survives but frames/sequence data are scrambled by the page's
 * VMP-obfuscated wasm (audio is left clear, hence audio-only playback in
 * generic players). cctvDecrypt only implements the legacy CNTV transform,
 * so these channels cannot be relayed from that delivery.
 *
 * HOWEVER the same channels are also served by the legacy cdrmld (H.264)
 * family our decryptor fully supports — the web page simply no longer links
 * to it. Seed the relay from the cdrmld tree instead (verified working for
 * cctv5plus: identical decrypt diagnostics to cctv5).
 */
const CDRMLD_BITRATE_RANGE = "?b=200-2100";
const CDRMLD_DEFAULT_HOST = "https://ldocctvwbcdbyte.volcfcdn.com/ldocctvwbcd";
const CDRMLD_HOST_BY_STREAM_ID: Record<string, string> = {
    cctv1: "https://ldncctvwbcdcnc.v.wscdns.com/ldncctvwbcd",
    cctv3: "https://ldocctvwbcdks.v.kcdnvip.com/ldocctvwbcd",
    cctv5: "https://ldcctvwbcdks.v.kcdnvip.com/ldocctvwbcd",
    cctv5plus: "https://ldcctvwbcdbd.a.bdydns.com/ldcctvwbcd",
    cctv6: "https://ldocctvwbcdbd.a.bdydns.com/ldocctvwbcd",
    cctv8: "https://ldocctvwbcdks.v.kcdnvip.com/ldocctvwbcd",
    cctv13: "https://ldncctvwbcdbd.a.bdydns.com/ldncctvwbcd",
    cctv16: "https://ldcctvwbcdks.v.kcdnvip.com/ldocctvwbcd"
};

/**
 * CDN family -> the cdrmld base on the SAME provider. The page's current
 * playlist host identifies which provider it is using right now; mirroring
 * that provider keeps the relay on the same network path as the page instead
 * of pinning one hardcoded CDN.
 */
const CDRMLD_BASE_BY_CDN_FAMILY: Array<{ match: RegExp; base: string }> = [
    {
        match: /\.bdydns\.com$/i,
        base: "https://ldcctvwbcdbd.a.bdydns.com/ldcctvwbcd"
    },
    {
        match: /\.volcfcdn\.com$/i,
        base: "https://ldcctvwbcdbyte.volcfcdn.com/ldcctvwbcd"
    },
    {
        match: /\.live\.cntv\.cn$/i,
        base: "https://ldcctvwbcdtxy.liveplay.myqcloud.com/ldcctvwbcd"
    },
    {
        match: /\.liveplay\.myqcloud\.com$/i,
        base: "https://ldcctvwbcdtxy.liveplay.myqcloud.com/ldcctvwbcd"
    },
    {
        match: /\.kcdnvip\.com$/i,
        base: "https://ldcctvwbcdks.v.kcdnvip.com/ldocctvwbcd"
    },
    {
        match: /\.wscdns\.com$/i,
        base: "https://ldcctvwbcdcnc.v.wscdns.com/ldncctvwbcd"
    }
];

function cdrmldBaseForPageHost(host: string): string | undefined {
    return CDRMLD_BASE_BY_CDN_FAMILY.find(entry => entry.match.test(host))
        ?.base;
}

function cdrmldMasterUrl(base: string, streamId: string): string {
    return `${base}/cdrmld${streamId}_1/index.m3u8${CDRMLD_BITRATE_RANGE}`;
}

function liveStreamIdFromUrl(url: string): string | undefined {
    try {
        return new URL(url).pathname
            .match(/^\/live\/([a-z0-9_]+)\/?$/i)?.[1]
            ?.toLowerCase();
    } catch {
        return undefined;
    }
}

const ENC1_RE = /\/enc1(?:\/|$)/i;

function isEnc1Delivery(url: string): boolean {
    try {
        return ENC1_RE.test(new URL(url).pathname);
    } catch {
        return false;
    }
}

/** Max wait for the page player to roll its media playlist to the clicked rung. */
const PAGE_SWITCH_TIMEOUT_MS = 10000;

/**
 * Whether the page's current media playlist IS `variant`. The CCTV ladder
 * serves every rung from the SAME path and only differs by the BR parameter
 * (td/ud/hd/md), so comparing by URL string alone would match every rung.
 */
function mediaMatchesVariant(mediaUrl: string, variantUrl: string): boolean {
    try {
        const media = new URL(mediaUrl);
        const variant = new URL(variantUrl);
        if (media.pathname !== variant.pathname) return false;
        const mediaBR = media.searchParams.get("BR");
        const variantBR = variant.searchParams.get("BR");
        if (mediaBR !== null || variantBR !== null)
            return mediaBR === variantBR;
        return media.search === variant.search;
    } catch {
        return false;
    }
}

async function clickPageResolutionItem(
    tabId: number,
    label: string
): Promise<boolean> {
    try {
        const [result] = await browser.scripting.executeScript({
            target: { tabId },
            func: (label: string) => {
                const item = document.querySelector<HTMLElement>(
                    `#resolution_item_${label}_player, .resolution_item_${label}_player`
                );
                if (!item) return false;
                item.click();
                return true;
            },
            args: [label]
        } as any);
        return result?.result === true;
    } catch (error) {
        logger.warn("CCTV resolution item click failed", {
            tabId,
            label,
            error: error instanceof Error ? error.message : String(error)
        });
        return false;
    }
}

async function waitForPageMediaVariant(
    tabId: number,
    variantUrl: string
): Promise<boolean> {
    const deadline = Date.now() + PAGE_SWITCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const media = capturedMediaByTab.get(tabId);
        if (media && mediaMatchesVariant(media.url, variantUrl)) return true;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    const media = capturedMediaByTab.get(tabId);
    return media !== undefined && mediaMatchesVariant(media.url, variantUrl);
}

/**
 * Rung whose click was NOT observed to switch the page's playlist recently
 * (player ignoring synthetic clicks, or the tab was paused): retrying on
 * every resolve would re-pay the full switch wait, so suppress briefly.
 */
const failedSwitchByTab = new Map<number, { height: number; at: number }>();
const FAILED_SWITCH_RETRY_MS = 60000;

/**
 * The bridge relay mirrors the page player's own rung — its media playlist
 * refreshes AND its page-downloaded TS segments are the relay's supply past
 * the bootstrap frontier — so a resolution request can only take effect by
 * switching the PAGE's resolution. Click the player's
 * `resolution_item_<label>_player` menu item for the requested rung (mapped
 * through the page's own ladder, captured with the master playlist) and wait
 * for the player to roll its media playlist over. Auto (0) targets the
 * ladder's HIGHEST rung — same semantics as the master-path selection.
 * Best-effort: when anything mismatches the resolve keeps following
 * whatever the page is playing.
 */
async function ensurePageVariant(tabId: number, requestedHeight: number) {
    const master = capturedMasterByTab.get(tabId);
    if (!master) return;
    const variants = parseMasterVariants(master.raw, master.url);
    // Auto: highest RESOLUTION rung, not merely max bandwidth (they can
    // theoretically disagree).
    const target = requestedHeight
        ? pickMasterVariant(variants, requestedHeight)
        : variants
              .filter(variant => variant.height !== undefined)
              .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
    if (!target?.height) return;
    const current = capturedMediaByTab.get(tabId)?.url;
    if (current && mediaMatchesVariant(current, target.url)) return;
    const failed = failedSwitchByTab.get(tabId);
    if (
        failed &&
        failed.height === target.height &&
        Date.now() - failed.at < FAILED_SWITCH_RETRY_MS
    ) {
        return;
    }
    const label = pageQualityLabel(target.height);
    logger.info("CCTV page resolution switch requested", {
        tabId,
        label,
        height: target.height,
        from: current
    });
    if (!(await clickPageResolutionItem(tabId, label))) {
        logger.warn("CCTV resolution item not found on the page", {
            tabId,
            label
        });
        failedSwitchByTab.set(tabId, { height: target.height, at: Date.now() });
        return;
    }
    const switched = await waitForPageMediaVariant(tabId, target.url);
    if (switched) {
        failedSwitchByTab.delete(tabId);
        logger.info("CCTV page resolution switched", { tabId, label });
    } else {
        failedSwitchByTab.set(tabId, { height: target.height, at: Date.now() });
        logger.warn("CCTV page resolution switch not observed before timeout", {
            tabId,
            label,
            mediaUrl: capturedMediaByTab.get(tabId)?.url
        });
    }
}

/**
 * Tee `.ts` segment responses fetched by the page player into the page
 * capture pipeline (see cctvPageCapture). Same filterResponseData pattern as
 * the master playlist capture: the page's original bytes pass through
 * untouched while a copy is retained. The XHR hook fallback installed by
 * cctvPageCapture covers browsers without filterResponseData.
 */
function initTsSegmentResponseCapture() {
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            if (
                details.tabId < 0 ||
                !cctvLiveTabs.has(details.tabId) ||
                !isCctvPageCaptureActive(details.tabId) ||
                !/\.ts([?#]|$)/i.test(details.url)
            ) {
                return;
            }
            const filterResponseData = (browser.webRequest as any)
                .filterResponseData as
                | ((requestId: string) => {
                      ondata: ((event: { data: ArrayBuffer }) => void) | null;
                      onstop: (() => void) | null;
                      onerror: (() => void) | null;
                      write(data: ArrayBuffer): void;
                      disconnect(): void;
                  })
                | undefined;
            if (!filterResponseData) return;
            let filter: ReturnType<NonNullable<typeof filterResponseData>>;
            try {
                filter = filterResponseData(details.requestId);
            } catch {
                return;
            }
            // Heartbeat-only sessions (cdrmld seeds) need neither the bytes nor
            // their per-segment copy — just the notification that the page
            // downloaded this URL.
            const heartbeatOnly = isCctvPageCaptureHeartbeatOnly(details.tabId);
            const chunks: ArrayBuffer[] = [];
            filter.ondata = event => {
                if (!heartbeatOnly) chunks.push(event.data);
                filter.write(event.data);
            };
            filter.onstop = () => {
                filter.disconnect();
                if (heartbeatOnly) {
                    handleCapturedCctvTsSegment(
                        details.tabId,
                        details.url,
                        new ArrayBuffer(0)
                    );
                    return;
                }
                const total = chunks.reduce(
                    (sum, chunk) => sum + chunk.byteLength,
                    0
                );
                // Concatenate into an exactly-sized ArrayBuffer (the capture pipeline
                // carries ArrayBuffer so fetch's BodyInit accepts it on every TS
                // version; see cctvPageCapture).
                const buffer = new ArrayBuffer(total);
                const view = new Uint8Array(buffer);
                let offset = 0;
                for (const chunk of chunks) {
                    view.set(new Uint8Array(chunk), offset);
                    offset += chunk.byteLength;
                }
                handleCapturedCctvTsSegment(details.tabId, details.url, buffer);
            };
            filter.onerror = () => filter.disconnect();
        },
        { urls: ["*://*/*.ts*"], types: ["xmlhttprequest", "media", "other"] },
        ["blocking"]
    );
}

/** Handles `cctv:resolveStreamUrl` messages from the injected page sender. */
export function initCctvLive() {
    initMasterPlaylistResponseCapture();
    initTsSegmentResponseCapture();
    browser.runtime.onMessage.addListener((message, sender) => {
        if (message?.subject === "cctv:capturedMasterPlaylist") {
            const tabId = sender.tab?.id;
            const { url, raw, kind } = message.data ?? {};
            if (
                tabId !== undefined &&
                cctvLiveTabs.has(tabId) &&
                typeof url === "string" &&
                typeof raw === "string"
            ) {
                if (kind === "media") {
                    if (/^#EXTM3U/im.test(raw) && /^#EXTINF/im.test(raw)) {
                        publishCapturedMedia(tabId, url);
                        logger.info(
                            "CCTV media playlist captured by XHR fallback",
                            {
                                tabId,
                                url
                            }
                        );
                    }
                } else if (isMasterPlaylist(raw)) {
                    publishCapturedMaster(tabId, { url, raw });
                    logger.info(
                        "CCTV master playlist captured by XHR fallback",
                        {
                            tabId,
                            url
                        }
                    );
                }
            }
            return;
        }
        if (message?.subject === "cctv:capturedTsSegment") {
            // XHR fallback path (MAIN world -> ISOLATED world -> here): binary
            // bodies travel base64-encoded so no messaging transport assumption
            // can corrupt them.
            const tabId = sender.tab?.id;
            const { url, base64 } = message.data ?? {};
            if (
                tabId !== undefined &&
                typeof url === "string" &&
                typeof base64 === "string"
            ) {
                try {
                    const binary = atob(base64);
                    const buffer = new ArrayBuffer(binary.length);
                    const view = new Uint8Array(buffer);
                    for (let i = 0; i < binary.length; i++) {
                        view[i] = binary.charCodeAt(i);
                    }
                    handleCapturedCctvTsSegment(tabId, url, buffer);
                } catch {
                    logger.warn("CCTV captured TS segment failed to decode", {
                        tabId
                    });
                }
            }
            return;
        }
        if (message?.subject === "cctv:getQualityChoices") {
            // Popup-originated (no sender.tab): the master playlist captured off
            // the page's own load is the ladder the popup should offer. Empty when
            // nothing is cached yet (popup falls back to the standard rungs).
            return (async () => {
                const [tab] = await browser.tabs.query({
                    active: true,
                    currentWindow: true
                });
                const master =
                    tab?.id !== undefined
                        ? capturedMasterByTab.get(tab.id)
                        : undefined;
                if (!master) return { choices: [] };
                const byHeight = new Map<number, MasterVariant>();
                for (const variant of parseMasterVariants(
                    master.raw,
                    master.url
                )) {
                    if (variant.height === undefined) continue;
                    const known = byHeight.get(variant.height);
                    if (!known || variant.bandwidth > known.bandwidth) {
                        byHeight.set(variant.height, variant);
                    }
                }
                const choices = [...byHeight.values()]
                    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
                    .flatMap(variant =>
                        variant.height === undefined
                            ? []
                            : [
                                  {
                                      height: variant.height,
                                      label: pageQualityLabel(variant.height)
                                  }
                              ]
                    );
                logger.info(
                    "CCTV quality choices served from captured master",
                    {
                        tabId: tab?.id,
                        choices
                    }
                );
                return { choices };
            })();
        }
        if (message?.subject !== "cctv:resolveStreamUrl") return;
        return (async () => {
            const tabId = sender.tab?.id;
            if (tabId === undefined) {
                return { error: "No tab associated with sender" };
            }
            try {
                const mediaUrl = await resolveLiveStreamUrl(tabId);
                const userAgent = await resolveChromeUserAgent();
                return { mediaUrl, userAgent };
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.error("CCTV live stream resolution failed", {
                    tabId,
                    reason
                });
                // Show the specific reason when the failure is actionable (e.g. the
                // enc1 delivery); fall back to the generic capture-failure message.
                await browser.notifications.create({
                    type: "basic",
                    title: "fx_cast_bilibili",
                    message: reason.startsWith("此频道")
                        ? reason
                        : browser.i18n.getMessage(
                              "errorCctvLiveUrlCaptureFailed"
                          )
                });
                return { error: reason };
            }
        })();
    });
}

async function reinjectCctvSender(tabId: number) {
    const [reinjectResult] = await browser.scripting.executeScript({
        target: { tabId },
        func: (() => (window as any).__fxCastCctv?.reinject()) as any
    });
    const result = reinjectResult?.result as
        | { status?: "started" | "debounced"; retryAfterMs?: number }
        | undefined;
    if (result?.status === "debounced") {
        const retryAfterMs = Math.max(0, Number(result.retryAfterMs) || 0) + 25;
        await new Promise(resolve => setTimeout(resolve, retryAfterMs));
        await browser.scripting.executeScript({
            target: { tabId },
            func: (() => (window as any).__fxCastCctv?.reinject()) as any
        });
    }
}

/**
 * Entry point for casting a tv.cctv.com/live/* tab. Mirrors the Bilibili
 * launch flow: probe the page sender, open the selector for a running cast,
 * re-cast when idle, inject the sender when absent.
 * `height` is the requested resolution cap (0 = auto/highest).
 */
export async function launchCctvSender(tabId: number, height = 0) {
    cctvQualityByTab.set(tabId, height);
    logger.info("CCTV live cast requested", { tabId });
    try {
        const probe = await browser.scripting.executeScript({
            target: { tabId },
            func: (() => {
                const api = (window as any).__fxCastCctv;
                if (!api) return "absent";
                return api.isCasting?.() ? "casting" : "idle";
            }) as any
        });
        const state = probe.find(result => typeof result.result === "string")
            ?.result as "absent" | "casting" | "idle" | undefined;

        if (state === "casting") {
            // A cast is already running: open the receiver selector so the popup
            // shows the session with a Stop button.
            try {
                await castManager.triggerCast(tabId);
            } catch (error) {
                if (!(error instanceof CastInstanceDestroyedError)) throw error;
                await reinjectCctvSender(tabId);
            }
            return;
        }

        if (state === "idle") {
            await reinjectCctvSender(tabId);
            return;
        }

        await browser.scripting.executeScript({
            target: { tabId },
            files: ["cast/senders/cctv.js"]
        });
    } catch (err) {
        logger.error("Failed to execute CCTV sender", err);
        await browser.notifications.create({
            type: "basic",
            title: "fx_cast_bilibili",
            message: `Injection failed: ${
                err instanceof Error ? err.message : String(err)
            }`
        });
    }
}

/**
 * Quality changed from the popup while a CCTV tab is open. The cap is stored
 * BEFORE touching the page so the re-resolve reads the new value. The page
 * player is switched onto the requested rung first (its media playlist and
 * page-downloaded TS segments feed the bridge relay, so the cast resolution
 * cannot move without moving the page's); a running cast then reloads its
 * media on the SAME session (page sender's setQuality: fresh resolve picks
 * the new variant and the bridge rebuilds its relay — no session teardown,
 * which would look like the cast just dropping). With no running cast the
 * page switch still applies, and the cap governs the next cast.
 */
export async function setCctvLiveQuality(tabId: number, height: number) {
    cctvQualityByTab.set(tabId, height);
    logger.info("CCTV quality changed", { tabId, height });
    await ensurePageVariant(tabId, height);
    try {
        const probe = await browser.scripting.executeScript({
            target: { tabId },
            func: (() => {
                const api = (window as any).__fxCastCctv;
                if (!api) return "absent";
                return api.isCasting?.() ? "casting" : "idle";
            }) as any
        });
        const state = probe.find(result => typeof result.result === "string")
            ?.result as "absent" | "casting" | "idle" | undefined;
        if (state === "casting") {
            await browser.scripting.executeScript({
                target: { tabId },
                func: (() => (window as any).__fxCastCctv?.setQuality()) as any
            });
        }
    } catch (err) {
        // No sender in the page (never cast, or navigated away): the new cap
        // applies to the next cast, nothing to reload.
        logger.info("CCTV quality change: no active cast to reload", {
            tabId,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}
