/**
 * Roku DASH remux video handling, exposed as an option on the options page
 * and persisted with the other options (browser.storage.sync).
 *
 * Every value except "copy" is passed to ffmpeg's x264 encoder as `-preset`;
 * "copy" skips the video re-encode and remuxes the representation the page
 * player selected as-is. Only x264 is offered: the remux transcodes at all
 * because older Roku devices cannot decode AV1/HEVC, and those same devices
 * black-screen when a "copy" hands them such a representation — the options
 * page spells that out in the option's description.
 *
 * Kept dependency-free so both the options bundle and the injected senders
 * can import it.
 */
export const ROKU_TRANSCODE_PRESETS = [
    "copy",
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium"
] as const;

export type RokuTranscodePreset = (typeof ROKU_TRANSCODE_PRESETS)[number];

/** Long-standing bridge default, kept when nothing is stored. */
export const DEFAULT_ROKU_TRANSCODE_PRESET: RokuTranscodePreset = "veryfast";

/** Clamp unknown/absent stored values onto the default. */
export function normalizeRokuTranscodePreset(
    value: unknown
): RokuTranscodePreset {
    return ROKU_TRANSCODE_PRESETS.includes(value as RokuTranscodePreset)
        ? (value as RokuTranscodePreset)
        : DEFAULT_ROKU_TRANSCODE_PRESET;
}
