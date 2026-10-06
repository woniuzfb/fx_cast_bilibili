/**
 * Yangshipin (CCTV) Mobile/DLNA Live Stream Resolver.
 *
 * Reverse-engineered from Tencent/CMG cKey v8.1 (Platform 4330403, iPhone DLNA profile).
 * Generates official unencrypted (_dlna.m3u8, encrypt: 0) HLS stream URLs that decode
 * cleanly under strict FFmpeg validation (-xerror).
 */

const PLATFORM = 4330403;
const APP_VERSION = "V8.22.1035.3031";
const API_URL = "https://bkliveinfo.ysp.cctv.cn/";

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

const CKEY_TEA_KEY = hexToBytes("59b2f7cf725ef43c34fdd7c123411ed3");
const GUARD_TEA_KEY = hexToBytes("110DBEC10C23E7D2E56A1CAD6914EF1B");
const CKEY_XOR = new Uint8Array([
    0x84, 0x2e, 0xed, 0x08, 0xf0, 0x66, 0xe6, 0xea, 0x48, 0xb4, 0xca, 0xa9,
    0x91, 0xed, 0x6f, 0xf3
]);
const GUARD_XOR = new Uint8Array([
    0xb3, 0xc9, 0x53, 0xa0, 0x69, 0x13, 0xad, 0x4d
]);

function u32(val: number): number {
    return val >>> 0;
}

function teaEncryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
    const bView = new DataView(block.buffer, block.byteOffset, 8);
    const kView = new DataView(key.buffer, key.byteOffset, 16);

    let y = bView.getUint32(0, false);
    let z = bView.getUint32(4, false);
    const k0 = kView.getUint32(0, false);
    const k1 = kView.getUint32(4, false);
    const k2 = kView.getUint32(8, false);
    const k3 = kView.getUint32(12, false);

    let sum = 0;
    for (let i = 0; i < 16; i++) {
        sum = u32(sum + 0x9e3779b9);
        y = u32(
            y + u32(u32((z << 4) + k0) ^ u32(z + sum) ^ u32((z >>> 5) + k1))
        );
        z = u32(
            z + u32(u32((y << 4) + k2) ^ u32(y + sum) ^ u32((y >>> 5) + k3))
        );
    }

    const out = new Uint8Array(8);
    const oView = new DataView(out.buffer);
    oView.setUint32(0, y, false);
    oView.setUint32(4, z, false);
    return out;
}

function checksum(buffer: Uint8Array): number {
    let value = 0;
    for (let i = 0; i < buffer.length; i++) {
        value = (Math.imul(0x83, value) + buffer[i]) & 0x7fffffff;
    }
    return value >>> 0;
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
    let totalLen = 0;
    for (const arr of arrays) totalLen += arr.length;
    const res = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
        res.set(arr, offset);
        offset += arr.length;
    }
    return res;
}

function encryptTeaPacket(
    input: Uint8Array,
    key: Uint8Array,
    randomBytes: (n: number) => Uint8Array
): Uint8Array {
    const padLength = (8 - ((input.length + 10) % 8)) % 8;
    const r1 = randomBytes(1);
    const rPad = randomBytes(padLength);
    const r2 = randomBytes(2);
    const plain = concatBytes([
        new Uint8Array([(r1[0] & 0xf8) | padLength]),
        rPad,
        r2,
        input,
        new Uint8Array(7)
    ]);

    const outputChunks: Uint8Array[] = [];
    let previousPlain = new Uint8Array(8);
    let previousCipher = new Uint8Array(8);

    for (let offset = 0; offset < plain.length; offset += 8) {
        const source = plain.subarray(offset, offset + 8);
        const mixed = new Uint8Array(8);
        for (let i = 0; i < 8; i++) mixed[i] = source[i] ^ previousCipher[i];
        const encrypted = teaEncryptBlock(mixed, key);
        const cipher = new Uint8Array(8);
        for (let i = 0; i < 8; i++) cipher[i] = encrypted[i] ^ previousPlain[i];
        outputChunks.push(cipher);
        previousPlain = mixed;
        previousCipher = cipher;
    }
    return concatBytes(outputChunks);
}

const textEncoder = new TextEncoder();

function lengthPrefixed(value: string | Uint8Array): Uint8Array {
    const data = typeof value === "string" ? textEncoder.encode(value) : value;
    const out = new Uint8Array(2 + data.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, data.length, false);
    out.set(data, 2);
    return out;
}

function uint32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, false);
    return out;
}

function guardTail(value: string): string {
    const text = String(value);
    return text.length >= 5 ? text.slice(-5) : "";
}

