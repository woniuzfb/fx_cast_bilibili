// bridge/src/bridge/components/cctvDecrypt.ts
//
// CCTV live sample-decryptor for the live HLS relay.
//
// CCTV live segments are NOT bitstream-corrupt and are NOT standard HLS
// AES-128 (there is no #EXT-X-KEY in the playlist). Instead each *slice* NAL's
// RBSP payload (nal_unit_type 1 / 5) is transformed by a proprietary CNTV
// routine baked into the page's WASM player; SPS/PPS/SEI/AUD are left in the
// clear and the MPEG-TS transport layer is unscrambled. That is why every
// H.264 decoder renders gray on the raw bytes while the browser — which runs
// the WASM step before the decoder — plays fine.
//
// The live player (`_nalplay2`) reaches the transform through the WASM
// function at index 58 ("sub58"), NOT through the exported `func60_TEA`
// (which is only called by the VOD path `_vodplay`). sub58 differs from
// func60_TEA in exactly two ways:
//   1. emulation-prevention removal is conditional: `00 00 03` is dropped
//      only when the byte after the 03 is < 4 *signed* (0..3 or 0x80+);
//   2. `_nalplay2` only sends slices of at least 112 bytes to sub58. This
//      call-site guard matters because sub58 itself would otherwise process
//      one sampled block in any slice longer than 39 bytes, even though a
//      complete 80-byte sampling stride after the 32-byte prefix is absent;
//   3. for eligible slices, the TEA block count is ceil, not floor: blocks at
//      32+80k run while 10k < (n-32)>>3, so a final stride shorter than the
//      full 80 bytes is STILL decrypted (its leading 8-byte block) whenever
//      those 8 bytes are present; only a tail remainder < 8 bytes is left
//      untouched. The `k < lim` guard never binds before the block's physical
//      fit (32+80k+8 <= n) — verified on real cctv5 segments, where 254/300
//      slice NALs end on a partial (<80B) stride whose 8-byte block still runs.
// The helper semantics and the live-path guard were checked separately:
// direct sub58 output matches this implementation for eligible slices, while
// bypassing slices shorter than 112 bytes removes the deterministic H.264
// decode errors in the supplied six-segment capture.
//
// The transform is implemented here in pure JS (16-round TEA, key = bytes
// [16..32) of the unescaped NAL), so the WASM glue/binary and its loader are
// no longer involved in decryption at all.
//
// Decryption changes the NAL length (the sub58 unescape removes EPBs the
// CNTV escaper inserted, so slices shrink slightly), so the output segment
// is REBUILT: transformed video PES payloads are re-packetized into 188-byte
// TS packets, short tails are stuffed through the adaptation field, and
// video-PID continuity counters are renumbered across the whole segment so
// repacketization never trips CC checks. Callers must therefore use the
// returned buffer's length, not the input's.
//
// Verified locally against real captured segments: the video ES PID is 256
// or 257 depending on the channel (NOT the 0x100 the reference demo
// hardcodes), so the PID MUST be discovered from the PAT/PMT. Truncated
// downloads (trailing zero-fill / desync) are common; only whole
// 0x47-synced 188-byte packets from the start are processed and any
// trailing garbage is passed through untouched. Never throws on malformed
// input — worst case it returns the bytes unmodified.

/**
 * Discover the video ES PID from PAT -> PMT. Never assume 0x100: real CCTV
 * segments carry video on 256/257. Returns -1 if not found.
 */
