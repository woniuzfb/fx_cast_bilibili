import logger from "../lib/logger";
import options from "../lib/options";

import { MenuId } from "../menuIds";

import castManager, { CastInstanceDestroyedError } from "./castManager";
import { CCTV_LIVE_PAGE_RE, launchCctvSender } from "./cctvLive";

const _ = browser.i18n.getMessage;

const URL_PATTERN_HTTP = "http://*/*";
const URL_PATTERN_HTTPS = "https://*/*";
const URL_PATTERN_FILE = "file://*/*";

const URL_PATTERNS_REMOTE = [URL_PATTERN_HTTP, URL_PATTERN_HTTPS];
const URL_PATTERNS_ALL = [...URL_PATTERNS_REMOTE, URL_PATTERN_FILE];

/** Match patterns for the whitelist option menus. */
const whitelistChildMenuPatterns = new Map<string | number, string>();

/**
 * Monotonic counter used to correlate a single launchBilibiliSender call with
 * the selector-open events it triggers, so interleaved calls (popup auto-cast
 * racing a manual click) can be told apart in the background log.
 */
let bilibiliLaunchSeq = 0;

async function bilibiliDebug(message: string, data?: unknown) {
    if (await options.get("bilibiliDebugEnabled")) logger.info(message, data);
}

/** Handles initial menu setup. */
export async function initMenus() {
    logger.info("init (menus)");

    // Clear any existing menus from a previous event page load
    await browser.menus.removeAll();

    const opts = await options.getAll();

    // Global "Cast..." menu item
    browser.menus.create({
        id: MenuId.Cast,
        contexts: ["action", "page", "tools_menu"],
        title: _("contextCast"),
        documentUrlPatterns: ["http://*/*", "https://*/*"],
        icons: { "16": "icons/icon.svg" }
    });

    // <video>/<audio> "Cast..." context menu item
    browser.menus.create({
        id: MenuId.CastMedia,
        contexts: ["audio", "video", "image"],
        title: _("contextCast"),
        visible: opts.mediaEnabled,
        targetUrlPatterns: opts.localMediaEnabled
            ? URL_PATTERNS_ALL
            : URL_PATTERNS_REMOTE
    });

    // Whitelist menu parent item
    browser.menus.create({
        id: MenuId.Whitelist,
        contexts: ["action"],
        title: _("contextAddToWhitelist"),
        enabled: false
    });
    // Top item in the whitelist submenu, which is the recommended pattern based
    // on the current page URL and is always present.
    browser.menus.create({
        id: MenuId.WhitelistRecommended,
        title: _("contextAddToWhitelistRecommended"),
        parentId: MenuId.Whitelist
    });
    // Separator between recommended and advanced patterns
    browser.menus.create({
        id: MenuId.WhitelistSeparator,
        type: "separator",
        parentId: MenuId.Whitelist
    });

    const popupMenuProps = {
        visible: false,
        documentUrlPatterns: [`${browser.runtime.getURL("ui/popup")}/*`]
    } satisfies browser.menus._CreateCreateProperties;

    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupMediaPlayPause,
        title: _("popupMediaPlay")
    });
    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupMediaMute,
        type: "checkbox",
        title: _("popupMediaMute")
    });
    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupMediaSkipPrevious,
        title: _("popupMediaSkipPrevious")
    });
    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupMediaSkipNext,
        title: _("popupMediaSkipNext")
    });
    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupMediaCaptions,
        title: _("popupMediaSubtitlesCaptions")
    });
    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupMediaCaptionsOff,
        parentId: MenuId.PopupMediaCaptions,
        type: "radio",
        title: _("popupMediaSubtitlesCaptionsOff")
    });

    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupMediaSeparator,
        type: "separator"
    });

    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupCast,
        title: _("popupCastButtonTitle"),
        icons: { 16: "icons/icon.svg" }
    });
    browser.menus.create({
        ...popupMenuProps,
        id: MenuId.PopupStop,
        title: _("popupStopButtonTitle")
    });

    browser.menus.onShown.addListener(onMenuShown);
    browser.menus.onClicked.addListener(onMenuClicked);

    options.addEventListener("changed", async ev => {
        const alteredOpts = ev.detail;
        const newOpts = await options.getAll();

        if (MenuId.CastMedia && alteredOpts.includes("mediaEnabled")) {
            browser.menus.update(MenuId.CastMedia, {
                visible: newOpts.mediaEnabled
            });
        }
        if (MenuId.CastMedia && alteredOpts.includes("localMediaEnabled")) {
            browser.menus.update(MenuId.CastMedia, {
                targetUrlPatterns: newOpts.localMediaEnabled
                    ? URL_PATTERNS_ALL
                    : URL_PATTERNS_REMOTE
            });
        }
    });
}

