import logger from "../lib/logger";
import options from "../lib/options";
import defaultOptions from "../defaultOptions";

import { cacheUaInfo, getChromeUserAgentString } from "../lib/userAgents";
import { RemoteMatchPattern } from "../lib/matchPattern";

import { CAST_SDK_SCRIPT_URL_PATTERNS } from "../cast/urls";

// Missing on @types/firefox-webext-browser
type OnBeforeSendHeadersDetails = Parameters<
    Parameters<typeof browser.webRequest.onBeforeSendHeaders.addListener>[0]
>[0] & {
    frameAncestors?: Array<{ url: string; frameId: number }>;
};
type OnBeforeRequestDetails = Parameters<
    Parameters<typeof browser.webRequest.onBeforeRequest.addListener>[0]
>[0] & {
    frameAncestors?: Array<{ url: string; frameId: number }>;
};

export interface WhitelistItemData {
    pattern: string;
    isEnabled: boolean;
    isUserAgentDisabled?: boolean;
    customUserAgent?: string;
}

/**
 * Dynamic content script ids used for atomic replacement.
 *
 * Registration is a replacement, but ids are unique, so the new configuration
 * is registered under the spare id first and the previous one is removed only
 * after that succeeded. Registering under one fixed id would require removing
 * the live script first, and a failed register would then leave NO content
 * script at all.
 */
const WHITELIST_SCRIPT_IDS = ["whitelist-content-a", "whitelist-content-b"];
/** Id older versions used; removed once a replacement is in place. */
const LEGACY_WHITELIST_SCRIPT_ID = "whitelist-content";
/**
 * What is registered when the user's patterns are all rejected. A configuration
 * mistake must not disable the extension's own defaults.
 */
const FALLBACK_WHITELIST_PATTERNS = defaultOptions.siteWhitelist.map(
    item => item.pattern
);

/**
 * Splits configured patterns into the ones this browser accepts and the ones it
 * does not, WITHOUT registering anything.
 *
 * The validation has to happen before the live registration is touched, and
 * per pattern: one bad entry must cost only that entry. `RemoteMatchPattern` is
 * the same parser the request-time matching uses, so a pattern accepted here is
 * one the rest of the file can use.
 */
export function partitionWhitelistPatterns(patterns: string[]): {
    valid: string[];
    rejected: string[];
} {
    const valid: string[] = [];
    const rejected: string[] = [];
    for (const pattern of patterns) {
        if (valid.includes(pattern)) continue;
        try {
            new RemoteMatchPattern(pattern);
            valid.push(pattern);
        } catch {
            rejected.push(pattern);
        }
    }
    return { valid, rejected };
}

let matchPatterns: RemoteMatchPattern[] = [];

let platform: string;
let chromeUserAgent: string | undefined;
let chromeUserAgentHybrid: string | undefined;

let siteWhitelistEnabled = false;
let siteWhitelist: Nullable<WhitelistItemData[]> = null;
let customUserAgent: string | undefined;

export async function initWhitelist() {
    logger.info("init (whitelist)");

    await cacheUaInfo();

    if (!platform) {
        const browserInfo = await browser.runtime.getBrowserInfo();

        // TODO: Allow hybrid UA to be configurable
        platform = (await browser.runtime.getPlatformInfo()).os;
        chromeUserAgent = await getChromeUserAgentString(platform);
        chromeUserAgentHybrid = await getChromeUserAgentString(platform, {
            hybridFirefoxVersion: browserInfo.version
        });
        if (!chromeUserAgent) {
            throw logger.error("Failed to get Chrome UA string");
        }

        customUserAgent = await options.get("siteWhitelistCustomUserAgent");
    }

    // Register on first run
    await registerSiteWhitelist();

    options.addEventListener("changed", async ev => {
        // Update custom UA on change
        if (ev.detail.includes("siteWhitelistCustomUserAgent")) {
            customUserAgent = await options.get("siteWhitelistCustomUserAgent");
        }
        // Re-register whitelist on change
        if (
            ev.detail.includes("siteWhitelist") ||
            ev.detail.includes("siteWhitelistEnabled")
        ) {
            // No unregister first: the registration replaces itself
            // atomically, and removing the live script up front is what turned
            // one invalid pattern into "no content script at all".
            void registerSiteWhitelist().catch(err =>
                logger.error("Failed to register the site whitelist", err)
            );
        }
    });
}

