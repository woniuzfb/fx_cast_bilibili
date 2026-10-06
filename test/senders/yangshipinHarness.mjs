#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ============================================================================
// 1. Channel definitions (PID -> ChannelId, Name, Defn) from iptv
// ============================================================================
export const CHANNELS_MAP = new Map([
    [
        "600001859",
        {
            id: "cctv1",
            name: "CCTV1综合",
            channelId: "2024078201",
            livePid: "600001859",
            defn: "fhd"
        }
    ],
    [
        "600001800",
        {
            id: "cctv2",
            name: "CCTV2财经",
            channelId: "2024075401",
            livePid: "600001800",
            defn: "fhd"
        }
    ],
    [
        "600001801",
        {
            id: "cctv3",
            name: "CCTV3综艺",
            channelId: "2024068501",
            livePid: "600001801",
            defn: "fhd"
        }
    ],
    [
        "600001814",
        {
            id: "cctv4",
            name: "CCTV4中文国际",
            channelId: "2029797101",
            livePid: "600001814",
            defn: "fhd"
        }
    ],
    [
        "600001818",
        {
            id: "cctv5",
            name: "CCTV5体育",
            channelId: "2024078401",
            livePid: "600001818",
            defn: "fhd"
        }
    ],
    [
        "600001817",
        {
            id: "cctv5p",
            name: "CCTV5+体育赛事",
            channelId: "2024078001",
            livePid: "600001817",
            defn: "fhd"
        }
    ],
    [
        "600108442",
        {
            id: "cctv6",
            name: "CCTV6电影",
            channelId: "2013693901",
            livePid: "600108442",
            defn: "fhd"
        }
    ],
    [
        "600004092",
        {
            id: "cctv7",
            name: "CCTV7国防军事",
            channelId: "2024072001",
            livePid: "600004092",
            defn: "fhd"
        }
    ],
    [
        "600001803",
        {
            id: "cctv8",
            name: "CCTV8电视剧",
            channelId: "2029793001",
            livePid: "600001803",
            defn: "fhd"
        }
    ],
    [
        "600004078",
        {
            id: "cctv9",
            name: "CCTV9纪录",
            channelId: "2024078601",
            livePid: "600004078",
            defn: "fhd"
        }
    ],
    [
        "600001805",
        {
            id: "cctv10",
            name: "CCTV10科教",
            channelId: "2024078701",
            livePid: "600001805",
            defn: "fhd"
        }
    ],
    [
        "600001806",
        {
            id: "cctv11",
            name: "CCTV11戏曲",
            channelId: "2027248701",
            livePid: "600001806",
            defn: "fhd"
        }
    ],
    [
        "600001807",
        {
            id: "cctv12",
            name: "CCTV12社会与法",
            channelId: "2027248801",
            livePid: "600001807",
            defn: "fhd"
        }
    ],
    [
        "600001811",
        {
            id: "cctv13",
            name: "CCTV13新闻",
            channelId: "2029797201",
            livePid: "600001811",
            defn: "fhd"
        }
    ],
    [
        "600001809",
        {
            id: "cctv14",
            name: "CCTV14少儿",
            channelId: "2027248901",
            livePid: "600001809",
            defn: "fhd"
        }
    ],
    [
        "600001815",
        {
            id: "cctv15",
            name: "CCTV15音乐",
            channelId: "2027249001",
            livePid: "600001815",
            defn: "fhd"
        }
    ],
    [
        "600098637",
        {
            id: "cctv16",
            name: "CCTV16奥林匹克",
            channelId: "2027249101",
            livePid: "600098637",
            defn: "fhd"
        }
    ],
    [
        "600099502",
        {
            id: "cctv164k",
            name: "CCTV16 4K",
            channelId: "2027249301",
            livePid: "600099502",
            defn: "fhd"
        }
    ],
    [
        "600001810",
        {
            id: "cctv17",
            name: "CCTV17农业农村",
            channelId: "2027249401",
            livePid: "600001810",
            defn: "fhd"
        }
    ],
    [
        "600002264",
        {
            id: "cctv4k",
            name: "CCTV4K超高清",
            channelId: "2029810301",
            livePid: "600002264",
            defn: "fhd"
        }
    ],
    [
        "600156816",
        {
            id: "cctv8k",
            name: "CCTV8K超高清",
            channelId: "2026774101",
            livePid: "600156816",
            defn: "fhd"
        }
    ]
]);

