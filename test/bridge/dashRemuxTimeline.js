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
    write(false);
    let index = 0;
    const step = () => {
        const file = pattern.replace("%06d", String(index).padStart(6, "0"));
        fs.writeFileSync(file, Buffer.alloc(376, 0x47));
        lines.push("#EXTINF:4.000000,");
        lines.push(path.basename(file));
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
        // timeline rules — no minimum pad runway on the Chromecast path, and pad
        // generation serialized behind the keyframe probe. Both rewrites must
        // apply: a control that silently tests the fixed code would report green
        // and mean nothing.
        const original = fs.readFileSync(sourcePath, "utf8");
        const reverted = original
            .replace(
                /Math\.max\(keyframe, CHROMECAST_MIN_PAD_SECONDS\)/,
                "keyframe"
            )
            .replace(
                /if \(useStartupPadding\) \{\n\s*requestPadSegment\(CHROMECAST_MIN_PAD_SECONDS\);\n\s*\}/,
                ""
            );
        if (
            reverted === original ||
            reverted.includes("requestPadSegment(CHROMECAST_MIN_PAD_SECONDS)")
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
        fetchPlaylist = true
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

    const result = {
        requestId,
        data: started.data,
        playlist,
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
    check(
        "option off: no pad entries are published at all",
        rows.length > 0 && !rows.includes("pad.ts"),
        JSON.stringify({ first: rows[0], pads: countLeading(rows, "pad.ts") })
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
        /padBaseSeconds = useStartupPadding\b/.test(source) &&
            /!rokuDashPrebuffer && chromecastDashStartupPadding !== false/.test(
                source
            ),
        "the Roku path's pad base no longer ignores the option"
    );
    check(
        "option (Roku): the up-front pad generation is gated by the same flag (never on the Roku path)",
        /if \(useStartupPadding\) \{\n\s*requestPadSegment\(CHROMECAST_MIN_PAD_SECONDS\);/.test(
            source
        ),
        "the up-front pad generation is not gated by the option-derived flag"
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
    const run = await runRemux(bridge, {
        startTime: 2.864,
        keyframes: "0",
        probeMs: 1200
    });
    const probe = run.spawns.find(entry => entry.tool === "ffprobe");
    const remux = run.spawns.find(entry => entry.role === "remux");
    const pad = run.spawns.find(entry => entry.role === "pad");
    check(
        "parallel startup: all three processes are started for one remux",
        Boolean(probe && remux && pad),
        JSON.stringify(run.spawns)
    );
    check(
        "parallel startup: the pad generator starts BEFORE the probe exits (not serialized behind it)",
        Boolean(probe && pad) && pad.at < probe.at + 1200,
        JSON.stringify({ probeMs: 1200, spawns: run.spawns })
    );
    check(
        "parallel startup: the remux starts before the probe exits",
        Boolean(probe && remux) && remux.at < probe.at + 1200,
        JSON.stringify({ probeMs: 1200, spawns: run.spawns })
    );
    check(
        "parallel startup: readiness still waits for the finished probe",
        run.readyMs >= 1200,
        JSON.stringify({ readyMs: run.readyMs })
    );
    return run;
}

function segmentNames(playlist) {
    return [...String(playlist ?? "").matchAll(/^(pad|segment-\d+)\.ts/gm)].map(
        match => match[0]
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
    check(
        "sender: the item-transition release runs BEFORE the generic page hold (it cannot hold itself alive)",
        sender.indexOf("if (this.dashItemTransitionActive()) {") <
            sender.indexOf("if (this.isHoldingPage()) return;"),
        "the transition release is unreachable behind the hold guard"
    );
    check(
        "sender: the transition guard is evaluated before the equal-state early return",
        sender.indexOf(
            "const itemTransition = this.dashItemTransitionActive();"
        ) <
            sender.indexOf(
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
        // zero-start padding and the parallel pad startup must FAIL here, or the
        // checks above measure nothing.
        const expected = failures.filter(name =>
            /opening cast.*opens with pad entries|start-at-0|parallel startup: the pad generator/.test(
                name
            )
        );
        if (expected.length < 3) {
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
