#!/usr/bin/env node
"use strict";
/**
 * Windowing reverse proxy in front of the bridge's DASH remux server, for
 * validating the live-window-middle theory of the early-cast LOAD failure.
 *
 * The Chromecast joins a no-ENDLIST EVENT playlist at the MIDDLE of the
 * available window and rejects LOAD positions before that join point. This
 * proxy keeps the advertised window small enough that the start position is
 * always past the middle: it reveals the first segment immediately, then one
 * more segment per segment-duration of wall clock (a 1x drip, like the Roku
 * path's windowing).
 *
 * Usage: node window-proxy.js <bridgeBaseUrl> <listenPort> <revealSeconds> [runwaySegments] [injectPads]
 *   revealSeconds: the position the receiver will LOAD at (must stay past the
 *   window middle).
 *   runwaySegments: cap the visible media past the position to this many 5s
 *   segments (default 12, mirroring ROKU_DASH_PREBUFFER_SEGMENTS), dripping
 *   one more segment per 4s of wall clock after the first playlist fetch.
 *   Pass -1 to serve the upstream playlist verbatim (passthrough bisection:
 *   isolates proxy HTTP mechanics from the windowing rewrite).
 *   injectPads: prepend this many 4s bridge pad.ts entries to the playlist
 *   (for the early-cast fix validation: pads push the LOAD position past the
 *   window middle; the caller must LOAD at revealSeconds + injectPads*4).
 */
const http = require("http");

const bridgeBase = process.argv[2];
const listenPort = Number(process.argv[3]);
const revealSeconds = Number(process.argv[4]);
const runwaySegments = Number(process.argv[5] || 12);
const injectPads = Number(process.argv[6] || 0);
const PAD_SECONDS = 4;
const SEGMENT_SECONDS = 5;
const DRIP_SECONDS = 4;
const generation = (() => {
    const parts = new URL(bridgeBase).pathname.split("/");
    return parts[1] === "s" ? parts[2] : "";
})();

const startedAt = Date.now();
// The drip clock only starts when the receiver first asks for the playlist:
// the cast app can take ~7s to (re)launch, and letting the window grow during
// that delay pushes the middle past the start position (observed: a mid cast
// at 1435 failed once the playlist grew to 3345s, middle 1672 > 1435).
let anchoredAt = null;
let padCount = 0;

function log(...parts) {
    console.log(
        `${new Date().toISOString().slice(11, 23)} [proxy] ${parts.join(" ")}`
    );
}

function parseEntries(body) {
    const lines = body.split("\n");
    const headers = [];
    const entries = [];
    let pendingExtinf;
    for (const line of lines) {
        if (line.startsWith("#EXTINF:")) {
            pendingExtinf = Number(line.slice(8, -1));
        } else if (/\.ts(\?|$)/.test(line)) {
            entries.push({ duration: pendingExtinf ?? 0, file: line });
            pendingExtinf = undefined;
        } else if (line.startsWith("#")) {
            headers.push(line);
        }
    }
    return { headers, entries };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    // bridgeBase is the full playlist URL; upstream requests must use its
    // ORIGIN plus the incoming path, not concatenate both paths.
    const bridgeOrigin = new URL(bridgeBase).origin;
    const proxy = (headers = {}) => {
        const upstream = http.get(
            `${bridgeOrigin}${req.url}`,
            { headers },
            upstreamRes => {
                // Buffer and reply with an explicit Content-Length: the
                // bridge never uses chunked transfer, and the Chromecast's
                // player stack may not tolerate it.
                const chunks = [];
                upstreamRes.on("data", c => chunks.push(c));
                upstreamRes.on("end", () => {
                    const body = Buffer.concat(chunks);
                    res.writeHead(upstreamRes.statusCode, {
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "no-store",
                        "Content-Type":
                            upstreamRes.headers["content-type"] ?? "video/mp2t",
                        "Content-Length": body.length
                    });
                    res.end(req.method === "HEAD" ? undefined : body);
                });
            }
        );
        upstream.on("error", err => {
            log(`upstream error ${err.message}`);
            if (!res.headersSent) res.writeHead(502);
            res.end();
        });
    };

    if (url.pathname.endsWith(".m3u8")) {
        http.get(`${bridgeOrigin}${req.url}`, upstreamRes => {
            let body = "";
            upstreamRes.on("data", c => (body += c));
            upstreamRes.on("end", () => {
                if (runwaySegments < 0) {
                    // Passthrough: proxy mechanics only, no windowing.
                    log(`playlist passthrough: ${body.length} bytes`);
                    res.writeHead(200, {
                        "Access-Control-Allow-Origin": "*",
                        "Cache-Control": "no-store",
                        "Content-Type": "application/x-mpegURL",
                        "Content-Length": Buffer.byteLength(body)
                    });
                    res.end(body);
                    return;
                }
                const { headers, entries } = parseEntries(body);
                if (anchoredAt === null) anchoredAt = Date.now();
                const elapsed = (Date.now() - anchoredAt) / 1000;
                const allEntries = injectPads > 0
                    ? [
                          ...Array.from({ length: injectPads }, () => ({
                              duration: PAD_SECONDS,
                              file: `pad.ts?g=${generation}`
                          })),
                          ...entries
                      ]
                    : entries;
                const revealTotal = revealSeconds + injectPads * PAD_SECONDS;
                // Acceptance rule (validated on-device): the seek target must
                // land at or after the END of the window's middle segment.
                // Keep the visible end below 2x the position (middle-segment
                // bound, -6s for the middle segment's own tail), and also cap
                // the runway past the position (Roku-style windowing) so the
                // 50-238x remux cannot push the middle past the position.
                const capByMiddle = 2 * revealTotal - 6;
                const capByRunway =
                    revealTotal +
                    (runwaySegments + Math.floor(elapsed / DRIP_SECONDS)) *
                        SEGMENT_SECONDS;
                const visibleEnd = Math.min(capByMiddle, capByRunway);
                const lines = [...headers];
                let shown = 0;
                let total = 0;
                for (const entry of allEntries) {
                    if (total + entry.duration > visibleEnd) break;
                    lines.push(`#EXTINF:${entry.duration.toFixed(6)},`);
                    lines.push(entry.file);
                    total += entry.duration;
                    shown++;
                }
                const body2 = lines.join("\n") + "\n";
                log(
                    `playlist: ${shown}/${entries.length} entries (${total.toFixed(1)}s visible, middle ${(total / 2).toFixed(1)}s)`
                );
                res.writeHead(200, {
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store",
                    "Content-Type": "application/x-mpegURL",
                    "Content-Length": Buffer.byteLength(body2)
                });
                res.end(body2);
            });
        }).on("error", () => {
            res.writeHead(502).end();
        });
        return;
    }

    log(`forward ${url.pathname}`);
    proxy();
});

server.listen(listenPort, "0.0.0.0", () =>
    log(`proxying ${bridgeBase} on :${listenPort}, reveal from ${revealSeconds}s`)
);
