#!/usr/bin/env node
"use strict";

/**
 * The Roku capture-input contract, executed through the REAL bridge remux.
 *
 * Why this exists. The replacement-handoff line (see
 * `.workbuddy/memory/2026-09-16.md`, "【推翻】6.32-6.35") was declared fixed on the
 * strength of a harness whose success criterion was "some bridge port received a
 * payload with the expected marker". On the device that criterion held — 2.5 MB
 * were replayed — while the remux still failed, because the bridge does NOT need
 * "a payload": it needs, per kind, a Range-0 init whose sidx declares a fragment
 * whose FULL byte range has been captured. Only then does it emit
 * `page-response-start-selected`, only that sets `keyframeResolved` /
 * `padReadyResult` for video, and only then does the readiness gate clear.
 *
 * So this harness runs the real thing:
 *
 *   1. `mediaServer.ts` is bundled from source (esbuild) and
 *      `startRemoteMediaServer` is called with `rokuDashPrebuffer: true`, i.e.
 *      the Roku capture path with its own `/ingest` + `/video` + `/audio`
 *      endpoints.
 *   2. The fixture "page" POSTs real DASH-shaped bytes to `/ingest` in exactly
 *      the ranges a page would: a Range-0 init (ftyp+moov+sidx) followed by
 *      whole sidx fragments. The bytes are synthesised, not downloaded: this
 *      harness must be able to say "the page delivered this range set" and vary
 *      it case by case, which a CDN download cannot.
 *   3. The fake ffmpeg really opens BOTH `-i` URLs over HTTP and drains them,
 *      so the bridge's per-kind input selection is entered by the same path
 *      production uses. (The fake replaces only the decoding/muxing, which this
 *      harness does not measure; the readiness gate it drives is real, and its
 *      segment files are written incrementally under `-hls_flags temp_file`
 *      semantics so the gate's "complete segment" rule is the production one.)
 *
 * What it proves:
 *
 *   - both kinds fed => BOTH `page-response-start-selected`, the gate clears,
 *     the served playlist advertises the prebuffer and every advertised segment
 *     is servable: the full chain works.
 *   - audio's covering fragment missing, or its Range-0 missing => video
 *     selects, audio NEVER does, the audio input receives not one byte, and no
 *     stream is produced at all. That is the on-device failure shape,
 *     reproduced locally. The two "audio unusable" inputs are deliberately kept
 *     separate (they are different page behaviours) even though the bridge's
 *     observable output for them is the same: "the audio bytes that did arrive
 *     were not usable" is not something the bridge can report, which is exactly
 *     why the capture has to be held to "a complete range set for both kinds".
 *   - audio arriving late => audio DOES select and the gate still clears. The
 *     bridge waits; it does not fail. Any fix therefore has to be upstream (the
 *     capture must deliver the range), not in the bridge.
 *
 * Usage:
 *   node test/bridge/pageCaptureRemux.js
 *   node test/bridge/pageCaptureRemux.js --verbose
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repoRoot = path.resolve(__dirname, "../..");
const esbuildPath = path.join(
    repoRoot,
    "bridge/node_modules/esbuild/lib/main.js"
);
const mediaServerSource = path.join(
    repoRoot,
    "bridge/src/bridge/components/mediaServer.ts"
);

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");

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

// ---------------------------------------------------------------------------
// Synthetic DASH (fMP4) bytes
// ---------------------------------------------------------------------------

// The same representation layout the capture harness drives the extension with
// (test/fixtures/syntheticDash.js): one definition of the byte layout both
// sides read.
const { buildFmp4 } = require("../fixtures/syntheticDash");

// ---------------------------------------------------------------------------
// Fake ffmpeg / ffprobe
// ---------------------------------------------------------------------------

/**
 * The fake tools. Same shape as `dashRemuxTimeline.js` (one script, two
 * personalities, selected by its own filename so the bridge's
 * `ffmpegPath.replace(/ffmpeg$/, "ffprobe")` resolution finds `fake-ffprobe`),
 * with two differences that matter HERE:
 *
 *   - the fake ffmpeg really GETs the two `-i` inputs over HTTP and drains
 *     them. That is what enters the bridge's capture input selection
 *     (`input-request` -> `page-response-start-selected`); a fake that ignores
 *     its inputs cannot observe that contract at all.
 *   - it produces NO output until BOTH inputs have delivered bytes, and exits
 *     without writing a playlist when one of them never does. That is the
 *     faithful shape of `-map 0:v:0 -map 1:a:0`: ffmpeg cannot write a single
 *     output packet until every mapped input is open and probed, so an audio
 *     input that never yields a byte means no playlist, hence no
 *     `mediaServerStarted` — which is exactly what the device showed
 *     ("Error opening input file .../audio", no LOAD).
 *
 * Every input outcome (status, bytes, ended, timed out) is appended to
 * inputs.log as JSON, so "the audio input never got a byte" is a fact this
 * harness asserts instead of infers.
 */
