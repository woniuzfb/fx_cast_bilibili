#!/usr/bin/env node
"use strict";

/**
 * DASH remux timeline, executed through the REAL bridge server.
 *
 * `test/senders/dashCastOffset.js` covers the sender half by lifting
 * mediaServer.ts's expressions out of the file, which cannot see when the pad
 * generator starts, what the readiness gate waits for, whether the pad segment
 * exists, or what the HTTP playlist really looks like. This harness answers
 * those questions by running `startRemoteMediaServer` itself, bundled from
 * source with esbuild, with two seams that are the same seams production uses:
 *
 *   FX_CAST_BILIBILI_FFMPEG         the fake ffmpeg/ffprobe executables.
 *     ffprobe  prints a fixed packet window (the probed keyframes).
 *     ffmpeg   writes an HLS EVENT playlist + segment files, and records the
 *              wall-clock moment it was spawned, which is how "pad generation
 *              runs in parallel with the probe" becomes an observable fact:
 *              a serialized implementation cannot spawn the remux before the
 *              probe has exited.
 *   FX_CAST_BILIBILI_ALLOWED_HOSTS  an extra DASH host, so the fixture URL can
 *              drive the real server without a CDN. Unset in normal runs.
 *
 * Everything else is production code: the argument construction, the pad
 * generator, ffprobe parsing, playlist rewriting, the readiness gate and the
 * HTTP serving of playlist and segments.
 *
 * Usage:
 *   node test/bridge/dashRemuxTimeline.js            # the contract
 *   node test/bridge/dashRemuxTimeline.js --pre-fix  # negative control
 *
 * The pre-fix control runs the same cases against HEAD^ and requires the
 * zero-start / parallelism / probe-fallback expectations to FAIL there.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const esbuildPath = path.join(
    repoRoot,
    "bridge/node_modules/esbuild/lib/main.js"
);
const mediaServerSource = path.join(
    repoRoot,
    "bridge/src/bridge/components/mediaServer.ts"
);
const bilibiliSource = path.join(
    repoRoot,
    "extension/src/cast/senders/bilibili.ts"
);
const mediaSenderSource = path.join(
    repoRoot,
    "extension/src/cast/senders/media.ts"
);

const argv = process.argv.slice(2);
const REVERT_TIMELINE = argv.includes("--revert-timeline");
const revIndex = argv.indexOf("--rev");
const REV = revIndex >= 0 && argv[revIndex + 1] ? argv[revIndex + 1] : "HEAD^";

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
    if (cond) {
        pass++;
        console.info("  ok   " + name);
    } else {
        fail++;
        failures.push(name);
        console.info(
            "  FAIL " + name + (detail === undefined ? "" : " :: " + detail)
        );
    }
};

/** A worktree of another revision, or the working tree. */
function resolveSources() {
    if (!argv.includes("--rev")) {
        return {
            mediaServerSource,
            bilibiliSource,
            mediaSenderSource,
            worktree: undefined
        };
    }
    const worktree = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cast-bridge-rev-")
    );
    fs.rmSync(worktree, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--detach", worktree, REV], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"]
    });
    process.on("exit", () => {
        try {
            execFileSync("git", ["worktree", "remove", "--force", worktree], {
                cwd: repoRoot,
                stdio: "ignore"
            });
        } catch {
            // A leftover worktree must not change the test result.
        }
    });
    return {
        mediaServerSource: path.join(
            worktree,
            "bridge/src/bridge/components/mediaServer.ts"
        ),
        bilibiliSource: path.join(
            worktree,
            "extension/src/cast/senders/bilibili.ts"
        ),
        mediaSenderSource: path.join(
            worktree,
            "extension/src/cast/senders/media.ts"
        ),
        worktree
    };
}

// ---------------------------------------------------------------------------
// Fake ffmpeg / ffprobe
// ---------------------------------------------------------------------------

/**
 * The fake tools. One script, two personalities (selected by its own name), so
 * the bridge's `ffmpegPath.replace(/ffmpeg$/, "ffprobe")` resolution works:
 *
 *   fake-ffprobe  writes the probe window JSON and exits after PROBE_MS.
 *   fake-ffmpeg   appends its own start time to spawns.log, writes one segment
 *                 per HLS chunk ffmpeg would close, and maintains an EVENT
 *                 playlist.
 *
 * The remux instance is told how many segments to produce and how long to keep
 * producing them (FX_FAKE_HLS_SEGMENTS / FX_FAKE_HLS_SEGMENT_MS), and the pad
 * instance is recognised by the absence of -hls_segment_filename.
 */
