"use strict";

/**
 * Native-messaging framing shared by the harness pieces.
 *
 * Firefox talks to a native host as: 4-byte little-endian length, then that
 * many bytes of UTF-8 JSON. The bridge implements this in
 * `bridge/src/transforms.ts`; this module is the harness's own copy, used to
 * PARSE a copy of a byte stream that is forwarded verbatim elsewhere.
 *
 * The distinction matters: the wrapper must never re-encode what it forwards,
 * or a harness bug would become a bridge bug. It pipes raw bytes and parses
 * only for the trace.
 */

/** Encodes one message the way a native host (or Firefox) would. */
function encode(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
}

/**
 * Incremental frame splitter. Feed it every chunk; it returns the messages that
 * became complete, and keeps the remainder for the next call.
 */
class FrameReader {
    constructor(onMessage) {
        this.buffer = Buffer.alloc(0);
        this.onMessage = onMessage;
        this.awaiting = undefined;
    }

    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            if (this.awaiting === undefined) {
                if (this.buffer.length < 4) return;
                this.awaiting = this.buffer.readUInt32LE(0);
                this.buffer = this.buffer.subarray(4);
                continue;
            }
            if (this.buffer.length < this.awaiting) return;
            const body = this.buffer
                .subarray(0, this.awaiting)
                .toString("utf8");
            this.buffer = this.buffer.subarray(this.awaiting);
            this.awaiting = undefined;
            let parsed;
            let parseError;
            try {
                parsed = JSON.parse(body);
            } catch (err) {
                parseError = err instanceof Error ? err.message : String(err);
            }
            this.onMessage(parsed, parseError);
        }
    }
}

module.exports = { encode, FrameReader };
