import logger from "../lib/logger";
import options from "../lib/options";
import bridge, { type BridgeInfo } from "../lib/bridge";
import { baseConfigStorage, fetchBaseConfig } from "../lib/chromecastConfigApi";

import defaultOptions from "../defaultOptions";
import messaging from "../messaging";

import castManager from "./castManager";
import deviceManager from "./deviceManager";

import { initAction } from "./action";
import { initMenus, launchBilibiliSender } from "./menus";
import {
    CCTV_LIVE_PAGE_RE,
    initCctvLive,
    launchCctvSender,
    setCctvLiveQuality
} from "./cctvLive";
import { initWhitelist } from "./whitelist";
import { initBleRemote } from "./bleRemote";
import { cacheUaInfo } from "../lib/userAgents";

const _ = browser.i18n.getMessage;

/**
 * On install, set the default options before initializing the
 * extension. On update, handle any unset values and set to the new
 * defaults.
 */
browser.runtime.onInstalled.addListener(async details => {
    switch (details.reason) {
        case "install": {
            // Set defaults
            await options.setAll(defaultOptions);

            // Extension initialization
            init();
            break;
        }

        case "update": {
            // Set new defaults
            await options.update(defaultOptions);
            break;
        }
    }
});

/**
 * Checks whether the bridge can be reached and is compatible with the
 * current version of the extension. If not, triggers a notification
 * with the appropriate info.
 */
async function notifyBridgeCompat() {
    logger.info("checking for bridge...");

    let info: BridgeInfo;
    try {
        info = await bridge.getInfo();
    } catch (err) {
        logger.info("... bridge issue!");
        return;
    }

    if (info.isVersionCompatible) {
        logger.info("... bridge compatible!");
    } else {
        logger.info("... bridge incompatible!");

        const updateNotificationId = await browser.notifications.create({
            type: "basic",
            title: `${_("extensionName")} — ${_(
                "optionsBridgeIssueStatusTitle"
            )}`,
            message: info.isVersionOlder
                ? _("optionsBridgeOlderAction")
                : _("optionsBridgeNewerAction")
        });

        browser.notifications.onClicked.addListener(notificationId => {
            if (notificationId !== updateNotificationId) {
                return;
            }

            browser.tabs.create({
                url: `https://github.com/woniuzfb/fx_cast_bilibili`
            });
        });
    }
}

/**
 * Updates locally-stored base config data if never downloaded or since
 * expired.
 */
async function cacheBaseConfig() {
    const { baseConfigUpdated } = await baseConfigStorage.get(
        "baseConfigUpdated"
    );

    // If never updated or updated more than 48 hours ago
    if (
        !baseConfigUpdated ||
        (Date.now() - baseConfigUpdated) / 1000 >= 172800
    ) {
        logger.info("Fetching updated Chromecast base config...");
        const baseConfig = await fetchBaseConfig();
        if (baseConfig) {
            await baseConfigStorage.set({
                baseConfig,
                baseConfigUpdated: Date.now()
            });
        }
    }
}

let isInitialized = false;

async function init() {
    if (isInitialized) {
        return;
    }

    /**
     * If options haven't been set yet, we can't properly initialize,
     * so wait until init is called again in the onInstalled listener.
     */
    if (!(await options.getAll())) {
        return;
    }

    logger.info("init");
    isInitialized = true;

    await notifyBridgeCompat();

    await deviceManager.init();
    await castManager.init();

    await initAction();
    await initMenus();
    await initWhitelist();
    initBleRemote();
    initCctvLive();

    // Surface popup debug logs in the background console. The browser-action
    // popup can't be inspected directly, so Popup.svelte forwards its debug
    // lines here via runtime.sendMessage({ subject: "popup:debugLog" }).
    browser.runtime.onMessage.addListener(message => {
        if (message?.subject !== "popup:debugLog") return;
        void options.get("bilibiliDebugEnabled").then(enabled => {
            if (!enabled) return;
            logger.info(
                "[popup] " + String(message?.data?.message),
                message?.data?.data ?? {}
            );
        });
    });

    // Sender/content-script consoles are separate from the extension
    // background console. Forward CCTV recovery diagnostics here so a single
    // background-console export contains both recovery decisions and relay logs.
    browser.runtime.onMessage.addListener((message, sender) => {
        if (message?.subject !== "cctv:recoveryDebug") return;
        if (sender.tab?.id === undefined) return;
        const level = message?.data?.level === "error" ? "error" : "info";
        const text = "[cctv recovery] " + String(message?.data?.message ?? "");
        const data = {
            tabId: sender.tab.id,
            ...(message?.data?.data ?? {})
        };
        if (level === "error") logger.error(text, data);
        else logger.info(text, data);
    });

    browser.runtime.onMessage.addListener(message => {
        if (message?.subject !== "action:castCurrentTab") return;

        return (async () => {
            const [tab] = await browser.tabs.query({
                active: true,
                currentWindow: true
            });
            if (tab.id === undefined) {
                logger.error("No active tab found for browser-action Cast");
                return;
            }
            if (message.data?.selection) {
                castManager.queueReceiverSelection(
                    tab.id,
                    message.data.selection
                );
            }
            if (
                /^https:\/\/(?:www|m)\.bilibili\.com\/video\//.test(
                    tab.url ?? ""
                )
            ) {
                await launchBilibiliSender(
                    tab.id,
                    Number(message.data?.quality) || 0
                );
            } else if (CCTV_LIVE_PAGE_RE.test(tab.url ?? "")) {
                await launchCctvSender(
                    tab.id,
                    Number(message.data?.quality) || 0
                );
            } else {
                await castManager.triggerCast(tab.id);
            }
        })().catch(err => {
            logger.error("Browser-action Cast failed", err);
            throw err;
        });
    });

    browser.runtime.onMessage.addListener(message => {
        if (message?.subject !== "action:setBilibiliQuality") return;
        void (async () => {
            const [tab] = await browser.tabs.query({
                active: true,
                currentWindow: true
            });
            if (tab.id === undefined) return;
            await browser.scripting.executeScript({
                target: { tabId: tab.id },
                func: ((quality: number) => {
                    (window as any).__fxCastBilibili?.setQuality?.(quality);
                }) as any,
                args: [Number(message.data?.quality) || 0]
            });
        })().catch(err => logger.error("Bilibili quality change failed", err));
    });

    browser.runtime.onMessage.addListener(message => {
        if (message?.subject !== "action:setCctvQuality") return;
        void (async () => {
            const [tab] = await browser.tabs.query({
                active: true,
                currentWindow: true
            });
            if (tab.id === undefined) return;
            await setCctvLiveQuality(
                tab.id,
                Number(message.data?.quality) || 0
            );
        })().catch(err => logger.error("CCTV quality change failed", err));
    });

    messaging.onMessage.addListener(message => {
        switch (message.subject) {
            case "main:refreshDeviceManager":
                deviceManager.refresh();
                break;
        }
    });
}

cacheUaInfo();
cacheBaseConfig();
init();
