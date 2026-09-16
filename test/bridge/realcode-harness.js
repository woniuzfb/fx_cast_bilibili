#!/usr/bin/env node
"use strict";
/**
 * Real-code, real-device harness for the Chromecast DASH remux startup path.
 *
 * Drives the REAL bridge (compiled output, stdio native messaging) through the
 * REAL startRemoteMediaServer -> startDashRemuxServer path (real ffmpeg args,
 * real playlist rewriting, real pads, real windowing), then LOADs the REAL
 * Chromecast through castv2 exactly like the extension does, and observes the
 * outcome. This is the instrument that pinned down the Default Media
 * Receiver's middle-window join rule and validated the production fix
 * (startup pad runway + playlist windowing + presentationStartTime offset).
 * Root cause and findings: .workbuddy/memory/2026-09-16.md.
 *
 * The harness builds its OWN private copy of the bridge into a per-run temp
 * directory before every run (the same approach as
 * test/integration/sessionHarness.js), so it always exercises the current
 * working tree and never reads dist/ or an installed bridge. Nothing is ever
 * written into the repository: all scratch (the build, the probe segment)
 * lives in that temp directory and is removed on exit.
 *
 * Usage:
 *   node test/bridge/realcode-harness.js --start-time 2.9 --label early
 *   node test/bridge/realcode-harness.js --start-time 1436.4925 --label mid
 *   # Legacy A/B mode: isolate the windowing/pads mechanisms through the
 *   # proxy (the production bridge now has both built in):
 *   node test/bridge/realcode-harness.js --start-time 2.9 --label w \
 *       --window-proxy [--inject-pads 16] [--proxy-runway 12]
 *
 * Reading a run: LOAD -> playlist (chromecastWindowed* debug fields) -> the
 * receiver fetches pad.ts (it joins at the window middle) -> segment-000000
 * (the seek to the LOAD position accepted) -> BUFFERING t=<position> -> PLAYING.
 * Reports that stay at t=0 mean the seek was rejected (middle-window rule).
 *
 * Options:
 *   --host <ip>        Chromecast address (default 10.0.0.140)
 *   --bvid <id>        Bilibili video id (default BV1szuWzjE5y)
 *   --cid <id>         Bilibili cid (default 31065573226)
 *   --start-time <s>   page position to start the remux at
 *   --label <name>     log prefix + snapshot dir name
 *   --observe-ms <ms>  give up after this long without PLAYING/ERROR
 *   --reloads <n>      re-LOAD attempts on LOAD_FAILED (warm app session)
 *   --no-current-time  LOAD without a currentTime (control experiment)
 *   --load-delay <ms>  wait before LOAD (let the remux balloon the playlist)
 *   --window-proxy     serve the playlist through window-proxy.js (A/B)
 *   --proxy-runway n   windowed runway in 5s segments (default 12)
 *   --inject-pads n    inject n 4s pad entries via the proxy (LOAD shifts too)
 */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");

const CHROMECAST_PORT = 8009;
const APP_ID = "CC1AD845";
const MEDIA_PORT = 9557;
const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA = "urn:x-cast:com.google.cast.media";

function parseArgs(argv) {
    const args = {
        host: "10.0.0.140",
        bvid: "BV1szuWzjE5y",
        cid: 31065573226,
        startTime: 2.9,
        label: "run",
        observeMs: 18000,
        windowProxy: false,
        reloads: 0,
        noCurrentTime: false,
        loadDelayMs: 0,
        injectPads: 0
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--host") args.host = argv[++i];
        else if (argv[i] === "--bvid") args.bvid = argv[++i];
        else if (argv[i] === "--cid") args.cid = Number(argv[++i]);
        else if (argv[i] === "--start-time") args.startTime = Number(argv[++i]);
        else if (argv[i] === "--label") args.label = argv[++i];
        else if (argv[i] === "--observe-ms") args.observeMs = Number(argv[++i]);
        else if (argv[i] === "--window-proxy") args.windowProxy = true;
        else if (argv[i] === "--reloads") args.reloads = Number(argv[++i]);
        else if (argv[i] === "--no-current-time") args.noCurrentTime = true;
        else if (argv[i] === "--proxy-runway")
            args.proxyRunway = Number(argv[++i]);
        else if (argv[i] === "--load-delay")
            args.loadDelayMs = Number(argv[++i]);
        else if (argv[i] === "--inject-pads")
            args.injectPads = Number(argv[++i]);
        else throw new Error(`unknown arg ${argv[i]}`);
    }
    return args;
}
const args = parseArgs(process.argv.slice(2));
const CHROMECAST_HOST = args.host;
const { Client } = require(path.join(REPO, "bridge/node_modules/castv2"));
const log = (...parts) =>
    console.log(
        `${new Date().toISOString().slice(11, 23)} [${args.label}] ${parts.join(
            " "
        )}`
    );
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- native messaging codec -------------------------------------------
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
            } catch (err) {
                log(`decode error: ${err.message}`);
            }
        }
    });
}