function writeFakeTools(dir) {
    const script = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const log = p => fs.appendFileSync(path.join(__dirname, "spawns.log"), p + "\\n");

if (name.includes("ffprobe")) {
    log("ffprobe " + Date.now());
    const keyframes = (process.env.FX_FAKE_KEYFRAMES || "0").split(",").map(Number);
    const duration = Number(process.env.FX_FAKE_DURATION || "600");
    const packets = keyframes.map(pts => ({ pts_time: String(pts), flags: "K__" }));
    // Malformed output is how the probe FAILURE case is driven.
    process.stdout.write(
        process.env.FX_FAKE_PROBE_GARBAGE === "1"
            ? "not json"
            : JSON.stringify({ packets, format: { duration: String(duration) } })
    );
    setTimeout(() => process.exit(0), Number(process.env.FX_FAKE_PROBE_MS || "600"));
} else {
    log("ffmpeg " + Date.now() + " " + (argv.includes("-hls_segment_filename") ? "remux" : "pad"));
    const outIndex = argv.indexOf("-hls_segment_filename");
    if (outIndex < 0) {
        // Pad instance: a real 4s TS would be pointless here, but the file must
        // exist for the playlist to be servable.
        const target = argv[argv.length - 1];
        fs.writeFileSync(target, Buffer.alloc(188 * 8, 0x47));
        process.exit(0);
    }
    const pattern = argv[outIndex + 1];
    const playlistPath = argv[argv.length - 1];
    const count = Number(process.env.FX_FAKE_HLS_SEGMENTS || "6");
    const segmentMs = Number(process.env.FX_FAKE_HLS_SEGMENT_MS || "120");
    const header = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:4",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:EVENT"
    ].join("\\n");
    const lines = [];
    const write = endList => {
        fs.writeFileSync(
            playlistPath,
            header + "\\n" + lines.join("\\n") + "\\n" + (endList ? "#EXT-X-ENDLIST\\n" : "")
        );
    };
    // EVERY advertised entry exists from the first write; only the files drip.
    // A real remux produces segments at 50-238x and the receiver sees a list
    // that keeps growing while its app launches, so an up-front list is the
    // faithful shape — and it is the only one that makes the served playlist
    // deterministic regardless of how long the harness took to get there.
    for (let i = 0; i < count; i++) {
        lines.push("#EXTINF:4.000000,");
        lines.push(path.basename(pattern.replace("%06d", String(i).padStart(6, "0"))));
    }
    write(false);
    let index = 0;
    const step = () => {
        const file = pattern.replace("%06d", String(index).padStart(6, "0"));
        fs.writeFileSync(file, Buffer.alloc(376, 0x47));
        index++;
        write(index >= count);
        if (index >= count) process.exit(0);
        setTimeout(step, segmentMs);
    };
    step();
    const keepAlive = setInterval(() => undefined, 1000);
    process.on("exit", () => clearInterval(keepAlive));
}
`;
    const ffmpeg = path.join(dir, "fake-ffmpeg");
    const ffprobe = path.join(dir, "fake-ffprobe");
    fs.writeFileSync(ffmpeg, script, { mode: 0o755 });
    fs.writeFileSync(ffprobe, script, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "spawns.log"), "");
    return { ffmpeg, ffprobe, spawnsLog: path.join(dir, "spawns.log") };
}

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

async function buildBridge(sourcePath) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-bridge-"));
    let entry = sourcePath;
    if (REVERT_TIMELINE) {
        // Negative control, one behavior at a time: take the CURRENT source (so
        // the harness seams still exist) and put back exactly the pre-fix
        // timeline rules — no minimum pad runway on the Chromecast path, pad
        // generation serialized behind the keyframe probe, and no window cap on
        // the advertised playlist. All three rewrites must apply: a control that
        // silently tests the fixed code would report green and mean nothing.
        const original = fs.readFileSync(sourcePath, "utf8");
        const reverted = original
            .replace(
                /Math\.max\(keyframe, CHROMECAST_MIN_PAD_SECONDS\)/,
                "keyframe"
            )
            .replace(
                /if \(useStartupPadding\) \{\n\s*requestPadSegment\(CHROMECAST_MIN_PAD_SECONDS\);\n\s*\}/,
                ""
            )
            .replace(
                /const visibleEnd = Math\.min\(capByMiddle, capByRunway\);/,
                "const visibleEnd = capByRunway;"
            );
        if (
            reverted === original ||
            reverted.includes(
                "requestPadSegment(CHROMECAST_MIN_PAD_SECONDS)"
            ) ||
            reverted.includes("Math.min(capByMiddle, capByRunway)")
        ) {
            throw new Error(
                "--revert-timeline could not rewrite the timeline rules; the patch no longer matches the source"
            );
        }
        // Written NEXT TO the original: the file's relative imports must still
        // resolve. Removed on exit.
        entry = path.join(
            path.dirname(sourcePath),
            "mediaServer.revertedControl.ts"
        );
        fs.writeFileSync(entry, reverted);
        process.on("exit", () => {
            try {
                fs.rmSync(entry, { force: true });
            } catch {
                // Best effort: a leftover file in the tree must not change the
                // test result.
            }
        });
    }
    const outfile = path.join(workDir, "mediaServer.cjs");
    const esbuild = require(esbuildPath);
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        // A source copied outside its tree (the pre-fix control) has no
        // node_modules of its own: resolve dependencies from this checkout.
        nodePaths: [path.join(repoRoot, "bridge/node_modules")]
    });
    return { module: require(outfile), workDir };
}

/** The messages the bridge sent us (Messenger stub). */
function makeMessenger() {
    const messages = [];
    return {
        messages,
        sendMessage(message) {
            messages.push(message);
        },
        waitFor(subject, requestId, timeoutMs = 20000) {
            const startedAt = Date.now();
            return new Promise((resolve, reject) => {
                const poll = () => {
                    const failed = messages.find(
                        message =>
                            message.subject === "mediaCast:mediaServerError" &&
                            message.data?.requestId === requestId
                    );
                    if (failed) {
                        return reject(
                            new Error(
                                `bridge refused the remux: ${failed.data?.message}`
                            )
                        );
                    }
                    const found = messages.find(
                        message =>
                            message.subject === subject &&
                            (!requestId ||
                                message.data?.requestId === requestId)
                    );
                    if (found) return resolve(found);
                    if (Date.now() - startedAt > timeoutMs) {
                        return reject(
                            new Error(
                                `timed out waiting for ${subject}: ${JSON.stringify(
                                    messages.map(m => m.subject)
                                )}`
                            )
                        );
                    }
                    setTimeout(poll, 25);
                };
                poll();
            });
        }
    };
}

function fetchText(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", chunk => (body += chunk));
            res.on("end", () =>
                resolve({ status: res.statusCode, body, headers: res.headers })
            );
        }).on("error", reject);
    });
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

/**
 * One bridge remux run: real startRemoteMediaServer, fake tools underneath,
 * and the resulting playlist fetched over HTTP the way a receiver would.
 */
async function runRemux(bridge, options) {
    const {
        startTime,
        keyframes = "0",
        probeMs = 600,
        probeGarbage = false,
        segments = 6,
        segmentMs = 120,
        rokuDashPrebuffer = false,
        /** Options page value: undefined = ON (the default), false = OFF. */
        startupPadding = undefined,
        fetchPlaylist = true,
        /** Receiver-app launch delay before its FIRST playlist fetch. */
        playlistFetchDelayMs = 0
    } = options;
    const tools = writeFakeTools(bridge.toolsDir);
    const messenger = makeMessenger();
    const port = await freePort();
    const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;

    process.env.FX_CAST_BILIBILI_FFMPEG = tools.ffmpeg;
    process.env.FX_CAST_BILIBILI_ALLOWED_HOSTS = "fixture.invalid";
    process.env.FX_FAKE_KEYFRAMES = keyframes;
    process.env.FX_FAKE_PROBE_MS = String(probeMs);
    process.env.FX_FAKE_HLS_SEGMENTS = String(segments);
    process.env.FX_FAKE_HLS_SEGMENT_MS = String(segmentMs);
    process.env.FX_FAKE_PROBE_GARBAGE = probeGarbage ? "1" : "0";

    const startedAt = Date.now();
    await bridge.module.startRemoteMediaServer(
        messenger,
        requestId,
        "https://fixture.invalid/video.m4s",
        "https://www.bilibili.com/video/BVtest",
        "application/x-mpegURL",
        port,
        "https://fixture.invalid/audio.m4s",
        startTime,
        false,
        undefined,
        false,
        rokuDashPrebuffer,
        undefined,
        startupPadding
    );

    const started = await messenger.waitFor(
        "mediaCast:mediaServerStarted",
        requestId
    );
    const readyAt = Date.now();
    const { localAddress, mediaPath } = started.data;
    const playlistUrl = `http://${localAddress}:${port}/${mediaPath}`;

    let playlist;
    if (fetchPlaylist) {
        // The receiver's own fetch: this exercises the rewrite + HTTP serving.
        // A delay models the receiver app's launch, during which the un-windowed
        // playlist would grow.
        if (playlistFetchDelayMs > 0) {
            await new Promise(resolve =>
                setTimeout(resolve, playlistFetchDelayMs)
            );
        }
        playlist = await fetchText(playlistUrl);
    }

    const spawns = fs
        .readFileSync(tools.spawnsLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => {
            const [tool, at, role] = line.split(" ");
            return { tool, at: Number(at), role };
        });

    // The bridge's own playlist diagnostics, parsed: the window it published is
    // a fact about the served playlist, and the server's view of it (shown /
    // total / windowEnd) is the only way to tell a window from a short list.
    // `event` is the message's field; the window numbers ride inside `details`.
    const playlistDebug = messenger.messages
        .filter(
            message =>
                message.subject === "main:dashRemuxDebug" &&
                message.data?.event === "playlist"
        )
        .map(message => {
            try {
                return JSON.parse(message.data?.details ?? "{}");
            } catch {
                return undefined;
            }
        })
        .filter(Boolean);

    const result = {
        requestId,
        data: started.data,
        playlist,
        playlistDebug,
        playlistUrl,
        port,
        spawns,
        readyMs: readyAt - startedAt,
        padPath: path.join(bridge.tempDirOf?.(requestId) ?? "", "pad.ts")
    };
    return result;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function caseOpeningCast(bridge, minPadSeconds) {
    const run = await runRemux(bridge, { startTime: 2.864, keyframes: "0" });
    const rows = segmentNames(run.playlist.body);
    check(
        "opening cast (2.864s, keyframe 0): the SERVED playlist opens with pad entries",
        rows.length > 0 && rows[0] === "pad.ts",
        JSON.stringify({ first: rows[0], count: rows.length })
    );
    check(
        "opening cast: the served playlist has the minimum runway in front of the real segments",
        countLeading(rows, "pad.ts") ===
            Math.floor(Number(run.data.padBaseSeconds) / 4),
        JSON.stringify({
            pads: countLeading(rows, "pad.ts"),
            padBase: run.data.padBaseSeconds
        })
    );
    check(
        "opening cast: presentationStartTime shifts the LOAD position past the runway",
        Math.abs(Number(run.data.presentationStartTime) - (32 + 2.864)) < 1e-6,
        JSON.stringify(run.data)
    );
    check(
        "opening cast: the pad segment is served (the runway is real, not just advertised)",
        run.playlist.body.includes("pad.ts") ? await padIsServable(run) : false
    );
    return run;
}