function writeFakeTools(dir) {
    const script = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const argv = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const dir = __dirname;
const log = p => fs.appendFileSync(path.join(dir, "spawns.log"), p + "\\n");
const record = entry =>
    fs.appendFileSync(path.join(dir, "inputs.log"), JSON.stringify(entry) + "\\n");

if (name.includes("ffprobe")) {
    log("ffprobe " + Date.now());
    const keyframes = (process.env.FX_FAKE_KEYFRAMES || "0").split(",").map(Number);
    const duration = Number(process.env.FX_FAKE_DURATION || "600");
    const packets = keyframes.map(pts => ({ pts_time: String(pts), flags: "K__" }));
    process.stdout.write(
        JSON.stringify({ packets, format: { duration: String(duration) } })
    );
    setTimeout(() => process.exit(0), Number(process.env.FX_FAKE_PROBE_MS || "200"));
} else {
    const outIndex = argv.indexOf("-hls_segment_filename");
    const role = outIndex < 0 ? "pad" : "remux";
    log("ffmpeg " + Date.now() + " " + role);
    if (role === "pad") {
        fs.writeFileSync(argv[argv.length - 1], Buffer.alloc(188 * 8, 0x47));
        process.exit(0);
    }

    // The capture inputs in argument order (video first, audio second) — the
    // order the bridge maps to 0:v:0 / 1:a:0.
    const inputs = [];
    for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === "-i") inputs.push(argv[i + 1]);
    }
    const inputTimeout = Number(process.env.FX_FAKE_INPUT_TIMEOUT_MS || "3000");
    const state = inputs.map((url, index) => ({
        role,
        index,
        kind: index === 0 ? "video" : "audio",
        url,
        status: undefined,
        bytes: 0,
        ended: false,
        timedOut: false
    }));
    const requests = state.map((entry, index) => {
        const request = http.get(entry.url, res => {
            entry.status = res.statusCode;
            res.on("data", chunk => (entry.bytes += chunk.length));
            res.on("end", () => (entry.ended = true));
        });
        request.on("error", error => {
            entry.error = String(error && error.message);
        });
        return request;
    });

    const started = Date.now();
    const waitForInputs = setInterval(() => {
        const opened = state.filter(entry => entry.bytes > 0).length;
        if (opened === state.length) {
            clearInterval(waitForInputs);
            produce();
            return;
        }
        if (Date.now() - started < inputTimeout) return;
        clearInterval(waitForInputs);
        // ffmpeg gives up when a mapped input never yields data: no output is
        // written at all, and the process exits nonzero.
        state.forEach((entry, index) => {
            if (entry.bytes > 0) return;
            entry.timedOut = true;
            requests[index].destroy();
            record(entry);
        });
        state.forEach(entry => {
            if (entry.bytes > 0) record(entry);
        });
        process.exit(3);
    }, 25);

    const pattern = argv[outIndex + 1];
    const playlistPath = argv[argv.length - 1];
    const count = Number(process.env.FX_FAKE_HLS_SEGMENTS || "14");
    const segmentMs = Number(process.env.FX_FAKE_HLS_SEGMENT_MS || "60");
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
    const produce = () => {
        state.forEach(entry => record(entry));
        // Every advertised entry exists from the first write; only the files
        // drip. The Roku gate refuses an incomplete "highest" segment, so this
        // is the shape that makes the gate's own rule decide readiness.
        for (let i = 0; i < count; i++) {
            lines.push("#EXTINF:4.000000,");
            lines.push(
                path.basename(pattern.replace("%06d", String(i).padStart(6, "0")))
            );
        }
        write(false);
        let index = 0;
        const step = () => {
            fs.writeFileSync(
                pattern.replace("%06d", String(index).padStart(6, "0")),
                Buffer.alloc(376, 0x47)
            );
            index++;
            write(index >= count);
            if (index >= count) return;
            setTimeout(step, segmentMs);
        };
        step();
        const keepAlive = setInterval(() => undefined, 1000);
        process.on("exit", () => clearInterval(keepAlive));
    };
}
`;
    const ffmpeg = path.join(dir, "fake-ffmpeg");
    const ffprobe = path.join(dir, "fake-ffprobe");
    fs.writeFileSync(ffmpeg, script, { mode: 0o755 });
    fs.writeFileSync(ffprobe, script, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "spawns.log"), "");
    fs.writeFileSync(path.join(dir, "inputs.log"), "");
    return {
        ffmpeg,
        ffprobe,
        spawnsLog: path.join(dir, "spawns.log"),
        inputsLog: path.join(dir, "inputs.log")
    };
}

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

async function buildBridge() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-cap-"));
    const outfile = path.join(workDir, "mediaServer.cjs");
    const esbuild = require(esbuildPath);
    await esbuild.build({
        entryPoints: [mediaServerSource],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        nodePaths: [path.join(repoRoot, "bridge/node_modules")]
    });
    return { module: require(outfile), workDir };
}

function makeMessenger() {
    const messages = [];
    return {
        messages,
        sendMessage(message) {
            messages.push(message);
            if (VERBOSE) {
                console.info(
                    "    bridge> " + message.subject,
                    JSON.stringify(message.data ?? {}).slice(0, 220)
                );
            }
        },
        waitFor(predicate, description, timeoutMs = 20000) {
            const startedAt = Date.now();
            return new Promise((resolve, reject) => {
                const poll = () => {
                    const found = messages.find(predicate);
                    if (found) return resolve(found);
                    if (Date.now() - startedAt > timeoutMs) {
                        return reject(
                            new Error(
                                `timed out waiting for ${description}: ${JSON.stringify(
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

/** Every `main:dashRemuxDebug` page-capture event this run produced. */
function captureEvents(messenger) {
    return messenger.messages
        .filter(
            message =>
                message.subject === "main:dashRemuxDebug" &&
                message.data?.event === "response"
        )
        .map(message => {
            try {
                return JSON.parse(message.data?.details ?? "{}");
            } catch {
                return undefined;
            }
        })
        .filter(Boolean);
}

const selectionOf = (events, kind) =>
    events.find(
        event =>
            event.pageCaptureEvent === "page-response-start-selected" &&
            event.kind === kind
    );

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll the fake ffmpeg's per-input report until both inputs have settled. */
async function waitForInputRecords(tools, count, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const lines = fs
            .readFileSync(tools.inputsLog, "utf8")
            .split("\n")
            .filter(Boolean);
        if (lines.length >= count || Date.now() > deadline) {
            return lines.map(line => JSON.parse(line));
        }
        await sleep(50);
    }
}

/** POST one captured byte range, exactly like the capture module does. */
async function ingest(capture, { kind, start, end, total, body }) {
    const url = `http://127.0.0.1:${
        capture.port
    }/ingest?rid=${encodeURIComponent(capture.requestId)}&gen=${
        capture.generation
    }&kind=${kind}&start=${start}&end=${end}&total=${total}`;
    const response = await fetch(url, {
        method: "POST",
        body: body.subarray(start, end + 1),
        headers: { "Content-Type": "application/octet-stream" }
    });
    return response.status;
}

/**
 * The page's own feed: Range-0 init, then whole sidx fragments.
 *
 * `fragments` selects which fragments the page fetched. `init: false` is the
 * "the page fetched media but never the Range-0 response" shape.
 */
async function feedKind(capture, kind, representation, options = {}) {
    const { init = true, fragments = "all" } = options;
    const statuses = [];
    if (init) {
        statuses.push(
            await ingest(capture, {
                kind,
                start: 0,
                end: representation.initEnd - 1,
                total: representation.total,
                body: representation.body
            })
        );
    }
    const wanted =
        fragments === "all"
            ? representation.fragments
            : representation.fragments.filter(item =>
                  fragments.includes(item.index)
              );
    for (const fragment of wanted) {
        statuses.push(
            await ingest(capture, {
                kind,
                start: fragment.start,
                end: fragment.end,
                total: representation.total,
                body: representation.body
            })
        );
    }
    return statuses;
}

/**
 * One remux run. Returns the run's observable facts: the bridge's own capture
 * events, the fake ffmpeg's per-input outcome, and the served playlist.
 */
async function runRemux(bridge, options) {
    const {
        startTime,
        video = buildFmp4(),
        audio = buildFmp4({ segmentBytes: 1024 }),
        feedVideo = { init: true, fragments: "all" },
        feedAudio = { init: true, fragments: "all" },
        /** Delay before the audio feed starts, modelling a slow page. */
        audioFeedDelayMs = 0,
        waitForReady = 20000,
        /** How long the fake ffmpeg waits for each input to yield a byte. */
        inputTimeoutMs = 2000,
        segmentCount = 14
    } = options;

    const tools = writeFakeTools(bridge.toolsDir);
    const messenger = makeMessenger();
    const port = await freePort();
    const requestId = `cap-${Math.random().toString(36).slice(2, 10)}`;

    process.env.FX_CAST_BILIBILI_FFMPEG = tools.ffmpeg;
    process.env.FX_CAST_BILIBILI_ALLOWED_HOSTS = "fixture.invalid";
    process.env.FX_FAKE_KEYFRAMES = "0";
    process.env.FX_FAKE_PROBE_MS = "150";
    process.env.FX_FAKE_HLS_SEGMENTS = String(segmentCount);
    process.env.FX_FAKE_HLS_SEGMENT_MS = "60";
    process.env.FX_FAKE_INPUT_TIMEOUT_MS = String(inputTimeoutMs);

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
        true,
        "copy",
        undefined
    );

    // The capture port is announced while the remux is being prepared; the fake
    // ffmpeg opens the two inputs as soon as it is spawned, so the feed has to
    // start as soon as the port exists.
    const ready = await messenger.waitFor(
        message => message.subject === "main:bilibiliPageCaptureReady",
        "bilibiliPageCaptureReady"
    );
    const capture = {
        port: ready.data.port,
        generation: ready.data.generation,
        requestId
    };

    const feed = async () => {
        const videoStatuses = await feedKind(
            capture,
            "video",
            video,
            feedVideo
        );
        if (audioFeedDelayMs > 0) await sleep(audioFeedDelayMs);
        const audioStatuses = await feedKind(
            capture,
            "audio",
            audio,
            feedAudio
        );
        return { videoStatuses, audioStatuses };
    };
    const feeding = feed();

    let started;
    let readyError;
    try {
        const found = await messenger.waitFor(
            message =>
                message.subject === "mediaCast:mediaServerStarted" &&
                message.data?.requestId === requestId,
            "mediaServerStarted",
            waitForReady
        );
        started = found.data;
    } catch (error) {
        readyError = error;
    }
    // A run whose gate never cleared still has to report what the feed and the
    // fake inputs did; both are bounded, so this join cannot hang the harness.
    const feedStatuses = await feeding;

    const events = captureEvents(messenger);
    const inputs = await waitForInputRecords(tools, 2, inputTimeoutMs + 2500);

    let playlist;
    let segments = [];
    if (started) {
        playlist = await fetchText(
            `http://${started.localAddress}:${port}/${started.mediaPath}`
        );
        // Every advertised prebuffer entry, fetched exactly the way the Roku
        // resolves them: relative to the playlist's own directory, with the
        // per-generation cache buster the playlist carries. Done before the
        // server is stopped — a servable playlist is only a fact while it is up.
        const advertised = [
            ...String(playlist.body).matchAll(/^(segment-\d+\.ts\?g=[^\s]+)$/gm)
        ].map(match => match[1]);
        const base = `http://${started.localAddress}:${port}/${path.dirname(
            started.mediaPath
        )}/`;
        for (const name of advertised.slice(0, 12)) {
            const segment = await fetchText(base + name).catch(() => undefined);
            segments.push({
                name,
                status: segment?.status,
                bytes: segment?.body.length
            });
        }
    }

    const failureMessage = messenger.messages.find(
        message =>
            message.subject === "mediaCast:mediaServerError" &&
            message.data?.requestId === requestId
    );

    const result = {
        requestId,
        capture,
        /** The media server port the receiver would fetch playlist/segments on. */
        port,
        events,
        inputs,
        playlist,
        segments,
        started,
        feedStatuses,
        failureMessage: failureMessage?.data?.message,
        readyMs: started ? Date.now() - startedAt : undefined,
        readyError: readyError?.message
    };
    bridge.module.stopMediaServer();
    await sleep(200);
    return result;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

function checkInput(input, kind, expectation) {
    check(
        `both kinds fed: the ${kind} input really was opened and served (${expectation})`,
        input &&
            input.status === 200 &&
            input.bytes > 0 &&
            input.ended &&
            !input.timedOut,
        JSON.stringify(input ?? { missing: true })
    );
}

async function caseBothKindsServed(bridge) {
    const run = await runRemux(bridge, { startTime: 0 });
    const video = selectionOf(run.events, "video");
    const audio = selectionOf(run.events, "audio");
    check(
        "both kinds fed: video is selected as the input start",
        Boolean(video),
        JSON.stringify(run.events.map(e => e.pageCaptureEvent))
    );
    check(
        "both kinds fed: audio is selected as the input start",
        Boolean(audio),
        JSON.stringify(run.events.map(e => e.pageCaptureEvent))
    );
    check(
        "both kinds fed: both inputs were requested",
        run.events.filter(e => e.pageCaptureEvent === "input-request")
            .length === 2,
        JSON.stringify(run.events.map(e => e.pageCaptureEvent))
    );
    checkInput(
        run.inputs.find(i => i.kind === "video"),
        "video",
        "the remux reads it"
    );
    checkInput(
        run.inputs.find(i => i.kind === "audio"),
        "audio",
        "the remux reads it"
    );
    check(
        "both kinds fed: the Roku readiness gate cleared",
        Boolean(run.started),
        run.readyError ?? run.failureMessage ?? "no mediaServerStarted"
    );
    const body = String(run.playlist?.body ?? "");
    const advertised = [
        ...body.matchAll(/^(segment-\d+\.ts\?g=[^\s]+)$/gm)
    ].map(m => m[1]);
    check(
        "both kinds fed: the served playlist advertises the prebuffer",
        advertised.length >= 12,
        `advertised=${advertised.length}`
    );
    const servable = run.segments.filter(
        segment => segment.status === 200 && segment.bytes > 0
    ).length;
    check(
        "both kinds fed: every advertised prebuffer segment is servable",
        servable >= 12,
        `servable=${servable} :: ${run.segments
            .map(segment => `${segment.name.split("?")[0]}->${segment.status}`)
            .join(", ")}`
    );
    return run;
}

async function caseCoveringFragmentMissing(bridge) {
    // The page fetched audio's init but only the FIRST fragment, and the remux
    // starts at a position inside a LATER fragment: the range the bridge needs
    // is simply not in the capture. This is the shape the device showed (init
    // for both kinds, media for video only) reduced to its invariant.
    const audio = buildFmp4({ segmentBytes: 1024 });
    const run = await runRemux(bridge, {
        startTime: 40,
        audio,
        feedAudio: { init: true, fragments: [0] },
        waitForReady: 2500,
        inputTimeoutMs: 1200
    });
    const audioEvents = run.events.filter(e => e.kind === "audio");
    check(
        "covering fragment missing: video is still selected",
        Boolean(selectionOf(run.events, "video")),
        JSON.stringify(run.events.map(e => e.pageCaptureEvent))
    );
    check(
        "covering fragment missing: audio is NEVER selected",
        !selectionOf(run.events, "audio"),
        JSON.stringify(audioEvents)
    );
    check(
        "covering fragment missing: the audio input received no byte at all",
        run.inputs.find(i => i.kind === "audio")?.bytes === 0,
        JSON.stringify(run.inputs.find(i => i.kind === "audio") ?? {})
    );
    check(
        "covering fragment missing: the remux produced no stream at all",
        !run.started,
        run.failureMessage ?? "the gate cleared anyway"
    );
    // The observability contract. A starved relay leaves the receiver draining
    // its prebuffer into BUFFERING, and every per-chunk event around it is
    // suppressed — so the bridge has to SAY which range it is parked on, or a
    // stuck buffer is undiagnosable from an always-on log.
    check(
        "covering fragment missing: the bridge reports the range it is parked on",
        run.events.some(
            event =>
                event.pageCaptureEvent === "waiting-for-captured-input-start" &&
                event.kind === "audio"
        ),
        JSON.stringify(run.events.map(e => e.pageCaptureEvent))
    );
    return run;
}

async function caseInitMissing(bridge) {
    // The page fetched audio media ranges but never the Range-0 response: no
    // init, so no sidx, so no fragment table. It must be distinguishable from
    // "the fragment is missing" by the bridge's own observable output.
    const audio = buildFmp4({ segmentBytes: 1024 });
    const run = await runRemux(bridge, {
        startTime: 0,
        audio,
        feedAudio: { init: false, fragments: [0, 1, 2] },
        waitForReady: 2500,
        inputTimeoutMs: 1200
    });
    check(
        "init missing: audio is NEVER selected",
        !selectionOf(run.events, "audio"),
        JSON.stringify(run.events.filter(e => e.kind === "audio"))
    );
    check(
        "init missing: the audio input received no byte at all",
        run.inputs.find(i => i.kind === "audio")?.bytes === 0,
        JSON.stringify(run.inputs.find(i => i.kind === "audio") ?? {})
    );
    check(
        "init missing: the remux produced no stream at all",
        !run.started,
        run.failureMessage ?? "the gate cleared anyway"
    );
    check(
        "init missing: the bridge reports the missing Range-0 it is parked on",
        run.events.some(
            event =>
                event.pageCaptureEvent === "waiting-for-captured-init" &&
                event.kind === "audio"
        ),
        JSON.stringify(run.events.map(e => e.pageCaptureEvent))
    );
    return run;
}

/**
 * The other half of the observability contract: the input start IS selectable, so
 * the relay starts, and then the fragment AFTER it never arrives. The serving
 * loop parks, ffmpeg stops getting bytes, the receiver drains its prebuffer and
 * sits in BUFFERING — the on-device "stuck in buffer". Nothing per-chunk is
 * logged there, so this bookmark is the only always-on evidence of where it
 * stopped.
 */
async function caseLaterFragmentMissing(bridge) {
    const audio = buildFmp4({ segmentBytes: 1024 });
    const run = await runRemux(bridge, {
        startTime: 0,
        audio,
        feedAudio: { init: true, fragments: [0] },
        waitForReady: 2500,
        inputTimeoutMs: 1200
    });
    check(
        "later fragment missing: the start IS selected (the relay gets going)",
        Boolean(selectionOf(run.events, "audio")),
        JSON.stringify(run.events.filter(e => e.kind === "audio"))
    );
    check(
        "later fragment missing: the bridge reports the fragment it is parked on",
        run.events.some(
            event =>
                event.pageCaptureEvent === "waiting-for-captured-fragment" &&
                event.kind === "audio" &&
                event.mediaTime === 4
        ),
        JSON.stringify(run.events.map(e => e.pageCaptureEvent))
    );
    return run;
}

async function caseAudioArrivesLate(bridge) {
    // Nothing for audio at first, the whole representation 1.5s later. The
    // bridge must wait for it rather than fail the generation: the failure is
    // upstream, so a fix belongs there.
    const audio = buildFmp4({ segmentBytes: 1024 });
    const run = await runRemux(bridge, {
        startTime: 0,
        audio,
        feedAudio: { init: true, fragments: "all" },
        audioFeedDelayMs: 1500,
        waitForReady: 20000,
        inputTimeoutMs: 6000
    });
    check(
        "late audio: audio is selected once its range arrives",
        Boolean(selectionOf(run.events, "audio")),
        JSON.stringify(run.events.filter(e => e.kind === "audio"))
    );
    check(
        "late audio: the gate still clears",
        Boolean(run.started),
        run.readyError ?? run.failureMessage ?? "no mediaServerStarted"
    );
    return run;
}

// ---------------------------------------------------------------------------

let bridgeWorkDir;
let toolsRoot;

async function main() {
    const { module: bridgeModule, workDir } = await buildBridge();
    bridgeWorkDir = workDir;
    toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-cap-tools-"));
    const bridge = {
        module: bridgeModule,
        workDir,
        toolsDir: toolsRoot
    };

    console.info("bridge capture-input harness (working tree)");
    console.info("case: both kinds fed");
    await caseBothKindsServed(bridge);
    console.info("case: the covering audio fragment is missing");
    await caseCoveringFragmentMissing(bridge);
    console.info("case: the audio Range-0 is missing");
    await caseInitMissing(bridge);
    console.info("case: a later audio fragment is missing");
    await caseLaterFragmentMissing(bridge);
    console.info("case: audio arrives late");
    await caseAudioArrivesLate(bridge);

    console.info("");
    console.info(`${pass}/${pass + fail} checks passed`);
    if (fail) for (const name of failures) console.info("  - " + name);
    process.exitCode = fail ? 1 : 0;
}

function cleanup() {
    for (const dir of [bridgeWorkDir, toolsRoot]) {
        if (!dir) continue;
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // A leftover temp dir must not change the test result.
        }
    }
}

process.on("exit", cleanup);

main().catch(error => {
    console.error("pageCaptureRemux ERROR", error);
    process.exitCode = 1;
});