function findVideoPid(buf: Uint8Array, packetCount: number): number {
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
            if (pusi) o += 1 + buf[o]!; // pointer_field
            const sectionLen = ((buf[o + 1]! & 0x0f) << 8) | buf[o + 2]!;
            const end = o + 3 + sectionLen - 4; // exclude CRC32
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
                // 0x1b = H.264, 0x24 = H.265, 0x1c = AAC-in-TS variants seen on CCTV.
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

// ---------------------------------------------------------------- TS parsing

/** Parsed layout of one TS packet within the input buffer. */
interface TsPacketInfo {
    index: number; // packet index; byte offset = index * 188
    pusi: boolean;
    afc: number; // adaptation_field_control
    adaptLen: number; // adaptation_field_length when afc === 3
    payloadStart: number; // absolute byte offset of the payload
}

/** A video PES frame: the run of video-PID packets from one PUSI to the next. */
interface PesFrame {
    packets: TsPacketInfo[];
    pesHdrLen: number; // 9 + PES_header_data_length
    payload: Buffer; // concatenated packet payloads (PES header + ES)
}

interface ParseResult {
    frames: PesFrame[];
    /** First packet index where 0x47 sync broke; -1 when the segment is whole. */
    syncLostAt: number;
}

function parseVideoPesFrames(
    buf: Buffer,
    packetCount: number,
    videoPid: number
): ParseResult {
    const frames: PesFrame[] = [];
    let cur:
        | { packets: TsPacketInfo[]; pesHdrLen: number; parts: Buffer[] }
        | undefined;
    let syncLostAt = -1;
    for (let p = 0; p < packetCount; p++) {
        const i = p * 188;
        if (buf[i] !== 0x47) {
            syncLostAt = p;
            break;
        }
        const pid = ((buf[i + 1]! & 0x1f) << 8) | buf[i + 2]!;
        if (pid !== videoPid) continue;
        const pusi = (buf[i + 1]! & 0x40) !== 0;
        const afc = (buf[i + 3]! & 0x30) >>> 4;
        if (afc !== 1 && afc !== 3) continue; // no payload
        const adaptLen = afc === 3 ? buf[i + 4]! : 0;
        const payloadStart = i + 4 + (afc === 3 ? 1 + adaptLen : 0);
        if (payloadStart >= i + 188) continue;
        const info: TsPacketInfo = {
            index: p,
            pusi,
            afc,
            adaptLen,
            payloadStart
        };
        if (pusi) {
            if (cur) {
                frames.push({
                    packets: cur.packets,
                    pesHdrLen: cur.pesHdrLen,
                    payload: Buffer.concat(cur.parts)
                });
            }
            if (payloadStart + 9 > i + 188) {
                cur = undefined; // PES header doesn't fit; drop this frame
                continue;
            }
            cur = {
                packets: [info],
                pesHdrLen: 9 + buf[payloadStart + 8]!,
                parts: []
            };
        } else if (cur) {
            cur.packets.push(info);
        }
        cur?.parts.push(buf.subarray(payloadStart, i + 188));
    }
    if (cur) {
        frames.push({
            packets: cur.packets,
            pesHdrLen: cur.pesHdrLen,
            payload: Buffer.concat(cur.parts)
        });
    }
    return { frames, syncLostAt };
}

// ------------------------------------------------------------------- H.264

interface Nal {
    sc: Buffer; // start code (00 00 01 or 00 00 00 01)
    body: Buffer; // NAL header byte + RBSP
}

/** Split an ES buffer (PES payload with Annex-B start codes) into NALs. */
function splitNals(es: Buffer, from: number): Nal[] {
    const nals: Nal[] = [];
    const findStartCode = (pos: number): number => {
        for (let i = pos; i + 3 < es.length; i++) {
            if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) return i;
            if (
                i + 4 < es.length &&
                es[i] === 0 &&
                es[i + 1] === 0 &&
                es[i + 2] === 0 &&
                es[i + 3] === 1
            ) {
                return i;
            }
        }
        return -1;
    };
    let pos = from;
    while (pos < es.length) {
        const sc = findStartCode(pos);
        if (sc < 0) break;
        const scLen = es[sc + 2] === 1 ? 3 : 4;
        const nalStart = sc + scLen;
        let next = findStartCode(nalStart);
        if (next < 0) next = es.length;
        nals.push({
            sc: es.subarray(sc, nalStart),
            body: es.subarray(nalStart, next)
        });
        pos = next;
    }
    return nals;
}

// ------------------------------------------------------- TEA (sub58 semantics)

const TEA_DELTA = 0x9e3779b9;

/** 16-round TEA decrypt of one 8-byte block, little-endian, key at keyOff. */
function teaDecryptBlock(buf: Buffer, off: number, keyOff: number): void {
    let v0 = buf.readUInt32LE(off);
    let v1 = buf.readUInt32LE(off + 4);
    const k0 = buf.readUInt32LE(keyOff);
    const k1 = buf.readUInt32LE(keyOff + 4);
    const k2 = buf.readUInt32LE(keyOff + 8);
    const k3 = buf.readUInt32LE(keyOff + 12);
    for (let round = 16; round >= 1; round--) {
        const sum = Math.imul(TEA_DELTA, round) >>> 0;
        v1 =
            (v1 -
                ((((v0 << 4) >>> 0) + k2) ^
                    ((v0 + sum) >>> 0) ^
                    ((v0 >>> 5) + k3))) >>>
            0;
        v0 =
            (v0 -
                ((((v1 << 4) >>> 0) + k0) ^
                    ((v1 + sum) >>> 0) ^
                    ((v1 >>> 5) + k1))) >>>
            0;
    }
    buf.writeUInt32LE(v0, off);
    buf.writeUInt32LE(v1, off + 4);
}

