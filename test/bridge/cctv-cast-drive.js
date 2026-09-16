#!/usr/bin/env node
"use strict";
/**
 * CCTV live relay (hlsLive) on-device driver.
 *
 * The DASH-remux harness drives `startDashRemuxServer`; this drives the OTHER
 * server the bridge can start, the CCTV live relay, and then LOADs the real
 * Chromecast at it exactly like the extension does. It exists because the two
 * relay modes (the synthetic DVR and nothing else so far) failed on-device with
 * "Receiver returned media error" after serving a SINGLE segment, and the
 * relay's own logs cannot say WHAT the receiver asked for: this logs every
 * relay HTTP request next to every receiver media message.
 *
 * Usage:
 *   node test/bridge/cctv-cast-drive.js --seed "<media playlist url>" [options]
 *   node test/bridge/cctv-cast-drive.js --master "<master playlist url>" [options]
 *
 *   --seed URL        the page's own CCTV media playlist (m3u8) to relay
 *   --master URL      a master playlist; its first variant is used
 *   --host IP         Chromecast address (default 10.0.0.140)
 *   --current-time N  LOAD position (default 0, what the sender sends)
 *   --observe-ms N    how long to watch (default 30000)
 *   --keep            leave the receiver app running instead of stopping it
 *   --no-cast         start the relay and probe the playlist only (no device)
 *
 * What to read: the playlist the relay serves, how many segments the receiver
 * actually fetches, whether any came back 503, and the first MEDIA_STATUS
 * after the LOAD.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const CHROMECAST_PORT = 8009;
const APP_ID = "CC1AD845";
const MEDIA_PORT = 9556;
const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA = "urn:x-cast:com.google.cast.media";

function parseArgs(argv) {
    const args = {
        host: "10.0.0.140",
        seed: undefined,
        master: undefined,
        currentTime: 0,
        observeMs: 30000,
        keep: false,
        noCast: false
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--host") args.host = argv[++i];
        else if (argv[i] === "--seed") args.seed = argv[++i];
        else if (argv[i] === "--master") args.master = argv[++i];
        else if (argv[i] === "--current-time")
            args.currentTime = Number(argv[++i]);
        else if (argv[i] === "--observe-ms") args.observeMs = Number(argv[++i]);
        else if (argv[i] === "--keep") args.keep = true;
        else if (argv[i] === "--no-cast") args.noCast = true;
        else if (argv[i] === "--url") args.url = argv[++i];
        else if (argv[i] === "--no-relay") args.noRelay = true;
        else throw new Error(`unknown arg ${argv[i]}`);
    }
    if (!args.seed && !args.master && !process.argv.includes("--no-relay"))
        throw new Error("--seed, --master or --no-relay required");
    return args;
}

const args = parseArgs(process.argv.slice(2));
/** `--url URL --no-relay`: cast an arbitrary URL through the same handshake. */
const DIRECT_URL = (() => {
    const i = process.argv.indexOf("--url");
    return i >= 0 ? process.argv[i + 1] : undefined;
})();
const NO_RELAY = process.argv.includes("--no-relay");
const log = (...parts) =>
    console.log(`${new Date().toISOString().slice(11, 23)} ${parts.join(" ")}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REFERER = "https://tv.cctv.com/live/cctv5/";
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

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

async function resolveSeed() {
    if (args.seed) return args.seed;
    const response = await fetch(args.master, {
        headers: { Referer: REFERER, "User-Agent": USER_AGENT }
    });
    const body = await response.text();
    const variant = body
        .split("\n")
        .map(line => line.trim())
        .find(line => line && !line.startsWith("#"));
    if (!variant) throw new Error("master playlist has no variant");
    return new URL(variant, args.master).href;
}

function fetchText(url, headers) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, res => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", c => (body += c));
            res.on("end", () =>
                resolve({ status: res.statusCode, body, headers: res.headers })
            );
        }).on("error", reject);
    });
}

function castLoad(url, currentTime, observeMs, opts = {}) {
    const { Client } = require(path.join(REPO, "bridge/node_modules/castv2"));
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
                    if (sessionId && receiverChannel && !opts.keep)
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
                }, 1000);
            }, 300);
        };

        client.connect({ host: args.host, port: CHROMECAST_PORT }, () => {
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
            pingTimer = setInterval(() => {
                try {
                    heartbeat.send({ type: "PING" });
                } catch {}
            }, 5000);

            receiverChannel = client.createChannel(
                "sender-0",
                "receiver-0",
                NS_RECEIVER,
                "JSON"
            );
            const sendLoad = app => {
                sessionId = app.sessionId;
                log(`app session ${sessionId} transport ${app.transportId}`);
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
                            else if (s.idleReason === "ERROR") finish("ERROR");
                        }
                        return;
                    }
                    events.push(`media ${JSON.stringify(mm).slice(0, 200)}`);
                    log(`media msg: ${JSON.stringify(mm).slice(0, 200)}`);
                    if (mm.type === "LOAD_FAILED") finish("LOAD_FAILED");
                });
                log(`LOAD currentTime=${currentTime} url=${url}`);
                mediaChannel.send({
                    type: "LOAD",
                    requestId: requestId++,
                    media: {
                        contentId: url,
                        contentType: "application/x-mpegURL",
                        streamType: "BUFFERED",
                        duration: 7200,
                        metadata: {
                            type: 0,
                            metadataType: 0,
                            title: "cctv relay probe"
                        }
                    },
                    currentTime,
                    autoplay: true
                });
            };
            receiverChannel.on("message", m => {
                if (m.type !== "RECEIVER_STATUS") return;
                const app = (m.status.applications || []).find(
                    a => a.appId === APP_ID
                );
                if (!app && sessionId) sessionId = undefined;
                if (app && !sessionId) sendLoad(app);
            });
            // Explicit launch handshake (the sequence cast-drive.js uses): stop a
            // leftover app instance first, then LAUNCH and LOAD once the app is
            // reported. Without this a stale session silently swallowed the LOAD
            // and the harness measured nothing.
            receiverChannel.send({ type: "GET_STATUS", requestId: requestId++ });
            sleep(1200).then(async () => {
                if (sessionId) {
                    log(`stopping existing app session ${sessionId}`);
                    const stale = sessionId;
                    sessionId = undefined;
                    receiverChannel.send({
                        type: "STOP",
                        sessionId: stale,
                        requestId: requestId++
                    });
                    await sleep(1500);
                }
                log("launching Default Media Receiver...");
                receiverChannel.send({
                    type: "LAUNCH",
                    appId: APP_ID,
                    requestId: requestId++
                });
            });
            observeTimer = setTimeout(() => finish("OBSERVE_TIMEOUT"), observeMs);
        });
        client.on("error", err => reject(err));
    });
}

async function main() {
    if (NO_RELAY) {
        if (!DIRECT_URL) throw new Error("--no-relay needs --url");
        log(`direct cast (no relay): ${DIRECT_URL}`);
        const result = await castLoad(
            DIRECT_URL,
            args.currentTime,
            args.observeMs,
            { keep: args.keep }
        );
        log(`outcome: ${result.outcome}`);
        process.exit(0);
    }
    const seed = await resolveSeed();
    log(`seed: ${seed}`);

    const harnessDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cctv-harness-")
    );
    process.on("exit", () => {
        try {
            fs.rmSync(harnessDir, { recursive: true, force: true });
        } catch {}
    });
    const bridgeBuildDir = path.join(harnessDir, "bridge");
    const { spawnSync } = require("child_process");
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
            `bridge build failed: ${String(built.stderr || built.stdout).slice(-500)}`
        );
    }
    const bridge = spawn("node", [path.join(bridgeBuildDir, "src/main.js")], {
        cwd: path.join(REPO, "bridge"),
        env: {
            ...process.env,
            // The build lands in a temp dir with no node_modules of its own, so
            // runtime deps (yargs) resolve from the checkout.
            NODE_PATH: path.join(REPO, "bridge/node_modules")
        },
        stdio: ["pipe", "pipe", "pipe"]
    });
    bridge.stdin.on("error", () => {});
    let bridgeStderr = "";
    bridge.stderr.on("data", chunk => {
        bridgeStderr = (bridgeStderr + String(chunk)).slice(-6000);
    });
    process.on("exit", () => {
        if (bridgeStderr.trim()) {
            console.error("--- bridge stderr (tail) ---");
            console.error(bridgeStderr.split("\n").slice(-25).join("\n"));
        }
    });

    const requestId = `cctv-${Date.now().toString(36)}`;
    let started;
    const relayRequests = [];
    attachReader(bridge, message => {
        if (message.subject === "mediaCast:relayDebug") {
            const d = message.data ?? {};
            const event = String(d.event ?? "");
            if (event === "relay request") {
                relayRequests.push(d);
                log(`relay ${d.method} ${d.path}`);
            } else if (
                /playlist|ready|served|unavailable|404|monitor|supply/.test(
                    event
                )
            ) {
                const { requestId: _ignored, event: _event, ...rest } = d;
                log(`relay ${event}: ${JSON.stringify(rest).slice(0, 400)}`);
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
        }
    });

    writeMessage(bridge, {
        subject: "bridge:startRemoteMediaServer",
        data: {
            requestId,
            mediaUrl: seed,
            referer: REFERER,
            contentType: "application/x-mpegURL",
            port: MEDIA_PORT,
            startTime: 0,
            hlsLive: true,
            userAgent: USER_AGENT,
            cctvDebugEnabled: true
        }
    });

    const deadline = Date.now() + 90000;
    while (!started && Date.now() < deadline) await sleep(200);
    if (!started) throw new Error("live relay never became ready");

    const playlistUrl = `http://${started.localAddress}:${MEDIA_PORT}/${started.mediaPath}`;
    const playlist = await fetchText(playlistUrl);
    const entries = [...playlist.body.matchAll(/^\/seg\?u=/gm)].length;
    log(
        `served playlist: status=${playlist.status} bytes=${playlist.body.length} entries=${entries}`
    );
    log(`served playlist head:\n${playlist.body.split("\n").slice(0, 14).join("\n")}`);
    const padEntries = (playlist.body.match(/^pad\.ts$/gm) ?? []).length;
    log(`pad entries in served playlist: ${padEntries}`);
    if (padEntries > 0) {
        const pad = await fetchText(
            `http://${started.localAddress}:${MEDIA_PORT}/pad.ts`
        );
        log(
            `pad.ts: status=${pad.status} bytes=${String(pad.body.length)}` +
                ` type=${pad.headers["content-type"]}`
        );
    }
    log(`served playlist tail:\n${playlist.body.split("\n").slice(-4).join("\n")}`);

    // Which of the advertised entries are actually servable right now, and how
    // long does the relay take to answer? Indexes sampled across the timeline.
    const segUrls = [
        ...playlist.body.matchAll(/^(\/seg\?u=[^\s]+)$/gm)
    ].map(m => m[1]);
    for (const index of [0, 1, entries - 1, Math.floor(entries / 2)]) {
        const target = segUrls[index];
        if (!target) continue;
        const startedAt = Date.now();
        const response = await fetchText(
            `http://${started.localAddress}:${MEDIA_PORT}${target}`
        );
        log(
            `sample entry[${index}]: status=${response.status} bytes=${String(
                response.body.length
            )} in ${Date.now() - startedAt}ms`
        );
    }

    if (!args.noCast) {
        const result = await castLoad(
            playlistUrl,
            args.currentTime,
            args.observeMs,
            { keep: args.keep }
        );
        log(`outcome: ${result.outcome}`);
        const byIndex = new Map();
        for (const request of relayRequests) {
            if (request.path !== "/seg") continue;
        }
        log(`relay /seg requests: ${relayRequests.filter(r => r.path === "/seg").length}`);
    }

    writeMessage(bridge, {
        subject: "bridge:stopMediaServer",
        data: { requestId, force: true }
    });
    await sleep(1000);
    bridge.kill("SIGTERM");
    await sleep(300);
    process.exit(0);
}

main().catch(err => {
    console.error(`fatal: ${err.stack || err}`);
    process.exit(1);
});
