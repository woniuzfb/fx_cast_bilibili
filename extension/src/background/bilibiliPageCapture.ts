import logger from "../lib/logger";

type Kind = "video" | "audio";
interface Endpoint {
    port: number;
    generation: number;
}
interface Payload {
    kind: Kind;
    start: number;
    end: number;
    total: number;
    /**
     * Standalone ArrayBuffer covering EXACTLY [start..end] (length ===
     * end - start + 1, never a view into a larger buffer): the candidate
     * overlap comparison indexes it relative to `start`.
     */
    bytes: ArrayBuffer;
    sequence: number;
}
interface ManifestEntry {
    kind: Kind;
    /** Exclusive end of the DASH SegmentBase indexRange (end + 1): the byte
     *  offset at which the first media segment starts, i.e. the coverage a
     *  candidate needs before its init+sidx is complete. Undefined when the
     *  manifest declares no indexRange. */
    initEndExclusive?: number;
}

interface PathState {
    url: string;
    kind: Kind;
    queued: Payload[];
    queuedBytes: number;
    replacesPath?: string;
    kindGeneration: number;
    /**
     * The candidate's own completed Range-0 (init) response. Deliberately NOT
     * the page-level initByKind: until commit, the old committed
     * representation is still the active one, and a rebuild triggered in
     * between must pair the OLD committed URL with the OLD init.
     */
    init?: Payload;
}
interface PageState {
    tabId: number;
    pageUrl?: string;
    paths: Map<string, PathState>;
    representations: Map<string, ManifestEntry>;
    initByKind: Partial<Record<Kind, Payload>>;
    kindGeneration: Record<Kind, number>;
    notifyWhenInitialized: Set<Kind>;
    requestId?: string;
    endpoint?: Endpoint;
    pending: Record<Kind, Payload[]>;
    pendingBytes: number;
    upload: Record<Kind, Promise<void>>;
    retryTimers: Partial<Record<Kind, ReturnType<typeof setTimeout>>>;
    /**
     * Consecutive retryable upload failures per kind since the last response
     * that advanced the queue (2xx, or the drop-only 409). Drives the capped
     * exponential backoff and the rebuild threshold; reset by every relay
     * boundary (invalidateRelayUploads) and by queue progress.
     */
    retryAttempts: Partial<Record<Kind, number>>;
    /**
     * Rolling media tail used to bridge capture-generation boundaries. It is
     * retained across Stop -> Cast and reset to the new target at page-seek
     * start, so a successor relay is not dependent on MSE re-fetching bytes.
     */
    handoff: Record<Kind, Payload[]>;
    handoffBytes: number;
    handoffPending: boolean;
    /** One relay-rebuild request per arm cycle (overflow throttle). */
    overflowNotified?: boolean;
    /**
     * Bumped by every media-generation reset: in-flight upload chains
     * capture it and abort after any await when it no longer matches, so a
     * reset cannot race a stale 204 into negative accounting or POSTs for a
     * dead page.
     */
    uploadEpoch: number;
}

interface CaptureRequest {
    page: PageState;
    kindGeneration: number;
    path: string;
    chunks: ArrayBuffer[];
    bytes: number;
    rangeStart?: number;
    rangeEnd?: number;
    rangeTotal?: number;
    nextOffset: number;
    stopped: boolean;
    completed: boolean;
    deferredChunks: ArrayBuffer[];
    publishDeferred?: () => void;
}

/**
 * Active-backlog cap per tab (payloads captured but not yet accepted by the
 * bridge). This is NOT a whole-tab capture cap: each replacement candidate
 * has its own independently capped queue (PathState.queuedBytes, same limit),
 * plus small in-flight response buffers — so worst case is roughly
 * (2 + number-of-candidates) x this value, all bounded.
 */
const MAX_PENDING_BYTES = 256 * 1024 * 1024;
const pages = new Map<number, PageState>();
const requests = new Map<string, CaptureRequest>();
let sequence = 0;
let initialized = false;

function videoPage(url?: string) {
    if (!url) return false;
    try {
        const u = new URL(url);
        return (
            u.hostname === "www.bilibili.com" &&
            (u.pathname.startsWith("/video/") ||
                u.pathname.startsWith("/bangumi/play/"))
        );
    } catch {
        return false;
    }
}
function pageIdentity(url?: string): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        const part = parsed.searchParams.get("p");
        return `${parsed.origin}${parsed.pathname}${part ? `?p=${part}` : ""}`;
    } catch {
        return undefined;
    }
}
function mediaResource(
    url: string
): { path: string; kind?: Kind } | undefined {
    try {
        const u = new URL(url);
        if (
            !(
                u.hostname.endsWith(".bilivideo.com") ||
                u.hostname.endsWith(".bilivideo.cn")
            ) ||
            !u.pathname.endsWith(".m4s")
        ) {
            return;
        }
        const path = u.pathname.startsWith("/v1/resource/")
            ? u.pathname.slice("/v1/resource".length)
            : u.pathname;
        if (!path.startsWith("/upgcxcode/")) return;
        // Bilibili DASH file naming: <cid>-1-<code>.m4s. Audio adaptation
        // codes are all in the 302xx range (30216/30232/30252/30280); video
        // codes never are (30080, 30112, 100026, ...). Classifies a stream
        // even when no playurl/__playinfo__ manifest was observed for the
        // page (page loaded before the extension, manifest response missed,
        // or the page's flavor of manifest lists different streams than the
        // extension saw) — without this fallback every m4s byte was dropped
        // silently and no pair ever committed.
        const match = /-1-(\d+)\.m4s$/.exec(path);
        return {
            path,
            kind: match
                ? match[1].startsWith("302")
                    ? "audio"
                    : "video"
                : undefined
        };
    } catch {
        return;
    }
}
/**
 * Invalidate everything belonging to the current relay upload generation
 * for this tab: bump the upload epoch so in-flight chains abandon themselves
 * at their next await checkpoint (already-sent fetches cannot be cancelled),
 * disarm the endpoint, rebuild the chain heads, and clear retry timers. This
 * is THE single authoritative relay-invalidation boundary — it runs on every
 * relay transition (page reset, begin, commit, end, backlog overflow), and
 * no caller needs its own timer/request cleanup.
 */