// --- playurl ------------------------------------------------------------
async function fetchPlayurl() {
    const url =
        `https://api.bilibili.com/x/player/playurl?bvid=${args.bvid}&cid=${args.cid}` +
        `&qn=32&fnval=16&fnver=0`;
    const response = await fetch(url, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
            "Referer": `https://www.bilibili.com/video/${args.bvid}/`
        }
    });
    const data = (await response.json()).data;
    const videos = (data.dash.video || []).filter(v =>
        v.codecs.startsWith("avc1")
    );
    // Prefer the 480P AVC rendition (avc1.640033, High@5.1 - same stamping as
    // the 1080P one the real cast captured).
    const video = videos.find(v => v.id === 32) || videos[0];
    const audios = data.dash.audio || [];
    const audio = audios.find(a => a.id === 30280) || audios[0];
    if (!video || !audio) throw new Error("no avc video/audio rendition");
    return { videoUrl: video.baseUrl, audioUrl: audio.baseUrl };
}

// --- castv2 driver ------------------------------------------------------
function castLoad(url, currentTime, duration, observeMs, opts = {}) {
    const attempts = opts.reloads !== undefined ? opts.reloads + 1 : 1;
    const sendCurrentTime = !opts.noCurrentTime;
    return new Promise((resolve, reject) => {
        const client = new Client();
        const events = [];
        let requestId = 1;
        let sessionId;
        let mediaSessionId;
        let mediaChannel;
        let receiverChannel;
        let pingTimer;
        let done = false;
        let attempt = 0;
        let observeTimer;

        const finish = outcome => {
            if (done) return;
            done = true;
            if (pingTimer) clearInterval(pingTimer);
            if (observeTimer) clearTimeout(observeTimer);
            try {
                if (mediaSessionId !== undefined && mediaChannel)
                    mediaChannel.send({
                        type: "STOP",
                        mediaSessionId,
                        requestId: requestId++
                    });
            } catch {}
            setTimeout(() => {
                try {
                    if (sessionId && receiverChannel)
                        receiverChannel.send({
                            type: "STOP",
                            sessionId,
                            requestId: requestId++
                        });
                } catch {}
                setTimeout(() => {
                    try {
                        client.close();
                    } catch {}
                    resolve({ outcome, events });
                }, 1200);
            }, 400);
        };

        client.connect({ host: CHROMECAST_HOST, port: CHROMECAST_PORT }, () => {
            const connection = client.createChannel(
                "sender-0",
                "receiver-0",
                NS_CONNECTION,
                "JSON"
            );
            connection.send({ type: "CONNECT" });
            const heartbeat = client.createChannel(
                "sender-0",
                "receiver-0",
                NS_HEARTBEAT,
                "JSON"
            );
            heartbeat.on("message", m => {
                if (m.type === "PING") heartbeat.send({ type: "PONG" });
            });
            const heartbeat0 = heartbeat;
            pingTimer = setInterval(() => {
                try {
                    heartbeat0.send({ type: "PING" });
                } catch {}
            }, 5000);

            receiverChannel = client.createChannel(
                "sender-0",
                "receiver-0",
                NS_RECEIVER,
                "JSON"
            );
            receiverChannel.on("message", m => {
                if (m.type === "RECEIVER_STATUS") {
                    const app = (m.status.applications || []).find(
                        a => a.appId === APP_ID
                    );
                    if (app && !sessionId) {
                        sessionId = app.sessionId;
                        const transportConnection = client.createChannel(
                            "sender-0",
                            app.transportId,
                            NS_CONNECTION,
                            "JSON"
                        );
                        transportConnection.send({ type: "CONNECT" });
                        const transportHeartbeat = client.createChannel(
                            "sender-0",
                            app.transportId,
                            NS_HEARTBEAT,
                            "JSON"
                        );
                        transportHeartbeat.on("message", hm => {
                            if (hm.type === "PING")
                                transportHeartbeat.send({ type: "PONG" });
                        });
                        mediaChannel = client.createChannel(
                            "sender-0",
                            app.transportId,
                            NS_MEDIA,
                            "JSON"
                        );
                        mediaChannel.on("message", mm => {
                            if (mm.type === "MEDIA_STATUS") {
                                for (const s of mm.status || []) {
                                    mediaSessionId = s.mediaSessionId;
                                    const line =
                                        `MEDIA_STATUS ${s.playerState}` +
                                        ` t=${s.currentTime}` +
                                        (s.idleReason
                                            ? ` idleReason=${s.idleReason}`
                                            : "");
                                    events.push(line);
                                    log(line);
                                    if (s.playerState === "PLAYING")
                                        finish("PLAYING");
                                    else if (s.idleReason === "ERROR")
                                        finish("ERROR");
                                }
                            } else {
                                events.push(
                                    `media ${JSON.stringify(mm).slice(0, 160)}`
                                );
                                log(
                                    `media msg: ${JSON.stringify(mm).slice(
                                        0,
                                        160
                                    )}`
                                );
                                if (mm.type === "LOAD_FAILED") {
                                    // Re-LOAD on the same (warm) app session to
                                    // distinguish cold-start effects from a
                                    // load-inherent failure.
                                    attempt++;
                                    if (attempt < attempts) {
                                        log(
                                            `LOAD_FAILED; re-LOAD attempt ${
                                                attempt + 1
                                            }/${attempts}`
                                        );
                                        mediaSessionId = undefined;
                                        sendLoad();
                                    } else {
                                        finish("LOAD_FAILED");
                                    }
                                }
                            }
                        });
                        const sendLoad = () => {
                            const media = {
                                contentId: url,
                                contentType: "application/x-mpegURL",
                                streamType: "BUFFERED",
                                metadata: {
                                    type: 0,
                                    metadataType: 0,
                                    title: `harness ${args.label}`
                                }
                            };
                            if (Number.isFinite(duration))
                                media.duration = duration;
                            const load = {
                                type: "LOAD",
                                requestId: requestId++,
                                media,
                                autoplay: true
                            };
                            if (sendCurrentTime) {
                                load.currentTime = currentTime;
                                log(`LOAD currentTime=${currentTime} ${url}`);
                            } else {
                                log(`LOAD (no currentTime) ${url}`);
                            }
                            mediaChannel.send(load);
                            if (observeTimer) clearTimeout(observeTimer);
                            observeTimer = setTimeout(
                                () => finish("TIMEOUT"),
                                observeMs
                            );
                        };
                        sendLoad();
                    }
                }
            });
            receiverChannel.send({
                type: "LAUNCH",
                appId: APP_ID,
                requestId: requestId++
            });
        });
        client.on("error", err => {
            log(`cast client error: ${err.message}`);
            finish("CAST_ERROR");
        });
    });
}