/** Handle updating menus when shown. */
async function onMenuShown(info: browser.menus._OnShownInfo) {
    // Only rebuild menus if whitelist menu present
    if (info.menuIds.includes(MenuId.Whitelist)) {
        updateWhitelistMenu(info.pageUrl);
        return;
    }
}

/** Handle menu click events */
async function onMenuClicked(
    info: browser.menus.OnClickData,
    tab?: browser.tabs.Tab
) {
    // Handle whitelist menus
    if (info.parentMenuItemId === MenuId.Whitelist) {
        const pattern = whitelistChildMenuPatterns.get(info.menuItemId);
        if (!pattern) {
            throw logger.error(
                `Whitelist pattern not found for menu item ID ${info.menuItemId}.`
            );
        }
        const whitelist = await options.get("siteWhitelist");
        if (!whitelist.find(item => item.pattern === pattern)) {
            // Add to whitelist and update options
            whitelist.push({ pattern, isEnabled: true });
            await options.set("siteWhitelist", whitelist);
        }
        return;
    }

    if (tab?.id !== undefined) {
        switch (info.menuItemId) {
            case MenuId.Cast: {
                if (
                    /^https:\/\/(?:www|m)\.bilibili\.com\/video\//.test(
                        tab.url ?? ""
                    )
                ) {
                    await launchBilibiliSender(tab.id);
                } else if (CCTV_LIVE_PAGE_RE.test(tab.url ?? "")) {
                    await launchCctvSender(tab.id);
                } else {
                    castManager.triggerCast(tab.id, info.frameId);
                }
                break;
            }

            case MenuId.CastMedia: {
                if (info.srcUrl) {
                    const frameIds = info.frameId ? [info.frameId] : undefined;
                    await browser.scripting.executeScript({
                        target: { tabId: tab.id, frameIds },
                        func: (
                            mediaUrl: string,
                            targetElementId: number | undefined
                        ) => {
                            (window as any).mediaUrl = mediaUrl;
                            (window as any).targetElementId = targetElementId;
                        },
                        args: [info.srcUrl, info.targetElementId]
                    });
                    await browser.scripting.executeScript({
                        target: { tabId: tab.id, frameIds },
                        files: ["cast/senders/media.js"]
                    });
                }
                break;
            }
        }
    }
}

async function reinjectBilibiliSender(tabId: number, seq: number) {
    const [reinjectResult] = await browser.scripting.executeScript({
        target: { tabId },
        func: (() => (window as any).__fxCastBilibili?.reinject()) as any
    });
    const result = reinjectResult?.result as
        | { status?: "started" | "debounced"; retryAfterMs?: number }
        | undefined;
    if (result?.status === "debounced") {
        const retryAfterMs = Math.max(0, Number(result.retryAfterMs) || 0) + 25;
        void bilibiliDebug("Bilibili reinject debounced; retrying", {
            seq,
            tabId,
            retryAfterMs
        });
        await new Promise(resolve => setTimeout(resolve, retryAfterMs));
        await browser.scripting.executeScript({
            target: { tabId },
            func: (() => (window as any).__fxCastBilibili?.reinject()) as any
        });
    }
    void bilibiliDebug("Bilibili reinject dispatched", {
        seq,
        tabId,
        status: result?.status
    });
}

