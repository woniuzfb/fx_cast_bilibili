#!/usr/bin/env node
"use strict";
/**
 * Minimal castv2 driver: launch the Default Media Receiver on the real
 * Chromecast, LOAD a media URL and log every media-channel message plus the
 * receiver state. A standalone probe for receiver behaviour questions that do
 * not need the bridge (used to pin down the middle-window join rule; see
 * .workbuddy/memory/2026-09-16.md).
 *
 * Usage:
 *   node test/bridge/cast-drive.js --url URL [--host 10.0.0.140]
 *       [--current-time 2.888] [--duration 6022] [--observe-ms 15000]
 *       [--content-type application/x-mpegURL] [--keep-app]
 */
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const { Client } = require(path.join(REPO, "bridge/node_modules/castv2"));

const PORT = 8009;
const APP_ID = "CC1AD845";
const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA = "urn:x-cast:com.google.cast.media";

function parseArgs(argv) {
    const args = {
        host: "10.0.0.140",
        url: undefined,
        currentTime: 0,
        duration: undefined,
        observeMs: 15000,
        contentType: "application/x-mpegURL",
        keepApp: false
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--host") args.host = argv[++i];
        else if (argv[i] === "--url") args.url = argv[++i];
        else if (argv[i] === "--current-time")
            args.currentTime = Number(argv[++i]);
        else if (argv[i] === "--duration") args.duration = Number(argv[++i]);
        else if (argv[i] === "--observe-ms") args.observeMs = Number(argv[++i]);
        else if (argv[i] === "--content-type") args.contentType = argv[++i];
        else if (argv[i] === "--keep-app") args.keepApp = true;
        else throw new Error(`unknown arg ${argv[i]}`);
    }
    if (!args.url) throw new Error("--url required");
    return args;
}

const args = parseArgs(process.argv.slice(2));
const HOST = args.host;
const log = (...parts) =>
    console.log(`${new Date().toISOString().slice(11, 23)} ${parts.join(" ")}`);

let requestId = 1;
const client = new Client();
let receiverChannel;
let mediaChannel;
let sessionId;
let transportId;
let mediaSessionId;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs)
                return reject(new Error(`timeout waiting for ${label}`));
            setTimeout(check, 100);
        };
        check();
    });
}

async function main() {
    log(`connecting to ${HOST}:${PORT}...`);
    await new Promise((resolve, reject) => {
        client.connect({ host: HOST, port: PORT }, resolve);
        client.on("error", reject);
    });
    client.on("error", err => log(`client error: ${err.message}`));
    log("connected");

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
    heartbeat.on("message", message => {
        if (message.type === "PING") heartbeat.send({ type: "PONG" });
    });
    const pingTimer = setInterval(() => heartbeat.send({ type: "PING" }), 5000);

    receiverChannel = client.createChannel(
        "sender-0",
        "receiver-0",
        NS_RECEIVER,
        "JSON"
    );
    receiverChannel.on("message", message => {
        if (message.type === "RECEIVER_STATUS") {
            const app = (message.status.applications || []).find(
                a => a.appId === APP_ID
            );
            if (app && !sessionId) {
                sessionId = app.sessionId;
                transportId = app.transportId;
            }
            if (!app && sessionId) {
                log("receiver: app stopped");
                sessionId = undefined;
            }
        } else if (message.type !== "PING" && message.type !== "PONG") {
            log(`receiver msg: ${JSON.stringify(message).slice(0, 200)}`);
        }
    });

    // Stop any existing DMR instance for a clean slate.
    receiverChannel.send({ type: "GET_STATUS", requestId: requestId++ });
    await sleep(1500);
    if (sessionId) {
        log(`stopping existing app session ${sessionId}`);
        receiverChannel.send({
            type: "STOP",
            sessionId,
            requestId: requestId++
        });
        await waitFor(() => !sessionId, 10000, "app stop");
    }

    log("launching Default Media Receiver...");
    const launchId = requestId++;
    receiverChannel.send({
        type: "LAUNCH",
        appId: APP_ID,
        requestId: launchId
    });
    await waitFor(() => sessionId, 20000, "app launch");
    log(`app session ${sessionId} transport ${transportId}`);

    const transportConnection = client.createChannel(
        "sender-0",
        transportId,
        NS_CONNECTION,
        "JSON"
    );
    transportConnection.send({ type: "CONNECT" });
    const transportHeartbeat = client.createChannel(
        "sender-0",
        transportId,
        NS_HEARTBEAT,
        "JSON"
    );
    transportHeartbeat.on("message", message => {
        if (message.type === "PING") transportHeartbeat.send({ type: "PONG" });
    });

    mediaChannel = client.createChannel(
        "sender-0",
        transportId,
        NS_MEDIA,
        "JSON"
    );
    mediaChannel.on("message", message => {
        if (message.type === "MEDIA_STATUS") {
            for (const status of message.status || []) {
                mediaSessionId = status.mediaSessionId;
                log(
                    `MEDIA_STATUS playerState=${status.playerState}` +
                        ` currentTime=${status.currentTime}` +
                        (status.idleReason
                            ? ` idleReason=${status.idleReason}`
                            : "") +
                        (status.extendedStatus !== undefined
                            ? ` extended=${JSON.stringify(
                                  status.extendedStatus
                              )}`
                            : "")
                );
            }
        } else {
            log(`media msg: ${JSON.stringify(message).slice(0, 300)}`);
        }
    });

    const media = {
        contentId: args.url,
        contentType: args.contentType,
        streamType: "BUFFERED",
        metadata: { type: 0, metadataType: 0, title: "fx-cast experiment" }
    };
    if (Number.isFinite(args.duration)) media.duration = args.duration;

    log(`LOAD currentTime=${args.currentTime} url=${args.url}`);
    mediaChannel.send({
        type: "LOAD",
        requestId: requestId++,
        media,
        currentTime: args.currentTime,
        autoplay: true
    });

    await sleep(args.observeMs);

    if (!args.keepApp) {
        if (mediaSessionId !== undefined) {
            mediaChannel.send({
                type: "STOP",
                mediaSessionId,
                requestId: requestId++
            });
            await sleep(500);
        }
        if (sessionId) {
            receiverChannel.send({
                type: "STOP",
                sessionId,
                requestId: requestId++
            });
            await sleep(1500);
        }
    }
    clearInterval(pingTimer);
    try {
        client.close();
    } catch {}
    log("done");
    process.exit(0);
}

main().catch(err => {
    console.error(`fatal: ${err.stack || err}`);
    process.exit(1);
});