/**
 * Decrypt one slice NAL (header byte + RBSP) like the live `_nalplay2` path.
 * Slices shorter than 112 bytes bypass sub58. Eligible slices use sub58's
 * conditional emulation-prevention removal, then TEA on 8-byte blocks at
 * 32+80k while 10k < (n-32)>>3 (i.e. ceil((n-32)/80) blocks: a final stride
 * shorter than 80 bytes still gets its leading 8-byte block; only a < 8-byte
 * tail remainder is left untouched), key = bytes [16..32) of the unescaped
 * NAL. Returns a new, possibly shorter buffer.
 */
function decryptSliceNal(nal: Buffer): Buffer {
    // `_nalplay2` treats the first 32 bytes as prefix/key material and samples
    // one 8-byte block per 80-byte stride. Without a complete first stride,
    // the live path leaves the slice untouched instead of calling sub58.
    if (nal.length < 112) return Buffer.from(nal);

    const b = Buffer.from(nal);
    let len = b.length;
    // sub58's conditional removal uses a *signed* compare on the byte after
    // the 03: it drops 00 00 03 when that byte is < 4 signed (0..3 or 0x80+).
    let j = 0;
    while (j < len - 3) {
        if (
            b[j] === 0 &&
            b[j + 1] === 0 &&
            b[j + 2] === 3 &&
            b.readInt8(j + 3) < 4
        ) {
            b.copy(b, j + 2, j + 3, len); // memmove left
            b[len - 1] = 0;
            len--;
            j++; // sub58 resumes scanning at j+1
            continue;
        }
        j++;
    }
    const lim = (len - 32) >> 3;
    let k = 0;
    while (k < lim) {
        const off = 32 + k * 8;
        if (off + 8 > len) break; // safety; the loop bound already guarantees fit
        teaDecryptBlock(b, off, 16);
        k += 10;
    }
    return b.subarray(0, len);
}

// NOTE: no re-escaping after decryption. The decrypted slice is ALREADY a
// valid escaped EBSP — the CNTV transform only scrambles sparse 8-byte
// sample blocks, so sub58's output is the original NAL's escaped bytes and
// the downstream decoder's own EPB removal is the correct inverse. Re-
// escaping here double-escapes: the decoder strips one 03 layer and the
// surviving EPB bytes become phantom CABAC data, desyncing the bitstream
// (verified on 1600 real slice NALs: decrypted slices contain only 00 00 03
// EPB sites, never 00 00 {00,01,02} raw-RBSP patterns, and re-escaped
// segments decode with "cabac decode of qscale diff failed" errors exactly
// proportional to the number of inserted EPBs, while verbatim output decodes
// clean).

// ----------------------------------------------------------- TS rebuilding

interface PesTransform {
    frame: PesFrame;
    newPayload: Buffer; // (possibly rewritten) PES header + transformed ES
}

/**
 * Rebuild the segment with transformed PES frames re-packetized. Output may
 * be LONGER than the input: when a transformed PES outgrows the packet count
 * it originally occupied, brand-new 188-byte packets (same PID, PUSI=0) are
 * inserted. Packets with leftover space are stuffed through the adaptation
 * field (0xFF), preserving any original adaptation content (e.g. PCR).
 * Video-PID continuity counters are renumbered across the whole output so
 * insertions never surface as CC errors. Packets not belonging to a
 * transformed frame are copied verbatim (CC still renumbered for video PID);
 * the region after syncLostAt (truncated download tail) is copied raw.
 */
