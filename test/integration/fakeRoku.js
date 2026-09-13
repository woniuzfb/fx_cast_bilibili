#!/usr/bin/env node
"use strict";

/**
 * A fake Roku: SSDP responder plus an ECP HTTP server.
 *
 * The discovery process finds Roku devices over real SSDP and then talks to
 * them over real ECP HTTP, so a cross-process harness needs a device to find.
 * This is that device, and it is deliberately a REAL socket implementation
 * rather than a stub inside the bridge: the point of this harness is to leave
 * every production path untouched, including the discovery and polling ones.
 *
 * Matched against the parsers in bridge/src/bridge/components/roku/ecp.ts:
 *   /query/device-info   -> must contain "<device-info"; serial-number decides
 *                           the device id (`roku-<serial>`)
 *   /query/media-player  -> state attribute + optional <position>/<duration>
 *   /query/active-app    -> <app id="...">Name</app>
 *   /keypress/<Key>      -> 200
 *
 * State is scriptable from the test through a small control HTTP server, and
 * also by writing the state file, so a test can assert on what the bridge did
 * (e.g. which keys were pressed) without reading bridge internals.
 *
 * Usage:
 *   node test/integration/fakeRoku.js --harness-dir <dir> [--ssdp-port 1900]
 *                                    [--ecp-port 8060] [--control-port 0]
 */

const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const SSDP_MULTICAST = "239.255.255.250";

function parseArgs(argv) {
    const args = {
        harnessDir: fs.mkdtempSync(path.join(os.tmpdir(), "fake-roku-")),
        ssdpPort: 1900,
        ecpPort: 8060,
        controlPort: 0,
        serial: "HARNESS0001",
        name: "Harness Roku"
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--harness-dir") args.harnessDir = argv[++i];
        else if (arg === "--ssdp-port") args.ssdpPort = Number(argv[++i]);
        else if (arg === "--ecp-port") args.ecpPort = Number(argv[++i]);
        else if (arg === "--control-port") args.controlPort = Number(argv[++i]);
        else if (arg === "--serial") args.serial = argv[++i];
        else if (arg === "--name") args.name = argv[++i];
        else throw new Error(`fakeRoku: unknown argument ${arg}`);
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(args.harnessDir, { recursive: true });

/**
 * What the fake device currently reports. `idle` is the interesting default:
 * the startup synthesis only exists because ECP can report idle while the
 * session has already registered HLS DVR media.
 */
let state = {
    playerState: "idle",
    position: undefined,
    duration: undefined,
    title: undefined
};

const requests = [];
const keypresses = [];

function record(file, value) {
    fs.appendFileSync(
        path.join(args.harnessDir, file),
        JSON.stringify(value) + "\n"
    );
}

function recordRequest(entry) {
    requests.push(entry);
    record("fake-roku-requests.ndjson", entry);
}

// --- ECP over HTTP --------------------------------------------------------

function xml(body) {
    return `<?xml version="1.0" encoding="UTF-8" ?>${body}`;
}

const ecp = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const at = Date.now();
    let body = "";
    let status = 200;

    if (url.pathname === "/query/device-info") {
        body = xml(
            `<device-info>` +
                `<udn>uuid:roku:ecp:${args.serial}</udn>` +
                `<serial-number>${args.serial}</serial-number>` +
                `<device-id>${args.serial}</device-id>` +
                `<friendly-device-name>${args.name}</friendly-device-name>` +
                `<user-device-name>${args.name}</user-device-name>` +
                `<model-name>Harness Roku 1</model-name>` +
                `<power-mode>PowerOn</power-mode>` +
                `</device-info>`
        );
    } else if (url.pathname === "/query/media-player") {
        const position =
            state.position === undefined
                ? ""
                : `<position>${state.position * 1000} ms</position>`;
        const duration =
            state.duration === undefined
                ? ""
                : `<duration>${state.duration * 1000} ms</duration>`;
        const title = state.title ? `<title>${state.title}</title>` : "";
        body = xml(
            `<media-player state="${state.playerState}">${position}${duration}${title}</media-player>`
        );
    } else if (url.pathname === "/query/active-app") {
        // The media player channel pretending to be Media Assistant (782875),
        // which is what resolvePlayerAppId prefers.
        body = xml(`<active-app><app id="782875">Media Assistant</app></active-app>`);
    } else if (url.pathname === "/query/apps") {
        body = xml(`<apps><app id="782875" type="md">Media Assistant</app></apps>`);
    } else if (url.pathname.startsWith("/keypress/")) {
        const key = decodeURIComponent(url.pathname.slice("/keypress/".length));
        keypresses.push({ key, at });
        record("fake-roku-keypresses.ndjson", { key, at, method: req.method });
        body = xml(`<ok/>`);
    } else if (url.pathname.startsWith("/launch/")) {
        record("fake-roku-launches.ndjson", {
            at,
            path: url.pathname,
            params: url.search
        });
        body = xml(`<ok/>`);
    } else {
        status = 404;
        body = xml(`<error>unknown path ${url.pathname}</error>`);
    }

    recordRequest({ at, method: req.method, path: url.pathname, status });
    res.writeHead(status, {
        "content-type": "text/xml; charset=utf-8",
        "content-length": Buffer.byteLength(body)
    });
    res.end(body);
});