async function caseZeroStart(bridge) {
    const run = await runRemux(bridge, { startTime: 0, keyframes: "0" });
    const rows = segmentNames(run.playlist.body);
    check(
        "start-at-0: takes the SAME padded path as any other opening cast",
        rows.length > 0 &&
            rows[0] === "pad.ts" &&
            run.data.padBaseSeconds === 32,
        JSON.stringify({
            first: rows[0],
            padBase: run.data.padBaseSeconds,
            presentationStartTime: run.data.presentationStartTime
        })
    );
    check(
        "start-at-0: LOAD is the runway itself (page position 0 -> presentation 32)",
        Number(run.data.presentationStartTime) === 32,
        JSON.stringify(run.data)
    );
    return run;
}

async function caseMidVideo(bridge) {
    const run = await runRemux(bridge, {
        startTime: 1431.805,
        keyframes: "1431"
    });
    check(
        "mid-video (health control): pad base is the probed keyframe and the offset is 0",
        Number(run.data.padBaseSeconds) === 1431 &&
            Math.abs(Number(run.data.presentationStartTime) - 1431.805) < 1e-6,
        JSON.stringify(run.data)
    );
    check(
        "mid-video (health control): the probe result is reported as such",
        Number(run.data.probedKeyframeSeconds) === 1431,
        JSON.stringify(run.data)
    );
    return run;
}

