import logger from "../lib/logger";

/**
 * Page TS segment capture for CCTV live casts.
 *
 * While a CCTV live relay runs, the page player keeps fetching TS segments at
 * the live edge. Those response bodies are the ground truth for what the CDN
 * is actually serving, so they are forwarded to the bridge's live relay and
 * used as the ONLY supply for pipeline sequences past the relay's bootstrap
 * frontier (no CDN fetch, no publish polling). Segments before the frontier
 * (the initial historical window) stay on the bridge's own validated network
 * path.
 *
 * Transport: the extension background POSTs each captured segment to the
 * relay's `/cctv-page-capture` endpoint. Between relay generations (recovery
 * rebuild, bridge boot) nothing is listening, so captures accumulate in a
 * bounded buffer here and are flushed the next time a relay reports ready.
 */

/** Where captured segments should be POSTed (one relay generation). */
interface TsIngestEndpoint {
    /** Relay listener port (the sender's configured localMediaServerPort). */
    port: number;
    /** relay requestId the endpoint is authenticated with. */
    requestId: string;
}

interface TsCaptureState {
    endpoint?: TsIngestEndpoint;
    /**
     * True from session start: the relay may not be listening yet (it comes up
     * before its prebuffer completes), so failed POSTs buffer for the retry
     * timer instead of switching the state off. Only an explicit
     * mediaServerStopped/Error for the active rid disarms.
     */
    armed: boolean;
    /**
     * cdrmld-seeded sessions: the page plays the enc1/AV1 tree while the relay
     * serves cdrmld H.264, so captured bytes are unusable. Captures degrade to
     * body-less progress heartbeats (the bridge only reads their timestamp).
     */
    heartbeatOnly: boolean;
    /** Captures awaiting a listening relay (bounded, FIFO). */
    pending: Array<{ url: string; bytes: ArrayBuffer }>;
    pendingBytes: number;
    /** Periodic flush of buffered captures while armed. */
    retryTimer?: ReturnType<typeof setInterval>;
}

const tsCaptureByTab = new Map<number, TsCaptureState>();

/** Bounded buffer for the relay-restart gap. */
const TS_PENDING_MAX_BYTES = 96 * 1024 * 1024;
const TS_PENDING_MAX_ENTRIES = 64;

function newState(heartbeatOnly: boolean): TsCaptureState {
    return {
        armed: false,
        heartbeatOnly,
        pending: [],
        pendingBytes: 0
    };
}

function bufferPending(state: TsCaptureState, url: string, bytes: ArrayBuffer) {
    state.pending.push({ url, bytes });
    state.pendingBytes += bytes.byteLength;
    while (
        state.pending.length > 1 &&
        (state.pending.length > TS_PENDING_MAX_ENTRIES ||
            state.pendingBytes > TS_PENDING_MAX_BYTES)
    ) {
        const dropped = state.pending.shift();
        if (dropped) state.pendingBytes -= dropped.bytes.byteLength;
    }
}

/**
 * POST one capture to the relay. Returns "sent", "rejected" (the relay is
 * listening but refused THIS segment — drop it) or "unreachable" (re-buffer
 * and disarm until the next mediaServerStarted re-arms the endpoint).
 * Bodies are carried as ArrayBuffer: it is accepted by fetch's BodyInit
 * directly, while a bare Uint8Array annotation widens to ArrayBufferLike
 * under TS >= 5.7 and no longer satisfies BufferSource.
 */
async function postCapturedSegment(
    state: TsCaptureState,
    url: string,
    bytes: ArrayBuffer
): Promise<"sent" | "rejected" | "unreachable"> {
    const endpoint = state.endpoint;
    if (!endpoint) return "unreachable";
    try {
        const ingestUrl =
            `http://127.0.0.1:${endpoint.port}/cctv-page-capture` +
            `?rid=${encodeURIComponent(endpoint.requestId)}` +
            `&u=${encodeURIComponent(url)}`;
        const response = await fetch(ingestUrl, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: bytes,
            cache: "no-store"
        });
        if (response.ok) return "sent";
        // The relay is alive but does not want these bytes (wrong variant, bad
        // rid, unrecognized URL): dropping one segment must not disable the
        // whole ingest path.
        logger.warn("CCTV page capture ingest rejected", {
            url,
            status: response.status
        });
        void response.body?.cancel().catch(() => undefined);
        return "rejected";
    } catch (error) {
        // The listener is not up yet (relay still prebuffering — it listens
        // before it is ready) or the bridge is between relays: keep the capture
        // and let the retry timer flush it. Arming is only revoked by an
        // explicit mediaServerStopped/Error.
        logger.warn("CCTV page capture ingest unreachable; buffering", {
            url,
            error: error instanceof Error ? error.message : String(error)
        });
        return "unreachable";
    }
}