function createGuard(
    timestamp: number,
    guid: string,
    randomBytes: (n: number) => Uint8Array
): string {
    const body = concatBytes([
        uint32(timestamp),
        lengthPrefixed(guardTail(guid)),
        lengthPrefixed(guardTail("null")),
        lengthPrefixed(guardTail("null")),
        lengthPrefixed("-1")
    ]);
    const plain = lengthPrefixed(body);
    const encrypted = concatBytes([
        encryptTeaPacket(plain, GUARD_TEA_KEY, randomBytes),
        uint32(checksum(plain))
    ]);
    for (let i = 0; i < encrypted.length; i++) {
        encrypted[i] ^= GUARD_XOR[i & 7];
    }
    return Array.from(encrypted)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
}

function buildPacket({
    channelId,
    timestamp,
    guid,
    guard,
    uid
}: {
    channelId: string;
    timestamp: number;
    guid: string;
    guard: string;
    uid: string;
}): Uint8Array {
    const body = concatBytes([
        hexToBytes("0000004200000004000004d2"),
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
    const packet = new Uint8Array(body.length + 2);
    new DataView(packet.buffer).setUint16(0, body.length, false);
    packet.set(body, 2);
    const sum = checksum(packet);
    new DataView(packet.buffer).setUint32(18, sum, false);
    return packet;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function customBase64(bytes: Uint8Array): string {
    return bytesToBase64(bytes)
        .replace(/\+/g, "_")
        .replace(/\//g, "-")
        .replace(/=+$/g, "");
}

export function createYangshipinCKey(
    channelId: string,
    options: {
        now?: number;
        guid?: string;
        uid?: string;
        randomBytes?: (n: number) => Uint8Array;
    } = {}
): {
    cKey: string;
    guid: string;
    timestamp: number;
    flowId: string;
} {
    const timestamp = Math.floor(Number(options.now ?? Date.now()) / 1000);
    const randomBytes =
        options.randomBytes ||
        ((n: number) => {
            const arr = new Uint8Array(n);
            crypto.getRandomValues(arr);
            return arr;
        });
    const guid =
        options.guid ||
        Array.from(randomBytes(16))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");
    const guard = createGuard(timestamp, guid, randomBytes);
    const uid =
        options.uid ||
        Array.from(randomBytes(4))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase();
    const packet = buildPacket({
        channelId: String(channelId),
        timestamp,
        guid,
        guard,
        uid
    });
    const encrypted = concatBytes([
        encryptTeaPacket(packet, CKEY_TEA_KEY, randomBytes),
        uint32(checksum(packet))
    ]);
    for (let i = 0; i < encrypted.length; i++) {
        encrypted[i] ^= CKEY_XOR[i & 15];
    }
    return {
        cKey: `--01${customBase64(encrypted)}`,
        guid,
        timestamp,
        flowId: `${crypto.randomUUID().toUpperCase()}_${PLATFORM}`
    };
}

const H264_CAPABILITY = btoa("H(30:1080,60:1080|30:1080,60:1080)");

export interface YangshipinDlnaStreamResult {
    playurl: string;
    backurlList: string[];
    defn: string;
    vkeyIntervalSeconds?: number;
    data: any;
}

/**
 * Request clean, unencrypted mobile/DLNA HLS stream URLs from official CCTV/Yangshipin API.
 */
export async function requestYangshipinDlnaStream(
    channelId: string,
    livePid: string,
    defn = "fhd",
    timeoutMs = 8000
): Promise<YangshipinDlnaStreamResult> {
    const ticket = createYangshipinCKey(channelId);
    const query = new URLSearchParams({
        atime: "120",
        livepid: livePid,
        cnlid: channelId,
        appVer: APP_VERSION,
        app_version: "300090",
        caplv: "1",
        cmd: "2",
        defn: defn || "fhd",
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
        const response = await fetch(`${API_URL}?${query.toString()}`, {
            signal: controller.signal,
            headers: {
                Accept: "application/json"
            }
        });
        if (!response.ok) {
            throw new Error(`Yangshipin API HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (Number(payload?.iretcode) !== 0) {
            throw new Error(
                payload?.errinfo ||
                    `Yangshipin API error ${payload?.iretcode ?? "unknown"}`
            );
        }
        if (!payload.playurl) {
            throw new Error("Yangshipin API returned no playurl");
        }

        const backurls: string[] = [];
        const rawBackups = payload.backurl_list ?? payload.backurlList;
        if (Array.isArray(rawBackups)) {
            for (const item of rawBackups) {
                const u =
                    typeof item === "string"
                        ? item
                        : item?.url || item?.playurl;
                if (u && typeof u === "string") backurls.push(u);
            }
        }

        return {
            playurl: payload.playurl,
            backurlList: backurls,
            defn: payload.defn || defn,
            vkeyIntervalSeconds: Number(payload.vkey_renew_interval) || 14400,
            data: payload
        };
    } finally {
        clearTimeout(timer);
    }
}