/**
 * The window: a no-ENDLIST EVENT playlist is capped at the tail so the LOAD
 * position always stays past the window's middle. This is what keeps the
 * 50-238x remux from ballooning the list past the position during the receiver
 * app's launch delay (on-device: a mid cast failed once the list reached
 * 3345s, middle 1672 > position 1435).
 */
async function caseWindow(bridge) {
    const PRESENTATION_START = 32 + 2.864;
    const run = await runRemux(bridge, {
        startTime: 2.864,
        keyframes: "0",
        // 40 x 4s: far past both window bounds, so the served playlist is
        // truncated for a reason instead of merely being short.
        segments: 40
    });
    const served = segmentNames(run.playlist.body);
    const debug = run.playlistDebug.at(-1);
    check(
        "window: the bridge reports a Chromecast window on the served playlist",
        Boolean(debug && debug.chromecastWindowed === true),
        JSON.stringify(debug ?? run.playlistDebug)
    );
    check(
        "window: the served playlist is truncated to the window, not served whole",
        Boolean(debug) &&
            served.length === Number(debug.chromecastVisibleEntries) &&
            Number(debug.chromecastVisibleEntries) <
                Number(debug.chromecastTotalEntries),
        JSON.stringify({
            served: served.length,
            shown: debug?.chromecastVisibleEntries,
            total: debug?.chromecastTotalEntries
        })
    );
    const windowEnd = Number(debug?.chromecastWindowEnd);
    const visibleSeconds = Number(debug?.chromecastVisibleSeconds);
    // Observing from here cannot reproduce the bridge's exact elapsed time (the
    // drip starts inside the request), so the assertion is on the DISTANCE from
    // the position: it is fixed by the formula, and 0.2s of slack covers the gap
    // between the bridge's clock reading and this one. The runway bound would be
    // presentation + 60 = 94.9s — an order of magnitude outside that slack.
    const expectedWindowEnd = 2 * (PRESENTATION_START - 5);
    check(
        "window: the window end is the middle bound 2 x (position + elapsed - segment - 1), not the position + 60s runway",
        Number.isFinite(windowEnd) &&
            Math.abs(windowEnd - expectedWindowEnd) < 0.2,
        JSON.stringify({
            windowEnd,
            expectedWindowEnd,
            runwayBound: PRESENTATION_START + 60
        })
    );
    check(
        "window: exactly the entries that fit inside the window end are advertised (the rest is held back)",
        Number.isFinite(windowEnd) &&
            visibleSeconds <= windowEnd &&
            visibleSeconds > windowEnd - 4,
        JSON.stringify({ visibleSeconds, windowEnd })
    );
    // The join acceptance rule, from the playlist the receiver actually gets:
    // the entry containing the middle of the window must END before the LOAD
    // position, and every entry must have landed inside the window end.
    const durations = entryDurations(run.playlist.body);
    const half = durations.reduce((total, d) => total + d, 0) / 2;
    let reached = 0;
    let middleEntryEnd = 0;
    for (const duration of durations) {
        reached += duration;
        if (reached >= half) {
            middleEntryEnd = reached;
            break;
        }
    }
    check(
        "window: the window's middle entry ends before the LOAD position (the join rule)",
        middleEntryEnd > 0 && middleEntryEnd <= PRESENTATION_START,
        JSON.stringify({
            middleEntryEnd,
            presentationStart: PRESENTATION_START
        })
    );
    check(
        "window: nothing past the window end is advertised",
        Number.isFinite(windowEnd) && visibleSeconds <= windowEnd + 1e-6,
        JSON.stringify({ visibleSeconds, windowEnd })
    );
    check(
        "window: the window still carries real segments now (it is not a bare pad runway)",
        served.includes("segment-000000.ts"),
        JSON.stringify(served.slice(-3))
    );
    return run;
}

