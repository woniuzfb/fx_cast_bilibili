#!/usr/bin/env node
"use strict";
/**
 * Roku DASH remux startup, executed against the REAL bridge server.
 *
 * The DASH timeline harness drives the same server, but its fake ffmpeg has a
 * personality the Roku path never exercises: the readiness gate waits for
 * ROKU_DASH_PREBUFFER_SEGMENTS COMPLETE segments before `mediaServerStarted`,
 * and "complete" is judged from the playlist plus the NEXT file existing — a
 * condition the production `-hls_flags temp_file` governs. A fake that writes
 * the playlist and the files in one step cannot tell whether that gate ever
 * clears, which is exactly the risk when the flags are shared with the
 * Chromecast path.
 *
 * This harness therefore runs the real ffmpeg command line (real CDN inputs,
 * real transcode, real segmenter) with the Roku capture parameters and reports
 * how long the gate takes, which segments appear, and whether the served
 * playlist/prebuffer are usable. Nothing is written into the repository: the
 * build and the segments live in a per-run temp dir.
 *
 * Usage:
 *   node test/bridge/rokuDashStartup.js            # one run, prints the report
 *   node test/bridge/rokuDashStartup.js --timeout 90
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.resolve(__dirname, "..", "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const START_TIME = Number(arg("--start-time", "38.532464"));
const PORT = Number(arg("--port", "9559"));
const GATE_TIMEOUT_MS = Number(arg("--timeout", "60")) * 1000;
const BVID = arg("--bvid", "BV1szuWzjE5y");
const CID = arg("--cid", "31065573226");

const log = (...parts) =>
    console.log(`${new Date().toISOString().slice(11, 23)} ${parts.join(" ")}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPlayurl() {
    const url =
        `https://api.bilibili.com/x/player/playurl?bvid=${BVID}&cid=${CID}` +
        `&qn=80&fnval=16&fnver=0`;
    const response = await fetch(url, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            "Referer": `https://www.bilibili.com/video/${BVID}/`
        }
    });
    const data = (await response.json()).data;
    const video = (data.dash.video || [])[0];
    const audio = (data.dash.audio || [])[0];
    if (!video || !audio) throw new Error("no DASH rendition");
    return { videoUrl: video.baseUrl, audioUrl: audio.baseUrl, video };
}

function writeMessage(child, message) {
    const json = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    child.stdin.write(Buffer.concat([header, json]));
}

function attachReader(child, onMessage) {
    let buffer = Buffer.alloc(0);
    child.stdout.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            if (buffer.length < 4) return;
            const length = buffer.readUInt32LE(0);
            if (buffer.length < 4 + length) return;
            const json = buffer.subarray(4, 4 + length);
            buffer = buffer.subarray(4 + length);
            try {
                onMessage(JSON.parse(json.toString("utf8")));
            } catch {}
        }
    });
}

function fetchText(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", c => (body += c));
            res.on("end", () =>
                resolve({ status: res.statusCode, body, headers: res.headers })
            );
        }).on("error", reject);
    });
}

async function main() {
    const { videoUrl, audioUrl, video } = await fetchPlayurl();
    log(
        `page source: video=${video.codecs} ${video.width}x${video.height}` +
            ` host=${new URL(videoUrl).hostname}`
    );

    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-roku-start-"));
    process.on("exit", () => {
        try {
            fs.rmSync(harnessDir, { recursive: true, force: true });
        } catch {}
    });
    const bridgeBuildDir = path.join(harnessDir, "bridge");
    const built = spawnSync(
        process.execPath,
        [path.join(REPO, "bridge/bin/build.js"), "--out-dir", bridgeBuildDir],
        {
            cwd: REPO,
            env: {
                ...process.env,
                PATH: `${path.join(REPO, "bridge/node_modules/.bin")}${
                    path.delimiter
                }${process.env.PATH ?? ""}`
            },
            stdio: ["ignore", "pipe", "pipe"]
        }
    );
    if (
        built.status !== 0 ||
        !fs.existsSync(path.join(bridgeBuildDir, "src/main.js"))
    ) {
        throw new Error(
            `bridge build failed: ${String(built.stderr || built.stdout).slice(
                -400
            )}`
        );
    }

    const bridge = spawn("node", [path.join(bridgeBuildDir, "src/main.js")], {
        cwd: path.join(REPO, "bridge"),
        env: {
            ...process.env,
            // The build lands in a temp dir with no node_modules of its own, so
            // runtime deps (yargs) must resolve from the checkout.
            NODE_PATH: path.join(REPO, "bridge/node_modules")
        },
        stdio: ["pipe", "pipe", "pipe"]
    });
    bridge.stdin.on("error", () => {});
    let bridgeStderr = "";
    bridge.stderr.on("data", c => {
        bridgeStderr = (bridgeStderr + String(c)).slice(-4000);
    });

    const requestId = `roku-startup-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    let started;
    let capturePort;
    let captureGeneration;
    const events = [];
    const subjects = new Map();
    attachReader(bridge, message => {
        subjects.set(message.subject, (subjects.get(message.subject) ?? 0) + 1);
        if (message.subject === "mediaCast:dashRemuxDebug") {
            const d = message.data ?? {};
            events.push(`${d.event} ${String(d.details ?? "").slice(0, 200)}`);
            return;
        }
        if (message.subject === "main:dashRemuxDebug") {
            events.push(
                `${message.data?.event} ${String(
                    message.data?.details ?? ""
                ).slice(0, 200)}`
            );
            return;
        }
        if (message.subject === "main:bilibiliPageCaptureReady") {
            capturePort = message.data.port;
            captureGeneration = message.data.generation;
            return;
        }
        if (
            message.subject === "mediaCast:mediaServerStarted" &&
            message.data.requestId === requestId
        ) {
            started = message.data;
            return;
        }
        if (message.subject === "mediaCast:mediaServerError") {
            events.push(`ERROR ${JSON.stringify(message.data).slice(0, 300)}`);
        }
    });

    writeMessage(bridge, {
        subject: "bridge:startRemoteMediaServer",
        data: {
            requestId,
            mediaUrl: videoUrl,
            audioUrl,
            referer: `https://www.bilibili.com/video/${BVID}/`,
            contentType: "application/x-mpegURL",
            port: PORT,
            startTime: START_TIME,
            hlsLive: false,
            rokuDashPrebuffer: true,
            rokuTranscodePreset: "veryfast"
        }
    });

    // The Roku path does not read the CDN itself: it reads the page's captured
    // response through the bridge's capture endpoints, and the readiness gate
    // cannot clear until that feed exists. Play the page's part here — download
    // the captured DASH pair and POST it to /ingest in the same ranges the page
    // would — otherwise this harness would only measure the missing feed.
    const feedDeadline = Date.now() + 30000;
    while (capturePort === undefined && Date.now() < feedDeadline)
        await sleep(200);
    if (capturePort === undefined) {
        console.error("FAIL: the bridge never announced a capture port");
        console.error(
            `subjects seen: ${JSON.stringify([...subjects.entries()])}`
        );
        for (const event of events.slice(-10)) console.error(`  ${event}`);
        if (bridgeStderr.trim()) {
            console.error("--- bridge stderr (tail) ---");
            console.error(bridgeStderr.split("\n").slice(-12).join("\n"));
        }
        bridge.kill("SIGTERM");
        process.exitCode = 1;
        return;
    }
    log(`capture port ${capturePort} (generation ${captureGeneration})`);
    const feed = { video: 0, audio: 0 };
    const ingest = async (kind, url) => {
        const response = await fetch(url, {
            headers: {
                "Referer": `https://www.bilibili.com/video/${BVID}/`,
                "User-Agent": "Mozilla/5.0"
            }
        });
        if (!response.ok) throw new Error(`source fetch ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        const total = body.length;
        const CHUNK = 512 * 1024;
        for (let start = 0; start < total; start += CHUNK) {
            const end = Math.min(total - 1, start + CHUNK - 1);
            const url = `http://127.0.0.1:${capturePort}/ingest?rid=${encodeURIComponent(
                requestId
            )}&gen=${captureGeneration}&kind=${kind}&start=${start}&end=${end}&total=${total}`;
            const posted = await fetch(url, {
                method: "POST",
                body: body.subarray(start, end + 1),
                headers: { "Content-Type": "application/octet-stream" }
            });
            if (posted.status !== 204 && posted.status !== 200) {
                throw new Error(
                    `ingest ${kind} ${start}-${end} -> ${posted.status}`
                );
            }
            feed[kind] += end - start + 1;
        }
    };
    // Both kinds concurrently: the remux opens them as two inputs.
    void ingest("video", videoUrl);
    void ingest("audio", audioUrl);

    const deadline = Date.now() + GATE_TIMEOUT_MS;
    while (!started && Date.now() < deadline) await sleep(200);
    const gateMs = Date.now() - startedAt;

    if (!started) {
        console.error(
            `FAIL: mediaServerStarted never arrived within ${GATE_TIMEOUT_MS}ms` +
                ` (the Roku readiness gate never cleared)`
        );
        console.error(`events seen: ${events.length}`);
        for (const event of events.slice(-12)) console.error(`  ${event}`);
        bridge.kill("SIGTERM");
        process.exitCode = 1;
        return;
    }

    console.log(
        `mediaServerStarted after ${gateMs}ms: ${JSON.stringify(started)}`
    );
    const playlistUrl = `http://${started.localAddress}:${PORT}/${started.mediaPath}`;
    const playlist = await fetchText(playlistUrl);
    // Segment URLs carry the per-generation cache buster, exactly as the Roku
    // fetches them.
    const entries = (playlist.body.match(/^segment-\d+\.ts\?g=/gm) ?? [])
        .length;
    const hasEndList = playlist.body.includes("#EXT-X-ENDLIST");
    console.log(
        `served playlist: status=${playlist.status} entries=${entries}` +
            ` endList=${hasEndList}`
    );
    console.log(`playlist body:\n${playlist.body}`);

    // Every advertised segment must be servable, and the prebuffer (12) must be
    // there before the Roku is told to load.
    let servable = 0;
    const advertised = [
        ...playlist.body.matchAll(/^(segment-\d+\.ts\?g=[^\s]+)$/gm)
    ].map(m => m[1]);
    for (const name of advertised.slice(0, 14)) {
        const segment = await fetchText(
            `http://${started.localAddress}:${PORT}/${name}`
        );
        if (segment.status === 200 && segment.body.length > 0) servable++;
    }
    console.log(
        `servable: ${servable}/${Math.min(
            14,
            advertised.length
        )} advertised segments`
    );

    const ok = entries >= 12 && servable >= 12;
    console.log(
        ok
            ? `PASS: the Roku gate cleared with ${entries} segments advertised` +
                  ` and ${servable} servable`
            : `FAIL: entries=${entries} servable=${servable} (need 12+ of each)`
    );
    process.exitCode = ok ? 0 : 1;

    writeMessage(bridge, {
        subject: "bridge:stopMediaServer",
        data: { requestId, force: true }
    });
    await sleep(800);
    bridge.kill("SIGTERM");
    if (bridgeStderr.trim()) {
        console.error("--- bridge stderr (tail) ---");
        console.error(bridgeStderr.split("\n").slice(-15).join("\n"));
    }
}

main().catch(err => {
    console.error(`fatal: ${err.stack || err}`);
    process.exitCode = 1;
});