function invalidateRelayUploads(state: PageState) {
    state.uploadEpoch++;
    state.endpoint = undefined;
    state.upload = {
        video: Promise.resolve(),
        audio: Promise.resolve()
    };
    for (const timer of Object.values(state.retryTimers)) {
        if (timer) clearTimeout(timer);
    }
    state.retryTimers = {};
    state.retryAttempts = {};
}

function clearHandoff(state: PageState) {
    state.handoff = { video: [], audio: [] };
    state.handoffBytes = 0;
    state.handoffPending = false;
}

function rememberHandoffPayload(state: PageState, item: Payload) {
    if (item.start === 0) return;
    state.handoff[item.kind].push(item);
    state.handoffBytes += item.bytes.byteLength;

    // Keep a rolling, bounded tail. Dropping the oldest partial segment is
    // safe: the bridge's sidx map selects the first later segment whose entire
    // byte range is present; retaining many complete following segments avoids
    // depending on the page to re-fetch its MSE buffer after a recast.
    while (state.handoffBytes > MAX_PENDING_BYTES) {
        const oldest = (["video", "audio"] as const)
            .map(kind => ({ kind, item: state.handoff[kind][0] }))
            .filter((entry): entry is { kind: Kind; item: Payload } =>
                Boolean(entry.item)
            )
            .sort((a, b) => a.item.sequence - b.item.sequence)[0];
        if (!oldest) break;
        state.handoff[oldest.kind].shift();
        state.handoffBytes -= oldest.item.bytes.byteLength;
    }
}

function resetMediaGeneration(state: PageState, reason: string) {
    state.kindGeneration.video++;
    state.kindGeneration.audio++;
    // Bump the upload epoch and drop the relay identity: any in-flight
    // upload chain from the previous generation must stop touching
    // pendingBytes or POSTing — its captured `pending` array reference points
    // at arrays this reset just replaced, and a stale 204 would otherwise
    // drive state.pendingBytes negative.
    invalidateRelayUploads(state);
    state.requestId = undefined;
    state.overflowNotified = false;
    state.paths.clear();
    state.initByKind = {};
    state.notifyWhenInitialized.clear();
    state.pending = { video: [], audio: [] };
    state.pendingBytes = 0;
    clearHandoff(state);
    for (const [requestId, request] of requests) {
        if (request.page === state) requests.delete(requestId);
    }
    logger.info("[Bilibili page capture] media generation reset", {
        reason,
        kindGeneration: { ...state.kindGeneration }
    });
}

