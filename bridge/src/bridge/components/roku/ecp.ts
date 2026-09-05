/**
 * Roku External Control Protocol (ECP) client.
 *
 * ECP is a plain-HTTP control protocol served on TCP port 8060. Every
 * command is a GET/POST on the device root; there is no authentication on
 * a local network. Reference: the QuickCast chrome-cast-extension Roku
 * implementation and Roku's public ECP docs.
 *
 * Key endpoints used here:
 *   GET  /query/device-info  XML device identity (names, model, serial)
 *   GET  /query/apps         XML list of installed channels
 *   GET  /query/media-player XML current playback state
 *   POST /launch/<appId>?<params>   Launch a channel with query params
 *   POST /keypress/<key>     Send a remote-control keypress
 */
import fetch from "node-fetch";

export const ROKU_PORT = 8060;

/** Media Assistant is a channel-store channel purpose-built for playing
 * URLs via deeplinks (u/t/videoName/videoFormat — Play On Roku compatible
 * request structure). Unlike the OEM Roku Media Player, it actually honors
 * the URL params: some OEM TV builds of app 2213 accept /launch with a 200
 * but ignore the parameters entirely and just show the channel home screen.
 * Preferred when installed; 2213 stays as the fallback for retail devices. */
export const MEDIA_ASSISTANT_APP_ID = "782875";

/** Roku Media Player is preinstalled on modern boxes; Play On Roku is the
 * older equivalent. */
export const ROKU_MEDIA_PLAYER_APP_ID = "2213";
export const PLAY_ON_ROKU_APP_ID = "15985";

/** Text extraction from ECP's small XML documents. A regex is enough here —
 * the documents are flat and machine-generated. */
function tag(xml: string, name: string): string | undefined {
    const match = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml);
    const value = match?.[1]?.trim();
    return value ? value : undefined;
}

function attr(xml: string, name: string): string | undefined {
    const match = new RegExp(`${name}="([^"]*)"`, "i").exec(xml);
    const value = match?.[1]?.trim();
    return value ? value : undefined;
}

function decodeEntities(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

const REQUEST_TIMEOUT_MS = 5000;

async function request(
    host: string,
    path: string,
    options: { method: "GET" | "POST"; timeoutMs?: number } = {
        method: "GET"
    }
): Promise<string> {
    // node-fetch supports `timeout`, but the resolved RequestInit type
    // (DOM lib / @types/node-fetch) may not declare it — assert instead.
    const init = {
        method: options.method,
        timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS
    } as unknown as Parameters<typeof fetch>[1];
    const response = await fetch(`http://${host}:${ROKU_PORT}${path}`, init);
    if (!response.ok) {
        throw new Error(
            `ECP ${options.method} ${path} -> HTTP ${response.status}`
        );
    }
    return response.text();
}

export interface RokuDeviceInfo {
    friendlyName: string;
    modelName: string;
    serialNumber?: string;
    powerMode?: string;
}

/** GET /query/device-info */
export async function queryDeviceInfo(
    host: string,
    timeoutMs?: number
): Promise<RokuDeviceInfo> {
    const xml = await request(host, "/query/device-info", {
        method: "GET",
        timeoutMs
    });
    if (!/<device-info/i.test(xml)) {
        throw new Error("not a Roku device");
    }

    return {
        friendlyName: decodeEntities(
            tag(xml, "user-device-name") ??
                tag(xml, "friendly-device-name") ??
                tag(xml, "default-device-name") ??
                `Roku (${host})`
        ),
        modelName: tag(xml, "model-name") ?? "Roku",
        serialNumber: tag(xml, "serial-number"),
        powerMode: tag(xml, "power-mode")
    };
}

/** Which installed channel can play media URLs. Preference order:
 * Media Assistant (honors URL params everywhere, incl. OEM TVs where the
 * stock Roku Media Player ignores them) -> Roku Media Player -> legacy
 * Play On Roku. Falls back to 2213 blindly when /query/apps is
 * unavailable (it ships on essentially every box). */
export async function resolvePlayerAppId(host: string): Promise<string> {
    try {
        const xml = await request(host, "/query/apps", { method: "GET" });
        if (new RegExp(`id="${MEDIA_ASSISTANT_APP_ID}"`).test(xml)) {
            return MEDIA_ASSISTANT_APP_ID;
        }
        if (new RegExp(`id="${ROKU_MEDIA_PLAYER_APP_ID}"`).test(xml)) {
            return ROKU_MEDIA_PLAYER_APP_ID;
        }
        if (new RegExp(`id="${PLAY_ON_ROKU_APP_ID}"`).test(xml)) {
            return PLAY_ON_ROKU_APP_ID;
        }
    } catch {
        // Fall through to the default below.
    }
    return ROKU_MEDIA_PLAYER_APP_ID;
}

export interface MediaPlayerState {
    state?: string;
    position?: number;
    duration?: number;
    title?: string;
    isLive?: boolean;
    buffering?: { current: number; max: number; target: number };
    streamSegment?: {
        mediaSequence?: number;
        segmentType?: string;
        timeSeconds?: number;
    };
}

function millisecondsTag(xml: string, name: string): number | undefined {
    const raw = tag(xml, name);
    if (!raw) return undefined;
    const match = /([-+]?\d+(?:\.\d+)?)\s*ms/i.exec(raw);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value / 1000 : undefined;
}

/** GET /query/media-player. When nothing is playing the state attribute is
 * "idle" and position/duration tags are absent. */
export async function queryMediaPlayer(
    host: string
): Promise<MediaPlayerState> {
    const xml = await request(host, "/query/media-player", { method: "GET" });
    const state = attr(xml, "state") ?? "idle";

    const bufferingMatch =
        /<buffering\b[^>]*\bcurrent="([^"]*)"[^>]*\bmax="([^"]*)"[^>]*\btarget="([^"]*)"[^>]*\/>/i.exec(
            xml
        );
    const buffering = bufferingMatch
        ? {
              current: Number(bufferingMatch[1]) || 0,
              max: Number(bufferingMatch[2]) || 0,
              target: Number(bufferingMatch[3]) || 0
          }
        : undefined;

    const streamSegmentMatch = /<stream_segment\b([^>]*)\/>/i.exec(xml);
    const streamSegmentAttrs = streamSegmentMatch?.[1] ?? "";
    const mediaSequenceRaw = /\bmedia_sequence="([^"]*)"/i.exec(
        streamSegmentAttrs
    )?.[1];
    const segmentTimeRaw = /\btime="([^"]*)"/i.exec(streamSegmentAttrs)?.[1];
    const streamSegment = streamSegmentMatch
        ? {
              mediaSequence:
                  mediaSequenceRaw !== undefined
                      ? Number(mediaSequenceRaw)
                      : undefined,
              segmentType: /\bsegment_type="([^"]*)"/i.exec(
                  streamSegmentAttrs
              )?.[1],
              timeSeconds:
                  segmentTimeRaw !== undefined
                      ? Number(segmentTimeRaw) || 0
                      : undefined
          }
        : undefined;

    return {
        state,
        position: millisecondsTag(xml, "position"),
        duration: millisecondsTag(xml, "duration"),
        title:
            decodeEntities(tag(xml, "title") ?? attr(xml, "title") ?? "") ||
            undefined,
        isLive: /<is_live>\s*true\s*<\/is_live>/i.test(xml),
        buffering,
        streamSegment
    };
}