export async function launchBilibiliSender(tabId: number, quality = 0) {
    const seq = ++bilibiliLaunchSeq;
    const debugEnabled = await options.get("bilibiliDebugEnabled");
    void bilibiliDebug("Bilibili cast requested", {
        seq,
        tabId,
        t: Date.now()
    });
    try {
        // Probe the tab: is the sender injected, and is it currently casting?
        // Returns "absent" | "casting" | "idle".
        const probe = await browser.scripting.executeScript({
            target: { tabId },
            func: (() => {
                const api = (window as any).__fxCastBilibili;
                if (!api) return "absent";
                return api.isCasting?.() ? "casting" : "idle";
            }) as any
        });
        const state = probe.find(result => typeof result.result === "string")
            ?.result as "absent" | "casting" | "idle" | undefined;
        if (state !== "absent") {
            await browser.scripting.executeScript({
                target: { tabId },
                func: ((selectedQuality: number, selectedDebug: boolean) => {
                    const api = (window as any).__fxCastBilibili;
                    api?.setDebug?.(selectedDebug);
                    api?.setQuality?.(selectedQuality);
                }) as any,
                args: [quality, debugEnabled]
            });
        }

        // Detailed probe trace: which branch this launch takes. Pair the `seq`
        // with the subsequent "Opening receiver selector" log to see whether this
        // launch is the one that clobbered a good (App) selector with the generic
        // device-only view.
        void bilibiliDebug("Bilibili probe result", {
            seq,
            tabId,
            state,
            rawResults: probe.map(r => r.result)
        });

        if (state === "casting") {
            // A cast is already running. Open the receiver selector so the popup can
            // show the running session with a Stop button. The Stop button depends on
            // the owned session id being sent to the popup (getReceiverSelection now
            // includes connectedTransportIds in the selector's initial state), NOT on
            // availableMediaTypes, so it appears even though the generic path exposes
            // no App media for Bilibili.
            void bilibiliDebug(
                "Bilibili sender already casting; opening selector",
                {
                    seq,
                    tabId
                }
            );
            try {
                await castManager.triggerCast(tabId);
                void bilibiliDebug(
                    "Bilibili casting-branch triggerCast returned",
                    {
                        seq,
                        tabId
                    }
                );
            } catch (error) {
                if (!(error instanceof CastInstanceDestroyedError)) throw error;
                void bilibiliDebug(
                    "Bilibili cast instance disappeared; restarting page sender",
                    { seq, tabId }
                );
                await reinjectBilibiliSender(tabId, seq);
            }
            return;
        }

        if (state === "idle") {
            // Injected but not casting (e.g. the previous cast was stopped). Ask the
            // sender to re-cast: it re-runs resolve + cast.requestSession in the page,
            // which is the only path that opens a selector with real castable media
            // (a Cast button) for Bilibili. reinject() is debounced so a popup
            // auto-cast plus a manual click won't fight each other.
            void bilibiliDebug("Bilibili sender idle; re-casting", {
                seq,
                tabId
            });
            await reinjectBilibiliSender(tabId, seq);
            return;
        }

        await browser.scripting.executeScript({
            target: { tabId },
            func: ((selectedQuality: number, selectedDebug: boolean) => {
                (window as any).__fxCastBilibiliInitialQuality =
                    selectedQuality;
                (window as any).__fxCastBilibiliInitialDebug = selectedDebug;
            }) as any,
            args: [quality, debugEnabled]
        });
        const senderResults = await browser.scripting.executeScript({
            target: { tabId },
            files: ["cast/senders/bilibili.js"]
        });
        void bilibiliDebug("Bilibili sender execution result", senderResults);
    } catch (err) {
        logger.error("Failed to execute Bilibili sender", err);
        await browser.notifications.create({
            type: "basic",
            title: "fx_cast_bilibili",
            message: `Injection failed: ${
                err instanceof Error ? err.message : String(err)
            }`
        });
    }
}