function pageState(tabId: number, pageUrl?: string) {
    const identity = pageIdentity(pageUrl);
    let state = pages.get(tabId);
    if (state && identity && state.pageUrl && state.pageUrl !== identity) {
        resetMediaGeneration(state, "page-identity-changed");
        pages.delete(tabId);
        state = undefined;
    }
    if (!state) {
        state = {
            tabId,
            pageUrl: identity,
            paths: new Map(),
            representations: new Map(),
            initByKind: {},
            kindGeneration: { video: 0, audio: 0 },
            notifyWhenInitialized: new Set(),
            pending: { video: [], audio: [] },
            pendingBytes: 0,
            upload: { video: Promise.resolve(), audio: Promise.resolve() },
            retryTimers: {},
            retryAttempts: {},
            handoff: { video: [], audio: [] },
            handoffBytes: 0,
            handoffPending: false,
            uploadEpoch: 0
        };
        pages.set(tabId, state);
    } else if (identity) {
        state.pageUrl = identity;
    }
    return state;
}
function addRepresentations(state: PageState, value: unknown) {
    const root = value as any;
    const data = root?.data ?? root;
    const dash = data?.dash ?? data?.data?.dash;
    if (!dash) return;
    const next = new Map<string, ManifestEntry>();
    const add = (items: any, kind: Kind) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            const url = item?.baseUrl ?? item?.base_url;
            const resource =
                typeof url === "string" ? mediaResource(url) : undefined;
            if (!resource) continue;
            const { path } = resource;
            // SegmentBase carries the DASH byte ranges of the init segment and
            // the sidx index (e.g. Initialization "0-994", indexRange
            // "995-18018"). A candidate representation is only committable
            // once its captured bytes cover through the end of the index.
            const segmentBase =
                item?.SegmentBase ?? item?.segmentBase ?? item?.segment_base;
            const indexSpec =
                segmentBase?.indexRange ??
                segmentBase?.IndexRange ??
                segmentBase?.index_range;
            const rangeEnd = (spec?: string) => {
                const match = /^\d+-\d+$/.exec(String(spec ?? ""));
                return match ? Number(match[2]) + 1 : undefined;
            };
            next.set(path, {
                kind,
                // indexRange ONLY. Falling back to the Initialization end
                // would treat an init-only capture as "init+sidx ready" and
                // commit a candidate the bridge cannot parse; an unknown
                // indexRange falls back to the complete-Range-0 requirement.
                initEndExclusive: rangeEnd(indexSpec)
            });
        }
    };
    add(dash.video, "video");
    add(dash.audio, "audio");
    if (!next.size) return;
    state.representations = next;

    // A manifest response describes what the page may request next. It is not
    // itself proof that the player stopped consuming the currently committed
    // paths. Keep committed streams until an actual page request selects a
    // replacement. Only discard uncommitted candidates no longer authorized
    // by the latest page manifest.
    for (const [path, stream] of [...state.paths.entries()]) {
        if (stream.replacesPath && !next.has(path)) {
            // Revoked candidate: full teardown (also releases its in-flight
            // capture requests immediately).
            abandonCandidate(state, stream, path, "manifest-revoked");
        }
    }
    logger.info("[Bilibili page capture] representation manifest cached", {
        representations: [...next.entries()],
        committed: [...state.paths.entries()]
            .filter(([, stream]) => !stream.replacesPath)
            .map(([path, stream]) => [path, stream.kind])
    });
}
function extractPlayInfo(html: string): unknown {
    const marker = /window\.__playinfo__\s*=\s*/g;
    const match = marker.exec(html);
    if (!match) return undefined;
    const start = html.indexOf("{", match.index + match[0].length);
    if (start < 0) return undefined;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
        const char = html[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {
            try {
                return JSON.parse(html.slice(start, i + 1));
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}
function teeTextResponse(
    requestId: string,
    onText: (text: string, complete: boolean) => boolean | void
) {
    const factory = (browser.webRequest as any).filterResponseData;
    if (typeof factory !== "function") return;
    const filter = factory(requestId);
    const decoder = new TextDecoder();
    let text = "";
    let done = false;
    filter.ondata = (event: { data: ArrayBuffer }) => {
        filter.write(event.data);
        if (done) return;
        text += decoder.decode(event.data, { stream: true });
        if (onText(text, false) === true) done = true;
    };
    filter.onstop = () => {
        if (done) {
            filter.close();
            return;
        }
        text += decoder.decode();
        filter.close();
        onText(text, true);
    };
    filter.onerror = () => {
        try {
            filter.disconnect();
        } catch {}
    };
}

/**
 * Ask the sender to rebuild the relay for this tab (fresh bridge generation,
 * fresh capture window). Used by the extension's own upload failure paths —
 * backlog over cap, an unexpected 4xx, retry exhaustion — mirroring the
 * bridge's terminal verdict on main:bilibiliCaptureOverflow. `requestId` is
 * forwarded when known so the sender can ignore a request that belongs to a
 * generation it has already replaced.
 */
function notifyCaptureUploadFailure(
    state: PageState,
    source: string,
    requestId?: string,
    kind?: Kind
) {
    logger.warn("[Bilibili page capture] relay rebuild requested", {
        tabId: state.tabId,
        source,
        requestId,
        kind,
        pendingBytes: state.pendingBytes
    });
    void browser.tabs
        .sendMessage(state.tabId, {
            subject: "bilibili:captureOverflow",
            data: { source, requestId, kind }
        })
        .catch(() => undefined);
}

/**
 * Retryable-failure backoff (503 / network errors): 250ms doubling to 8s.
 * A fixed 250ms retry on an unchanged queue head would spin forever on a
 * permanent failure, while stopping silently would strand the generation with
 * no timer and no notification — so the threshold escalates to an explicit
 * rebuild request instead of giving up.
 */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 8_000;
const RETRY_REBUILD_THRESHOLD = 8;

function scheduleRetry(state: PageState, kind: Kind) {
    if (state.retryTimers[kind] || !state.endpoint || !state.requestId) return;
    const requestId = state.requestId;
    const attempt = (state.retryAttempts[kind] ?? 0) + 1;
    state.retryAttempts[kind] = attempt;

    if (attempt >= RETRY_REBUILD_THRESHOLD) {
        // Terminal for this upload generation: ask for a rebuild FIRST (the
        // notification carries the request id), then invalidate so no stale
        // in-flight chain can post into the replaced endpoint.
        notifyCaptureUploadFailure(
            state,
            "upload-retry-exhausted",
            requestId,
            kind
        );
        invalidateRelayUploads(state);
        return;
    }

    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const uploadEpoch = state.uploadEpoch;
    state.retryTimers[kind] = setTimeout(() => {
        delete state.retryTimers[kind];
        // A relay boundary (begin/commit/end/reset) invalidates this retry.
        if (state.uploadEpoch !== uploadEpoch) return;
        flush(state, kind);
    }, delay);
}
function flush(state: PageState, kind: Kind) {
    if (!state.endpoint || !state.requestId) return;
    const retryTimer = state.retryTimers[kind];
    if (retryTimer) {
        clearTimeout(retryTimer);
        delete state.retryTimers[kind];
    }
    state.upload[kind] = state.upload[kind].then(async () => {
        const pending = state.pending[kind];
        const uploadEpoch = state.uploadEpoch;
        const epochCurrent = () => state.uploadEpoch === uploadEpoch;
        while (
            state.endpoint &&
            state.requestId &&
            epochCurrent() &&
            pending.length
        ) {
            const item = pending[0];
            const ep = state.endpoint;
            const requestId = state.requestId;
            const url =
                `http://127.0.0.1:${ep.port}/ingest?rid=${encodeURIComponent(
                    requestId
                )}` +
                `&gen=${ep.generation}&kind=${kind}&start=${item.start}&end=${item.end}&total=${item.total}`;
            try {
                const response = await fetch(url, {
                    method: "POST",
                    body: item.bytes,
                    cache: "no-store"
                });
                if (!epochCurrent()) return;
                if (!response.ok) {
                    if (response.status === 409) {
                        // Contract with the bridge: 409 means EXACTLY "stale
                        // cross-representation payload" (total mismatch on a
                        // non-init range). Drop this item, keep the endpoint —
                        // an invalid payload must never disarm a live
                        // generation — and count it as queue progress so it
                        // also clears the consecutive-failure backoff.
                        pending.shift();
                        state.pendingBytes -= item.bytes.byteLength;
                        state.retryAttempts[kind] = 0;
                        continue;
                    }
                    if (
                        response.status === 403 ||
                        response.status === 410 ||
                        response.status === 507
                    ) {
                        // Terminal for this endpoint: requestId mismatch, a
                        // replaced capture generation, or a generation that was
                        // terminated (which already requested a rebuild).
                        if (
                            state.requestId === requestId &&
                            state.endpoint?.port === ep.port &&
                            state.endpoint?.generation === ep.generation
                        ) {
                            state.endpoint = undefined;
                        }
                        return;
                    }
                    if (response.status >= 400 && response.status < 500) {
                        // Unexpected 4xx: the payload cannot be proven safe to
                        // discard, so rebuild instead of hammering the same
                        // queue head in a hot retry loop. The status is part of
                        // the recorded reason so the verdict is diagnosable.
                        notifyCaptureUploadFailure(
                            state,
                            `upload-rejected-${response.status}`,
                            requestId,
                            kind
                        );
                        invalidateRelayUploads(state);
                        return;
                    }
                    scheduleRetry(state, kind);
                    return;
                }
                if (!epochCurrent()) return;
                const destinationIsCurrent =
                    state.requestId === requestId &&
                    state.endpoint?.port === ep.port &&
                    state.endpoint?.generation === ep.generation;
                if (!destinationIsCurrent) return;
                if (pending[0] !== item) continue;
                pending.shift();
                state.pendingBytes -= item.bytes.byteLength;
                state.retryAttempts[kind] = 0;
            } catch {
                if (!epochCurrent()) return;
                scheduleRetry(state, kind);
                return;
            }
        }
    });
}
function enqueue(state: PageState, item: Payload) {
    const pending = state.pending[item.kind];
    // Append only: payloads are created under a global monotonic sequence and
    // enqueued in arrival order, so the queue is already sequence-sorted.
    // (begin() re-sorts once on the rare re-prime path.) A per-chunk sort here
    // would be O(n log n) on the hot path exactly when the bridge is behind.
    pending.push(item);
    state.pendingBytes += item.bytes.byteLength;
    let droppedWhileArmed = false;
    // Confirmed POSTs are already shifted off the queue, so this bounds the
    // unconfirmed backlog only. While armed, dropping a non-init payload
    // means the bridge is not consuming fast enough — the bytes are gone for
    // good (the bridge reads strictly in order). Disarm FIRST: an atomic
    // stop of the old feed so no further payload is POSTed (and acked) into
    // a stream we just holed, then drop, then request a rebuild.
    while (state.pendingBytes > MAX_PENDING_BYTES) {
        const candidates = (["video", "audio"] as const)
            .map(kind => ({
                kind,
                item: state.pending[kind].find(value => value.start !== 0)
            }))
            .filter((entry): entry is { kind: Kind; item: Payload } =>
                Boolean(entry.item)
            )
            .sort((a, b) => a.item.sequence - b.item.sequence);
        const oldest = candidates[0];
        if (!oldest) break;
        if (state.endpoint) {
            // Relay boundary: kill the old upload generation immediately
            // (epoch bump + chain heads) rather than only disarming — in
            // flight fetches from the overflowed relay stop mattering at
            // their next await checkpoint.
            invalidateRelayUploads(state);
            droppedWhileArmed = true;
        }
        const queue = state.pending[oldest.kind];
        const index = queue.indexOf(oldest.item);
        queue.splice(index, 1);
        state.pendingBytes -= oldest.item.bytes.byteLength;
    }
    if (droppedWhileArmed) {
        // One dropped payload means the surviving window has a permanent hole
        // in the middle — carrying it into the rebuilt relay would park
        // ffmpeg on the gap forever. Keep only the init segments; the rebuilt
        // generation re-primes from initByKind and fills its window with
        // fresh arrivals from the still-playing page.
        for (const kind of ["video", "audio"] as const) {
            state.pending[kind] = state.pending[kind].filter(
                item => item.start === 0
            );
        }
        state.pendingBytes = (["video", "audio"] as const).reduce(
            (total, kind) =>
                total +
                state.pending[kind].reduce(
                    (sum, item) => sum + item.bytes.byteLength,
                    0
                ),
            0
        );
    }
    if (droppedWhileArmed && !state.overflowNotified) {
        // Once this generation has been invalidated and a rebuild requested,
        // later backlog trimming only bounds memory: the endpoint is gone, so
        // `droppedWhileArmed` cannot become true again for the same dead
        // generation and no second notification is emitted.
        state.overflowNotified = true;
        notifyCaptureUploadFailure(state, "extension-backlog", state.requestId);
    }
    flush(state, item.kind);
}
function abandonRequest(id: string) {
    const request = requests.get(id);
    if (!request) return;
    // Per-request cleanup ONLY. A page-side abort (buffer-window shift,
    // seek-cancel, prefetch replacement, network scheduling) says nothing
    // about the candidate representation itself: other in-flight requests
    // and re-fetches can still complete it, and bytes already published stay
    // in the candidate queue. Candidates are abandoned only through the
    // explicit verdicts in maybeCommitCandidate/abandonCandidate (conflicting
    // overlap, cache limit, manifest revoke).
    request.chunks = [];
    request.deferredChunks = [];
    requests.delete(id);
}
function finalize(id: string) {
    const request = requests.get(id);
    if (!request?.stopped) return;
    if (
        request.rangeStart === undefined ||
        request.rangeEnd === undefined ||
        request.rangeTotal === undefined
    ) {
        // No usable Content-Range: nothing to publish.
        // onCompleted/onErrorOccurred will clean the entry up.
        if (request.completed) abandonRequest(id);
        return;
    }
    requests.delete(id);
    const stream = request.page.paths.get(request.path);
    if (!stream) return;
    if (request.kindGeneration !== stream.kindGeneration) return;
    if (request.bytes !== request.rangeEnd - request.rangeStart + 1) return;
    if (request.rangeStart !== 0) return;

    // Media payloads were already forwarded per chunk by publish(); what
    // remains here is the INIT response (bytes 0..N: ftyp+moov+sidx) — the
    // master-playlist analog — plus the replacement-representation commit.
    const merged = new Uint8Array(request.bytes);
    let offset = 0;
    for (const chunk of request.chunks) {
        merged.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }
    const init: Payload = {
        kind: stream.kind,
        start: 0,
        end: request.rangeEnd,
        total: request.rangeTotal,
        bytes: merged.buffer,
        sequence: sequence++
    };
    const previous = request.page.initByKind[stream.kind];
    if (stream.replacesPath) {
        // Candidate init: park it on the CANDIDATE itself — never in the
        // page-level initByKind (still owned by the old committed
        // representation until commit) and never duplicated into queued
        // (begin() would hand BOTH copies to the new bridge). queued carries
        // index/media payloads only; coverage counts stream.init separately.
        stream.init = init;
        if (candidateBytes(stream) > MAX_PENDING_BYTES) {
            // A pathological >cap init response is unusable, and waiting for
            // a media chunk to run the cap check would leave it parked.
            abandonCandidate(
                request.page,
                stream,
                request.path,
                "candidate-cache-limit"
            );
            return;
        }
        maybeCommitCandidate(request.page, stream, request.path);
        return;
    }
    if (!previous || init.end > previous.end) {
        request.page.initByKind[stream.kind] = init;
    }
}

/**
 * Contiguous byte coverage from offset 0 across the candidate's own init
 * payload and queued payloads. This is NOT the largest seen end: a hole keeps
 * the watermark pinned until a re-fetch fills it. Overlapping ranges are
 * byte-compared — conflicting content returns -1, which the caller treats as
 * an unusable candidate (catching here, BEFORE commit, beats letting the new
 * bridge reject the generation after the old relay is already torn down).
 *
 * Complexity: concurrent request completions can interleave byte ranges, so
 * arrival order is NOT byte order and the sort here is a real O(n log n) over
 * the candidate's queued payloads (with an O(n x accepted) overlap walk). It
 * runs only after the candidate's init exists, the queue is hard-capped, and
 * the candidate phase is transient; if that ever shows up as a hotspot, move
 * to an incrementally maintained ordered range set.
 */
function contiguousCoveredTo(stream: PathState): number {
    const ranges = (stream.init ? [stream.init] : [])
        .concat(stream.queued)
        .sort((a, b) => a.start - b.start);
    let covered = 0;
    const accepted: Payload[] = [];
    for (const range of ranges) {
        if (range.start > covered) break;
        for (const prior of accepted) {
            const overlapStart = Math.max(prior.start, range.start);
            const overlapEnd = Math.min(prior.end, range.end);
            if (overlapStart > overlapEnd) continue;
            const left = new Uint8Array(
                prior.bytes,
                overlapStart - prior.start,
                overlapEnd - overlapStart + 1
            );
            const right = new Uint8Array(
                range.bytes,
                overlapStart - range.start,
                overlapEnd - overlapStart + 1
            );
            let equal = true;
            for (let i = 0; i < left.length; i++) {
                if (left[i] !== right[i]) {
                    equal = false;
                    break;
                }
            }
            if (!equal) return -1;
        }
        if (range.end + 1 > covered) {
            covered = range.end + 1;
            accepted.push(range);
        }
    }
    return covered;
}

/** Candidate byte total: its queued payloads plus its own init payload. */
function candidateBytes(stream: PathState): number {
    return stream.queuedBytes + (stream.init?.bytes.byteLength ?? 0);
}

/** Discard a candidate whose bytes are unusable (conflicting overlap) or over
 * the candidate cache cap. The still-working committed representation is left
 * untouched, so the current relay keeps playing. */
function abandonCandidate(
    state: PageState,
    stream: PathState,
    path: string,
    reason: string
) {
    logger.warn("[Bilibili page capture] candidate abandoned", {
        tabId: state.tabId,
        kind: stream.kind,
        path,
        reason
    });
    // Release the in-flight capture requests bound to this candidate so their
    // buffered chunks and closures do not linger until the responses end.
    // (Their filters stay write-through; later callbacks no-op because the
    // request entries are gone.)
    for (const [id, request] of requests) {
        if (
            request.page === state &&
            request.path === path &&
            request.kindGeneration === stream.kindGeneration
        ) {
            request.chunks = [];
            request.deferredChunks = [];
            requests.delete(id);
        }
    }
    stream.queued = [];
    stream.queuedBytes = 0;
    stream.init = undefined;
    state.paths.delete(path);
    state.notifyWhenInitialized.delete(stream.kind);
}

/**
 * Commit a replacement representation only once the bridge will actually be
 * able to parse it: either the captured bytes cover the DASH SegmentBase
 * indexRange declared by the page's manifest (init + complete sidx), or —
 * when the manifest declares no indexRange — the candidate's own Range-0
 * response is verified to contain a complete sidx box. Committing on anything
 * weaker tears down the working committed stream for a candidate the bridge
 * would hang on.
 */
function maybeCommitCandidate(
    state: PageState,
    stream: PathState,
    path: string
) {
    if (!stream.replacesPath) return;
    // A first mid-file media chunk must never commit: the candidate's own
    // COMPLETE Range-0 (init) response is the minimum requirement.
    if (!stream.init) return;
    const coveredTo = contiguousCoveredTo(stream);
    if (coveredTo < 0) {
        abandonCandidate(state, stream, path, "conflicting-overlap");
        return;
    }
    const required = state.representations.get(path)?.initEndExclusive;
    if (required !== undefined) {
        if (coveredTo < required) return;
        // Defense in depth: when the whole required range came from the
        // candidate's own init response, verify it really contains a complete
        // sidx (a CDN entity whose length matches but content does not would
        // otherwise commit and hang the new relay). Split responses (index
        // fetched through queued media ranges) stay on the manifest-trusted
        // path — the bridge validates them on merge.
        if (
            stream.init.end + 1 >= required &&
            !containsCompleteSidx(stream.init.bytes)
        ) {
            abandonCandidate(state, stream, path, "invalid-sidx");
            return;
        }
    } else if (!containsCompleteSidx(stream.init.bytes)) {
        // Unknown indexRange: a complete Range-0 response is not proof of a
        // usable index (it may be an init-only fetch). Do not tear down the
        // working committed stream for a candidate without a complete sidx.
        return;
    }
    commitReplacement(state, stream, path);
}

/**
 * Lightweight probe: does `bytes` contain a COMPLETE sidx box (declared
 * reference_count fully inside the box, valid version)? It answers only
 * "is the index usable" — segment parsing stays on the bridge.
 */
function containsCompleteSidx(bytes: ArrayBuffer): boolean {
    const view = new DataView(bytes);
    let offset = 0;
    while (offset + 8 <= bytes.byteLength) {
        // getUint32 keeps box sizes unsigned (a plain bit-shift read turns
        // the high bit into a sign). largesize boxes (size32 === 1) are
        // rejected outright: the bridge parser does not consume them either,
        // keeping both validators semantics-aligned and conservative.
        const size = view.getUint32(offset, false);
        if (size === 1) return false;
        if (size < 8 || offset + size > bytes.byteLength) return false;
        if (view.getUint32(offset + 4, false) === 0x73696478) {
            // 'sidx'
            const version = view.getUint8(offset + 8);
            if (version !== 0 && version !== 1) return false;
            const timescale = view.getUint32(offset + 16, false);
            if (timescale === 0) return false;
            // body: ver/flags(4) refID(4) timescale(4) ept(4|8)
            // first_offset(4|8) reserved(2) count(2) refs(count*12)
            const countOffset = offset + 30 + (version === 1 ? 8 : 0);
            if (countOffset + 2 > offset + size) return false;
            const count = view.getUint16(countOffset, false);
            if (count === 0) return false;
            for (let i = 0; i < count; i++) {
                const refOffset = countOffset + 2 + i * 12;
                if (refOffset + 12 > offset + size) return false;
                const reference = view.getUint32(refOffset, false);
                // reference_type must be 0 (media); size and duration > 0.
                if (
                    (reference & 0x80000000) !== 0 ||
                    (reference & 0x7fffffff) === 0 ||
                    view.getUint32(refOffset + 4, false) === 0
                ) {
                    return false;
                }
            }
            return true;
        }
        offset += size;
    }
    return false;
}

/**
 * Commit a replacement representation's init segment: the media-generation
 * boundary for its kind. Bytes from the previous representation must never be
 * flushed into the new bridge/FFmpeg generation, so the committed stream is
 * replaced, the current kind's queue is cleared, and the (old-generation)
 * endpoint is disarmed. The candidate's queued bytes are handed to the next
 * begin/ready cycle once the sender has rebuilt the relay; the bounded reload
 * retry covers transient rebuild failures.
 */
function commitReplacement(state: PageState, stream: PathState, path: string) {
    const replacedPath = stream.replacesPath;
    if (!replacedPath || !stream.init) return;
    // Promote the candidate init to the page-level init INSIDE the same
    // atomic state transition as the stream replacement — never before.
    state.initByKind[stream.kind] = stream.init;
    state.paths.delete(replacedPath);
    stream.replacesPath = undefined;
    state.pendingBytes -= state.pending[stream.kind].reduce(
        (total, item) => total + item.bytes.byteLength,
        0
    );
    state.pending[stream.kind] = [];

    // Representation boundary: the retained rolling tail carries byte offsets
    // and a `total` belonging to the PREVIOUS representation and must never
    // cross into the next upload generation. The bridge's 409 contract also
    // rejects such stale non-init payloads safely, but clearing them here
    // avoids pointless POSTs and queue-head conflicts.
    clearHandoff(state);

    invalidateRelayUploads(state);
    logger.info(
        "[Bilibili page capture] replacement representation committed",
        {
            tabId: state.tabId,
            kind: stream.kind,
            from: replacedPath,
            to: path
        }
    );
    if (state.notifyWhenInitialized.delete(stream.kind)) {
        void browser.tabs
            .sendMessage(state.tabId, {
                subject: "bilibili:capturedRepresentationChanged",
                data: { kind: stream.kind, path }
            })
            .catch(() => undefined);
    }
}

export function beginBilibiliPageCapture(
    tabId: number,
    requestId: string,
    options: { resetWindow?: boolean } = {}
) {
    const state = pageState(tabId);
    // Every new relay (fresh cast, rebuild after overflow/stall, quality
    // switch, seek remux restart) starts its own upload epoch: stale in-flight
    // fetches and retry timers from the previous bridge generation must never
    // reach the new one, and the new chain must not queue behind a hung old
    // fetch.
    invalidateRelayUploads(state);
    state.requestId = requestId;
    state.endpoint = undefined;
    const consumeHandoff = options.resetWindow || state.handoffPending;
    if (consumeHandoff) {
        // Seek restart and Stop -> Cast both cross a capture-generation
        // boundary after the page may already have fetched the target/current
        // media into MSE. Drop the old pending window, keep init+sidx, and seed
        // the successor with the retained rolling tail.
        const handoff = state.handoff;
        const handoffBytes = state.handoffBytes;
        // Replaying must not consume the rolling tail. Otherwise each recast
        // advances the retained window toward the page's network buffer-ahead
        // until it no longer overlaps currentTime. Page seek resets the tail
        // explicitly before target ranges arrive.
        state.handoffPending = false;
        const keepInit = (items: Payload[]) => {
            const kept: Payload[] = [];
            for (const item of items) {
                if (item.start === 0) kept.push(item);
            }
            items.length = 0;
            items.push(...kept);
        };
        keepInit(state.pending.video);
        keepInit(state.pending.audio);
        for (const stream of state.paths.values()) {
            if (stream.replacesPath) continue;
            stream.queued = [];
            stream.queuedBytes = 0;
        }
        for (const kind of ["video", "audio"] as const) {
            state.pending[kind].push(...handoff[kind]);
        }
        state.pendingBytes =
            state.pending.video.reduce(
                (total, item) => total + item.bytes.byteLength,
                0
            ) +
            state.pending.audio.reduce(
                (total, item) => total + item.bytes.byteLength,
                0
            );
        if (handoffBytes > 0) {
            logger.info("[Bilibili page capture] generation handoff seeded", {
                tabId,
                requestId,
                reason: options.resetWindow ? "seek-restart" : "recast",
                bytes: handoffBytes,
                videoPayloads: handoff.video.length,
                audioPayloads: handoff.audio.length
            });
        }
    }
    for (const kind of ["video", "audio"] as const) {
        const init = state.initByKind[kind];
        if (!init) continue;
        const pending = state.pending[kind];
        const alreadyQueued = pending.some(
            item => item.start === init.start && item.end === init.end
        );
        if (!alreadyQueued) {
            pending.unshift({ ...init, sequence: sequence++ });
            state.pendingBytes += init.bytes.byteLength;
        }
        const committed = [...state.paths.values()].find(
            stream => stream.kind === kind && !stream.replacesPath
        );
        if (committed?.queued.length) {
            for (const item of committed.queued.splice(0)) {
                pending.push(item);
                state.pendingBytes += item.bytes.byteLength;
            }
            committed.queuedBytes = 0;
        }
    }
    for (const kind of ["video", "audio"] as const) {
        state.pending[kind].sort((a, b) => {
            if (a.start === 0 && b.start !== 0) return -1;
            if (b.start === 0 && a.start !== 0) return 1;
            return a.sequence - b.sequence;
        });
    }
}
export function armBilibiliPageCapture(
    tabId: number,
    requestId: string,
    port: number,
    generation: number
) {
    const state = pages.get(tabId);
    if (!state || state.requestId !== requestId) return;
    state.endpoint = { port, generation };
    state.overflowNotified = false;
    flush(state, "video");
    flush(state, "audio");
}
export function endBilibiliPageCapture(tabId: number, requestId?: string) {
    const state = pages.get(tabId);
    if (!state || (requestId && state.requestId !== requestId)) return;
    // Keep the rolling tail across an explicit Stop. A subsequent Cast starts
    // a fresh bridge generation, while the page may continue from bytes that
    // are already resident in MSE and therefore never issue another request.
    state.handoffPending = state.handoffBytes > 0;
    logger.info("[Bilibili page capture] capture ended", {
        tabId,
        retainedHandoffBytes: state.handoffBytes,
        handoffPending: state.handoffPending
    });
    invalidateRelayUploads(state);
    state.requestId = undefined;
}
export function initBilibiliPageCapture() {
    if (initialized) return;
    initialized = true;
    void browser.tabs.query({}).then(tabs =>
        tabs.forEach(tab => {
            if (tab.id !== undefined && videoPage(tab.url))
                pageState(tab.id, tab.url);
        })
    );
    browser.tabs.onUpdated.addListener((tabId, change, tab) => {
        const url = change.url ?? tab.url;
        if (videoPage(url)) {
            pageState(tabId, url);
        } else if (change.url) {
            // Same teardown as tab removal: without it the old state's
            // pending payloads, candidate queues, retry timers and capture
            // requests linger until their own lifetimes expire.
            const state = pages.get(tabId);
            if (state) resetMediaGeneration(state, "left-video-page");
            pages.delete(tabId);
        }
    });
    browser.tabs.onRemoved.addListener(tabId => {
        const state = pages.get(tabId);
        if (!state) return;
        resetMediaGeneration(state, "tab-removed");
        pages.delete(tabId);
    });
    browser.runtime.onMessage.addListener((message: any, sender: any) => {
        const tabId = sender.tab?.id ?? message.data?.tabId;
        const state = typeof tabId === "number" ? pages.get(tabId) : undefined;
        if (message?.subject === "bilibili:pageSeekStarted") {
            if (!state) return undefined;
            clearHandoff(state);
            logger.info("[Bilibili page capture] page-seek handoff reset", {
                tabId
            });
            return undefined;
        }
        if (message?.subject !== "bilibili:getCapturedMedia") return undefined;
        if (!state) return undefined;
        let videoUrl: string | undefined;
        let audioUrl: string | undefined;
        for (const stream of state.paths.values()) {
            if (stream.replacesPath) continue;
            if (stream.kind === "video") videoUrl = stream.url;
            if (stream.kind === "audio") audioUrl = stream.url;
        }
        const ready =
            videoUrl &&
            audioUrl &&
            state.initByKind.video &&
            state.initByKind.audio;
        return Promise.resolve(ready ? { videoUrl, audioUrl } : undefined);
    });
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            const previous = pages.get(details.tabId);
            if (previous) {
                resetMediaGeneration(previous, "main-frame-navigation");
                pages.delete(details.tabId);
            }
            const state = pageState(details.tabId, details.url);
            let published = false;
            teeTextResponse(details.requestId, html => {
                if (published) return true;
                const playInfo = extractPlayInfo(html);
                if (!playInfo) return;
                published = true;
                addRepresentations(state, playInfo);
                // The manifest is in hand: stop accumulating the rest of the HTML
                // (the filter keeps writing through to the page regardless).
                return true;
            });
        },
        {
            urls: [
                "*://www.bilibili.com/video/*",
                "*://www.bilibili.com/bangumi/play/*"
            ],
            types: ["main_frame"]
        },
        ["blocking"]
    );
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            const state = pages.get(details.tabId);
            if (!state) return;
            let path: string;
            try {
                path = new URL(details.url).pathname;
            } catch {
                return;
            }
            if (!path.endsWith("/playurl")) return;
            teeTextResponse(details.requestId, (text, complete) => {
                if (!complete) return;
                try {
                    addRepresentations(state, JSON.parse(text));
                } catch {}
            });
        },
        {
            urls: ["*://api.bilibili.com/x/player/*"],
            types: ["xmlhttprequest"]
        },
        ["blocking"]
    );

    browser.webRequest.onHeadersReceived.addListener(
        details => {
            const request = requests.get(details.requestId);
            if (!request) return;
            const value = details.responseHeaders?.find(
                h => h.name.toLowerCase() === "content-range"
            )?.value;
            const match = value
                ? /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value)
                : undefined;
            if (match) {
                request.rangeStart = Number(match[1]);
                request.rangeEnd = Number(match[2]);
                request.rangeTotal = Number(match[3]);
                if (request.rangeStart !== 0) {
                    // Early chunks of a media response were buffered only because
                    // their offset was unknown; they have just been published via
                    // the deferred flush, so the redundant copies can go.
                    request.chunks = [];
                }
            }
            request.publishDeferred?.();
            finalize(details.requestId);
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] },
        ["responseHeaders"]
    );
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            const state = pages.get(details.tabId);
            const resource = mediaResource(details.url);
            if (!state || !resource) return;
            const { path } = resource;
            let stream = state.paths.get(path);
            const kind =
                stream && !stream.replacesPath
                    ? stream.kind
                    : state.representations.get(path)?.kind ?? resource.kind;
            if (!kind) return;
            const committedForKind = [...state.paths.entries()].find(
                ([, item]) => item.kind === kind && !item.replacesPath
            );
            const candidateForKind = [...state.paths.entries()].find(
                ([, item]) => item.kind === kind && Boolean(item.replacesPath)
            );
            if (!stream && candidateForKind) {
                // Only one uncommitted representation per kind. A second page
                // candidate supersedes the first without touching the committed
                // stream or repeatedly advancing the generation for each request.
                abandonCandidate(
                    state,
                    candidateForKind[1],
                    candidateForKind[0],
                    "superseded"
                );
            }
            if (!stream && committedForKind && committedForKind[0] !== path) {
                const castGenerationActive = Boolean(state.endpoint);
                state.kindGeneration[kind]++;
                logger.info(
                    "[Bilibili page capture] representation candidate selected",
                    {
                        tabId: details.tabId,
                        kind,
                        from: committedForKind[0],
                        to: path,
                        kindGeneration: state.kindGeneration[kind],
                        castGenerationActive
                    }
                );
                if (castGenerationActive) state.notifyWhenInitialized.add(kind);
            }
            stream = state.paths.get(path);
            if (!stream) {
                stream = {
                    url: details.url,
                    kind,
                    queued: [],
                    queuedBytes: 0,
                    replacesPath: committedForKind?.[0],
                    kindGeneration: state.kindGeneration[kind]
                };
                state.paths.set(path, stream);
                logger.info(
                    "[Bilibili page capture] exact page stream selected",
                    {
                        tabId: details.tabId,
                        path,
                        kind
                    }
                );
            }
            stream.url = details.url;
            const factory = (browser.webRequest as any).filterResponseData;
            if (typeof factory !== "function") return;
            const request: CaptureRequest = {
                page: state,
                kindGeneration: stream.kindGeneration,
                path,
                chunks: [],
                bytes: 0,
                nextOffset: 0,
                stopped: false,
                completed: false,
                deferredChunks: []
            };
            requests.set(details.requestId, request);
            const filter = factory(details.requestId);
            // Real-time per-chunk publishing: each chunk is copied through AND
            // forwarded to the bridge the moment its source offset is known, so a
            // large (or never-finishing) in-flight Range response cannot starve
            // ffmpeg. Chunks that arrive before the response headers carry an
            // unknown offset — they are held in arrival order and flushed
            // immediately once Content-Range lands. An aborted response keeps
            // every byte it already delivered.
            const publish = (copy: ArrayBuffer) => {
                if (
                    pages.get(details.tabId) !== state ||
                    state.paths.get(path) !== stream ||
                    stream!.kindGeneration !== request.kindGeneration
                )
                    return;
                if (
                    request.rangeStart === undefined ||
                    request.rangeEnd === undefined ||
                    request.rangeTotal === undefined
                ) {
                    request.deferredChunks.push(copy);
                    return;
                }
                const start = request.rangeStart + request.nextOffset;
                const end = start + copy.byteLength - 1;
                if (end > request.rangeEnd) return;
                const item: Payload = {
                    kind,
                    start,
                    end,
                    total: request.rangeTotal,
                    bytes: copy,
                    sequence: sequence++
                };
                if (!stream!.replacesPath) {
                    rememberHandoffPayload(state, item);
                }
                if (stream!.replacesPath) {
                    stream!.queued.push(item);
                    stream!.queuedBytes += copy.byteLength;
                    if (candidateBytes(stream!) > MAX_PENDING_BYTES) {
                        abandonCandidate(
                            state,
                            stream!,
                            path,
                            "candidate-cache-limit"
                        );
                        return;
                    }
                    maybeCommitCandidate(state, stream!, path);
                } else {
                    enqueue(state, item);
                }
                request.nextOffset += copy.byteLength;
            };
            request.publishDeferred = () => {
                const copies = request.deferredChunks.splice(0);
                // Chunks that arrived before the response headers were buffered
                // because their offset was unknown. Now that it is known, an init
                // response (start 0) must NOT be published per chunk — its early
                // chunks are already in request.chunks and finalize() will
                // republish the complete init as one payload.
                if (request.rangeStart === 0) return;
                for (const copy of copies) publish(copy);
            };
            filter.ondata = (event: { data: ArrayBuffer }) => {
                filter.write(event.data);
                // Identity guard before buffering: once a candidate is superseded
                // or abandoned, an in-flight response must stop accumulating into
                // request.chunks even though publish() would drop it anyway.
                if (
                    pages.get(details.tabId) !== state ||
                    state.paths.get(path) !== stream ||
                    stream!.kindGeneration !== request.kindGeneration
                )
                    return;
                const copy = event.data.slice(0);
                if (
                    request.rangeStart === 0 ||
                    request.rangeStart === undefined
                ) {
                    request.chunks.push(copy);
                }
                // Init responses are exempt from real-time publishing: they are
                // small, and finalize() republishes each as ONE complete init
                // payload — per-chunk init copies would duplicate every byte in
                // pending and again in begin()'s re-queue.
                if (request.rangeStart !== 0) publish(copy);
                request.bytes += copy.byteLength;
            };
            filter.onstop = () => {
                filter.close();
                request.stopped = true;
                request.publishDeferred?.();
                finalize(details.requestId);
            };
            filter.onerror = () => {
                abandonRequest(details.requestId);
                try {
                    filter.disconnect();
                } catch {}
            };
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] },
        ["blocking"]
    );
    browser.webRequest.onCompleted.addListener(
        details => {
            const request = requests.get(details.requestId);
            if (!request) return;
            request.completed = true;
            request.publishDeferred?.();
            finalize(details.requestId);
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] }
    );
    browser.webRequest.onErrorOccurred.addListener(
        details => {
            abandonRequest(details.requestId);
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest", "media", "other"] }
    );
}