/**
 * Returns the configured user agent matching the specified URL or
 * undefined if the user agent is disabled.
 */
function getUserAgent(url: string, host?: string): Optional<string> {
    if (!siteWhitelistEnabled || !siteWhitelist) return;

    // Search site-specific user agents
    const matchingItem = siteWhitelist.find(
        item =>
            item.customUserAgent &&
            new RemoteMatchPattern(item.pattern).matches(url)
    );
    if (matchingItem) {
        if (!matchingItem.isEnabled || matchingItem.isUserAgentDisabled) return;
        return matchingItem.customUserAgent;
    }

    return (
        customUserAgent ||
        (host === "www.youtube.com" ? chromeUserAgentHybrid : chromeUserAgent)
    );
}

/**
 * Override User-Agent header for requests to whitelisted URLs. Sites
 * with Chromecast support will usually only load the Cast SDK if they
 * detect a Chrome user agent string.
 */
async function onWhitelistedBeforeSendHeaders(
    details: OnBeforeSendHeadersDetails
) {
    if (!details.requestHeaders) {
        throw logger.error(
            "OnBeforeSendHeaders handler details missing requestHeaders."
        );
    }

    const host = details.requestHeaders.find(header => header.name === "Host");

    for (const header of details.requestHeaders) {
        if (header.name === "User-Agent") {
            header.value = getUserAgent(details.url, host?.value);
            break;
        }
    }

    return {
        requestHeaders: details.requestHeaders
    };
}

/**
 * Override User-Agent header for requests from child frames of
 * whitelisted URLs to support embedded players on other origins (e.g.
 * CDN domains).
 */
function onWhitelistedChildBeforeSendHeaders(
    details: OnBeforeSendHeadersDetails
) {
    if (!details.requestHeaders || !details.frameAncestors) {
        return;
    }

    for (const ancestor of details.frameAncestors) {
        // If no matching patterns
        if (!matchPatterns.some(pattern => pattern.matches(ancestor.url))) {
            continue;
        }

        // Override User-Agent header
        const requestHeaders = details.requestHeaders;
        for (const header of requestHeaders) {
            if (header.name === "User-Agent") {
                const host = requestHeaders.find(
                    header => header.name === "Host"
                );
                header.value = getUserAgent(details.url, host?.value);
                break;
            }
        }

        return { requestHeaders };
    }
}

/**
 * Handle requests to cast_sender.js SDK loader script and redirect to
 * the extension's implementation.
 */
async function onBeforeCastSDKRequest(details: OnBeforeRequestDetails) {
    if (!details.originUrl || details.tabId === -1) {
        return {};
    }

    // Test against whitelist if enabled
    if (await options.get("siteWhitelistEnabled")) {
        /**
         * Frame ancestor URLs (if present) or origin URL that the SDK
         * is loaded from.
         */
        const urls = [
            ...(details.frameAncestors?.map(ancestor => ancestor.url) ?? []),
            details.originUrl
        ];

        // Allow request if no whitelist matches
        if (
            !urls.some(url =>
                matchPatterns.some(pattern => pattern.matches(url))
            )
        ) {
            return {};
        }
    }

    await browser.scripting.executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        files: ["cast/contentBridge.js"],
        injectImmediately: true
    });

    return {
        redirectUrl: browser.runtime.getURL("cast/content.js")
    };
}