/** Handles updating the whitelist menus for a given URL */
async function updateWhitelistMenu(pageUrl?: string) {
    /**
     * If page URL doesn't exist, we're not on a page and have nothing
     * to whitelist, so disable the menu and return.
     */
    if (!pageUrl) {
        browser.menus.update(MenuId.Whitelist, {
            enabled: false
        });

        browser.menus.refresh();
        return;
    }

    const url = new URL(pageUrl);
    const urlHasOrigin = url.origin !== "null";

    /**
     * If the page URL doesn't have an origin, we're not on a
     * remote page and have nothing to whitelist, so disable the
     * menu and return.
     */
    if (!urlHasOrigin) {
        browser.menus.update(MenuId.Whitelist, {
            enabled: false
        });

        browser.menus.refresh();
        return;
    }

    // Enable the whitelist menu
    browser.menus.update(MenuId.Whitelist, {
        enabled: true
    });

    for (const [menuId] of whitelistChildMenuPatterns) {
        // Clear all page-specific temporary menus
        if (menuId !== MenuId.WhitelistRecommended)
            browser.menus.remove(menuId);

        whitelistChildMenuPatterns.delete(menuId);
    }

    // If there is more than one subdomain, get the base domain
    const baseDomain =
        (url.hostname.match(/\./g) || []).length > 1
            ? url.hostname.substring(url.hostname.indexOf(".") + 1)
            : url.hostname;

    const portlessOrigin = `${url.protocol}//${url.hostname}`;

    const patternRecommended = `${portlessOrigin}/*`;
    const patternSearch = `${portlessOrigin}${url.pathname}${url.search}`;
    const patternWildcardProtocol = `*://${url.hostname}/*`;
    const patternWildcardSubdomain = `${url.protocol}//*.${baseDomain}/*`;
    const patternWildcardProtocolAndSubdomain = `*://*.${baseDomain}/*`;

    // Update recommended menu item
    browser.menus.update(MenuId.WhitelistRecommended, {
        title: _("contextAddToWhitelistRecommended", patternRecommended)
    });
    whitelistChildMenuPatterns.set(
        MenuId.WhitelistRecommended,
        patternRecommended
    );

    if (url.search) {
        whitelistChildMenuPatterns.set(
            browser.menus.create({
                id: MenuId.WhitelistSearch,
                title: _("contextAddToWhitelistAdvancedAdd", patternSearch),
                parentId: MenuId.Whitelist
            }),
            patternSearch
        );
    }

    /**
     * Split URL path into segments and add menu items for each
     * partial path as the segments are removed.
     */
    {
        const pathTrimmed = url.pathname.endsWith("/")
            ? url.pathname.substring(0, url.pathname.length - 1)
            : url.pathname;

        const pathSegments = pathTrimmed
            .split("/")
            .filter(segment => segment)
            .reverse();

        if (pathSegments.length) {
            for (let i = 0; i < pathSegments.length; i++) {
                const partialPath = pathSegments.slice(i).reverse().join("/");

                const pattern = `${portlessOrigin}/${partialPath}/*`;

                const partialPathMenuId = `${MenuId.WhitelistPath}-${i}`;
                browser.menus.create({
                    id: partialPathMenuId,
                    title: _("contextAddToWhitelistAdvancedAdd", pattern),
                    parentId: MenuId.Whitelist
                });

                whitelistChildMenuPatterns.set(partialPathMenuId, pattern);
            }
        }
    }

    whitelistChildMenuPatterns.set(
        browser.menus.create({
            id: MenuId.WhitelistWildcardProtocol,
            title: _(
                "contextAddToWhitelistAdvancedAdd",
                patternWildcardProtocol
            ),
            parentId: MenuId.Whitelist
        }),
        patternWildcardProtocol
    );

    whitelistChildMenuPatterns.set(
        browser.menus.create({
            id: MenuId.WhitelistWildcardSubdomain,
            title: _(
                "contextAddToWhitelistAdvancedAdd",
                patternWildcardSubdomain
            ),
            parentId: MenuId.Whitelist
        }),
        patternWildcardSubdomain
    );
    whitelistChildMenuPatterns.set(
        browser.menus.create({
            id: MenuId.WhitelistWildcardProtocolAndSubdomain,
            title: _(
                "contextAddToWhitelistAdvancedAdd",
                patternWildcardProtocolAndSubdomain
            ),
            parentId: MenuId.Whitelist
        }),
        patternWildcardProtocolAndSubdomain
    );

    await browser.menus.refresh();
}