/**
 * The drip clock is anchored at the receiver's FIRST playlist fetch, not at the
 * remux's start. That anchoring IS the fix for the second half of the failure:
 * on-device, the receiver app's 3-7s launch delay let the list balloon to 3345s
 * while the LOAD position stayed at 1435, putting the window's middle (1672)
 * past the position — a mid cast failed that way (harness run "midctl2").
 */
async function caseWindowAnchor(bridge) {
    const PRESENTATION_START = 32 + 2.864;
    const LOAD_DELAY_MS = 2500;
    const run = await runRemux(bridge, {
        startTime: 2.864,
        keyframes: "0",
        // 200 x 4s = 800s of advertised media at 50ms per segment: the list is
        // still growing (no ENDLIST) when the delayed first fetch arrives, which
        // is exactly the state that defeated the on-device mid cast.
        segments: 200,
        segmentMs: 50,
        playlistFetchDelayMs: LOAD_DELAY_MS
    });
    const debug = run.playlistDebug.at(-1);
    const windowEnd = Number(debug?.chromecastWindowEnd);
    check(
        "window anchor: the first fetch still gets a window sized from ITS own moment, not from the remux start",
        // Same distance-from-position observation as caseWindow: 2.1s of
        // generation elapsed before the fetch, and the window ignores it.
        Number.isFinite(windowEnd) &&
            Math.abs(windowEnd - 2 * (PRESENTATION_START - 5)) < 0.5,
        JSON.stringify({
            windowEnd,
            expected: 2 * (PRESENTATION_START - 5),
            listedEntries: debug?.chromecastTotalEntries
        })
    );
    check(
        "window anchor: the remux ballooned far past the position while the receiver was away (the failure this anchoring prevents)",
        Number(debug?.chromecastTotalEntries) > 100 &&
            windowEnd < PRESENTATION_START + 60,
        JSON.stringify({
            listedEntries: debug?.chromecastTotalEntries,
            windowEnd
        })
    );
    return run;
}

async function casePadDiscontinuity(bridge) {
    const run = await runRemux(bridge, { startTime: 2.864, keyframes: "0" });
    const body = String(run.playlist.body ?? "");
    const tagAt = body.indexOf("#EXT-X-DISCONTINUITY");
    const realAt = body.indexOf("segment-000000.ts");
    const lastPadAt = body.lastIndexOf("pad.ts");
    check(
        "discontinuity: the served playlist declares the pad -> real segment boundary exactly once",
        tagAt >= 0 && body.indexOf("#EXT-X-DISCONTINUITY", tagAt + 1) === -1,
        JSON.stringify(body.split("\n").slice(-8))
    );
    check(
        "discontinuity: it sits between the last pad and the first real segment",
        tagAt >= 0 && lastPadAt >= 0 && realAt > tagAt && tagAt > lastPadAt,
        JSON.stringify({ lastPadAt, tagAt, realAt })
    );
    return run;
}

async function caseNoPadDiscontinuity(bridge) {
    // A mid-video cast is padded to its keyframe (1431s of runway), so it DOES
    // have the boundary; what must never happen is a tag with no pads in front
    // of it, because then there is no discontinuity to declare.
    const mid = await runRemux(bridge, {
        startTime: 1431.805,
        keyframes: "1431"
    });
    const midBody = String(mid.playlist.body ?? "");
    check(
        "discontinuity: a padded mid-video cast declares its own boundary too (the tag follows the pads, whatever the pad base)",
        midBody.includes("#EXT-X-DISCONTINUITY") &&
            midBody.indexOf("#EXT-X-DISCONTINUITY") >
                midBody.lastIndexOf("pad.ts"),
        JSON.stringify({
            pads: countLeading(segmentNames(midBody), "pad.ts"),
            tagAt: midBody.indexOf("#EXT-X-DISCONTINUITY")
        })
    );
    const off = await runRemux(bridge, {
        startTime: 2.864,
        keyframes: "0",
        startupPadding: false
    });
    const offBody = String(off.playlist.body ?? "");
    const offRows = segmentNames(offBody);
    check(
        "discontinuity: no pad entries anywhere means no boundary is declared (nothing to declare it between)",
        !offBody.includes("#EXT-X-DISCONTINUITY") &&
            !offRows.includes("pad.ts") &&
            Number(off.data.padBaseSeconds) === 0,
        JSON.stringify({
            tagAt: offBody.indexOf("#EXT-X-DISCONTINUITY"),
            first: offRows[0],
            padBase: off.data.padBaseSeconds
        })
    );
    return mid;
}

/**
 * The options-page switch (default ON). OFF must restore the pre-compatibility
 * timeline completely: no runway, LOAD at the requested start, no pad segment
 * generated up front, and an unchanged mid-video case either way.
 */