/**
 * cdrmld sessions: notify the relay that the page downloaded `url`. No bytes
 * travel — the relay only reads the request's arrival time as its page
 * download progress watermark. Silent by design: a missed heartbeat is
 * self-healing (the next segment arrives seconds later).
 */
async function postHeartbeat(
    state: TsCaptureState,
    url: string
): Promise<void> {
    const endpoint = state.endpoint;
    if (!endpoint || !state.armed) return;
    try {
        const ingestUrl =
            `http://127.0.0.1:${endpoint.port}/cctv-page-capture` +
            `?rid=${encodeURIComponent(endpoint.requestId)}` +
            `&u=${encodeURIComponent(url)}&hb=1`;
        const response = await fetch(ingestUrl, {
            method: "POST",
            cache: "no-store"
        });
        if (!response.ok) void response.body?.cancel().catch(() => undefined);
    } catch {
        /* relay between generations; the next segment's heartbeat retries */
    }
}

async function flushPending(state: TsCaptureState) {
    while (state.pending.length > 0 && state.armed) {
        const next = state.pending[0];
        if (!next) break;
        const outcome = await postCapturedSegment(state, next.url, next.bytes);
        if (outcome === "sent") {
            state.pending.shift();
            state.pendingBytes -= next.bytes.byteLength;
        } else if (outcome === "rejected") {
            state.pending.shift();
            state.pendingBytes -= next.bytes.byteLength;
        } else {
            break;
        }
    }
}

/**
 * Start (or re-arm, on a recovery rebuild) capture for a tab. An existing
 * buffer is kept: segments captured during a relay restart belong to the
 * rebuilt relay's window. Arming is optimistic — POSTs that arrive before
 * the relay's listener exists buffer and are flushed by the retry timer, so
 * a recovery prebuffer that needs still-arriving segments is never starved
 * by the handshake.
 */
export function beginCctvPageCapture(
    tabId: number,
    endpoint: TsIngestEndpoint,
    heartbeatOnly = false
) {
    const state = tsCaptureByTab.get(tabId) ?? newState(heartbeatOnly);
    if (state.heartbeatOnly !== heartbeatOnly) {
        // Mode switch (e.g. the page delivery changed between casts): buffered
        // bytes from the previous mode belong to a different tree and would only
        // be rejected by the new relay.
        state.pending.length = 0;
        state.pendingBytes = 0;
    }
    state.heartbeatOnly = heartbeatOnly;
    state.endpoint = endpoint;
    state.armed = true;
    if (!state.retryTimer) {
        state.retryTimer = setInterval(() => {
            if (state.armed && state.pending.length > 0)
                void flushPending(state);
        }, 2000);
    }
    tsCaptureByTab.set(tabId, state);
    void armCctvPageCaptureInTab(tabId);
}

/** The relay for `requestId` is listening: buffered captures go out now. */
export function armCctvPageCaptureIngest(tabId: number, requestId: string) {
    const state = tsCaptureByTab.get(tabId);
    if (!state || state.endpoint?.requestId !== requestId) return;
    state.armed = true;
    void flushPending(state);
}

/** The relay for `requestId` stopped/failed: back to buffering. */
export function pauseCctvPageCaptureIngest(tabId: number, requestId: string) {
    const state = tsCaptureByTab.get(tabId);
    if (!state || state.endpoint?.requestId !== requestId) return;
    state.armed = false;
}

/** Cast session over: drop all capture state for the tab. */
export function endCctvPageCapture(tabId: number) {
    const state = tsCaptureByTab.get(tabId);
    if (state?.retryTimer) clearInterval(state.retryTimer);
    tsCaptureByTab.delete(tabId);
    void browser.scripting
        .executeScript({
            target: { tabId },
            func: (enabled: boolean) => {
                (window as any).__fxCastCctvTsCaptureEnabled = enabled;
            },
            args: [false],
            world: "MAIN",
            injectImmediately: true
        } as any)
        .catch(() => undefined);
}

