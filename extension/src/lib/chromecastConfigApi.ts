import logger from "./logger";
import { TypedStorageArea } from "./TypedStorageArea";

const ENDPOINT = "https://clients3.google.com/cast/chromecast/device";

export interface BaseConfig {
    app_tags: Array<{
        supports_audio_only: boolean;
        suports_video: boolean;
        app_id: number;
    }>;
}

export const baseConfigStorage = new TypedStorageArea<{
    baseConfig: BaseConfig;
    baseConfigUpdated: number;
}>(browser.storage.local);

/**
 * Fetches Chromecast base config data subset.
 */
export async function fetchBaseConfig(): Promise<BaseConfig | null> {
    try {
        const res = await fetch(`${ENDPOINT}/baseconfig`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = JSON.parse((await res.text()).slice(4)) as {
            app_tags?: unknown;
        };
        if (!Array.isArray(parsed.app_tags)) {
            throw new Error("Chromecast base config is missing app_tags");
        }

        // Strip other properties after validating the required shape.
        return { app_tags: parsed.app_tags as BaseConfig["app_tags"] };
    } catch (err) {
        logger.error("Failed to fetch Chromecast base config!");
        return null;
    }
}

/**
 * Get app tag from base config.
 * @param baseConfig Base config data.
 * @param appId Chromecast app ID.
 */
export function getAppTag(
    baseConfig: BaseConfig | null | undefined,
    appId: string
) {
    if (!Array.isArray(baseConfig?.app_tags)) return undefined;

    // App tag IDs are represented as 32-bit signed integers
    const signedAppId = (parseInt(appId, 16) << 32) >> 32;
    return baseConfig.app_tags.find(tag => tag.app_id === signedAppId);
}

/**
 * Fetches Chromecast app config.
 *
 * @param appId Chromecast app ID
 * @returns
 */
export async function fetchAppConfig(appId: string) {
    try {
        const res = await fetch(`${ENDPOINT}/app?a=${appId}`);
        return JSON.parse((await res.text()).slice(4));
    } catch (err) {
        logger.error("Failed to fetch Chromecast app config!", { appId });
        return null;
    }
}