// --- main ---------------------------------------------------------------
async function main() {
    // Private bridge build, per run (same approach as sessionHarness.js): a
    // fresh temp copy compiled from the working tree, so the harness never
    // reads dist/, an installed bridge, or a possibly-stale prebuilt dir.
    // EVERYTHING the harness writes (the build, the probe segment) lives in
    // this one per-run temp dir, removed on every exit path - the harness
    // never writes into the repository.
    const harnessDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-harness-bridge-")
    );
    process.on("exit", () => {
        try {
            fs.rmSync(harnessDir, { recursive: true, force: true });
        } catch {}
    });
    const bridgeBuildDir = path.join(harnessDir, "bridge");
    {
        const built = spawnSync(
            process.execPath,
            [
                path.join(REPO, "bridge/bin/build.js"),
                "--out-dir",
                bridgeBuildDir
            ],
            {
                cwd: REPO,
                // build.js spawns bare `tsc` through a shell and does not
                // check its status: without the bridge's node_modules/.bin on
                // PATH it exits 0 with an EMPTY output tree. Put tsc on PATH
                // and assert the artifact below.
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
                `harness bridge build failed: ${String(
                    built.stderr || built.stdout
                ).slice(-600)}`
            );
        }
        log(`bridge build (private): ${bridgeBuildDir}`);
    }
    const BRIDGE_MAIN = path.join(bridgeBuildDir, "src/main.js");

    const { videoUrl, audioUrl } = await fetchPlayurl();
    log(
        `video host=${new URL(videoUrl).hostname} audio host=${
            new URL(audioUrl).hostname
        }`
    );

    const bridge = spawn("node", [BRIDGE_MAIN], {
        cwd: path.join(REPO, "bridge"),
        env: {
            ...process.env,
            NODE_PATH: path.join(REPO, "bridge/node_modules")
        },
        stdio: ["pipe", "pipe", "inherit"]
    });
    log(`bridge pid=${bridge.pid}`);
    // Swallow EPIPE when the bridge dies first (e.g. on the abort path).
    bridge.stdin.on("error", () => {});

    const requestId = `harness-${args.label}-${Date.now().toString(36)}`;
    let started;
    const bridgeMessages = [];

    attachReader(bridge, message => {
        if (message.subject === "main:dashRemuxDebug") {
            const d = message.data;
            if (
                d.event === "response" ||
                d.event === "playlist" ||
                d.event === "segment"
            ) {
                log(`remux ${d.event}: ${d.details ?? ""}`);
            } else if (d.event === "ffmpeg") {
                log(`remux ffmpeg: ${d.details ?? ""}`);
            }
            return;
        }
        if (
            message.subject === "mediaCast:mediaServerStarted" &&
            message.data.requestId === requestId
        ) {
            started = message.data;
            log(`mediaServerStarted: ${JSON.stringify(started)}`);
            return;
        }
        if (message.subject === "mediaCast:mediaServerError") {
            log(`mediaServerError: ${JSON.stringify(message.data)}`);
            return;
        }
        if (message.subject === "main:bilibiliCaptureOverflow") {
            log(`captureOverflow: ${JSON.stringify(message.data)}`);
            return;
        }
    });

    writeMessage(bridge, {
        subject: "bridge:startRemoteMediaServer",
        data: {
            requestId,
            mediaUrl: videoUrl,
            audioUrl,
            referer: "https://www.bilibili.com/",
            contentType: "application/x-mpegURL",
            port: MEDIA_PORT,
            startTime: args.startTime,
            hlsLive: false,
            rokuDashPrebuffer: false
        }
    });
    log(`startRemoteMediaServer startTime=${args.startTime}`);

    const deadline = Date.now() + 60000;
    while (!started && Date.now() < deadline) await sleep(200);
    if (!started) throw new Error("media server never started");

    // Sanity: the remux output must identify its audio codec - a bad CDN
    // mirror once produced an unidentifiable audio stream ("unknown") that
    // fails the load on its own and poisons the experiment.
    const directUrl = `http://${started.localAddress}:${MEDIA_PORT}/${started.mediaPath}`;
    {
        const probe = await fetch(
            directUrl.replace("index.m3u8", "segment-000000.ts")
        );
        const buffer = Buffer.from(await probe.arrayBuffer());
        const probePath = path.join(harnessDir, `probe-${args.label}.ts`);
        fs.writeFileSync(probePath, buffer);
        // Note: ffprobe csv may emit the codec line twice on these files;
        // require every reported line to be "aac".
        const codecs = require("child_process")
            .execSync(
                `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 ${probePath}`
            )
            .toString()
            .split("\n")
            .map(s => s.trim())
            .filter(Boolean);
        log(`remux audio codec(s): ${codecs.join(",") || "(none)"}`);
        if (codecs.length === 0 || codecs.some(c => c !== "aac")) {
            log("ABORT: audio stream is not aac (bad CDN mirror?)");
            bridge.kill("SIGKILL");
            process.exit(2);
        }
    }

    let loadUrl = directUrl;
    let proxyProcess;
    if (args.windowProxy) {
        const proxyPort = 9958;
        proxyProcess = spawn(
            "node",
            [
                path.join(__dirname, "window-proxy.js"),
                directUrl,
                String(proxyPort),
                String(started.startTime),
                String(args.proxyRunway !== undefined ? args.proxyRunway : 12),
                String(args.injectPads)
            ],
            { stdio: ["ignore", "inherit", "inherit"] }
        );
        await sleep(300);
        if (proxyProcess.exitCode !== null)
            throw new Error(
                `window proxy died (exit ${proxyProcess.exitCode})`
            );
        loadUrl = `http://${started.localAddress}:${proxyPort}/${started.mediaPath}`;
        log(`window proxy on ${loadUrl}`);
    }

    // Faithful to production: the extension LOADs right when the server is
    // ready (the playlist already carries minimumPlaylistDuration of media),
    // at the bridge's presentationStartTime (the padded-timeline position)
    // with the duration extended by the same presentation offset.
    const presentationStart =
        started.presentationStartTime !== undefined
            ? started.presentationStartTime
            : started.startTime + args.injectPads * 4;
    const presentationOffset = presentationStart - started.startTime;
    if (args.loadDelayMs > 0) {
        log(`waiting ${args.loadDelayMs}ms before LOAD (let the remux finish)`);
        await sleep(args.loadDelayMs);
    }
    const result = await castLoad(
        loadUrl,
        presentationStart,
        started.pageDuration + presentationOffset,
        args.observeMs,
        { reloads: args.reloads, noCurrentTime: args.noCurrentTime }
    );
    log(`outcome: ${result.outcome}`);
    if (proxyProcess) proxyProcess.kill("SIGTERM");

    writeMessage(bridge, {
        subject: "bridge:stopMediaServer",
        data: { requestId, force: true }
    });
    await sleep(1500);
    bridge.kill("SIGTERM");
    await sleep(500);
    process.exit(0);
}

main().catch(err => {
    console.error(`fatal: ${err.stack || err}`);
    process.exit(1);
});