// --- SSDP -----------------------------------------------------------------

const ssdp = dgram.createSocket({ type: "udp4", reuseAddr: true });

function ssdpResponse() {
    return [
        "HTTP/1.1 200 OK",
        `LOCATION: http://127.0.0.1:${args.ecpPort}/`,
        "CACHE-CONTROL: max-age=1800",
        "EXT:",
        "SERVER: Roku/9.4 UPnP/1.0 Roku/9.4",
        "ST: roku:ecp",
        `USN: uuid:roku:ecp:${args.serial}::roku:ecp`,
        "",
        ""
    ].join("\r\n");
}

function notifyAlive() {
    const message = [
        "NOTIFY * HTTP/1.1",
        `HOST: ${SSDP_MULTICAST}:${args.ssdpPort}`,
        "CACHE-CONTROL: max-age=1800",
        `LOCATION: http://127.0.0.1:${args.ecpPort}/`,
        "NT: roku:ecp",
        "NTS: ssdp:alive",
        "SERVER: Roku/9.4 UPnP/1.0 Roku/9.4",
        `USN: uuid:roku:ecp:${args.serial}::roku:ecp`,
        "",
        ""
    ].join("\r\n");
    const buffer = Buffer.from(message);
    ssdp.send(buffer, 0, buffer.length, args.ssdpPort, SSDP_MULTICAST, () => {});
}

ssdp.on("message", (buffer, rinfo) => {
    const message = buffer.toString("utf8");
    if (!/^M-SEARCH \* HTTP/i.test(message)) return;
    record("fake-roku-msearch.ndjson", {
        at: Date.now(),
        from: `${rinfo.address}:${rinfo.port}`,
        searchTarget: /^ST:\s*(.+)\r?$/im.exec(message)?.[1]?.trim()
    });
    // Reply unicast to whoever asked: that is what the bridge listens for.
    const response = Buffer.from(ssdpResponse());
    ssdp.send(response, 0, response.length, rinfo.port, rinfo.address, () => {});
});

ssdp.on("error", err => {
    // A second responder (or a system one) owning the port is not fatal: the
    // bridge also probes subnet broadcast when it cannot join the group.
    record("fake-roku-errors.ndjson", { at: Date.now(), error: err.message });
});

// --- control --------------------------------------------------------------

const control = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/state") {
        if (req.method === "POST") {
            let raw = "";
            req.on("data", chunk => {
                raw += chunk;
            });
            req.on("end", () => {
                try {
                    const patch = JSON.parse(raw);
                    state = { ...state, ...patch };
                    record("fake-roku-state.ndjson", { at: Date.now(), state });
                    res.writeHead(200).end(JSON.stringify(state));
                } catch (err) {
                    res.writeHead(400).end(String(err));
                }
            });
            return;
        }
        res.writeHead(200).end(JSON.stringify(state));
        return;
    }
    if (url.pathname === "/observations") {
        res.writeHead(200).end(
            JSON.stringify({ state, requests: requests.slice(-200), keypresses })
        );
        return;
    }
    res.writeHead(404).end("{}");
});

function ready() {
    ssdp.bind(args.ssdpPort, () => {
        try {
            ssdp.addMembership(SSDP_MULTICAST);
        } catch {
            // Unicast M-SEARCH replies still arrive without the membership.
        }
        ssdp.setMulticastLoopback(true);
        notifyAlive();
        setInterval(notifyAlive, 5000).unref?.();
    });
    ecp.listen(args.ecpPort, "127.0.0.1", () => {
        control.listen(args.controlPort, "127.0.0.1", () => {
            record("fake-roku-ready.ndjson", {
                at: Date.now(),
                pid: process.pid,
                ecpPort: args.ecpPort,
                ssdpPort: args.ssdpPort,
                controlPort: control.address().port
            });
            // Printed so a parent process can read the control port.
            console.log(
                JSON.stringify({
                    ready: true,
                    pid: process.pid,
                    controlPort: control.address().port,
                    ecpPort: args.ecpPort
                })
            );
        });
    });
}

ready();

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        record("fake-roku-shutdown.ndjson", { at: Date.now(), signal });
        try {
            ssdp.close();
        } catch {}
        try {
            ecp.close();
        } catch {}
        try {
            control.close();
        } catch {}
        process.exit(0);
    });
}