/** True when the tab currently has an active capture session. */
export function isCctvPageCaptureActive(tabId: number): boolean {
    return tsCaptureByTab.has(tabId);
}

/**
 * True when captures for this tab are progress heartbeats only (cdrmld
 * seeds): the tee can skip buffering segment bytes entirely.
 */
export function isCctvPageCaptureHeartbeatOnly(tabId: number): boolean {
    return tsCaptureByTab.get(tabId)?.heartbeatOnly === true;
}

/** Entry point for captured segments (webRequest tee + XHR fallback). */
export function handleCapturedCctvTsSegment(
    tabId: number,
    url: string,
    bytes: ArrayBuffer
) {
    const state = tsCaptureByTab.get(tabId);
    if (!state) return;
    if (state.heartbeatOnly) {
        // Progress heartbeat: only the URL and arrival time matter.
        void postHeartbeat(state, url);
        return;
    }
    if (bytes.byteLength === 0) return;
    if (state.armed && state.endpoint) {
        void postCapturedSegment(state, url, bytes).then(outcome => {
            if (outcome === "unreachable") bufferPending(state, url, bytes);
        });
    } else {
        bufferPending(state, url, bytes);
    }
}

/**
 * MAIN-world XHR hook: tees `.ts` responses the page player fetches. Only
 * needed when webRequest.filterResponseData is unavailable (the primary tee
 * needs no page injection); the ISOLATED-world bridge forwards its captures.
 */
function installCctvTsXhrHook() {
    if ((window as any).__fxCastCctvTsXhrHook) return;
    (window as any).__fxCastCctvTsXhrHook = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: any[]
    ) {
        const absoluteUrl = new URL(String(url), location.href).href;
        if (/\.ts(?:[?#]|$)/i.test(absoluteUrl)) {
            this.addEventListener("load", () => {
                try {
                    if (!(window as any).__fxCastCctvTsCaptureEnabled) return;
                    if (
                        this.responseType !== "arraybuffer" ||
                        !(this.response instanceof ArrayBuffer)
                    ) {
                        return;
                    }
                    const bytes = new Uint8Array(this.response);
                    let binary = "";
                    const chunk = 0x8000;
                    for (let i = 0; i < bytes.length; i += chunk) {
                        binary += String.fromCharCode.apply(
                            null,
                            bytes.subarray(i, i + chunk) as unknown as number[]
                        );
                    }
                    window.postMessage(
                        {
                            source: "fx-cast-cctv-ts-segment",
                            url: this.responseURL || absoluteUrl,
                            base64: btoa(binary)
                        },
                        location.origin
                    );
                } catch {
                    /* capture must never break the page's playback */
                }
            });
        }
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    } as typeof XMLHttpRequest.prototype.open;
}

/** ISOLATED-world relay: page hook postMessage -> runtime message. */
function installCctvTsXhrBridge() {
    if ((window as any).__fxCastCctvTsXhrBridge) return;
    (window as any).__fxCastCctvTsXhrBridge = true;
    window.addEventListener("message", event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (
            data?.source !== "fx-cast-cctv-ts-segment" ||
            typeof data.url !== "string" ||
            typeof data.base64 !== "string"
        ) {
            return;
        }
        void browser.runtime
            .sendMessage({
                subject: "cctv:capturedTsSegment",
                data: { url: data.url, base64: data.base64 }
            })
            .catch(() => undefined);
    });
}

/**
 * Inject the XHR fallback hook and arm it. Cheap no-op when the primary
 * filterResponseData tee is available (capture stays network-level).
 */
export async function armCctvPageCaptureInTab(tabId: number) {
    try {
        if (
            typeof (browser.webRequest as any).filterResponseData !== "function"
        ) {
            await browser.scripting.executeScript({
                target: { tabId },
                func: installCctvTsXhrBridge,
                world: "ISOLATED",
                injectImmediately: true
            } as any);
            await browser.scripting.executeScript({
                target: { tabId },
                func: installCctvTsXhrHook,
                world: "MAIN",
                injectImmediately: true
            } as any);
        }
        await browser.scripting.executeScript({
            target: { tabId },
            func: (enabled: boolean) => {
                (window as any).__fxCastCctvTsCaptureEnabled = enabled;
            },
            args: [true],
            world: "MAIN",
            injectImmediately: true
        } as any);
    } catch (error) {
        logger.warn("CCTV TS capture injection failed", {
            tabId,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}