async function registerSiteWhitelist() {
    const opts = await options.getAll();
    siteWhitelist = opts.siteWhitelist;
    siteWhitelistEnabled = opts.siteWhitelistEnabled;

    // Validate BEFORE anything is registered or removed. Parsing used to throw
    // here, and the change listener had already removed the live registration,
    // so one bad pattern left every site - including the defaults - without
    // contentInitial.
    const { valid, rejected } = partitionWhitelistPatterns(
        siteWhitelist.map(item => item.pattern)
    );
    for (const pattern of rejected) {
        // Name the offender: the browser's own error only says "Invalid match
        // pattern", which tells the user nothing about WHICH entry is wrong.
        logger.warn("Rejected invalid whitelist match pattern", { pattern });
    }
    matchPatterns = valid.map(pattern => new RemoteMatchPattern(pattern));

    browser.webRequest.onBeforeRequest.addListener(
        onBeforeCastSDKRequest,
        { urls: CAST_SDK_SCRIPT_URL_PATTERNS },
        ["blocking"]
    );

    // Skip whitelist request listeners if disabled or empty. The formerly
    // registered script is removed as well: with the redirect disabled, a
    // leftover contentInitial would rewrite the SDK URL to the eureka loader
    // and the page would then be served Google's loader instead of the
    // extension's - i.e. the stale registration breaks the sites it used to
    // help.
    if (!siteWhitelistEnabled || !siteWhitelist.length) {
        await removeWhitelistContentScripts();
        return;
    }

    browser.webRequest.onBeforeSendHeaders.addListener(
        onWhitelistedBeforeSendHeaders,
        {
            // Filter for items with UA enabled
            urls: siteWhitelist.flatMap(item =>
                item.isEnabled && !item.isUserAgentDisabled
                    ? [item.pattern]
                    : []
            )
        },
        ["blocking", "requestHeaders"]
    );

    browser.webRequest.onBeforeSendHeaders.addListener(
        onWhitelistedChildBeforeSendHeaders,
        { urls: ["<all_urls>"] },
        ["blocking", "requestHeaders"]
    );

    // A configuration mistake must not disable the extension's own defaults.
    const matches = valid.length ? valid : FALLBACK_WHITELIST_PATTERNS;
    if (!valid.length) {
        logger.warn(
            "Every whitelist pattern was rejected; registering the defaults",
            { patterns: siteWhitelist.map(item => item.pattern) }
        );
    }

    const registeredIds = new Set(
        (await browser.scripting.getRegisteredContentScripts()).map(
            script => script.id
        )
    );
    const nextId =
        WHITELIST_SCRIPT_IDS.find(id => !registeredIds.has(id)) ??
        WHITELIST_SCRIPT_IDS[0];

    // If both IDs are already registered (e.g. from an interrupted replacement
    // or unregistration failure in a previous session), free nextId first so
    // registering it won't throw "already registered". The other ID remains
    // registered, so at least one content script stays active throughout.
    if (registeredIds.has(nextId)) {
        try {
            await browser.scripting.unregisterContentScripts({ ids: [nextId] });
            registeredIds.delete(nextId);
        } catch {
            /* ignore */
        }
    }

    const staleIds = [
        LEGACY_WHITELIST_SCRIPT_ID,
        ...WHITELIST_SCRIPT_IDS
    ].filter(id => id !== nextId && registeredIds.has(id));

    // Register first, remove afterwards: at every instant at least one
    // configuration is live, and a failure here leaves the previous one in
    // place instead of leaving nothing.
    await browser.scripting.registerContentScripts([
        {
            id: nextId,
            matches,
            js: ["cast/contentInitial.js"],
            runAt: "document_start",
            allFrames: true
        }
    ]);

    if (staleIds.length) {
        try {
            await browser.scripting.unregisterContentScripts({
                ids: staleIds
            });
        } catch (err) {
            logger.error("Failed to remove the previous whitelist script", err);
        }
    }
}

/** Removes every id this module has ever registered. */
async function removeWhitelistContentScripts() {
    try {
        await browser.scripting.unregisterContentScripts({
            ids: [LEGACY_WHITELIST_SCRIPT_ID, ...WHITELIST_SCRIPT_IDS]
        });
    } catch {
        /* none of them registered */
    }
}
