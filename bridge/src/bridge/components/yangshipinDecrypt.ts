// bridge/src/bridge/components/yangshipinDecrypt.ts
//
// Yangshipin CMG WASM live/VOD transport-stream descrambler.
//
// CCTV / Yangshipin PC web player (platform 5910204) scrambles H.264 slice NALs
// (nal_unit_type 1 and 5) and marks SPS byte 2 with constraint flags using
// China Media Group's proprietary WASM module (RJq7sO71JF.wasm).
//
// Descrambling is executed via the high-performance native addon (cmg_decrypt.node),
// which runs the wasm2c-compiled state machine and PRNG step-unwinding directly in C/C++.
// Slices are descrambled in-place and byte 2 of SPS is sanitized (sps[2] &= 0xfc).
// Non-scrambled segments (e.g. DLNA streams with sps[2] & 3 == 0) pass through untouched.

import fs from "fs";
import path from "path";

let nativeAddon: any = null;

function loadNativeAddon(): any {
    if (nativeAddon !== null) {
        return nativeAddon;
    }

    if ((process as any).pkg) {
        try {
            const mod = { exports: {} } as any;
            process.dlopen(
                mod,
                path.join(path.dirname(process.execPath), "cmg_decrypt.node")
            );
            nativeAddon = mod.exports;
            return nativeAddon;
        } catch (err) {
            console.error(
                "[yangshipinDecrypt] Failed to dlopen pkg cmg_decrypt.node:",
                err
            );
        }
    }

    const candidatePaths = [
        path.join(__dirname, "cmg_decrypt.node"),
        path.join(__dirname, "../../../build/Release/cmg_decrypt.node"),
        path.join(__dirname, "../../build/Release/cmg_decrypt.node"),
        path.join(__dirname, "../build/Release/cmg_decrypt.node"),
        path.join(path.dirname(process.execPath), "cmg_decrypt.node")
    ];

    for (const candidate of candidatePaths) {
        if (fs.existsSync(candidate)) {
            try {
                const mod = { exports: {} } as any;
                process.dlopen(mod, candidate);
                nativeAddon = mod.exports;
                return nativeAddon;
            } catch (err) {
                console.error(
                    `[yangshipinDecrypt] Failed to dlopen candidate ${candidate}:`,
                    err
                );
            }
        }
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        nativeAddon = require("bindings")("cmg_decrypt");
        return nativeAddon;
    } catch {
        // Native addon not available in this environment
        nativeAddon = false;
        return null;
    }
}

export interface YangshipinDecryptDiagnostics {
    packetCount: number;
    videoPid: number;
    sliceNalCount: number;
    outputBytes: number;
    nativeAvailable: boolean;
}

/**
 * Discover the video ES PID from PAT -> PMT.
 */
export function findVideoPid(buf: Uint8Array, packetCount: number): number {
    let pmtPid = -1;
    for (let p = 0; p < packetCount; p++) {
        const i = p * 188;
        if (buf[i] !== 0x47) break;
        const pid = ((buf[i + 1]! & 0x1f) << 8) | buf[i + 2]!;
        const pusi = (buf[i + 1]! & 0x40) >>> 6;
        const afc = (buf[i + 3]! & 0x30) >>> 4;
        if (afc === 2) continue; // adaptation only, no payload
        let o = i + 4;
        if (afc === 3) o += 1 + buf[o]!;
        if (pid === 0 && pmtPid < 0) {
            if (pusi) o += 1 + buf[o]!;
            const sectionLen = ((buf[o + 1]! & 0x0f) << 8) | buf[o + 2]!;
            const end = o + 3 + sectionLen - 4;
            let e = o + 8;
            while (e + 4 <= end) {
                const prog = (buf[e]! << 8) | buf[e + 1]!;
                const mapPid = ((buf[e + 2]! & 0x1f) << 8) | buf[e + 3]!;
                if (prog !== 0) {
                    pmtPid = mapPid;
                    break;
                }
                e += 4;
            }
        } else if (pid === pmtPid && pmtPid >= 0) {
            if (pusi) o += 1 + buf[o]!;
            const sectionLen = ((buf[o + 1]! & 0x0f) << 8) | buf[o + 2]!;
            const end = o + 3 + sectionLen - 4;
            const progInfoLen = ((buf[o + 10]! & 0x0f) << 8) | buf[o + 11]!;
            let e = o + 12 + progInfoLen;
            while (e + 5 <= end) {
                const streamType = buf[e]!;
                const esPid = ((buf[e + 1]! & 0x1f) << 8) | buf[e + 2]!;
                const esInfoLen = ((buf[e + 3]! & 0x0f) << 8) | buf[e + 4]!;
                if (
                    streamType === 0x1b ||
                    streamType === 0x24 ||
                    streamType === 0x1c
                ) {
                    return esPid;
                }
                e += 5 + esInfoLen;
            }
        }
    }
    return -1;
}

/**
 * Descramble a Yangshipin scrambled TS segment using CMG RJq7sO71JF WASM engine.
 * If the stream is not scrambled (e.g. DLNA), bytes are returned unmodified.
 */
export function decryptYangshipinSegment(
    input: Uint8Array,
    onDiagnostics?: (diag: YangshipinDecryptDiagnostics) => void
): Uint8Array {
    const packetCount = Math.floor(input.length / 188);
    const videoPid = findVideoPid(input, packetCount);

    const addon = loadNativeAddon();
    if (!addon || typeof addon.decryptSegment !== "function") {
        onDiagnostics?.({
            packetCount,
            videoPid,
            sliceNalCount: 0,
            outputBytes: input.length,
            nativeAvailable: false
        });
        return input;
    }

    try {
        const inBuf = Buffer.isBuffer(input)
            ? input
            : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        const outBuf = addon.decryptSegment(inBuf, true, true);
        const sliceCount = Number((outBuf as any)?.sliceCount) || 0;

        onDiagnostics?.({
            packetCount,
            videoPid,
            sliceNalCount: sliceCount,
            outputBytes: outBuf.length,
            nativeAvailable: true
        });

        return outBuf;
    } catch (err) {
        console.error("[yangshipinDecrypt] Error during native decrypt:", err);
        onDiagnostics?.({
            packetCount,
            videoPid,
            sliceNalCount: 0,
            outputBytes: input.length,
            nativeAvailable: true
        });
        return input;
    }
}