/** POST /launch/<appId>?<params> */
export async function launch(
    host: string,
    appId: string,
    params: Record<string, string>
): Promise<void> {
    const search = new URLSearchParams(params).toString();
    await request(host, `/launch/${appId}${search ? `?${search}` : ""}`, {
        method: "POST",
        timeoutMs: 8000
    });
}

export interface ActiveAppInfo {
    /** Channel ID of the foreground app; undefined on the home screen. */
    id?: string;
    name: string;
}

/** GET /query/active-app — the currently foreground channel. On the home
 * screen the single <app> element carries no id and is named "Roku". */
export async function queryActiveApp(host: string): Promise<ActiveAppInfo> {
    const xml = await request(host, "/query/active-app", { method: "GET" });
    const appElement = /<app\b[^>]*>([^<]*)<\/app>/i.exec(xml);
    const id = /\sid="([^"]*)"/i.exec(appElement?.[0] ?? "")?.[1]?.trim();
    const name = appElement?.[1]?.trim();
    return {
        id: id || undefined,
        name: name ? decodeEntities(name) : "Roku"
    };
}

/** POST /keypress/<key> */
export async function keypress(host: string, key: string): Promise<void> {
    await request(host, `/keypress/${key}`, { method: "POST" });
}

/**
 * Media format mapping for the Roku Media Player launch params. The `t`
 * param selects the player tab (video/audio), the format params tell the
 * player what demuxer to use.
 */
const MEDIA_FORMATS: Record<string, ["v" | "a", string]> = {
    m3u8: ["v", "hls"],
    mpd: ["v", "dash"],
    mp4: ["v", "mp4"],
    m4v: ["v", "mp4"],
    mov: ["v", "mp4"],
    mkv: ["v", "mkv"],
    webm: ["v", "mkv"],
    ts: ["v", "mp4"],
    mp3: ["a", "mp3"],
    m4a: ["a", "m4a"],
    aac: ["a", "aac"],
    flac: ["a", "flac"],
    wav: ["a", "wav"],
    ogg: ["a", "flac"],
    oga: ["a", "flac"],
    opus: ["a", "flac"]
};

/** Picks ["v"|"a", format] for a media URL. Falls back to video/mp4 for
 * extension-less URLs (the bridge proxy serves HLS without an extension —
 * Roku's player sniffs HLS from content, but hls is the safest guess for
 * this project's proxied streams). */
export function mediaFormatFor(url: string): ["v" | "a", string] {
    const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
    return (extension && MEDIA_FORMATS[extension]) || ["v", "mp4"];
}

/** Builds the /launch params that make the resolved player channel (Media
 * Assistant or Roku Media Player) play a URL. Both accept the Play On Roku
 * param structure; unknown extras (k, audioFormat) are ignored by Media
 * Assistant. */
export function buildLaunchParams(
    url: string,
    title: string,
    startPositionSeconds?: number
): Record<string, string> {
    const [kind, format] = mediaFormatFor(url);
    const params: Record<string, string> = {
        t: kind,
        u: url,
        k: "(null)",
        videoName: title,
        videoFormat: format,
        songName: title,
        audioFormat: format
    };
    // Seek target for the DASH-remux/SEEK re-launch path. Supported by the
    // Roku Media Player channel; silently ignored by Play On Roku.
    if (startPositionSeconds && startPositionSeconds > 0) {
        params.mediaPosition = String(Math.round(startPositionSeconds));
    }
    return params;
}