// ============================================================================
// 2. cKey v8.1 Generator (Standalone TEA cipher from iptv)
// ============================================================================
const PLATFORM = 4330403;
const APP_VERSION = "V8.22.1035.3031";
const CKEY_TEA_KEY = Buffer.from("59b2f7cf725ef43c34fdd7c123411ed3", "hex");
const GUARD_TEA_KEY = Buffer.from("110DBEC10C23E7D2E56A1CAD6914EF1B", "hex");
const CKEY_XOR = Buffer.from([
    0x84, 0x2e, 0xed, 0x08, 0xf0, 0x66, 0xe6, 0xea, 0x48, 0xb4, 0xca, 0xa9,
    0x91, 0xed, 0x6f, 0xf3
]);
const GUARD_XOR = Buffer.from([0xb3, 0xc9, 0x53, 0xa0, 0x69, 0x13, 0xad, 0x4d]);

function u32(v) {
    return v >>> 0;
}
function teaEncryptBlock(block, key) {
    let y = block.readUInt32BE(0);
    let z = block.readUInt32BE(4);
    const k = [0, 4, 8, 12].map(offset => key.readUInt32BE(offset));
    let sum = 0;
    for (let i = 0; i < 16; i++) {
        sum = u32(sum + 0x9e3779b9);
        y = u32(
            y + u32(u32((z << 4) + k[0]) ^ u32(z + sum) ^ u32((z >>> 5) + k[1]))
        );
        z = u32(
            z + u32(u32((y << 4) + k[2]) ^ u32(y + sum) ^ u32((y >>> 5) + k[3]))
        );
    }
    const out = Buffer.allocUnsafe(8);
    out.writeUInt32BE(y, 0);
    out.writeUInt32BE(z, 4);
    return out;
}
function checksum(buffer) {
    let value = 0;
    for (const byte of buffer)
        value = (Math.imul(0x83, value) + byte) & 0x7fffffff;
    return value >>> 0;
}
function encryptTeaPacket(input, key, random = randomBytes) {
    const padLength = (8 - ((input.length + 10) % 8)) % 8;
    const plain = Buffer.concat([
        Buffer.from([(random(1)[0] & 0xf8) | padLength]),
        random(padLength),
        random(2),
        input,
        Buffer.alloc(7)
    ]);
    const output = [];
    let previousPlain = Buffer.alloc(8);
    let previousCipher = Buffer.alloc(8);
    for (let offset = 0; offset < plain.length; offset += 8) {
        const source = Buffer.from(plain.subarray(offset, offset + 8));
        const mixed = Buffer.allocUnsafe(8);
        for (let i = 0; i < 8; i++) mixed[i] = source[i] ^ previousCipher[i];
        const encrypted = teaEncryptBlock(mixed, key);
        const cipher = Buffer.allocUnsafe(8);
        for (let i = 0; i < 8; i++) cipher[i] = encrypted[i] ^ previousPlain[i];
        output.push(cipher);
        previousPlain = mixed;
        previousCipher = cipher;
    }
    return Buffer.concat(output);
}
function lengthPrefixed(v) {
    const d = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8");
    const s = Buffer.allocUnsafe(2);
    s.writeUInt16BE(d.length);
    return Buffer.concat([s, d]);
}
function uint32(v) {
    const o = Buffer.allocUnsafe(4);
    o.writeUInt32BE(v >>> 0);
    return o;
}
function guardTail(v) {
    const t = String(v);
    return t.length >= 5 ? t.slice(-5) : "";
}
function createGuard(timestamp, guid, random) {
    const body = Buffer.concat([
        uint32(timestamp),
        lengthPrefixed(guardTail(guid)),
        lengthPrefixed(guardTail("null")),
        lengthPrefixed(guardTail("null")),
        lengthPrefixed("-1")
    ]);
    const plain = Buffer.concat([lengthPrefixed(body)]);
    const encrypted = Buffer.concat([
        encryptTeaPacket(plain, GUARD_TEA_KEY, random),
        uint32(checksum(plain))
    ]);
    for (let i = 0; i < encrypted.length; i++) encrypted[i] ^= GUARD_XOR[i & 7];
    return encrypted.toString("hex").toUpperCase();
}
function buildPacket({ channelId, timestamp, guid, guard, uid }) {
    const body = Buffer.concat([
        Buffer.from("0000004200000004000004d2", "hex"),
        uint32(PLATFORM),
        uint32(0),
        uint32(timestamp),
        lengthPrefixed("dcgh"),
        lengthPrefixed("_zj1A5Gh6QYcxWjIUGos2w=="),
        lengthPrefixed(APP_VERSION),
        lengthPrefixed(channelId),
        lengthPrefixed(guid),
        uint32(1),
        uint32(1),
        lengthPrefixed(uid),
        lengthPrefixed("nil"),
        lengthPrefixed("57eab0c4-2c58-44c6-8ae9-dd2757525dc5"),
        lengthPrefixed("nil"),
        lengthPrefixed("v0.1.000"),
        lengthPrefixed("com.cctv.yangshipin.app.iphone"),
        lengthPrefixed(String(PLATFORM)),
        lengthPrefixed("ex_json_bus"),
        lengthPrefixed("ex_json_vs"),
        lengthPrefixed(guard)
    ]);
    const packet = Buffer.allocUnsafe(body.length + 2);
    packet.writeUInt16BE(body.length, 0);
    body.copy(packet, 2);
    packet.writeUInt32BE(checksum(packet), 18);
    return packet;
}
function customBase64(buf) {
    return buf
        .toString("base64")
        .replace(/\+/g, "_")
        .replace(/\//g, "-")
        .replace(/=+$/g, "");
}
export function createCKey(channelId, options = {}) {
    const timestamp = Math.floor(Number(options.now ?? Date.now()) / 1000);
    const guid = options.guid || randomBytes(16).toString("hex");
    const random = options.randomBytes || randomBytes;
    const guard = createGuard(timestamp, guid, random);
    const uid = options.uid || randomBytes(4).toString("hex").toUpperCase();
    const packet = buildPacket({
        channelId: String(channelId),
        timestamp,
        guid,
        guard,
        uid
    });
    const encrypted = Buffer.concat([
        encryptTeaPacket(packet, CKEY_TEA_KEY, random),
        uint32(checksum(packet))
    ]);
    for (let i = 0; i < encrypted.length; i++) encrypted[i] ^= CKEY_XOR[i & 15];
    return {
        cKey: `--01${customBase64(encrypted)}`,
        guid,
        timestamp,
        flowId: `${randomUUID().toUpperCase()}_${PLATFORM}`
    };
}

// ============================================================================
// 3. Official Yangshipin API Request (Mobile / DLNA endpoint)
// ============================================================================
const API_URL = "https://bkliveinfo.ysp.cctv.cn/";
const H264_CAPABILITY = Buffer.from(
    "H(30:1080,60:1080|30:1080,60:1080)"
).toString("base64");
export const UPSTREAM_HEADERS = {
    "Accept": "application/vnd.apple.mpegurl,application/json,*/*",
    "Referer": "https://live.cctv.cn/",
    "User-Agent": "qqlive"
};

export async function requestPlayUrls(channel, timeoutMs = 8000) {
    const ticket = createCKey(channel.channelId);
    const query = new URLSearchParams({
        atime: "120",
        livepid: channel.livePid,
        cnlid: channel.channelId,
        appVer: "V8.22.1035.3031",
        app_version: "300090",
        caplv: "1",
        cmd: "2",
        defn: channel.defn || "fhd",
        device: "iPhone",
        encryptVer: "4.2",
        getpreviewinfo: "0",
        hevclv: "0",
        lang: "zh-Hans_CN",
        livequeue: "0",
        logintype: "1",
        nettype: "1",
        newnettype: "1",
        newplatform: String(PLATFORM),
        platform: String(PLATFORM),
        sdtfrom: "v3021",
        spacode: "23",
        spaudio: "1",
        spdemuxer: "6",
        spdrm: "2",
        spdynamicrange: "1",
        spflv: "1",
        spflvaudio: "1",
        sphdrfps: "60",
        sphttps: "1",
        spvcode: H264_CAPABILITY,
        spvideo: "4",
        stream: "1",
        system: "1",
        sysver: "ios18.2.1",
        uhd_flag: "0",
        cKey: ticket.cKey,
        guid: ticket.guid,
        fntick: String(ticket.timestamp),
        flowid: ticket.flowId,
        playbacktime: "0"
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${API_URL}?${query}`, {
            headers: { "User-Agent": "qqlive", "Accept": "application/json" },
            signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Number(data?.iretcode) !== 0)
            throw new Error(data?.errinfo || `iretcode ${data?.iretcode}`);
        const urls = [data.playurl];
        if (Array.isArray(data.backurl_list)) {
            for (const b of data.backurl_list) {
                if (b?.url) urls.push(b.url);
            }
        }
        return { urls: urls.filter(Boolean), payload: data };
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================================
// 4. Exact FFmpeg Validation from bridge/src/bridge/components/mediaServer.ts
//    (KEEPING -xerror INTACT AS REQUIRED BY ARCHITECTURE)
// ============================================================================
export function ffmpegSegmentDecodesCleanly(body, timeoutMs = 8000) {
    const ffmpegPath =
        [
            "/opt/homebrew/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/usr/bin/ffmpeg"
        ].find(p => fs.existsSync(p)) || "ffmpeg";

    return new Promise(resolve => {
        const child = spawn(
            ffmpegPath,
            [
                "-nostdin",
                "-v",
                "error",
                "-xerror",
                "-i",
                "pipe:0",
                "-progress",
                "pipe:1",
                "-nostats",
                "-f",
                "null",
                "-"
            ],
            { stdio: ["pipe", "pipe", "pipe"] }
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", chunk => {
            stdout = (stdout + String(chunk)).slice(-8000);
        });
        child.stderr?.on("data", chunk => {
            stderr = (stderr + String(chunk)).slice(-4000);
        });
        child.stdin?.on("error", () => {});

        let settled = false;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({ ok: false, detail: `timeout after ${timeoutMs}ms` });
        }, timeoutMs);

        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        child.on("error", err => finish({ ok: false, detail: err.message }));
        child.on("close", code => {
            const errorLines = stderr
                .split("\n")
                .map(line => line.trim())
                .filter(
                    line =>
                        line.length > 0 &&
                        !line.includes(
                            "Application provided invalid, non monotonically increasing dts to muxer"
                        ) &&
                        !line.startsWith("[null @")
                );
            if (code === 0 && errorLines.length === 0) {
                const durationValues = Array.from(
                    stdout.matchAll(/^out_time_(?:us|ms)=(\d+)$/gm)
                );
                let durationSeconds;
                if (durationValues.length > 0) {
                    const last = durationValues[durationValues.length - 1];
                    const raw = Number(last[1]);
                    if (Number.isFinite(raw)) {
                        durationSeconds = last[0].startsWith("out_time_us")
                            ? raw / 1_000_000
                            : raw / 1_000;
                    }
                }
                finish({ ok: true, durationSeconds });
            } else {
                finish({
                    ok: false,
                    detail: errorLines[0] || `ffmpeg exited with code ${code}`
                });
            }
        });

        child.stdin.write(body, () => {
            child.stdin.end();
        });
    });
}

// ============================================================================
// 5. ffprobe and NAL inspection
// ============================================================================
export function probeSegment(body) {
    const ffprobePath =
        [
            "/opt/homebrew/bin/ffprobe",
            "/usr/local/bin/ffprobe",
            "/usr/bin/ffprobe"
        ].find(p => fs.existsSync(p)) || "ffprobe";

    return new Promise(resolve => {
        const child = spawn(
            ffprobePath,
            [
                "-v",
                "warning",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-i",
                "pipe:0"
            ],
            { stdio: ["pipe", "pipe", "pipe"] }
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", c => {
            stdout += String(c);
        });
        child.stderr?.on("data", c => {
            stderr += String(c);
        });
        child.stdin?.on("error", () => {});
        child.on("close", code => {
            try {
                resolve({ code, data: JSON.parse(stdout), stderr });
            } catch (err) {
                resolve({ code, data: null, error: err.message, stderr });
            }
        });
        child.stdin.write(body, () => {
            child.stdin.end();
        });
    });
}

export function inspectNalUnits(buf) {
    let nalCounts = {};
    for (let i = 0; i < buf.length; i += 188) {
        if (buf[i] !== 0x47) continue;
        const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        if (pid === 256 || pid === 257 || pid === 0x100) {
            let o = i + 4;
            const afc = (buf[i + 3] >> 4) & 3;
            if (afc === 2) continue;
            if (afc === 3) o += 1 + buf[o];
            for (let j = o; j < i + 188 - 4; j++) {
                if (buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 1) {
                    const nalType = buf[j + 3] & 0x1f;
                    nalCounts[nalType] = (nalCounts[nalType] || 0) + 1;
                }
            }
        }
    }
    return nalCounts;
}

// ============================================================================
// 6. Test Runner Functionality
// ============================================================================
export async function testSegmentBuffer(buffer, label) {
    console.log(`\n======================================================`);
    console.log(`Testing Segment: ${label}`);
    console.log(`Byte size: ${buffer.length} bytes`);
    console.log(`------------------------------------------------------`);

    // 1. ffprobe analysis
    const probe = await probeSegment(buffer);
    if (probe.data) {
        const v = probe.data.streams?.find(s => s.codec_type === "video");
        const a = probe.data.streams?.find(s => s.codec_type === "audio");
        console.log(
            `[Stream] Video: codec=${v?.codec_name}, profile=${v?.profile}, resolution=${v?.width}x${v?.height}, fps=${v?.r_frame_rate}`
        );
        console.log(
            `[Stream] Audio: codec=${a?.codec_name}, sample_rate=${a?.sample_rate}Hz, channels=${a?.channels}`
        );
    } else {
        console.log(`[Stream] ffprobe failed: ${probe.stderr}`);
    }

    // 2. NAL inspection
    const nals = inspectNalUnits(buffer);
    console.log(
        `[NAL Units] Types found:`,
        nals,
        `(IDR type 5: ${nals["5"] || 0}, Slices type 1: ${nals["1"] || 0})`
    );

    // 3. Strict FFmpeg validation (-xerror intact!)
    const startedAt = Date.now();
    const validation = await ffmpegSegmentDecodesCleanly(buffer);
    const elapsedMs = Date.now() - startedAt;

    if (validation.ok) {
        console.log(
            `[FFmpeg -xerror] ✅ PASSED in ${elapsedMs}ms (decoded duration: ${validation.durationSeconds}s)`
        );
    } else {
        console.log(`[FFmpeg -xerror] ❌ FAILED in ${elapsedMs}ms`);
        console.log(`       Reason: ${validation.detail}`);
    }

    return validation;
}

export async function testSegmentFromUrl(segUrl, label) {
    const res = await fetch(segUrl, { headers: UPSTREAM_HEADERS });
    if (!res.ok) {
        console.log(`[Fetch] ❌ HTTP ${res.status} for ${segUrl}`);
        return { ok: false, detail: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return await testSegmentBuffer(buf, label);
}

export async function testPlaylistUrl(playlistUrl, maxSegs = 3) {
    console.log(`\n>>> Fetching Playlist: ${playlistUrl}`);
    const res = await fetch(playlistUrl, { headers: UPSTREAM_HEADERS });
    if (!res.ok) {
        console.error(`Failed to fetch playlist: HTTP ${res.status}`);
        return;
    }
    const text = await res.text();
    const lines = text.split("\n");
    const segLines = lines
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#"));
    console.log(`Found ${segLines.length} segments in playlist`);

    let passedCount = 0;
    let failedCount = 0;
    for (let i = 0; i < Math.min(maxSegs, segLines.length); i++) {
        const segUrl = new URL(segLines[i], playlistUrl).href;
        const result = await testSegmentFromUrl(
            segUrl,
            `#${i}: ${segLines[i].split("?")[0]}`
        );
        if (result.ok) passedCount++;
        else failedCount++;
    }

    console.log(
        `\nPlaylist Test Summary: ${passedCount} passed, ${failedCount} failed`
    );
}

// ============================================================================
// 7. CLI Entry Point
// ============================================================================
async function main() {
    const args = process.argv.slice(2);
    const getArg = flag => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : undefined;
    };

    const filePath = getArg("--file");
    const pid = getArg("--pid") || "600099502";
    const customUrl = getArg("--url");

    if (filePath) {
        console.log(`Loading file: ${filePath}`);
        const buf = fs.readFileSync(filePath);
        await testSegmentBuffer(buf, path.basename(filePath));
        return;
    }

    if (customUrl) {
        await testPlaylistUrl(customUrl);
        return;
    }

    // Default: Test channel by PID
    const chan = CHANNELS_MAP.get(pid);
    if (!chan) {
        console.error(`Unknown PID: ${pid}`);
        process.exit(1);
    }

    console.log(`\n======================================================`);
    console.log(`Testing Live Channel PID ${pid}: ${chan.name}`);
    console.log(
        `Requesting official live stream via bkliveinfo.ysp.cctv.cn...`
    );
    console.log(`======================================================`);

    try {
        const { urls } = await requestPlayUrls(chan);
        console.log(`Received ${urls.length} candidate URLs:`);
        urls.forEach((u, idx) => console.log(`  [${idx}] ${u}`));

        // Test the first working stream
        for (const u of urls) {
            console.log(`\nTrying candidate: ${u}`);
            try {
                await testPlaylistUrl(u, 2);
                break;
            } catch (err) {
                console.warn(
                    `Candidate failed: ${err.message}, trying next...`
                );
            }
        }
    } catch (err) {
        console.error(`requestPlayUrls failed:`, err);
    }
}

if (
    process.argv[1] &&
    import.meta.url.endsWith(path.basename(process.argv[1]))
) {
    main().catch(console.error);
}
