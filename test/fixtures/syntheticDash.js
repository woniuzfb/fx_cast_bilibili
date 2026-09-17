"use strict";

/**
 * A synthetic DASH representation, laid out exactly the way both sides of the
 * capture path read one:
 *
 *   [ftyp][moov][sidx][media ...]
 *
 * The bridge walks the top-level boxes, parses `sidx` (version, timescale,
 * earliest presentation time, first_offset, reference table) and defines the
 * init bytes as everything up to the first referenced byte; the extension
 * verifies the same sidx before it will commit a replacement candidate. Both
 * harnesses that need a *page-fetched representation* build it here, so the byte
 * layout they post, the ranges they post it in, and the ranges the receivers
 * compute are the same coordinate system — and "this fragment was never
 * captured" means exactly that.
 *
 * `initEnd` is the byte offset at which media starts, i.e. the value a DASH
 * SegmentBase `indexRange` must end at (indexRange end + 1).
 */
function buildFmp4({
    segments = 12,
    segmentSeconds = 4,
    timescale = 1000,
    segmentBytes = 4096,
    /** Every fragment declared as starting with a SAP (video needs it). */
    sap = true
} = {}) {
    const ftyp = Buffer.alloc(24);
    ftyp.writeUInt32BE(24, 0);
    ftyp.write("ftyp", 4, "ascii");
    ftyp.write("isom", 8, "ascii");
    ftyp.write("isom", 16, "ascii");

    const moov = Buffer.alloc(16);
    moov.writeUInt32BE(16, 0);
    moov.write("moov", 4, "ascii");

    const references = Buffer.alloc(segments * 12);
    for (let i = 0; i < segments; i++) {
        const at = i * 12;
        references.writeUInt32BE(segmentBytes, at);
        references.writeUInt32BE(segmentSeconds * timescale, at + 4);
        references.writeUInt32BE(sap ? 0x90000000 : 0, at + 8);
    }
    const sidxSize = 32 + segments * 12;
    const sidx = Buffer.alloc(sidxSize);
    sidx.writeUInt32BE(sidxSize, 0);
    sidx.write("sidx", 4, "ascii");
    sidx[8] = 0; // version 0
    sidx.writeUInt32BE(1, 12); // reference_ID
    sidx.writeUInt32BE(timescale, 16);
    sidx.writeUInt32BE(0, 20); // earliest_presentation_time
    sidx.writeUInt32BE(0, 24); // first_offset: media starts right after sidx
    sidx.writeUInt16BE(0, 28); // reserved
    sidx.writeUInt16BE(segments, 30);
    references.copy(sidx, 32);

    const media = Buffer.alloc(segments * segmentBytes, 0x47);
    const init = Buffer.concat([ftyp, moov, sidx]);
    const body = Buffer.concat([init, media]);
    const fragments = [];
    for (let i = 0; i < segments; i++) {
        fragments.push({
            index: i,
            time: i * segmentSeconds,
            duration: segmentSeconds,
            start: init.length + i * segmentBytes,
            end: init.length + (i + 1) * segmentBytes - 1
        });
    }
    return { body, init, initEnd: init.length, total: body.length, fragments };
}

/**
 * The playurl response shape the page capture's `addRepresentations` consumes,
 * for one item: a video and an audio rendition under `folder`, each declaring
 * the SegmentBase indexRange that makes its init+sidx committable.
 */
function playurlFor({
    folder,
    videoInitEnd,
    audioInitEnd,
    /** The rendition codes this response enumerates. They are parameters
     *  because a playurl response describes what BILIBILI would serve THAT
     *  request (qn + codec preference), which is not necessarily the rendition
     *  the page's own player fetched — see the pair gate's comment. */
    videoCode = 100026,
    audioCode = 30280
}) {
    const url = (kind, initEnd, code) =>
        `https://upos-sz-estgcos.bilivideo.com/upgcxcode/26/32/${folder}/` +
        `${folder}-1-${code}.m4s?deadline=1`;
    return {
        code: 0,
        data: {
            dash: {
                video: [
                    {
                        baseUrl: url("video", videoInitEnd, videoCode),
                        SegmentBase: { indexRange: `0-${videoInitEnd - 1}` },
                        codecs: "avc1.640033",
                        width: 1920,
                        height: 1080
                    }
                ],
                audio: [
                    {
                        baseUrl: url("audio", audioInitEnd, audioCode),
                        SegmentBase: { indexRange: `0-${audioInitEnd - 1}` },
                        codecs: "mp4a.40.2"
                    }
                ]
            }
        }
    };
}

/** The CDN URL a page would request for one rendition of one item. */
function renditionUrl(folder, kind) {
    const code = kind === "video" ? 100026 : 30280;
    return (
        `https://upos-sz-estgcos.bilivideo.com/upgcxcode/26/32/${folder}/` +
        `${folder}-1-${code}.m4s?deadline=1`
    );
}

/** The per-item folder both the media URL and the pair gate key on. */
function folderPathOf(folder, kind) {
    const code = kind === "video" ? 100026 : 30280;
    return `/upgcxcode/26/32/${folder}/${folder}-1-${code}.m4s`;
}

module.exports = { buildFmp4, playurlFor, renditionUrl, folderPathOf };