async function caseStartupPaddingOff(bridge) {
    const off = await runRemux(bridge, {
        startTime: 2.864,
        keyframes: "0",
        startupPadding: false
    });
    const rows = segmentNames(off.playlist.body);
    const offWindow = off.playlistDebug.at(-1);
    check(
        "option off (opening cast, keyframe 0): no pad entries exist to publish, and the window has nothing to keep",
        Number(off.data.padBaseSeconds) === 0 &&
            !rows.includes("pad.ts") &&
            Boolean(offWindow) &&
            Number(offWindow.chromecastVisibleEntries) === 0,
        JSON.stringify({
            rows: rows.length,
            pads: rows.filter(row => row === "pad.ts").length,
            padBase: off.data.padBaseSeconds,
            windowEnd: offWindow?.chromecastWindowEnd,
            body: String(off.playlist.body ?? "").slice(0, 120)
        })
    );
    check(
        "option off: LOAD is the requested start on an unpadded timeline",
        Number(off.data.padBaseSeconds) === 0 &&
            Math.abs(Number(off.data.presentationStartTime) - 2.864) < 1e-6,
        JSON.stringify(off.data)
    );
    check(
        "option off: the pad segment is not generated up front",
        !off.spawns.some(entry => entry.role === "pad"),
        JSON.stringify(off.spawns)
    );

    const offMid = await runRemux(bridge, {
        startTime: 1431.805,
        keyframes: "1431",
        startupPadding: false
    });
    check(
        "option off (health control): mid-video is unchanged — pad to the keyframe, no offset",
        Number(offMid.data.padBaseSeconds) === 1431 &&
            Math.abs(Number(offMid.data.presentationStartTime) - 1431.805) <
                1e-6,
        JSON.stringify(offMid.data)
    );

    // Roku is asserted from the SOURCE rather than driven here: its readiness
    // gate waits for the page-capture request handler (which sets
    // keyframeResolved and the bases), and this harness deliberately has no
    // capture input. The guarantee that matters — the option cannot reach that
    // path — is structural.
    const source = fs.readFileSync(resolved.mediaServerSource, "utf8");
    check(
        "option (Roku): the pad base never consults the option flag on the Roku path",
        // The policy moved into a named helper (dashPadBaseSeconds), so what this
        // asserts is that the ONLY flag reaching it is the gateway one - and that
        // the helper itself knows nothing about Roku.
        /padBaseSeconds = dashPadBaseSeconds\(/.test(source) &&
            /!rokuDashPrebuffer && chromecastDashStartupPadding !== false/.test(
                source
            ) &&
            !/dashPadBaseSeconds\(contentBaseSeconds, startupPadding\)[\s\S]{0,600}?rokuDashPrebuffer/.test(
                source
            ),
        "the Roku path's pad base no longer ignores the option"
    );
    check(
        "option (Roku): nothing requests a pad with the minimum runway (the flag cannot reach that path)",
        !/requestPadSegment\(CHROMECAST_MIN_PAD_SECONDS\)/.test(source) &&
            /requestPadSegment\?\.\(padBaseSeconds\);/.test(source),
        "the minimum-runway pad request is back"
    );
    // The one shared cut point for both remux inputs, read out of the source:
    // the keyframe, never the raw startTime, and never a keyframe-padded value
    // that would cut the audio ahead of the video.
    check(
        "seek: both inputs are cut at the resolved keyframe (min of pad base and content base), not startTime",
        /Math\.min\(padBaseSeconds, contentBaseSeconds\)/.test(source) &&
            !/seekArgs =[\s\S]{0,120}normalizedStartTime\.toFixed\(3\)/.test(
                source
            ),
        "the remux -ss is not the shared keyframe position"
    );
    return off;
}

async function caseProbeFailure(bridge) {
    const run = await runRemux(bridge, {
        startTime: 42.5,
        keyframes: "0",
        probeGarbage: true
    });
    check(
        "probe failure: readiness still completes (a corrupt probe cannot hang the cast)",
        Number.isFinite(Number(run.data.presentationStartTime)),
        JSON.stringify(run.data)
    );
    check(
        "probe failure: no probed keyframe is claimed (the startTime fallback is visible as a fallback)",
        run.data.probedKeyframeSeconds === undefined,
        JSON.stringify(run.data)
    );
    check(
        "probe failure: pad base falls back to the requested start",
        Number(run.data.padBaseSeconds) === 42.5,
        JSON.stringify(run.data)
    );
    return run;
}

async function caseParallelStart(bridge) {
    const PROBE_MS = 1200;
    const run = await runRemux(bridge, {
        startTime: 2.864,
        keyframes: "0",
        probeMs: PROBE_MS
    });
    const probe = run.spawns.find(entry => entry.tool === "ffprobe");
    const remux = run.spawns.find(entry => entry.role === "remux");
    const pad = run.spawns.find(entry => entry.role === "pad");
    check(
        "startup order: all three processes are started for one remux",
        Boolean(probe && remux && pad),
        JSON.stringify(run.spawns)
    );
    // The remux's -ss has to name the keyframe the video input will land on,
    // which is only known once the probe answers, so the remux now starts AFTER
    // it (bounded at 8s). This is the price of cutting both inputs at the same
    // point; the old parallel start cut them at different points and lost the
    // first segment's audio.
    check(
        "startup order: the remux starts only after the probe has exited (the shared cut point needs its answer)",
        Boolean(probe && remux) && remux.at >= probe.at + PROBE_MS - 150,
        JSON.stringify({ probeMs: PROBE_MS, spawns: run.spawns })
    );
    check(
        "startup order: pad generation starts with the remux, once the base is known (not before the probe)",
        Boolean(probe && pad) && pad.at >= probe.at + PROBE_MS - 150,
        JSON.stringify({ probeMs: PROBE_MS, spawns: run.spawns })
    );
    check(
        "startup order: readiness still waits for the finished probe",
        run.readyMs >= PROBE_MS,
        JSON.stringify({ probeMs: PROBE_MS, readyMs: run.readyMs })
    );
    return run;
}

function segmentNames(playlist) {
    return [...String(playlist ?? "").matchAll(/^(pad|segment-\d+)\.ts/gm)].map(
        match => match[0]
    );
}

/** Every advertised entry duration, in playlist order. */
function entryDurations(playlist) {
    return [...String(playlist ?? "").matchAll(/^#EXTINF:([0-9.]+)/gm)].map(
        match => Number(match[1])
    );
}

function countLeading(rows, name) {
    let count = 0;
    for (const row of rows) {
        if (row !== name) break;
        count++;
    }
    return count;
}

async function padIsServable(run) {
    const url = run.playlistUrl.replace("index.m3u8", "pad.ts");
    const response = await new Promise((resolve, reject) => {
        http.get(url, res => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        }).on("error", reject);
    });
    return response === 200;
}

/**
 * The page-side contracts around an item/quality change, read out of the REAL
 * sender sources (not restated), so the checks cannot drift from the shipped
 * code:
 *
 *  - bilibili.ts pauses the page ONLY on the initial cast;
 *  - MediaSender#prepareUpdatedMediaElement takes audio ownership of the new
 *    element (idempotent) and restores it on stop;
 *  - the page sender opens the item-transition window before the reload.
 */
/**
 * Do `first` and `second` appear, in that order, WITHIN `scope`?
 *
 * A file-wide first-occurrence search is not good enough for orderings inside a
 * method: `isHoldingPage()` is also consulted by helper methods defined earlier in
 * the class, so adding one such call reported the ordering below as broken when
 * nothing in the tick had moved.
 */
function orderWithin(source, scope, first, second) {
    const start = source.indexOf(scope);
    if (start < 0) return false;
    const a = source.indexOf(first, start);
    const b = source.indexOf(second, start);
    return a >= 0 && b >= 0 && a < b;
}

function checkItemChangeContracts() {
    const page = fs.readFileSync(resolved.bilibiliSource, "utf8");
    const pauseCondition =
        /if \(mediaElement instanceof HTMLVideoElement && ([^)]+)\) \{\n\s*mediaElement\.pause\(\)/.exec(
            page
        );
    check(
        "item change: the page is paused under an EXPLICIT condition, not unconditionally",
        Boolean(pauseCondition),
        "bilibili.ts no longer pauses inside a condition"
    );
    if (pauseCondition) {
        const decide = new Function(
            "isInitial",
            `return ${pauseCondition[1]};`
        );
        check(
            "item change: a non-initial change NEVER pauses the page (Roku capture source and Chromecast mirror alike)",
            decide(false) === false,
            JSON.stringify({ isInitial: false, condition: pauseCondition[1] })
        );
        check(
            "initial cast: still pauses while receiver selection is pending",
            decide(true) === true,
            JSON.stringify({ isInitial: true, condition: pauseCondition[1] })
        );
    }
    check(
        "item change: the sender takes audio ownership of the updated element instead",
        /^\s*sender\.prepareUpdatedMediaElement\(mediaElement\);$/m.test(page),
        "bilibili.ts does not call prepareUpdatedMediaElement"
    );
    check(
        "item change: audio is taken for EVERY receiver kind (an unmuted tab plays over the cast)",
        !/prepareUpdatedMediaElement[\s\S]{0,80}?selectedRoku/.test(page) &&
            !/selectedRoku[\s\S]{0,80}?prepareUpdatedMediaElement/.test(page),
        "the mute is conditional on the receiver kind"
    );
    check(
        "item change: the transition window is opened BEFORE the reload",
        /sender\.beginDashItemTransition\(\);\n\s*sender\.prepareUpdatedMediaElement/.test(
            page
        ),
        "beginDashItemTransition is not called before updateMedia"
    );

    const sender = fs.readFileSync(resolved.mediaSenderSource, "utf8");
    check(
        "sender: prepareUpdatedMediaElement mutes and records the element without pausing",
        /prepareUpdatedMediaElement\(element\?: HTMLMediaElement\) \{[\s\S]{0,1200}?element\.muted = true;/.test(
            sender
        ) && !/prepareUpdatedMediaElement[\s\S]{0,900}?\.pause\(/.test(sender),
        "prepareUpdatedMediaElement changed shape"
    );
    check(
        "sender: the transition window ignores the old session's PAUSED",
        /itemTransition = this\.dashItemTransitionActive\(\);[\s\S]{0,600}?PlayerState\.PAUSED/.test(
            sender
        ),
        "reconcilePlaybackState does not consult the transition window"
    );
    check(
        "sender: every DASH media states its offset explicitly (0 included), so it can never inherit the previous one",
        /presentationOffsetSeconds: this\.dashPresentation\.offsetSeconds/.test(
            sender
        ) && !/presentationOffsetSeconds: .*\?/.test(sender),
        "the offset is conditional again"
    );
    check(
        "sender: the offset is an immutable per-generation adapter, not a mutable number",
        /private dashPresentation: DashPresentation = identityPresentation/.test(
            sender
        ) && !/dashPresentationOffsetSeconds/.test(sender),
        "the sender still carries a mutable presentation offset"
    );
    check(
        "sender: the transition window needs BOTH the LOAD callback and a CONFIRMED new session id",
        /loadBelongsToTransition &&[\s\S]{0,200}?sessionAdvanced &&[\s\S]{0,200}?hasRealPosition/.test(
            sender
        ) &&
            // A transition that recorded no previous session must NOT read as
            // "any session will do": that reading let an old session close its own
            // replacement. The rule requires recorded previous-session identity.
            /previousMediaSessionId !== undefined &&[\s\S]{0,200}?mediaSessionId !==/.test(
                sender
            ),
        "the release rule lost one of its identity conditions"
    );
    const pageTickScope =
        "private addMediaElementListeners(mediaElement: HTMLMediaElement) {";
    check(
        "sender: the item-transition release runs BEFORE the generic page hold (it cannot hold itself alive)",
        orderWithin(
            sender,
            pageTickScope,
            "if (this.dashItemTransitionActive()) {",
            "if (this.isHoldingPage()) return;"
        ),
        "the transition release is unreachable behind the hold guard"
    );
    check(
        "sender: the transition guard is evaluated before the equal-state early return",
        orderWithin(
            sender,
            pageTickScope,
            "const itemTransition = this.dashItemTransitionActive();",
            "if (localState === boundMedia.playerState) return;"
        ),
        "the transition check sits after the early return again"
    );
    check(
        "sender: the transition window closes on the new session's first real position",
        /clearDashItemTransition\("new-media-position"\)/.test(sender),
        "no release path for the transition window"
    );
}

// ---------------------------------------------------------------------------

const resolved = resolveSources();
let bridgeWorkDir;
let toolsRoot;

async function main() {
    const { module: bridgeModule, workDir } = await buildBridge(
        resolved.mediaServerSource
    );
    bridgeWorkDir = workDir;
    toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-tools-"));
    const bridge = {
        module: bridgeModule,
        workDir,
        toolsDir: toolsRoot
    };

    const source = fs.readFileSync(resolved.mediaServerSource, "utf8");
    const minPadSeconds = Number(
        /const CHROMECAST_MIN_PAD_SECONDS = (\d+);/.exec(source)?.[1]
    );

    console.info(
        `bridge remux harness (${
            REVERT_TIMELINE
                ? "reverted timeline control"
                : argv.includes("--rev")
                ? `revision ${REV}`
                : "working tree"
        })`
    );

    // A case that cannot even start (the pre-fix bridge has no fixture-host seam,
    // so it refuses the remux) is a FAILED check, not a crashed harness: the
    // control mode needs to report it as an expected failure.
    const attempt = async (name, fn) => {
        try {
            return await fn();
        } catch (err) {
            check(
                `${name}: the bridge produced a stream to inspect`,
                false,
                err instanceof Error ? err.message : String(err)
            );
            return undefined;
        }
    };

    const opening = await attempt("opening cast", () =>
        caseOpeningCast(bridge, minPadSeconds)
    );
    await attempt("start-at-0", () => caseZeroStart(bridge));
    await attempt("mid-video", () => caseMidVideo(bridge));
    await attempt("window", () => caseWindow(bridge));
    await attempt("window anchor", () => caseWindowAnchor(bridge));
    await attempt("pad discontinuity", () => casePadDiscontinuity(bridge));
    await attempt("no-pad discontinuity", () => caseNoPadDiscontinuity(bridge));
    await attempt("startup padding off", () => caseStartupPaddingOff(bridge));
    await attempt("probe failure", () => caseProbeFailure(bridge));
    await attempt("parallel startup", () => caseParallelStart(bridge));
    checkItemChangeContracts();

    // Cleanup through the production stop, so no ffmpeg keeps running.
    bridge.module.stopMediaServer();
    void opening;

    console.info("");
    if (REVERT_TIMELINE) {
        // The control: with the pre-fix timeline rules back in place, the
        // zero-start padding, the parallel pad startup, the window cap and the
        // pad-boundary tag must FAIL here, or the checks above measure nothing.
        const expected = failures.filter(name =>
            /opening cast.*opens with pad entries|start-at-0|parallel startup: the pad generator|window: the window end is the middle bound|window anchor: the first fetch|discontinuity: the served playlist declares/.test(
                name
            )
        );
        if (expected.length < 6) {
            console.error(
                `dashRemuxTimeline: --revert-timeline expected the control failures, saw ${expected.length}` +
                    (failures.length ? ` (${failures.join("; ")})` : "")
            );
            process.exitCode = 1;
        } else {
            console.info(
                `reverted-timeline control: ${fail} check(s) failed, including the ${expected.length} expected`
            );
            for (const name of failures) console.info("  - " + name);
            process.exitCode = 0;
        }
    } else {
        console.info(`${pass}/${pass + fail} checks passed`);
        process.exitCode = fail ? 1 : 0;
    }
}

function cleanup() {
    for (const dir of [bridgeWorkDir, toolsRoot, resolved.worktree]) {
        if (!dir) continue;
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // A leftover temp dir must not change the test result.
        }
    }
}

process.on("exit", cleanup);

main().catch(err => {
    console.error("dashRemuxTimeline ERROR", err);
    process.exitCode = 1;
});