function rebuildSegment(
    input: Buffer,
    packetCount: number,
    videoPid: number,
    transforms: PesTransform[],
    syncLostAt: number,
    diagnostics: MutableCctvDecryptDiagnostics
): Buffer {
    const byFirstPacket = new Map<number, PesTransform>();
    const consumed = new Set<number>();
    for (const t of transforms) {
        byFirstPacket.set(t.frame.packets[0]!.index, t);
        for (const p of t.frame.packets) consumed.add(p.index);
    }
    const lastGood = syncLostAt >= 0 ? syncLostAt : packetCount;

    // Seed the CC sequence so the first emitted video packet keeps its
    // original counter value; everything after increments from there.
    let cc = -1;
    for (let p = 0; p < lastGood; p++) {
        const i = p * 188;
        const pid = ((input[i + 1]! & 0x1f) << 8) | input[i + 2]!;
        if (pid === videoPid) {
            cc = (input[i + 3]! & 0x0f) - 1;
            break;
        }
    }
    const nextCc = (): number => {
        cc = (cc + 1) & 0x0f;
        return cc;
    };

    const chunks: Buffer[] = [];

    const emitRaw = (p: number): void => {
        const pkt = Buffer.from(input.subarray(p * 188, p * 188 + 188));
        const pid = ((pkt[1]! & 0x1f) << 8) | pkt[2]!;
        if (pid === videoPid) pkt[3] = (pkt[3]! & 0xf0) | nextCc();
        chunks.push(pkt);
    };

    const emitPayloadPacket = (
        byte1: number,
        byte2: number,
        adaptation: Buffer | undefined,
        payload: Buffer
    ): void => {
        const pkt = Buffer.alloc(188, 0xff);
        pkt[0] = 0x47;
        pkt[1] = byte1;
        pkt[2] = byte2;
        pkt[3] = (adaptation ? 0x30 : 0x10) | nextCc();
        let o = 4;
        if (adaptation) {
            adaptation.copy(pkt, o);
            o += adaptation.length;
        }
        payload.copy(pkt, o);
        chunks.push(pkt);
    };

    const emitFrame = (t: PesTransform): void => {
        const { frame, newPayload } = t;
        const originalPackets = frame.packets.length;
        let emitted = 0;
        let pos = 0;
        for (
            let k = 0;
            k < frame.packets.length && pos < newPayload.length;
            k++
        ) {
            const p = frame.packets[k]!;
            const i = p.index * 188;
            // Keep the original header bits (TEI/PUSI/priority + PID) of each
            // reused packet; only the CC nibble (and possibly AFC) changes.
            const byte1 = input[i + 1]!;
            const byte2 = input[i + 2]!;
            const capacity = 188 - 4 - (p.afc === 3 ? 1 + p.adaptLen : 0);
            const take = Math.min(capacity, newPayload.length - pos);
            const isLast = pos + take === newPayload.length;
            let adaptation: Buffer | undefined;
            if (p.afc === 3) {
                const orig = input.subarray(i + 4, p.payloadStart); // len byte + content
                if (isLast && take < capacity) {
                    // Extend the adaptation field with 0xFF stuffing after the
                    // original content (PCR position inside the field is preserved).
                    const extra = capacity - take;
                    adaptation = Buffer.concat([
                        Buffer.from(orig),
                        Buffer.alloc(extra, 0xff)
                    ]);
                    adaptation[0] = (adaptation[0]! + extra) & 0xff;
                } else {
                    adaptation = Buffer.from(orig);
                }
            } else if (isLast && take < 184) {
                const stuff = 184 - take; // >= 1
                adaptation = Buffer.alloc(stuff, 0xff);
                adaptation[0] = stuff - 1;
            }
            emitPayloadPacket(
                byte1,
                byte2,
                adaptation,
                newPayload.subarray(pos, pos + take)
            );
            pos += take;
            emitted++;
        }
        // The PES grew past its original packet count: insert new packets.
        while (pos < newPayload.length) {
            const take = Math.min(184, newPayload.length - pos);
            let adaptation: Buffer | undefined;
            if (take < 184) {
                const stuff = 184 - take;
                adaptation = Buffer.alloc(stuff, 0xff);
                adaptation[0] = stuff - 1;
            }
            emitPayloadPacket(
                (videoPid >> 8) & 0x1f, // TEI=0, PUSI=0, priority=0
                videoPid & 0xff,
                adaptation,
                newPayload.subarray(pos, pos + take)
            );
            pos += take;
            emitted++;
        }
        if (emitted > originalPackets) {
            diagnostics.insertedPacketCount += emitted - originalPackets;
        }
    };

    for (let p = 0; p < lastGood; p++) {
        const t = byFirstPacket.get(p);
        if (t) {
            emitFrame(t);
            continue;
        }
        if (consumed.has(p)) continue; // emitted as part of its frame already
        emitRaw(p);
    }
    // Truncated tail (partial packet / desynced region) verbatim.
    if (lastGood * 188 < input.length) {
        chunks.push(input.subarray(lastGood * 188));
    }
    return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ driver

export interface CctvDecryptDiagnostics {
    packetCount: number;
    processedPackets: number;
    videoPid: number;
    pesCount: number;
    transformedPesCount: number;
    skippedIncompletePesCount: number;
    sliceNalCount: number;
    idrNalCount: number;
    insertedPacketCount: number;
    outputBytes: number;
}

type MutableCctvDecryptDiagnostics = CctvDecryptDiagnostics;

/**
 * Decrypt a CCTV live TS segment and return the result as a NEW buffer whose
 * length may differ from the input's (see the file header). The input is
 * never mutated. On any problem (unrecognized container, malformed PES,
 * nothing to transform) the input is returned unchanged.
 */
export function decryptCctvSegment(
    input: Buffer,
    onDiagnostics?: (diagnostics: CctvDecryptDiagnostics) => void
): Buffer {
    const packetCount = Math.floor(input.length / 188);
    const diagnostics: MutableCctvDecryptDiagnostics = {
        packetCount,
        processedPackets: 0,
        videoPid: -1,
        pesCount: 0,
        transformedPesCount: 0,
        skippedIncompletePesCount: 0,
        sliceNalCount: 0,
        idrNalCount: 0,
        insertedPacketCount: 0,
        outputBytes: input.length
    };
    try {
        const videoPid = findVideoPid(input, packetCount);
        diagnostics.videoPid = videoPid;
        if (videoPid < 0) {
            onDiagnostics?.(diagnostics);
            return input; // not a recognizable CCTV H.264 TS; pass through
        }

        const { frames, syncLostAt } = parseVideoPesFrames(
            input,
            packetCount,
            videoPid
        );
        diagnostics.processedPackets =
            syncLostAt >= 0 ? syncLostAt : packetCount;

        const transforms: PesTransform[] = [];
        for (const frame of frames) {
            diagnostics.pesCount++;
            const payload = frame.payload;
            if (
                payload.length < frame.pesHdrLen ||
                payload[0] !== 0 ||
                payload[1] !== 0 ||
                payload[2] !== 1
            ) {
                diagnostics.skippedIncompletePesCount++;
                continue;
            }
            // PES_packet_length counts bytes following the six-byte fixed prefix.
            // A CDN response may be truncated while still ending on a complete
            // 188-byte TS packet, so sync-byte checks alone cannot detect it.
            const declared =
                payload[4] !== 0 || payload[5] !== 0
                    ? 6 + ((payload[4]! << 8) | payload[5]!)
                    : 0;
            if (declared !== 0 && payload.length < declared) {
                diagnostics.skippedIncompletePesCount++;
                continue;
            }

            const nals = splitNals(payload, frame.pesHdrLen);
            const parts: Buffer[] = [];
            let touched = false;
            for (const nal of nals) {
                const nalType = nal.body.length > 0 ? nal.body[0]! & 0x1f : -1;
                if (nalType === 1 || nalType === 5) {
                    diagnostics.sliceNalCount++;
                    if (nalType === 5) diagnostics.idrNalCount++;
                    parts.push(nal.sc, decryptSliceNal(nal.body));
                    touched = true;
                } else {
                    parts.push(nal.sc, nal.body);
                }
            }
            if (!touched) continue;
            diagnostics.transformedPesCount++;

            const pesHdr = Buffer.from(payload.subarray(0, frame.pesHdrLen));
            const newEs = Buffer.concat(parts);
            // PES_packet_length: 0 means unbounded (legal for video in TS) and
            // stays 0; a bounded length is recomputed, falling back to 0 if the
            // transformed PES outgrows the 16-bit field.
            const oldLength = (pesHdr[4]! << 8) | pesHdr[5]!;
            if (oldLength !== 0) {
                const newLength = pesHdr.length + newEs.length - 6;
                if (newLength <= 0xffff) {
                    pesHdr[4] = newLength >> 8;
                    pesHdr[5] = newLength & 0xff;
                } else {
                    pesHdr[4] = 0;
                    pesHdr[5] = 0;
                }
            }
            transforms.push({
                frame,
                newPayload: Buffer.concat([pesHdr, newEs])
            });
        }

        if (transforms.length === 0) {
            onDiagnostics?.(diagnostics);
            return input; // nothing decryptable; pass through
        }

        const out = rebuildSegment(
            input,
            packetCount,
            videoPid,
            transforms,
            syncLostAt,
            diagnostics
        );
        diagnostics.outputBytes = out.length;
        onDiagnostics?.(diagnostics);
        return out;
    } catch {
        // Never throw on malformed input: pass the segment through untouched.
        onDiagnostics?.(diagnostics);
        return input;
    }
}
