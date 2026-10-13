/**
 * Yangshipin (央视频) PC / mobile session isolation.
 *
 * Pure WebExtension network-layer implementation of the design recorded in
 * `.memory/方案修订.md` (§0–§15).  Nothing in this module may:
 *
 * - read, query or compare any state belonging to the platform partition a
 *   request does not target (§0 iron rule 5, zero cross-partition access): the
 *   admission decision of §6.2 step 1 takes exactly two inputs — this
 *   partition and this request's raw header;
 * - hardcode credential names or values (§2.5); only *host routing* constants
 *   live in `yangshipinSite`;
 * - touch the page (no window/document/prototype hooks).
 *
 * The module is intentionally self-contained so that the single-ended autonomy
 * audit can be run against it alone.
 */

import logger from "../lib/logger";
import options from "../lib/options";

// ============================================================================
// §15 Site configuration (host names are routing config, never credentials)
// ============================================================================

export const yangshipinSite = {
    /** Registrable domain shared by every Yangshipin host. */
    domainSuffix: "yangshipin.cn",
    /** PC web document host. */
    pcDocHost: "www.yangshipin.cn",
    /** Mobile H5 document hosts. */
    mobileDocHosts: ["w.yangshipin.cn", "m.yangshipin.cn"],
    /**
     * Mobile document hosts whose **root path** serves a redirect trampoline
     * instead of the H5 app: `https://w.yangshipin.cn/` answers 200 with
     * `<meta http-equiv="refresh" content="0; URL='https://www.yangshipin.cn'"/>`
     * and hands the visitor to the PC site (HAR-verified 2026-10-13).  Real
     * business paths (`/home`, `/video`, `/tv`, ...) stay ordinary H5
     * documents.
     */
    trampolineDocHosts: ["w.yangshipin.cn"],
    /** Scope of the client-managed (JS written) domain entry. */
    clientDomainScope: "yangshipin.cn"
};

export type Platform =
    | "pc"
    | "mobile"
    | "external"
    | "unknown"
    /** §9.2 special case: a request class of its own, never a document host. */
    | "trampoline";

export function getHostname(urlStr?: string): string {
    if (!urlStr) return "";
    try {
        return new URL(urlStr).hostname.toLowerCase();
    } catch {
        const m = urlStr.match(/^(?:https?:)?\/\/([^\/?#:]+)/i);
        return m ? m[1].toLowerCase() : "";
    }
}

export function isYangshipinHost(host: string): boolean {
    const h = (host || "").toLowerCase();
    if (!h) return false;
    return (
        h === yangshipinSite.domainSuffix ||
        h.endsWith(`.${yangshipinSite.domainSuffix}`)
    );
}

export function docHostPlatform(host: string): "pc" | "mobile" | null {
    const h = (host || "").toLowerCase();
    if (h === yangshipinSite.pcDocHost) return "pc";
    if (yangshipinSite.mobileDocHosts.includes(h)) return "mobile";
    return null;
}

export function isYangshipinDocHost(host: string): boolean {
    return docHostPlatform(host) !== null;
}

/**
 * Path component of a URL string, exactly as written.  A **bare origin**
 * (`https://w.yangshipin.cn`, which is what an `Origin` header and
 * `details.originUrl` carry — they never include a path) returns `""`, not
 * `"/"`: the URL parser would normalise the missing path to `/` and make an
 * iframe at `/embed` look like the root shell.  `""` means "the path is not
 * known", and no trampoline verdict may be derived from it.
 */
export function getPathname(urlStr?: string): string {
    if (!urlStr) return "";
    const m = urlStr.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^\/?#]*(\/[^?#]*)?/i);
    if (m) return m[1] || "";
    try {
        return new URL(urlStr).pathname || "/";
    } catch {
        return "";
    }
}

/**
 * §9.2 trampoline special case: a configured mobile document host's root path
 * that only redirects.  It is deliberately *not* expressed as "not a document
 * host": that verdict would hand the request to the §12.2 per-host baseline
 * path, which deletes the parent-domain live parameters (`versionName`,
 * `vplatform`, `guid`, `nseqId`, ...) this exception exists to protect.
 *
 * The predicate requires an explicit **root** path.  Host-only evaluations
 * (the top-level host table, a bare initiator `originUrl` / `Origin` header,
 * which never carry a path) cannot tell the shell from `/home`, so an absent
 * or empty path never yields a trampoline verdict.
 */
export function isYangshipinTrampoline(
    host: string,
    pathname?: string
): boolean {
    if (typeof pathname !== "string") return false;
    const h = (host || "").toLowerCase();
    if (!yangshipinSite.trampolineDocHosts.includes(h)) return false;
    return pathname.trim() === "/";
}

/** URL-level form of `isYangshipinTrampoline` (host and path from one URL). */
export function isYangshipinTrampolineUrl(urlStr?: string): boolean {
    const host = getHostname(urlStr);
    if (!host) return false;
    return isYangshipinTrampoline(host, getPathname(urlStr));
}

// ============================================================================
// §14 Budgets and fixed limits
// ============================================================================

const MAX_COOKIE_HEADER_BYTES = 8192;
const MAX_PARTITION_ENTRIES = 200;
const MAX_COOKIE_VALUE_BYTES = 4096;

/** §11.5 tombstone lifetimes / capacity (D2 = B). */
const TOMBSTONE_TTL_FINGERPRINT_MS = 7 * 24 * 60 * 60 * 1000;
const TOMBSTONE_TTL_NAME_ONLY_MS = 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 256;

/** §11.4 debounce window; the timer never participates in any decision. */
const PERSIST_DEBOUNCE_MS = 1000;
/** §11.7 hydrate wait budget. */
const HYDRATE_TIMEOUT_MS = 500;
/** §14.2 request-id binding cache (LRU) size. */
const MAX_REQUEST_ID_CACHE = 1000;
/** §15 sliding-window circuit breaker. */
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
/** §11.6 storage schema version. */
const YSP_SCHEMA_VERSION = 1;

function utf8Bytes(value: string): number {
    try {
        return new TextEncoder().encode(value).length;
    } catch {
        return value.length;
    }
}

// ============================================================================
// §15 Observability, diagnostics and the master switch
// ============================================================================

export interface YangshipinDiagnostics {
    adopted: number;
    demoted: number;
    purged: number;
    stripped: number;
    reinjected: number;
    tombstones: number;
    evicted: number;
    errors: number;
    tombstoneBlocked: number;
    unknownPlatform: number;
    /** §9.2 trampoline verdicts that refused credentials to a redirect shell. */
    trampoline: number;
    setCookieParseFailures: number;
    invalidDomains: number;
    oversizeValues: number;
    pendingCopySuppressed: number;
    headerOverflowEvictions: number;
    sizeEvictions: number;
    hydrateTimeouts: number;
    baselineCleans: number;
    hostBaselineCleans: number;
    materialized: number;
}

const diagnostics: YangshipinDiagnostics = {
    adopted: 0,
    demoted: 0,
    purged: 0,
    stripped: 0,
    reinjected: 0,
    tombstones: 0,
    evicted: 0,
    errors: 0,
    tombstoneBlocked: 0,
    unknownPlatform: 0,
    trampoline: 0,
    setCookieParseFailures: 0,
    invalidDomains: 0,
    oversizeValues: 0,
    pendingCopySuppressed: 0,
    headerOverflowEvictions: 0,
    sizeEvictions: 0,
    hydrateTimeouts: 0,
    baselineCleans: 0,
    hostBaselineCleans: 0,
    materialized: 0
};

export function getYangshipinDiagnostics(): YangshipinDiagnostics {
    return { ...diagnostics };
}

let isolationOptionEnabled = true;
let isolationOptionInitialized = false;
let circuitBreakerTripped = false;
const errorWindow: number[] = [];

function initIsolationOptionWatcher(): void {
    if (isolationOptionInitialized) return;
    isolationOptionInitialized = true;
    const refresh = async () => {
        try {
            const opts = await options.getAll();
            isolationOptionEnabled = opts?.yangshipinSessionIsolation !== false;
        } catch {
            /* keep previous value */
        }
    };
    void refresh();
    options.addEventListener("changed", () => {
        void refresh();
    });
}

export function isYangshipinIsolationEnabled(): boolean {
    return isolationOptionEnabled && !circuitBreakerTripped;
}

function notify(message: string): void {
    try {
        void browser.notifications
            .create({
                type: "basic",
                title: "fx_cast_bilibili",
                message
            })
            .catch(() => undefined);
    } catch {
        /* notifications are best effort */
    }
}

/** §15 circuit breaker: exception count only, sliding window, notify once. */
function recordIsolationError(context: string): void {
    diagnostics.errors++;
    const now = Date.now();
    errorWindow.push(now);
    while (
        errorWindow.length > 0 &&
        now - errorWindow[0] > CIRCUIT_BREAKER_WINDOW_MS
    ) {
        errorWindow.shift();
    }
    if (
        !circuitBreakerTripped &&
        errorWindow.length >= CIRCUIT_BREAKER_THRESHOLD
    ) {
        circuitBreakerTripped = true;
        logger.error(
            "Yangshipin: session isolation disabled by circuit breaker",
            { context, windowMs: CIRCUIT_BREAKER_WINDOW_MS }
        );
        notify(
            "Yangshipin session isolation was disabled after repeated errors. Reload the extension to re-enable it."
        );
    }
}

// ============================================================================
// §4 Data models
// ============================================================================

export type CookieSource = "server" | "client";
export type SameSiteValue = "strict" | "lax" | "none";

export interface SessionPartitionCookie {
    name: string;
    value: string;
    host: string;
    path: string;
    isHostOnly: boolean;
    /** Stored verbatim from the wire (may carry a leading dot). */
    domain?: string;
    secure?: boolean;
    httpOnly: boolean;
    /** `null` marks a session cookie: never persisted, dropped on hydrate. */
    expires: number | null;
    /** §4.1 provenance — the only authority input (§0 iron rule 3). */
    source: CookieSource;
    /** RFC 6265 §5.4 tie-break; preserved across same-key updates. */
    createdAt: number;
    sameSite?: SameSiteValue;
    /** §13 materialization revision (monotonic, never reused). */
    valueRev: number;
}

export interface PartitionTombstone {
    name: string;
    scope: string;
    isHostOnly: boolean;
    path: string;
    timestamp: number;
    valueFingerprint?: string;
}

export interface MaterializedCopyRecord {
    valueRev: number;
    path: string;
    name: string;
}

export interface TombstoneSnapshot {
    byName: Map<string, PartitionTombstone[]>;
}

/** Shared empty snapshot for partitions with no tombstones (hot path). */
const EMPTY_TOMBSTONE_SNAPSHOT: TombstoneSnapshot = { byName: new Map() };

/** FNV-1a 32 bit; not cryptographic, only tells a stale value apart. */
export function fingerprint(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

// ============================================================================
// §4.2 Composite storage keys — the single normalization entry point
// ============================================================================

export function normalizeCookieScope(scope: string): string {
    return (scope || "").replace(/^\.+/, "").toLowerCase();
}

export function getCompositeCookieKey(
    name: string,
    scope: string,
    isHostOnly: boolean,
    path: string
): string {
    return `${name}#${isHostOnly ? "host" : "domain"}#${normalizeCookieScope(
        scope
    )}#${path || "/"}`;
}

export function getClientDomainKey(name: string): string {
    return getCompositeCookieKey(
        name,
        yangshipinSite.clientDomainScope,
        false,
        "/"
    );
}

function entryScopeOf(entry: SessionPartitionCookie): string {
    return entry.isHostOnly ? entry.host : entry.domain || entry.host;
}

export function getEntryCompositeKey(entry: SessionPartitionCookie): string {
    return getCompositeCookieKey(
        entry.name,
        entryScopeOf(entry),
        entry.isHostOnly,
        entry.path
    );
}

// ============================================================================
// RFC 6265 scope helpers
// ============================================================================

export function pathMatches(reqPath: string, cookiePath?: string): boolean {
    if (!cookiePath || cookiePath === "/") return true;
    if (reqPath === cookiePath) return true;
    if (reqPath.startsWith(cookiePath)) {
        if (cookiePath.endsWith("/")) return true;
        if (reqPath.charAt(cookiePath.length) === "/") return true;
    }
    return false;
}

export function domainMatches(reqHost: string, cookieDomain: string): boolean {
    const r = normalizeCookieScope(reqHost);
    const d = normalizeCookieScope(cookieDomain);
    if (!r || !d) return false;
    if (r === d) return true;
    return r.endsWith(`.${d}`);
}

export function matchesCookieScope(
    reqHost: string,
    reqPath: string,
    reqIsHttps: boolean,
    cookie: SessionPartitionCookie
): boolean {
    if (!cookie || !cookie.host) return false;
    const rHost = normalizeCookieScope(reqHost);
    if (!rHost) return false;
    if (cookie.isHostOnly) {
        if (rHost !== normalizeCookieScope(cookie.host)) return false;
    } else if (cookie.domain) {
        if (!domainMatches(rHost, cookie.domain)) return false;
    } else if (rHost !== normalizeCookieScope(cookie.host)) {
        return false;
    }
    if (cookie.secure && !reqIsHttps) return false;
    if (cookie.path && !pathMatches(reqPath, cookie.path)) return false;
    return true;
}

function tombstoneMatchesRequest(
    tombstone: PartitionTombstone,
    reqHost: string,
    reqPath: string
): boolean {
    const host = normalizeCookieScope(reqHost);
    const scope = normalizeCookieScope(tombstone.scope);
    const scopeMatches = tombstone.isHostOnly
        ? host === scope
        : host === scope || host.endsWith(`.${scope}`);
    if (!scopeMatches) return false;
    return pathMatches(reqPath, tombstone.path);
}

// ============================================================================
// §4.3 Session partition
// ============================================================================

export class SessionPartition {
    readonly storageKey: string;
    entries = new Map<string, SessionPartitionCookie>();
    tombstones = new Map<string, PartitionTombstone>();

    /** §5.2 step 3: partition-level demotion task set. */
    pendingDemoteNames = new Set<string>();
    /** §13 materialization ledger, keyed `${compKey}#${docHost}`. */
    materializedCopies = new Map<string, MaterializedCopyRecord>();
    /** §12.2 per-host baseline cleaning markers. */
    baselineCleanedHosts = new Set<string>();

    /** §13 doc hosts that have materialized their page copies in this session. */
    materializedDocHosts = new Set<string>();

    /** §4.3 monotonic materialization revision counter. */
    nextValueRev = 0;
    /** §11.3 generation: bumped by session clear / session termination. */
    generation = 0;

    /** §14.2 name index for O(1) server-authority lookups (server entries). */
    private serverNameIndex = new Map<string, Set<string>>();

    /**
     * §11.3 capacity eviction is LRU.  Map insertion order *is* the recency
     * order (marking re-inserts the key), so no clock is involved: pure
     * bookkeeping, never persisted, and never an input to any adjudication.
     */
    private usageOrder = new Map<string, true>();

    /** §11.4 single write queue state. */
    stateRev = 0;
    private confirmedRev = 0;
    private writeInFlight: Promise<void> | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(storageKey: string) {
        this.storageKey = storageKey;
    }

    // ------------------------------------------------------------------
    // State revision / persistence entry points (§11.4)
    // ------------------------------------------------------------------

    /** Any persistent-state change bumps `stateRev` (the only dirty source). */
    markChanged(): void {
        this.stateRev++;
    }

    hasPendingWrites(): boolean {
        return this.stateRev > this.confirmedRev;
    }

    /** §5.2 step 3: demotion task mutations that mark persistent state changed. */
    addPendingDemoteName(name: string): boolean {
        if (!name || this.pendingDemoteNames.has(name)) return false;
        this.pendingDemoteNames.add(name);
        this.markChanged();
        return true;
    }

    deletePendingDemoteName(name: string): boolean {
        if (!this.pendingDemoteNames.delete(name)) return false;
        this.markChanged();
        return true;
    }

    /** Fire-and-forget write-through. Never throws, never awaited. */
    persistNow(): void {
        void this.requestWrite();
    }

    /** Debounced merge write; the timer participates in no decision (§11.4). */
    schedulePersist(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.requestWrite();
        }, PERSIST_DEBOUNCE_MS);
    }

    /**
     * The single writer slot (§11.4).  Returns the run that owns the slot
     * after this call — the one already in flight when there is one (a second
     * caller must never start a second writer, or an older snapshot could land
     * after a newer one) or the one just started.  Fire-and-forget callers
     * ignore the promise.
     */
    private requestWrite(): Promise<void> {
        if (this.writeInFlight) return this.writeInFlight;
        const run = this.runWrites();
        this.writeInFlight = run;
        void run.finally(() => {
            if (this.writeInFlight === run) this.writeInFlight = null;
        });
        return run;
    }

    /** Serial writer: snapshots are written in `stateRev` order (§11.4). */
    private async runWrites(): Promise<void> {
        try {
            while (this.stateRev > this.confirmedRev) {
                const rev = this.stateRev;
                const payload = this.buildStoragePayload();
                await browser.storage.local.set(payload);
                this.confirmedRev = rev;
            }
        } catch (err) {
            logger.warn(
                "Yangshipin: failed to persist session partition (retry on next change)",
                {
                    storageKey: this.storageKey,
                    error: err instanceof Error ? err.message : String(err)
                }
            );
        }
    }

    /** Test/diagnostic helper: resolves once every queued write settled. */
    async waitForWrites(): Promise<void> {
        let current = this.writeInFlight;
        while (current) {
            await current;
            if (this.writeInFlight === current) break;
            current = this.writeInFlight;
        }
    }

    /**
     * §11.4 confirmed flush.  `persistNow()` deliberately swallows write
     * failures ("never throws, retry on next change"), and `waitForWrites()`
     * only waits for a write to *settle* — neither can tell a caller whether
     * the newest revision actually reached storage.  Callers that must not
     * report success for state that exists only in memory (the §12.3 user
     * reset) await this instead; on failure the partition stays dirty
     * (`stateRev > confirmedRev`), so an ordinary later change retries.
     *
     * It never starts a writer of its own: it hands the job to the single
     * writer slot and joins whatever run owns it.  Two overlapping confirmed
     * calls therefore share one writer instead of racing — a private writer per
     * caller could let an older snapshot land after a newer one, which is
     * exactly what §11.4's single queue forbids.
     */
    async persistNowConfirmed(): Promise<boolean> {
        this.cancelDebounce();
        this.markChanged();
        const rev = this.stateRev;
        await this.requestWrite();
        await this.waitForWrites();
        if (this.stateRev > this.confirmedRev) {
            // The run we joined may have written a *lower* revision and then
            // failed (a failure leaves `confirmedRev` behind and raises
            // nothing).  Give the newest revision one more pass through the
            // same slot before reporting failure.
            await this.requestWrite();
            await this.waitForWrites();
        }
        return this.confirmedRev >= rev;
    }

    private buildStoragePayload(): Record<string, unknown> {
        const entries: Record<string, SessionPartitionCookie> = {};
        for (const [k, e] of this.entries) {
            // Drop entries whose explicit expiry has already elapsed
            if (
                e.expires !== null &&
                e.expires !== undefined &&
                e.expires <= Date.now()
            ) {
                continue;
            }
            entries[k] = { ...e };
        }
        const tombstones: Record<string, PartitionTombstone> = {};
        for (const [k, t] of this.tombstones) {
            tombstones[k] = { ...t };
        }
        const materializedCopies: Record<string, MaterializedCopyRecord> = {};
        for (const [k, m] of this.materializedCopies) {
            materializedCopies[k] = { ...m };
        }
        return {
            fxcast_ysp_schema: YSP_SCHEMA_VERSION,
            [this.storageKey]: {
                entries,
                tombstones,
                materializedCopies,
                pendingDemoteNames: Array.from(this.pendingDemoteNames),
                baselineCleanedHosts: Array.from(this.baselineCleanedHosts),
                nextValueRev: this.nextValueRev,
                stateRev: this.stateRev
            }
        };
    }

    // ------------------------------------------------------------------
    // Entry mutation
    // ------------------------------------------------------------------

    private indexServer(entry: SessionPartitionCookie): void {
        if (entry.source !== "server") return;
        let set = this.serverNameIndex.get(entry.name);
        if (!set) {
            set = new Set();
            this.serverNameIndex.set(entry.name, set);
        }
        set.add(getEntryCompositeKey(entry));
    }

    private unindexKey(compKey: string): void {
        for (const [name, set] of this.serverNameIndex) {
            if (set.delete(compKey)) {
                if (set.size === 0) this.serverNameIndex.delete(name);
                return;
            }
        }
    }

    /** §4.3 `set()` — server takeover + monotonic valueRev + tombstone clear. */
    set(entry: SessionPartitionCookie): { tombstoneCleared: boolean } {
        const compKey = getEntryCompositeKey(entry);

        // 1. Server takeover: revoke the client domain entry of the same name,
        //    but only when it really is a client entry (a parent-domain server
        //    entry shares the client composite key).
        if (entry.source === "server") {
            const clientKey = getClientDomainKey(entry.name);
            const existing = this.entries.get(clientKey);
            if (existing && existing.source === "client") {
                this.entries.delete(clientKey);
                this.usageOrder.delete(clientKey);
                this.markChanged();
            }
        }

        const prev = this.entries.get(compKey);
        entry.createdAt = prev?.createdAt ?? entry.createdAt ?? Date.now();
        const materialChanged =
            !prev ||
            prev.value !== entry.value ||
            prev.expires !== entry.expires ||
            prev.secure !== entry.secure ||
            prev.sameSite !== entry.sameSite ||
            prev.httpOnly !== entry.httpOnly;
        entry.valueRev = materialChanged
            ? ++this.nextValueRev
            : prev.valueRev ?? ++this.nextValueRev;

        const tombstoneCleared = this.tombstones.delete(compKey);
        this.entries.set(compKey, entry);
        this.indexServer(entry);
        this.markUsed(compKey);
        this.markChanged();
        this.enforceEntryBudget();
        return { tombstoneCleared };
    }

    /** §14.1 entry cap: expired first (swept), then least recently used. */
    private enforceEntryBudget(): void {
        while (this.entries.size > MAX_PARTITION_ENTRIES) {
            const victim = this.evictionCandidate();
            if (victim === undefined) return;
            this.entries.delete(victim);
            this.usageOrder.delete(victim);
            this.unindexKey(victim);
            diagnostics.sizeEvictions++;
            this.markChanged();
        }
    }

    /**
     * Never-used entries are older than any used one (they are ordered by
     * `createdAt`); among used entries the first key of `usageOrder` is the
     * least recently used.
     */
    private evictionCandidate(): string | undefined {
        let oldestUnused: string | undefined;
        let oldestUnusedAt = Infinity;
        for (const [key, entry] of this.entries) {
            if (this.usageOrder.has(key)) continue;
            if (entry.createdAt < oldestUnusedAt) {
                oldestUnusedAt = entry.createdAt;
                oldestUnused = key;
            }
        }
        if (oldestUnused !== undefined) return oldestUnused;
        for (const key of this.usageOrder.keys()) {
            if (this.entries.has(key)) return key;
        }
        return undefined;
    }

    /** Record usage recency for §11.3 eviction (never a decision input). */
    markUsed(compKey: string): void {
        if (this.usageOrder.has(compKey)) this.usageOrder.delete(compKey);
        this.usageOrder.set(compKey, true);
    }

    /** §11.5 tombstone write path; returns whether a change happened. */
    tombstone(
        name: string,
        scope: string,
        isHostOnly: boolean,
        path: string,
        lastValue?: string
    ): boolean {
        const compKey = getCompositeCookieKey(name, scope, isHostOnly, path);
        this.entries.delete(compKey);
        this.usageOrder.delete(compKey);
        this.unindexKey(compKey);
        if (lastValue === undefined && this.tombstones.has(compKey)) {
            // Idempotent repeat delete: keep fingerprint and original TTL.
            return false;
        }
        this.tombstones.set(compKey, {
            name,
            scope: normalizeCookieScope(scope),
            isHostOnly,
            path: path || "/",
            timestamp: Date.now(),
            valueFingerprint:
                lastValue === undefined ? undefined : fingerprint(lastValue)
        });
        diagnostics.tombstones++;
        this.markChanged();
        this.evictTombstones();
        return true;
    }

    /** §11.5 TTL + FIFO eviction; returns the number of evicted tombstones. */
    evictTombstones(now: number = Date.now()): number {
        let evicted = 0;
        for (const [k, t] of Array.from(this.tombstones)) {
            const ttl =
                t.valueFingerprint === undefined
                    ? TOMBSTONE_TTL_NAME_ONLY_MS
                    : TOMBSTONE_TTL_FINGERPRINT_MS;
            if (now - t.timestamp > ttl) {
                this.tombstones.delete(k);
                evicted++;
            }
        }
        while (this.tombstones.size > MAX_TOMBSTONES) {
            let oldestKey: string | undefined;
            let oldestAt = Infinity;
            for (const [k, t] of this.tombstones) {
                if (t.timestamp < oldestAt) {
                    oldestAt = t.timestamp;
                    oldestKey = k;
                }
            }
            if (oldestKey === undefined) break;
            this.tombstones.delete(oldestKey);
            evicted++;
        }
        if (evicted > 0) {
            diagnostics.evicted += evicted;
            this.markChanged();
        }
        return evicted;
    }

    /** §4.3 pure query: is any live server entry carrying this name? */
    hasServerManagedName(name: string): boolean {
        const set = this.serverNameIndex.get(name);
        if (!set || set.size === 0) return false;
        for (const compKey of set) {
            if (this.entries.has(compKey)) return true;
        }
        return false;
    }

    /**
     * §11.5 request-scoped tombstone snapshot.  Tombstones are immutable once
     * created (a re-delete either returns early or replaces the object), so
     * the snapshot only needs to copy the per-name *buckets*: later writes and
     * clears cannot affect the arrays this request adjudicates against.
     */
    createTombstoneSnapshot(): TombstoneSnapshot {
        if (this.tombstones.size === 0) {
            // Shared empty snapshot: a request without tombstones allocates
            // nothing on the hot path.
            return EMPTY_TOMBSTONE_SNAPSHOT;
        }
        const byName = new Map<string, PartitionTombstone[]>();
        for (const t of this.tombstones.values()) {
            const list = byName.get(t.name);
            if (list) list.push(t);
            else byName.set(t.name, [t]);
        }
        return { byName };
    }

    /** §11.5 pure query: value-fingerprint adjudication (`rawValue` required). */
    hasMatchingTombstone(
        snapshot: TombstoneSnapshot,
        name: string,
        reqHost: string,
        reqPath: string,
        rawValue: string
    ): boolean {
        if (typeof rawValue !== "string") return false;
        const list = snapshot.byName.get(name);
        if (!list) return false;
        for (const t of list) {
            if (!tombstoneMatchesRequest(t, reqHost, reqPath)) continue;
            if (t.valueFingerprint === undefined) return true;
            if (t.valueFingerprint === fingerprint(rawValue)) return true;
        }
        return false;
    }

    /** §11.5 explicit exit: a differently-fingerprinted write clears it. */
    clearMatchingTombstone(
        name: string,
        reqHost: string,
        reqPath: string
    ): boolean {
        let cleared = false;
        for (const [k, t] of Array.from(this.tombstones)) {
            if (t.name !== name) continue;
            if (!tombstoneMatchesRequest(t, reqHost, reqPath)) continue;
            this.tombstones.delete(k);
            cleared = true;
        }
        if (cleared) this.markChanged();
        return cleared;
    }

    /** §11.1 lazy purge of expired entries, tombstoned with their last value. */
    sweepExpired(now: number): boolean {
        let removed = false;
        // Deleting the current key while iterating a Map is well-defined and
        // avoids the per-request copy of the whole partition.
        for (const [k, e] of this.entries) {
            if (e.expires === null || e.expires === undefined) continue;
            if (e.expires <= now) {
                this.entries.delete(k);
                this.usageOrder.delete(k);
                this.unindexKey(k);
                this.tombstone(
                    e.name,
                    entryScopeOf(e),
                    e.isHostOnly,
                    e.path,
                    e.value
                );
                removed = true;
            }
        }
        return removed;
    }

    /** §11.3 clear-session boundary (entries, tombstones, pending tasks). */
    clearSession(): void {
        this.cancelDebounce();
        this.entries.clear();
        this.serverNameIndex.clear();
        this.usageOrder.clear();
        this.tombstones.clear();
        this.pendingDemoteNames.clear();
        this.materializedDocHosts.clear();
        this.generation++;
        this.markChanged();
        this.persistNow();
    }

    /** Test reset: everything goes, including the materialization ledger. */
    reset(): void {
        this.cancelDebounce();
        this.clearInMemoryState();
        this.generation++;
        this.markChanged();
        this.persistNow();
    }

    private cancelDebounce(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    /** Drop every in-memory record (used by reset and by re-hydration). */
    clearInMemoryState(): void {
        this.entries.clear();
        this.serverNameIndex.clear();
        this.usageOrder.clear();
        this.tombstones.clear();
        this.pendingDemoteNames.clear();
        this.materializedCopies.clear();
        this.baselineCleanedHosts.clear();
        this.materializedDocHosts.clear();
    }

    /** Restore a persisted state object (schema already validated). */
    hydrate(raw: unknown): void {
        if (!raw || typeof raw !== "object") return;
        const state = raw as Record<string, unknown>;
        const rawEntries = state.entries;
        if (rawEntries && typeof rawEntries === "object") {
            for (const [key, value] of Object.entries(
                rawEntries as Record<string, unknown>
            )) {
                const entry = validateStoredEntry(value);
                if (!entry) continue;
                // Only drop entries whose explicit expiry has passed
                if (
                    entry.expires !== null &&
                    entry.expires !== undefined &&
                    entry.expires <= Date.now()
                ) {
                    continue;
                }
                this.entries.set(key, entry);
                this.markUsed(key);
                if (entry.source === "server") {
                    this.indexServer(entry);
                }
                if (entry.valueRev > this.nextValueRev) {
                    this.nextValueRev = entry.valueRev;
                }
            }
        }
        const rawTombstones = state.tombstones;
        if (rawTombstones && typeof rawTombstones === "object") {
            for (const [key, value] of Object.entries(
                rawTombstones as Record<string, unknown>
            )) {
                const t = validateStoredTombstone(value);
                if (!t) continue;
                this.tombstones.set(key, t);
            }
        }
        const rawCopies = state.materializedCopies;
        if (rawCopies && typeof rawCopies === "object") {
            for (const [key, value] of Object.entries(
                rawCopies as Record<string, unknown>
            )) {
                const rec = value as Record<string, unknown> | null;
                if (
                    rec &&
                    typeof rec === "object" &&
                    typeof rec.valueRev === "number" &&
                    typeof rec.path === "string" &&
                    typeof rec.name === "string"
                ) {
                    this.materializedCopies.set(key, {
                        valueRev: rec.valueRev,
                        path: rec.path,
                        name: rec.name
                    });
                }
            }
        }
        const rawDemote = state.pendingDemoteNames;
        if (Array.isArray(rawDemote)) {
            for (const n of rawDemote) {
                if (typeof n === "string" && n) {
                    this.pendingDemoteNames.add(n);
                }
            }
        }
        const rawHosts = state.baselineCleanedHosts;
        if (Array.isArray(rawHosts)) {
            for (const h of rawHosts) {
                if (typeof h === "string" && h) {
                    this.baselineCleanedHosts.add(h.toLowerCase());
                }
            }
        }
        const rawRev = state.nextValueRev;
        if (typeof rawRev === "number" && rawRev > this.nextValueRev) {
            this.nextValueRev = rawRev;
        }
        this.evictTombstones();
        // A stored payload can exceed the live entry cap (written by an older
        // build or merged across writes); converge immediately instead of
        // running oversized until the next upsert.
        this.enforceEntryBudget();
    }
}

function validateStoredEntry(
    value: unknown
): SessionPartitionCookie | undefined {
    if (!value || typeof value !== "object") return undefined;
    const e = value as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name) return undefined;
    if (typeof e.value !== "string") return undefined;
    if (typeof e.host !== "string" || !e.host) return undefined;
    if (typeof e.path !== "string" || !e.path) return undefined;
    if (typeof e.isHostOnly !== "boolean") return undefined;
    if (typeof e.httpOnly !== "boolean") return undefined;
    if (e.source !== "server" && e.source !== "client") return undefined;
    if (
        e.expires !== null &&
        e.expires !== undefined &&
        typeof e.expires !== "number"
    ) {
        return undefined;
    }
    const sameSite =
        e.sameSite === "strict" || e.sameSite === "lax" || e.sameSite === "none"
            ? (e.sameSite as SameSiteValue)
            : undefined;
    return {
        name: e.name,
        value: e.value,
        host: e.host,
        path: e.path,
        isHostOnly: e.isHostOnly,
        domain: typeof e.domain === "string" ? e.domain : undefined,
        secure: e.secure === true,
        httpOnly: e.httpOnly,
        expires: (e.expires as number | null | undefined) ?? null,
        source: e.source as CookieSource,
        createdAt: typeof e.createdAt === "number" ? e.createdAt : Date.now(),
        sameSite,
        valueRev: typeof e.valueRev === "number" ? e.valueRev : 0
    };
}

function validateStoredTombstone(
    value: unknown
): PartitionTombstone | undefined {
    if (!value || typeof value !== "object") return undefined;
    const t = value as Record<string, unknown>;
    if (typeof t.name !== "string" || !t.name) return undefined;
    if (typeof t.scope !== "string" || !t.scope) return undefined;
    if (typeof t.isHostOnly !== "boolean") return undefined;
    if (typeof t.path !== "string" || !t.path) return undefined;
    if (typeof t.timestamp !== "number") return undefined;
    return {
        name: t.name,
        scope: t.scope,
        isHostOnly: t.isHostOnly,
        path: t.path,
        timestamp: t.timestamp,
        valueFingerprint:
            typeof t.valueFingerprint === "string"
                ? t.valueFingerprint
                : undefined
    };
}

// ============================================================================
// §11 Storage keys, hydration
// ============================================================================

const YSP_SCHEMA_KEY = "fxcast_ysp_schema";
const YSP_PC_PARTITION_KEY = "fxcast_ysp_partition_pc";
const YSP_MOBILE_PARTITION_KEY = "fxcast_ysp_partition_mobile";
const BASELINE_CLEAN_DONE_KEY = "fxcast_ysp_baseline_clean_done";

export const pcPartition = new SessionPartition(YSP_PC_PARTITION_KEY);
export const mobilePartition = new SessionPartition(YSP_MOBILE_PARTITION_KEY);

/** §3.1 in-memory execution marker for the global baseline. */
let isBaselineCleanPending = true;

export function isYangshipinBaselinePending(): boolean {
    return isBaselineCleanPending;
}

function partitionForPlatform(platform: "pc" | "mobile"): SessionPartition {
    return platform === "pc" ? pcPartition : mobilePartition;
}

/**
 * §11.3 operation generation for hydration.  A user-level reset bumps this; a
 * snapshot whose read started in an earlier generation belongs to state the
 * user has since discarded and must never be committed (see `hydrateAll`).
 */
let stateEpoch = 0;

async function readStorage(): Promise<Record<string, unknown>> {
    if (typeof browser === "undefined" || !browser?.storage?.local) return {};
    const res = await browser.storage.local.get([
        YSP_SCHEMA_KEY,
        YSP_PC_PARTITION_KEY,
        YSP_MOBILE_PARTITION_KEY,
        BASELINE_CLEAN_DONE_KEY
    ]);
    return (res || {}) as Record<string, unknown>;
}

async function hydrateAll(): Promise<void> {
    const epoch = stateEpoch;
    try {
        const res = await readStorage();
        // §11.3: the snapshot was read in generation `epoch`; if a user reset
        // landed while the read was in flight, committing it would resurrect
        // exactly the credentials the reset discarded and would overwrite the
        // `isBaselineCleanPending` the reset just re-armed.  Drop it whole —
        // the reset already persisted the state it wants.
        if (epoch !== stateEpoch) {
            logger.info(
                "Yangshipin: discarded an in-flight hydration snapshot (a reset won the race)"
            );
            return;
        }
        const schema = res[YSP_SCHEMA_KEY];
        // §11.6: equal version restores; lower/higher versions are discarded
        // (version 1 has no migration path).
        const schemaAccepted = schema === YSP_SCHEMA_VERSION;
        if (schemaAccepted) {
            pcPartition.hydrate(res[YSP_PC_PARTITION_KEY]);
            mobilePartition.hydrate(res[YSP_MOBILE_PARTITION_KEY]);
        } else if (schema !== undefined) {
            logger.warn(
                "Yangshipin: discarded stored session partitions (schema mismatch)",
                { storedSchema: schema, currentSchema: YSP_SCHEMA_VERSION }
            );
        }
        isBaselineCleanPending = res[BASELINE_CLEAN_DONE_KEY] !== true;
        // Counts only — never credential names or values.  This is the one
        // line that tells a cold start apart from "the extension was not
        // running at all" (a temporary add-on is unloaded on browser exit, so
        // nothing hydrates and the site looks signed out by design).
        logger.info("Yangshipin: session partitions hydrated", {
            schemaAccepted,
            pcEntries: pcPartition.entries.size,
            mobileEntries: mobilePartition.entries.size,
            baselinePending: isBaselineCleanPending
        });
    } catch (err) {
        logger.warn("Yangshipin: failed to hydrate session partitions", {
            error: err instanceof Error ? err.message : String(err)
        });
        throw err;
    }
}

let hydrationPromise: Promise<void> | null = null;

export function ensurePartitionsHydrated(): Promise<void> {
    if (!hydrationPromise) {
        // A failed hydration must not poison the cache: storage failures can
        // be transient, and caching the rejection would fail every later
        // caller closed for the rest of the background lifetime.  Drop the
        // promise on failure so the next call retries.
        hydrationPromise = hydrateAll().catch(err => {
            hydrationPromise = null;
            throw err;
        });
    }
    return hydrationPromise;
}

/** §11.7: wait at most `timeoutMs`; false means fail-closed. */
export async function ensurePartitionsHydratedWithinTimeout(
    timeoutMs: number = HYDRATE_TIMEOUT_MS
): Promise<boolean> {
    try {
        const hydration = ensurePartitionsHydrated().then(
            () => "ok" as const,
            () => "err" as const
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">(resolve => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const result = await Promise.race([hydration, timeout]);
        if (timer) clearTimeout(timer);
        return result === "ok";
    } catch {
        return false;
    }
}

/**
 * Test support: drop in-memory state and re-run hydration from storage.  The
 * global baseline marker is left as the runtime decided it (only a cold start
 * reads `fxcast_ysp_baseline_clean_done`).
 */
export async function rehydrateYangshipinPartitions(): Promise<void> {
    pcPartition.clearInMemoryState();
    mobilePartition.clearInMemoryState();
    hydrationPromise = hydrateAll();
    await hydrationPromise;
}

export async function persistSessionPartitionsNow(): Promise<void> {
    await ensurePartitionsHydrated();
    pcPartition.persistNow();
    mobilePartition.persistNow();
    await Promise.all([
        pcPartition.waitForWrites(),
        mobilePartition.waitForWrites()
    ]);
}

/**
 * §3.1/§11.4 baseline marker write.  Returns whether the marker reached
 * storage: the ordinary fire-and-forget call sites ignore it (a lost marker
 * only costs one extra baseline run), but the §12.3 user reset must not report
 * success for a marker that is still only in memory.
 *
 * The marker is a single scalar written from several paths (baseline
 * completion, manual re-run, user reset), so the writes go through one chain:
 * `storage.local.set` for this key is never issued twice concurrently, and the
 * *last issued* write is the one that decides the stored value.  Same reasoning
 * as the per-partition writer (§11.4): without it an older write could land
 * after a newer one.
 */
let baselineMarkerWrite: Promise<boolean> = Promise.resolve(true);

function persistBaselineCleanDone(value: boolean): Promise<boolean> {
    const write = () => {
        try {
            return browser.storage.local
                .set({ [BASELINE_CLEAN_DONE_KEY]: value })
                .then(
                    () => true,
                    err => {
                        logger.warn(
                            "Yangshipin: failed to persist baseline marker",
                            {
                                error:
                                    err instanceof Error
                                        ? err.message
                                        : String(err)
                            }
                        );
                        return false;
                    }
                );
        } catch (err) {
            logger.warn("Yangshipin: failed to persist baseline marker", {
                error: err instanceof Error ? err.message : String(err)
            });
            return Promise.resolve(false);
        }
    };
    const next = baselineMarkerWrite.then(write, write);
    baselineMarkerWrite = next;
    return next;
}

// ============================================================================
// §9 Platform classification
// ============================================================================

export interface YangshipinRequestDetails {
    requestId?: string;
    url: string;
    method?: string;
    type?: string;
    tabId?: number;
    originUrl?: string;
    documentUrl?: string;
    requestHeaders?: { name: string; value?: string }[];
}

/** §9.3 top-level context, kept per tab; request routing only, no statistics. */
export const tabTopHostByTabId = new Map<number, string>();

interface RequestIdBinding {
    platform: Platform;
    generation: number;
    tabId: number;
}

export const requestIdPlatformMap = new Map<string, RequestIdBinding>();

export function recordRequestIdBinding(
    requestId: string | undefined,
    binding: RequestIdBinding
): void {
    if (!requestId) return;
    if (
        !requestIdPlatformMap.has(requestId) &&
        requestIdPlatformMap.size >= MAX_REQUEST_ID_CACHE
    ) {
        const oldest = requestIdPlatformMap.keys().next().value;
        if (oldest !== undefined) requestIdPlatformMap.delete(oldest);
    }
    requestIdPlatformMap.set(requestId, binding);
}

export function cleanupRequestIdPlatform(requestId?: string): void {
    if (!requestId) return;
    requestIdPlatformMap.delete(requestId);
}

/**
 * §9.2 initiator chain: `originUrl` > `documentUrl` > `Origin` > `Referer`,
 * reduced to hosts.  The chain describes *who* the request belongs to and
 * nothing else — an initiator URL is **never** inspected for its path (see
 * `isYangshipinTrampolineNavigation`).
 */
export function collectCallerHosts(details: {
    originUrl?: string;
    documentUrl?: string;
    requestHeaders?: { name: string; value?: string }[];
}): string[] {
    const hosts: string[] = [];
    const push = (value?: string) => {
        const host = getHostname(value);
        if (host && !hosts.includes(host)) hosts.push(host);
    };
    push(details.originUrl);
    push(details.documentUrl);
    push(
        details.requestHeaders?.find(h => h.name.toLowerCase() === "origin")
            ?.value
    );
    push(
        details.requestHeaders?.find(h => h.name.toLowerCase() === "referer")
            ?.value
    );
    return hosts;
}

/**
 * §9.2 trampoline request: a **top-level navigation to the shell URL itself**
 * that is **not an in-app navigation**.
 *
 * The rule is deliberately this narrow, and an initiator URL can never
 * *produce* a trampoline verdict (it can only exclude one):
 *
 * - The target must be an exact `main_frame` navigation to the shell.  A
 *   subresource / XHR / iframe request to the same path is ordinary mobile
 *   traffic.
 * - An initiator that *is* a mobile document makes the navigation an ordinary
 *   in-app one, handled as a mobile document.  The browser's default referrer
 *   policy trims cross-origin referrers to their **origin**
 *   (`https://w.yangshipin.cn/`) — textually identical to the shell URL — so
 *   reading paths out of initiator URLs turned every mobile login/API call into
 *   a "trampoline", sent it without credentials and discarded its
 *   `Set-Cookie` (observed 2026-10-13 18:38: `auth_login` answered with
 *   `vusession`/`vuserid`/`accesstoken`, none of which ever reached a later
 *   request).  Initiator paths are therefore never consulted.
 *
 * HAR evidence for the shell itself: `https://w.yangshipin.cn/` reached as a
 * `main_frame`, `sec-fetch-site: none` navigation answers 200 with a 163-byte
 * meta-refresh body and carries the jar's live client parameters, which the
 * mobile document path would adopt and then demote away before the redirect to
 * `www.yangshipin.cn` needs them (`10011 请求不合法`).
 */
export function isYangshipinTrampolineNavigation(details: {
    type?: string;
    url: string;
    originUrl?: string;
    documentUrl?: string;
    requestHeaders?: { name: string; value?: string }[];
}): boolean {
    if (details.type !== "main_frame") return false;
    if (!isYangshipinTrampolineUrl(details.url)) return false;
    return !collectCallerHosts(details).some(
        host => docHostPlatform(host) === "mobile"
    );
}

/**
 * §9.2 classification rules, evaluated in order.  The target host never
 * guesses the platform of a request whose initiator is unknown (R4 / D5), and
 * — per §9.3 step 2 — the top-level host table is a *context precondition*
 * for derived requests: it is never a substitute for a missing initiator.
 */
export function classifyYangshipinPlatform(
    details: YangshipinRequestDetails
): Platform {
    return classifyWithCallerHosts(details, collectCallerHosts(details));
}

/** Classification with the initiator chain already resolved (one parse per request). */
function classifyWithCallerHosts(
    details: YangshipinRequestDetails,
    callerHosts: string[]
): Platform {
    const isMainFrame = details.type === "main_frame";
    const isFrame = isMainFrame || details.type === "sub_frame";

    // §9.2 R0t: the shell is a request class of its own, decided *before* R1
    // and before the initiator fallback.  Saying "not a document host" instead
    // would drop it into the §12.2 per-host baseline path, whose parent-domain
    // deletes are exactly what broke the site (HAR 10011).
    if (isYangshipinTrampolineNavigation(details)) return "trampoline";

    // §9.3 step 2: every non-navigation request must carry an established
    // top-level context.  Missing context (navigation failed, extension
    // reloaded with old tabs, no tab at all) -> `unknown`, i.e. fail-closed;
    // a third-party context -> `external`.
    if (!isMainFrame) {
        if (typeof details.tabId !== "number" || details.tabId < 0) {
            return "unknown";
        }
        const topHost = tabTopHostByTabId.get(details.tabId);
        if (!topHost) return "unknown";
        if (!isYangshipinDocHost(topHost)) return "external";
    }

    // R1: navigations are classified by their target document host.
    if (isFrame) {
        const targetPlatform = docHostPlatform(getHostname(details.url));
        if (targetPlatform) return targetPlatform;
    }

    // R2/R3/R4: the initiator chain decides the platform.
    let callerPlatform: "pc" | "mobile" | null = null;
    for (const host of callerHosts) {
        const platform = docHostPlatform(host);
        if (!platform) continue;
        if (callerPlatform && callerPlatform !== platform) return "unknown";
        callerPlatform = platform;
    }
    if (callerPlatform) return callerPlatform;
    if (callerHosts.length > 0) return "external";
    return "unknown";
}

/**
 * Response-side platform resolution: the outbound verdict for this very hop
 * first, then — only when no verdict exists (extension reloaded mid-flight) —
 * the shell rule and the document-host fallback.  The binding must win: a
 * mobile-initiated navigation to the shell URL is an ordinary mobile document
 * response, and re-deciding it from the URL alone would strand its
 * `Set-Cookie`.
 */
function resolveResponsePlatform(
    requestId: string | undefined,
    url: string,
    type?: string
): Platform {
    const binding = requestId ? requestIdPlatformMap.get(requestId) : undefined;
    if (binding) return binding.platform;
    if (isYangshipinTrampolineNavigation({ type, url })) return "trampoline";
    return docHostPlatform(getHostname(url)) ?? "unknown";
}

// ============================================================================
// Request-scoped lifecycle state (§5.2 / §7.1 / §12.1 / §12.2)
// ============================================================================

const pendingDemoteNamesByReq = new Map<string, Set<string>>();
const pendingPurgeNamesByReq = new Map<string, Set<string>>();
const pendingBaselineCleanReqIds = new Set<string>();
const baselineCleanCookieNamesByReq = new Map<string, string[]>();
const requestCookieNamesByReq = new Map<string, string[]>();
const pendingHostBaselineCleanByReq = new Set<string>();

function parseCookieHeader(value: string): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    if (!value) return out;
    for (const pair of value.split(";")) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        out.push({
            name: trimmed.slice(0, eq).trim(),
            value: trimmed.slice(eq + 1).trim()
        });
    }
    return out;
}

function parseCookieHeaderNames(value: string): string[] {
    const names: string[] = [];
    for (const { name } of parseCookieHeader(value)) {
        if (!names.includes(name)) names.push(name);
    }
    return names;
}

function findHeader(
    headers: { name: string; value?: string }[] | undefined,
    name: string
): { name: string; value?: string } | undefined {
    return headers?.find(h => h.name.toLowerCase() === name);
}

function stripSetCookieHeaders(
    headers: { name: string; value?: string }[]
): browser.webRequest.BlockingResponse {
    const filtered = headers.filter(h => h.name.toLowerCase() !== "set-cookie");
    return filtered.length === headers.length
        ? {}
        : { responseHeaders: filtered };
}

function splitSetCookieHeader(value: string): string[] {
    return value
        .split(/\r\n|\n|\r/)
        .map(line => line.trim())
        .filter(Boolean);
}

function stripDomainFromSetCookieLine(line: string): string {
    const parts = line.split(";").map(s => s.trim());
    const filtered = parts.filter(
        part => !part.toLowerCase().startsWith("domain=")
    );
    return filtered.join("; ");
}

/** RFC 6265 §5.1.4 default-path of the request URI. */
export function defaultCookiePath(pathname: string): string {
    if (!pathname || pathname.charAt(0) !== "/") return "/";
    const lastSlash = pathname.lastIndexOf("/");
    if (lastSlash <= 0) return "/";
    return pathname.slice(0, lastSlash);
}

interface ParsedSetCookie {
    name: string;
    value: string;
    host: string;
    path: string;
    isHostOnly: boolean;
    domain?: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: SameSiteValue;
    expires: number | null;
    isDeletion: boolean;
}

/** §5.2 step 2 parser: RFC 6265 §5.2.2 Max-Age precedence, default path. */
export function parseSetCookieLine(
    line: string,
    respHost: string,
    defaultPath = "/"
): ParsedSetCookie | undefined {
    const parts = line.split(";").map(s => s.trim());
    const first = parts[0];
    if (!first) return undefined;
    const eq = first.indexOf("=");
    if (eq <= 0) return undefined;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return undefined;

    let maxAgeSec: number | null = null;
    let expiresMs: number | null = null;
    let httpOnly = false;
    let secure = false;
    let cookiePath: string | null = null;
    let cookieDomain: string | null = null;
    let sameSite: SameSiteValue | undefined;

    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const pEq = part.indexOf("=");
        const attrKey = (pEq > 0 ? part.slice(0, pEq) : part)
            .trim()
            .toLowerCase();
        const attrVal = pEq > 0 ? part.slice(pEq + 1).trim() : "";
        if (attrKey === "domain") {
            const d = normalizeCookieScope(attrVal);
            if (d.length > 0) cookieDomain = d;
        } else if (attrKey === "max-age") {
            // RFC 6265 §5.2.2: non-digits (besides a leading '-') invalidate it.
            if (/^-?\d+$/.test(attrVal)) {
                const sec = parseInt(attrVal, 10);
                if (!isNaN(sec)) maxAgeSec = sec;
            }
        } else if (attrKey === "expires") {
            const t = Date.parse(attrVal);
            if (!isNaN(t)) expiresMs = t;
        } else if (attrKey === "httponly") {
            httpOnly = true;
        } else if (attrKey === "secure") {
            secure = true;
        } else if (attrKey === "path") {
            cookiePath = attrVal || "/";
        } else if (attrKey === "samesite") {
            const v = attrVal.toLowerCase();
            if (v === "strict" || v === "lax" || v === "none") sameSite = v;
        }
    }

    // RFC 6265 §5.3: a valid Max-Age absolutely outranks Expires.
    let expires: number | null = null;
    let isDeletion = false;
    if (maxAgeSec !== null) {
        if (maxAgeSec <= 0) {
            isDeletion = true;
        } else {
            expires = Date.now() + maxAgeSec * 1000;
        }
    } else if (expiresMs !== null) {
        expires = expiresMs;
        if (expiresMs <= Date.now()) isDeletion = true;
    }

    // RFC 6265 §5.3 step 6: a Domain attribute that does not domain-match the
    // response host makes the browser ignore the whole cookie.  It must never
    // be "repaired" into a host-only cookie — that would let an unrelated
    // domain install a credential on this host.
    if (cookieDomain !== null && !domainMatches(respHost, cookieDomain)) {
        return undefined;
    }

    const hostOnly = cookieDomain === null;

    return {
        name,
        value,
        host: respHost,
        path: cookiePath ?? defaultPath,
        isHostOnly: hostOnly,
        domain: hostOnly ? undefined : cookieDomain ?? undefined,
        secure,
        httpOnly,
        sameSite,
        expires,
        isDeletion
    };
}

/**
 * Diagnostics companion of `parseSetCookieLine`: tells an illegal Domain
 * attribute apart from a malformed line.  Both are rejected by the parser;
 * only the reason differs.
 */
export function hasInvalidDomainAttribute(
    line: string,
    respHost: string
): boolean {
    const parts = line.split(";");
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const pEq = part.indexOf("=");
        const attrKey = (pEq > 0 ? part.slice(0, pEq) : part)
            .trim()
            .toLowerCase();
        if (attrKey !== "domain") continue;
        const value = normalizeCookieScope(
            pEq > 0 ? part.slice(pEq + 1).trim() : ""
        );
        if (!value) return false;
        return !domainMatches(respHost, value);
    }
    return false;
}

// ============================================================================
// §11.3 page-copy revocation guard
// ============================================================================

const YANGSHIPIN_DOC_HOSTS: readonly string[] = [
    yangshipinSite.pcDocHost,
    ...yangshipinSite.mobileDocHosts
];

/** Document host encoded in a `${compKey}#${docHost}` materialization key. */
function docHostOfLedgerKey(key: string): string | undefined {
    for (const host of YANGSHIPIN_DOC_HOSTS) {
        if (key.endsWith(`#${host}`)) return host;
    }
    return undefined;
}

/**
 * §11.3 (review fix): a non-HttpOnly credential materialized onto a document
 * host can still sit in the browser jar after its source entry is gone —
 * a session clear deletes the entries (and their tombstones), a server
 * deletion only tombstones the source scope.  The ledger record *is* the
 * revocation task: until the next same-platform document-host response
 * commits that revocation and drops the record, the residual page copy must
 * not be re-admitted, otherwise a cleared credential comes back as a
 * wider-scoped client entry.
 */
function hasPendingCopyRevocation(
    partition: SessionPartition,
    name: string,
    reqHost: string,
    reqPath: string
): boolean {
    // A live entry (server authority or active client) keeps its own authority path.
    if (partition.hasServerManagedName(name)) return false;
    if (partition.entries.has(getClientDomainKey(name))) return false;
    for (const [key, record] of partition.materializedCopies) {
        if (record.name !== name) continue;
        if (docHostOfLedgerKey(key) !== reqHost) continue;
        if (!pathMatches(reqPath, record.path)) continue;
        return true;
    }
    return false;
}

// ============================================================================
// §6 Outbound interception (`onBeforeSendHeaders`)
// ============================================================================

interface OutboundCookieItem {
    name: string;
    value: string;
    source: CookieSource;
    httpOnly: boolean;
    path: string;
    createdAt: number;
}

function cookieItemsBytes(items: OutboundCookieItem[]): number {
    let total = 0;
    for (const item of items) {
        total += utf8Bytes(`${item.name}=${item.value}; `);
    }
    return total;
}

/** §14.1: client entries first, then non-HttpOnly server, HttpOnly last. */
function applyHeaderBudget(items: OutboundCookieItem[]): void {
    if (cookieItemsBytes(items) <= MAX_COOKIE_HEADER_BYTES) return;
    const priority = (item: OutboundCookieItem) =>
        item.source === "client" ? 0 : item.httpOnly ? 2 : 1;
    const order = items
        .map((item, index) => ({ item, index }))
        .sort(
            (a, b) =>
                priority(a.item) - priority(b.item) ||
                a.item.path.length - b.item.path.length ||
                b.item.createdAt - a.item.createdAt
        );
    const dropped = new Set<number>();
    for (const { index } of order) {
        const remaining = items.filter((_, i) => !dropped.has(i));
        if (cookieItemsBytes(remaining) <= MAX_COOKIE_HEADER_BYTES) break;
        dropped.add(index);
        diagnostics.headerOverflowEvictions++;
    }
    for (let i = items.length - 1; i >= 0; i--) {
        if (dropped.has(i)) items.splice(i, 1);
    }
}

function sameSiteAllows(
    entry: SessionPartitionCookie,
    sameSiteInitiator: boolean,
    isTopLevelNavigation: boolean,
    method: string
): boolean {
    const value = entry.sameSite ?? "lax";
    if (value === "strict") return sameSiteInitiator;
    if (value === "lax") {
        if (sameSiteInitiator) return true;
        return isTopLevelNavigation && (method === "GET" || method === "HEAD");
    }
    // SameSite=None requires Secure.
    return entry.secure === true;
}

export async function handleYangshipinBeforeSendHeaders(
    details: YangshipinRequestDetails
): Promise<browser.webRequest.BlockingResponse> {
    try {
        if (!isYangshipinIsolationEnabled()) return {};
        const reqHeaders = details.requestHeaders;
        if (!reqHeaders) return {};

        // §3.2.0 *ordering* (the baseline branch itself sits below the hydrate
        // gate, and that is deliberate): the in-memory marker starts at `true`
        // and is only truthful once `fxcast_ysp_baseline_clean_done` has been
        // read.  Deciding before hydration would treat "not yet known" as
        // "definitely pending", so a perfectly healthy cold start whose first
        // navigation beats the storage read would register a *destructive*
        // one-shot baseline: the response would then materialize the page
        // copies from the restored partition and immediately delete them with
        // the baseline rows, while the ledger still books them as
        // materialized — the restart loses its page-visible session until the
        // next full background restart (reproduced; see
        // `.memory/2026-10-14.md` §8).  A baseline that is swallowed by the
        // fail-closed window below stays pending and is retried by the next
        // document navigation (§12.4), and the residue it targets can no
        // longer be *adopted* in the meantime because §12.2 per-host cleaning
        // now covers document hosts too.
        const hydrated = await ensurePartitionsHydratedWithinTimeout();
        if (!hydrated) {
            // §11.7 / §9.4: fail closed, never forward credentials blind.
            diagnostics.hydrateTimeouts++;
            const cookieHeader = findHeader(reqHeaders, "cookie");
            if (cookieHeader) {
                cookieHeader.value = "";
                diagnostics.stripped++;
                return { requestHeaders: reqHeaders as any };
            }
            return {};
        }

        // The initiator chain is resolved exactly once per request and feeds
        // both classification (§9.2 R2/R3) and the SameSite adjudication
        // (§9.3 step 3).
        const callerHosts = collectCallerHosts(details);
        const platform = classifyWithCallerHosts(details, callerHosts);
        const cookieHeader = findHeader(reqHeaders, "cookie");
        const targetPartition =
            platform === "pc"
                ? pcPartition
                : platform === "mobile"
                ? mobilePartition
                : null;
        recordRequestIdBinding(details.requestId, {
            platform,
            generation: targetPartition ? targetPartition.generation : -1,
            tabId: typeof details.tabId === "number" ? details.tabId : -1
        });

        if (platform === "trampoline") {
            // §9.2: a top-level navigation to the redirect shell.  It carries
            // no credential of either side, adopts nothing and starts no
            // partition work — no baseline, no demotion/purge task, no
            // materialization, no per-host clean marker.  The jar's own
            // parent-domain live parameters stay in the jar, untouched, for
            // the PC page the shell redirects to.
            diagnostics.trampoline++;
            if (cookieHeader) {
                cookieHeader.value = "";
                diagnostics.stripped++;
                return { requestHeaders: reqHeaders as any };
            }
            return {};
        }
        if (platform === "external") {
            // §9.1: third-party initiated — leave native behaviour alone.
            return {};
        }
        if (!targetPartition) {
            // §9.5 (D5): unknown origin means no right to carry credentials.
            diagnostics.unknownPlatform++;
            if (cookieHeader) {
                cookieHeader.value = "";
                diagnostics.stripped++;
                return { requestHeaders: reqHeaders as any };
            }
            return {};
        }

        const reqUrl = new URL(details.url);
        const reqHost = reqUrl.hostname.toLowerCase();
        const reqPath = reqUrl.pathname || "/";
        const reqIsHttps = reqUrl.protocol === "https:";

        // §3.2: the one-shot global baseline.  It is reached only after the
        // marker has actually been read (the hydrate gate above) and only for
        // an app document navigation of a pc/mobile-classified request — the
        // trampoline and the unknown/external cases have already returned, so
        // the redirect shell can never consume the baseline (§9.2).
        if (
            isBaselineCleanPending &&
            details.type === "main_frame" &&
            isYangshipinDocHost(reqHost)
        ) {
            if (details.requestId) {
                pendingBaselineCleanReqIds.add(details.requestId);
                baselineCleanCookieNamesByReq.set(
                    details.requestId,
                    parseCookieHeaderNames(cookieHeader?.value || "")
                );
            }
            if (cookieHeader) cookieHeader.value = "";
            return { requestHeaders: reqHeaders as any };
        }

        // §12.2 per-host baseline.  The clause "let this request through but
        // adopt nothing" is about the *jar's* legacy values: they must not
        // enter the partition, and the response deletes them.  It must NOT
        // suppress this partition's own candidates — Zero-Jar left the jar
        // empty on these hosts, so "pass through and nothing else" sent the
        // first call of every shared API host with no credentials at all and
        // without the page's cross-host client parameters (observed on a real
        // trace: `ucenter-api //v1/user/userinfo` -> `10011 请求不合法`).
        //
        // The coverage set is *every* yangshipin host, document hosts
        // included.  §3's global baseline only protects the one document host
        // that happens to be the first `main_frame` navigation; the other two
        // (`www` / `w` / `m`) used to be excluded here as well, so a page copy
        // the previous install had materialized on them was adopted by their
        // first steady-state request as a *parent-domain* client entry —
        // i.e. "adopt first, clean later" (HAR 2026-10-14 00:16: the m.w
        // document host admitted the leftovers ~150 ms after install).
        const incomingCookies = parseCookieHeader(cookieHeader?.value || "");
        const hostBaselinePending =
            !targetPartition.baselineCleanedHosts.has(reqHost);
        if (hostBaselinePending && details.requestId) {
            requestCookieNamesByReq.set(
                details.requestId,
                parseCookieHeaderNames(cookieHeader?.value || "")
            );
            pendingHostBaselineCleanByReq.add(details.requestId);
        }

        const newlyAdmittedClientItems: { name: string; value: string }[] = [];
        const demoteNames = new Set<string>();
        const purgeOnlyNames = new Set<string>();
        let tombstoneMutated = false;
        const deferredTombstoneClears: {
            name: string;
            reqHost: string;
            reqPath: string;
        }[] = [];

        // §11.1 step 1: sweep expired entries before any adjudication.
        if (targetPartition.sweepExpired(Date.now())) tombstoneMutated = true;

        // §11.5: request-scoped immutable tombstone snapshot.
        const tombstoneSnapshot = targetPartition.createTombstoneSnapshot();

        // ------------------------------------------------------------------
        // Step 1: admission over the raw header. Inputs are exactly the two
        // allowed ones: this partition + this request's raw header.  An
        // uncleaned host skips admission entirely (nothing is adopted, no
        // tombstone is cleared) while still receiving step 2–4 below.
        //
        // §3.2.2's "绝对不向分区采纳任何原始值" is enforced by *host* credit,
        // not by the global marker alone: after an install every host is
        // uncleaned, so the first request to each of them — document hosts
        // included — already refuses adoption (see the credit above).  That is
        // what keeps the intended order "clean, then take over" from being
        // inverted by a baseline that has not run yet.
        // ------------------------------------------------------------------
        for (const incoming of hostBaselinePending ? [] : incomingCookies) {
            const { name, value } = incoming;
            if (
                targetPartition.hasMatchingTombstone(
                    tombstoneSnapshot,
                    name,
                    reqHost,
                    reqPath,
                    value
                )
            ) {
                diagnostics.tombstoneBlocked++;
                demoteNames.add(name);
                continue;
            }
            // A differently fingerprinted write clears the tombstone later:
            // this request keeps adjudicating against the untouched snapshot.
            deferredTombstoneClears.push({ name, reqHost, reqPath });

            if (targetPartition.hasServerManagedName(name)) {
                purgeOnlyNames.add(name);
                diagnostics.purged++;
                continue;
            }

            // A page copy materialized earlier can still sit in the jar after
            // its source entry disappeared (session clear, server deletion).
            // Until the next document-host response revokes it, the residue
            // must not be re-admitted — that would resurrect a cleared
            // credential as a wider-scoped client entry.
            if (
                hasPendingCopyRevocation(
                    targetPartition,
                    name,
                    reqHost,
                    reqPath
                )
            ) {
                purgeOnlyNames.add(name);
                diagnostics.pendingCopySuppressed++;
                continue;
            }

            const clientKey = getClientDomainKey(name);
            const existingClient = targetPartition.entries.get(clientKey);
            if (existingClient) {
                if (utf8Bytes(value) > MAX_COOKIE_VALUE_BYTES) {
                    // §14.1: oversized values are dropped and counted.
                    diagnostics.oversizeValues++;
                    demoteNames.add(name);
                    continue;
                }
                if (existingClient.value !== value) {
                    existingClient.value = value;
                    existingClient.valueRev = ++targetPartition.nextValueRev;
                    targetPartition.markChanged();
                }
                demoteNames.add(name);
            } else {
                if (utf8Bytes(value) > MAX_COOKIE_VALUE_BYTES) {
                    diagnostics.oversizeValues++;
                    demoteNames.add(name);
                    continue;
                }
                targetPartition.set({
                    name,
                    value,
                    host: yangshipinSite.clientDomainScope,
                    domain: `.${yangshipinSite.clientDomainScope}`,
                    isHostOnly: false,
                    path: "/",
                    httpOnly: false,
                    expires: null,
                    source: "client",
                    createdAt: Date.now(),
                    valueRev: 0
                });
                diagnostics.adopted++;
                newlyAdmittedClientItems.push({ name, value });
                demoteNames.add(name);
            }
        }
        diagnostics.demoted += demoteNames.size;

        for (const clear of deferredTombstoneClears) {
            if (
                targetPartition.clearMatchingTombstone(
                    clear.name,
                    clear.reqHost,
                    clear.reqPath
                )
            ) {
                tombstoneMutated = true;
            }
        }

        if (details.requestId) {
            if (demoteNames.size > 0) {
                pendingDemoteNamesByReq.set(details.requestId, demoteNames);
            }
            if (purgeOnlyNames.size > 0) {
                pendingPurgeNamesByReq.set(details.requestId, purgeOnlyNames);
            }
        }

        // ------------------------------------------------------------------
        // Step 2: candidates from this partition, with tombstone + authority
        // suppression and SameSite/scope enforcement (§9.3 step 3).
        // ------------------------------------------------------------------
        const isTopLevelNavigation = details.type === "main_frame";
        const sameSiteInitiator = isTopLevelNavigation
            ? // §9.3 step 3 explicit exception: a top-level navigation with no
              // initiator at all (typed URL, bookmark, stripped referrer) is
              // still same-site for cookie purposes.
              callerHosts.length === 0 ||
              callerHosts.some(host => isYangshipinDocHost(host))
            : // Every remaining request only reaches this point because §9.2 R2
              // resolved a document-host initiator, i.e. it is same-site.  The
              // top-level table never supplies the initiator itself.
              callerHosts.some(host => isYangshipinDocHost(host));
        const method = (details.method || "GET").toUpperCase();

        const candidates: SessionPartitionCookie[] = [];
        for (const [compKey, entry] of targetPartition.entries) {
            if (!matchesCookieScope(reqHost, reqPath, reqIsHttps, entry)) {
                continue;
            }
            if (
                targetPartition.hasMatchingTombstone(
                    tombstoneSnapshot,
                    entry.name,
                    reqHost,
                    reqPath,
                    entry.value
                )
            ) {
                continue;
            }
            if (
                entry.source === "client" &&
                targetPartition.hasServerManagedName(entry.name)
            ) {
                continue;
            }
            if (
                !sameSiteAllows(
                    entry,
                    sameSiteInitiator,
                    isTopLevelNavigation,
                    method
                )
            ) {
                continue;
            }
            // §11.3 LRU bookkeeping: this entry is actually being sent.
            targetPartition.markUsed(compKey);
            candidates.push(entry);
        }

        // Step 3: RFC 6265 §5.4 order — path length descending, then createdAt.
        candidates.sort((a, b) => {
            if (b.path.length !== a.path.length) {
                return b.path.length - a.path.length;
            }
            if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
            return 0;
        });

        const outItems: OutboundCookieItem[] = candidates.map(entry => ({
            name: entry.name,
            value: entry.value,
            source: entry.source,
            httpOnly: entry.httpOnly,
            path: entry.path,
            createdAt: entry.createdAt
        }));

        // Step 4: re-inject only the items admitted by this very request.
        const seenNames = new Set(outItems.map(item => item.name));
        for (const item of newlyAdmittedClientItems) {
            if (seenNames.has(item.name)) continue;
            seenNames.add(item.name);
            outItems.push({
                name: item.name,
                value: item.value,
                source: "client",
                httpOnly: false,
                path: "/",
                createdAt: Date.now()
            });
        }

        // §12.2 "let this request through": on an uncleaned host the jar's own
        // values still go out (this very response deletes them).  Letting a
        // residue through is not a licence to bypass a decision this partition
        // has already made for that name, so the residue is dropped when:
        //   - its value is tombstoned (dead credential),
        //   - the name is server-authoritative anywhere in this partition
        //     (even when that entry does not scope-match this host),
        //   - the name is managed as a client entry (this partition's value
        //     and its SameSite/scope decisions win), or
        //   - a page copy of the name is still awaiting revocation.
        if (hostBaselinePending) {
            for (const incoming of incomingCookies) {
                if (seenNames.has(incoming.name)) continue;
                if (
                    targetPartition.hasMatchingTombstone(
                        tombstoneSnapshot,
                        incoming.name,
                        reqHost,
                        reqPath,
                        incoming.value
                    )
                ) {
                    continue;
                }
                if (targetPartition.hasServerManagedName(incoming.name)) {
                    continue;
                }
                if (
                    targetPartition.entries.has(
                        getClientDomainKey(incoming.name)
                    )
                ) {
                    continue;
                }
                if (
                    hasPendingCopyRevocation(
                        targetPartition,
                        incoming.name,
                        reqHost,
                        reqPath
                    )
                ) {
                    continue;
                }
                if (utf8Bytes(incoming.value) > MAX_COOKIE_VALUE_BYTES) {
                    diagnostics.oversizeValues++;
                    continue;
                }
                seenNames.add(incoming.name);
                outItems.push({
                    name: incoming.name,
                    value: incoming.value,
                    source: "client",
                    httpOnly: false,
                    path: "/",
                    createdAt: Date.now()
                });
            }
        }

        if (outItems.length > 0) diagnostics.reinjected += outItems.length;
        applyHeaderBudget(outItems);

        const outCookieValue = outItems
            .map(item => `${item.name}=${item.value}`)
            .join("; ");
        if (cookieHeader) {
            if (cookieHeader.value !== outCookieValue) {
                cookieHeader.value = outCookieValue;
            }
        } else if (outCookieValue) {
            reqHeaders.push({ name: "Cookie", value: outCookieValue });
        }

        // §11.4: tombstone changes are write-through; client changes are debounced.
        if (tombstoneMutated) targetPartition.persistNow();
        else if (targetPartition.hasPendingWrites())
            targetPartition.schedulePersist();

        return { requestHeaders: reqHeaders as any };
    } catch (err) {
        recordIsolationError("outbound");
        logger.warn("Yangshipin: error in onBeforeSendHeaders interceptor", {
            requestId: details.requestId,
            error: err instanceof Error ? err.message : String(err)
        });
        const reqHeaders = details.requestHeaders;
        const cookieHeader = findHeader(reqHeaders, "cookie");
        if (cookieHeader) {
            cookieHeader.value = "";
            diagnostics.stripped++;
            return { requestHeaders: reqHeaders as any };
        }
        return {};
    }
}

// ============================================================================
// §5, §7.2, §13 Inbound interception (`onHeadersReceived`)
// ============================================================================

export interface YangshipinResponseDetails {
    requestId?: string;
    url: string;
    type?: string;
    tabId?: number;
    statusCode?: number;
    responseHeaders?: { name: string; value?: string }[];
}

function clearRequestScopedState(requestId?: string): void {
    if (!requestId) return;
    pendingDemoteNamesByReq.delete(requestId);
    pendingPurgeNamesByReq.delete(requestId);
    pendingBaselineCleanReqIds.delete(requestId);
    baselineCleanCookieNamesByReq.delete(requestId);
    requestCookieNamesByReq.delete(requestId);
    pendingHostBaselineCleanByReq.delete(requestId);
    cleanupRequestIdPlatform(requestId);
}

function applySessionTerminationIfMatched(
    partition: SessionPartition,
    deletedServerEntriesByKey: Map<
        string,
        { name: string; source?: CookieSource; httpOnly?: boolean }
    >,
    issuedCompKeys: Set<string>
): boolean {
    // §7.2: no URL literal — an HttpOnly server entry was deleted in this
    // response and the same composite key was not re-issued.
    let matched = false;
    for (const [compKey, info] of deletedServerEntriesByKey) {
        if (
            info.source === "server" &&
            info.httpOnly === true &&
            !issuedCompKeys.has(compKey)
        ) {
            matched = true;
            break;
        }
    }
    if (!matched) return false;
    for (const entry of Array.from(partition.entries.values())) {
        if (entry.source === "server" && entry.httpOnly) {
            partition.tombstone(
                entry.name,
                entryScopeOf(entry),
                entry.isHostOnly,
                entry.path,
                entry.value
            );
        }
    }
    return true;
}

const COPY_KEY_SEPARATOR = "\u0000";

function getCopyKey(name: string, path: string): string {
    return `${name}${COPY_KEY_SEPARATOR}${path}`;
}

function buildMaterializedCopyLine(
    entry: SessionPartitionCookie,
    reqIsHttps: boolean
): string {
    let line = `${entry.name}=${entry.value}; Path=${entry.path}`;
    if (entry.expires !== null && entry.expires !== undefined) {
        line += `; Expires=${new Date(entry.expires).toUTCString()}`;
    }
    if (reqIsHttps) line += "; Secure";
    const sameSite =
        entry.sameSite ?? (entry.source === "client" ? "lax" : undefined);
    if (sameSite) {
        line += `; SameSite=${
            sameSite === "strict"
                ? "Strict"
                : sameSite === "lax"
                ? "Lax"
                : "None"
        }`;
    }
    return line;
}

/**
 * §13 materialization: one row per page-copy key `(name, path)`, computed
 * from the final state before any header is generated.
 * Covers non-HttpOnly server credentials as well as active client entries.
 */
function applyMaterialization(
    partition: SessionPartition,
    docHost: string,
    reqIsHttps: boolean,
    newResponseHeaders: { name: string; value?: string }[],
    materializeCommits: { key: string; record?: MaterializedCopyRecord }[],
    demotedHostOnlyNames: ReadonlySet<string> = new Set()
): boolean {
    const suffix = `#${docHost}`;
    const candidates = Array.from(partition.entries.values()).filter(entry => {
        if (entry.source === "server") {
            return !entry.httpOnly;
        }
        if (entry.source === "client") {
            return !partition.hasServerManagedName(entry.name);
        }
        return false;
    });
    candidates.sort((a, b) => {
        // Server authority strictly precedes client
        if (a.source !== b.source) {
            return a.source === "server" ? -1 : 1;
        }
        if (b.path.length !== a.path.length) {
            return b.path.length - a.path.length;
        }
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return 0;
    });
    const winnerByCopyKey = new Map<string, SessionPartitionCookie>();
    for (const entry of candidates) {
        const copyKey = getCopyKey(entry.name, entry.path);
        if (!winnerByCopyKey.has(copyKey)) winnerByCopyKey.set(copyKey, entry);
    }

    const ledgerByCopyKey = new Map<
        string,
        { key: string; record: MaterializedCopyRecord }[]
    >();
    for (const [key, record] of partition.materializedCopies) {
        if (!key.endsWith(suffix)) continue;
        const copyKey = getCopyKey(record.name, record.path);
        const entry = { key, record: { ...record } };
        const list = ledgerByCopyKey.get(copyKey);
        if (list) list.push(entry);
        else ledgerByCopyKey.set(copyKey, [entry]);
    }

    const copyKeys = new Set([
        ...winnerByCopyKey.keys(),
        ...ledgerByCopyKey.keys()
    ]);
    const firstVisitInSession = !partition.materializedDocHosts.has(docHost);
    let modified = false;
    for (const copyKey of copyKeys) {
        const winner = winnerByCopyKey.get(copyKey);
        const ledger = ledgerByCopyKey.get(copyKey) ?? [];
        if (winner) {
            const winnerKey = `${getEntryCompositeKey(winner)}${suffix}`;
            const current = partition.materializedCopies.get(winnerKey);
            const upToDate =
                !firstVisitInSession &&
                current !== undefined &&
                current.valueRev === winner.valueRev &&
                current.path === winner.path;
            const alreadyEmittedByDemote = demotedHostOnlyNames.has(
                winner.name
            );
            if (!upToDate) {
                if (!alreadyEmittedByDemote) {
                    newResponseHeaders.push({
                        name: "Set-Cookie",
                        value: buildMaterializedCopyLine(winner, reqIsHttps)
                    });
                    modified = true;
                }
                materializeCommits.push({
                    key: winnerKey,
                    record: {
                        valueRev: winner.valueRev,
                        path: winner.path,
                        name: winner.name
                    }
                });
                diagnostics.materialized++;
            }
            for (const stale of ledger) {
                if (stale.key === winnerKey) continue;
                materializeCommits.push({ key: stale.key });
            }
        } else {
            for (const stale of ledger) {
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${stale.record.name}=; Max-Age=0; Path=${stale.record.path}`
                });
                materializeCommits.push({ key: stale.key });
                modified = true;
            }
        }
    }
    return modified;
}

export async function handleYangshipinHeadersReceived(
    details: YangshipinResponseDetails
): Promise<browser.webRequest.BlockingResponse> {
    const respHeaders = details.responseHeaders;
    try {
        if (!isYangshipinIsolationEnabled()) return {};
        if (!respHeaders) return {};

        const hydrated = await ensurePartitionsHydratedWithinTimeout();
        if (!hydrated) {
            diagnostics.hydrateTimeouts++;
            // §12.4 / §7.1: a response that cannot be adjudicated must not leave
            // its request-scoped bookkeeping behind.  The per-host baseline
            // registration taken in the outbound handler in particular has to
            // stay retryable: the host is not credited, so its next request
            // passes through and cleans again.
            clearRequestScopedState(details.requestId);
            return stripSetCookieHeaders(respHeaders);
        }

        const requestId = details.requestId;
        const platform = resolveResponsePlatform(
            requestId,
            details.url,
            details.type
        );
        if (platform === "trampoline") {
            // §9.2: a trampoline response never reaches the jar or the
            // partitions — every Set-Cookie is stripped and no demotion drain,
            // baseline, session adjudication or materialization runs.
            clearRequestScopedState(requestId);
            return stripSetCookieHeaders(respHeaders);
        }
        if (platform !== "pc" && platform !== "mobile") {
            // §9.1 / §9.5: only pc/mobile adjudicated responses may touch the
            // jar or the partitions.
            diagnostics.stripped++;
            clearRequestScopedState(requestId);
            return stripSetCookieHeaders(respHeaders);
        }

        const targetPartition = partitionForPlatform(platform);
        const binding = requestId
            ? requestIdPlatformMap.get(requestId)
            : undefined;

        // §11.3 step 1b: a stale generation response is void — strip every
        // Set-Cookie and drop its request-scoped tasks.
        if (binding && binding.generation !== targetPartition.generation) {
            clearRequestScopedState(requestId);
            return stripSetCookieHeaders(respHeaders);
        }

        const reqUrl = new URL(details.url);
        const respHost = reqUrl.hostname.toLowerCase();
        const respPath = reqUrl.pathname || "/";
        const isDocHost = isYangshipinDocHost(respHost);

        let headersModified = false;
        let persistentStateDirty = false;
        let needsWriteThrough = false;

        // §11.1 step 1c: sweep right after the generation check.
        if (targetPartition.sweepExpired(Date.now())) needsWriteThrough = true;

        const newResponseHeaders: { name: string; value?: string }[] = [];
        const serverIssuedNames = new Set<string>();
        const issuedCompKeys = new Set<string>();
        const deletedServerEntriesByKey = new Map<
            string,
            { name: string; source?: CookieSource; httpOnly?: boolean }
        >();

        // ------------------------------------------------------------------
        // Step 2: parse the server's Set-Cookie list in order.
        // ------------------------------------------------------------------
        for (const header of respHeaders) {
            if (header.name.toLowerCase() !== "set-cookie" || !header.value) {
                newResponseHeaders.push(header);
                continue;
            }
            const lines = splitSetCookieHeader(header.value);
            const keptLines: string[] = [];
            // Zero-Jar must not depend on successful registration: mark the
            // header as rewritten as soon as a Set-Cookie header is seen.
            headersModified = true;

            for (const line of lines) {
                const parsed = parseSetCookieLine(
                    line,
                    respHost,
                    defaultCookiePath(respPath)
                );
                if (!parsed) {
                    if (hasInvalidDomainAttribute(line, respHost)) {
                        // RFC 6265 §5.3 step 6: ignored by the browser too.
                        diagnostics.invalidDomains++;
                    } else {
                        diagnostics.setCookieParseFailures++;
                    }
                    continue;
                }
                if (utf8Bytes(parsed.value) > MAX_COOKIE_VALUE_BYTES) {
                    // §14.1: oversized values are dropped and counted.
                    diagnostics.oversizeValues++;
                    continue;
                }
                const scope = parsed.isHostOnly
                    ? parsed.host
                    : parsed.domain || parsed.host;
                const compKey = getCompositeCookieKey(
                    parsed.name,
                    scope,
                    parsed.isHostOnly,
                    parsed.path
                );

                if (parsed.isDeletion) {
                    const prev = targetPartition.entries.get(compKey);
                    if (!deletedServerEntriesByKey.has(compKey)) {
                        deletedServerEntriesByKey.set(compKey, {
                            name: parsed.name,
                            source: prev?.source,
                            httpOnly: prev?.httpOnly
                        });
                    }
                    issuedCompKeys.delete(compKey);
                    serverIssuedNames.delete(parsed.name);
                    if (
                        targetPartition.tombstone(
                            parsed.name,
                            scope,
                            parsed.isHostOnly,
                            parsed.path,
                            prev?.value
                        )
                    ) {
                        needsWriteThrough = true;
                    }
                } else {
                    serverIssuedNames.add(parsed.name);
                    issuedCompKeys.add(compKey);
                    deletedServerEntriesByKey.delete(compKey);
                    const { tombstoneCleared } = targetPartition.set({
                        name: parsed.name,
                        value: parsed.value,
                        host: parsed.host,
                        path: parsed.path,
                        isHostOnly: parsed.isHostOnly,
                        domain: parsed.domain,
                        secure: parsed.secure,
                        httpOnly: parsed.httpOnly,
                        expires: parsed.expires,
                        source: "server",
                        createdAt: Date.now(),
                        sameSite: parsed.sameSite,
                        valueRev: 0
                    });
                    if (tombstoneCleared) needsWriteThrough = true;
                    persistentStateDirty = true;
                }

                // §0 iron rule 1 / D3 = A: shared API hosts never reach the jar.
                if (!isDocHost) continue;
                keptLines.push(stripDomainFromSetCookieLine(line));
            }

            if (keptLines.length > 0) {
                newResponseHeaders.push({
                    name: header.name,
                    value: keptLines.join("\n")
                });
            }
        }

        // Step 3a: purge-only domain copies (server authority already known
        // outbound). Safe on any Yangshipin host: Max-Age=0 creates nothing.
        const purgeNames = requestId
            ? pendingPurgeNamesByReq.get(requestId)
            : undefined;
        if (purgeNames) {
            for (const name of purgeNames) {
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${name}=; Max-Age=0; Path=/; Domain=.${yangshipinSite.domainSuffix}`
                });
                headersModified = true;
            }
        }

        // Step 3b: session termination adjudication (§7.2), before any
        // demotion/materialization work for dead credentials.
        const terminated = applySessionTerminationIfMatched(
            targetPartition,
            deletedServerEntriesByKey,
            issuedCompKeys
        );
        if (terminated) {
            targetPartition.generation++;
            needsWriteThrough = true;
            logger.info("Yangshipin: session termination detected", {
                platform
            });
        }

        // ------------------------------------------------------------------
        // Step 3: client live-parameter demotion (§0 iron rule 6).
        // ------------------------------------------------------------------
        const demoteNames = requestId
            ? pendingDemoteNamesByReq.get(requestId)
            : undefined;
        const processedDemoteNames: string[] = [];
        const demotedHostOnlyNames = new Set<string>();
        if (!isDocHost) {
            if (demoteNames) {
                for (const name of demoteNames) {
                    if (
                        serverIssuedNames.has(name) ||
                        targetPartition.hasServerManagedName(name)
                    ) {
                        newResponseHeaders.push({
                            name: "Set-Cookie",
                            value: `${name}=; Max-Age=0; Path=/; Domain=.${yangshipinSite.domainSuffix}`
                        });
                        headersModified = true;
                    } else {
                        // Task survives this response: wait for the next
                        // document-host response (accepted contract).
                        if (targetPartition.addPendingDemoteName(name)) {
                            persistentStateDirty = true;
                        }
                    }
                }
            }
        } else {
            const drain = new Set<string>(targetPartition.pendingDemoteNames);
            if (demoteNames) {
                for (const name of demoteNames) drain.add(name);
            }
            for (const name of drain) {
                const serverManaged =
                    serverIssuedNames.has(name) ||
                    targetPartition.hasServerManagedName(name);
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${name}=; Max-Age=0; Path=/; Domain=.${yangshipinSite.domainSuffix}`
                });
                headersModified = true;
                processedDemoteNames.push(name);
                if (serverManaged) continue;
                const liveEntry = targetPartition.entries.get(
                    getClientDomainKey(name)
                );
                if (!liveEntry || liveEntry.httpOnly) continue;
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${name}=${liveEntry.value}; Path=/; SameSite=Lax${
                        reqUrl.protocol === "https:" ? "; Secure" : ""
                    }`
                });
                demotedHostOnlyNames.add(name);
            }
        }

        // Step 3c: materialize page-visible credentials for the document host.
        const materializeCommits: {
            key: string;
            record?: MaterializedCopyRecord;
        }[] = [];
        if (
            isDocHost &&
            applyMaterialization(
                targetPartition,
                respHost,
                reqUrl.protocol === "https:",
                newResponseHeaders,
                materializeCommits,
                demotedHostOnlyNames
            )
        ) {
            headersModified = true;
        }

        // §3.2 step 3 / §12.2: baseline delete headers are appended last, so a
        // freshly issued server credential (kept in the partition, never in
        // the jar) is unaffected.
        if (requestId && pendingBaselineCleanReqIds.has(requestId)) {
            const names = baselineCleanCookieNamesByReq.get(requestId) ?? [];
            for (const name of names) {
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${name}=; Max-Age=0; Path=/; Domain=.${yangshipinSite.domainSuffix}`
                });
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${name}=; Max-Age=0; Path=/`
                });
            }
            headersModified = true;
            pendingBaselineCleanReqIds.delete(requestId);
            baselineCleanCookieNamesByReq.delete(requestId);
            // §12.2 credit bookkeeping: the baseline *is* this document host's
            // first clean, so it must also consume that host's credit.  Without
            // it the very next request to the same host would run a second
            // "pass through, adopt nothing" pass and, worse, delete the page
            // copies the first pass had just materialized.  The pass itself is
            // counted by `baselineCleans`, so `hostBaselineCleans` (the §12.2
            // counter) stays untouched.
            if (!targetPartition.baselineCleanedHosts.has(respHost)) {
                targetPartition.baselineCleanedHosts.add(respHost);
                targetPartition.persistNow();
            }
            if (isBaselineCleanPending) {
                isBaselineCleanPending = false;
                diagnostics.baselineCleans++;
                void persistBaselineCleanDone(true);
                notify(
                    "Yangshipin session isolation is now active. Please sign in once again."
                );
            }
        }

        if (requestId && pendingHostBaselineCleanByReq.has(requestId)) {
            const names = requestCookieNamesByReq.get(requestId) ?? [];
            for (const name of names) {
                // On a document host this very response also materializes page
                // copies (§13, step 3c above).  A delete row for a name this
                // partition still manages would cancel the copy emitted moments
                // earlier, so the deletion set on document hosts is limited to
                // values that have no partition authority at all (the same
                // guard §3d applies to the residue pass-through).  The two
                // row shapes stay host-only + parent-domain for every host.
                if (
                    isDocHost &&
                    (targetPartition.hasServerManagedName(name) ||
                        targetPartition.entries.has(getClientDomainKey(name)))
                ) {
                    continue;
                }
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${name}=; Max-Age=0; Path=/`
                });
                newResponseHeaders.push({
                    name: "Set-Cookie",
                    value: `${name}=; Max-Age=0; Path=/; Domain=.${yangshipinSite.domainSuffix}`
                });
            }
            headersModified = true;
            pendingHostBaselineCleanByReq.delete(requestId);
            requestCookieNamesByReq.delete(requestId);
            if (!targetPartition.baselineCleanedHosts.has(respHost)) {
                targetPartition.baselineCleanedHosts.add(respHost);
                diagnostics.hostBaselineCleans++;
                targetPartition.persistNow();
            }
        }

        // ------------------------------------------------------------------
        // Commit boundary: only a full successful pass commits tasks/ledger.
        // ------------------------------------------------------------------
        for (const name of processedDemoteNames) {
            if (targetPartition.deletePendingDemoteName(name)) {
                persistentStateDirty = true;
            }
        }
        for (const commit of materializeCommits) {
            if (commit.record) {
                targetPartition.materializedCopies.set(
                    commit.key,
                    commit.record
                );
            } else {
                targetPartition.materializedCopies.delete(commit.key);
            }
            targetPartition.markChanged();
            persistentStateDirty = true;
        }
        if (isDocHost) {
            targetPartition.materializedDocHosts.add(respHost);
        }

        cleanupRequestIdPlatform(requestId);
        if (requestId) {
            pendingDemoteNamesByReq.delete(requestId);
            pendingPurgeNamesByReq.delete(requestId);
        }

        // §11.4: write-through for tombstones/termination/baseline, debounced
        // merge for ordinary server entry and ledger changes.
        if (needsWriteThrough) {
            targetPartition.persistNow();
        } else if (persistentStateDirty) {
            targetPartition.schedulePersist();
        }

        return headersModified ? { responseHeaders: newResponseHeaders } : {};
    } catch (err) {
        recordIsolationError("inbound");
        logger.warn("Yangshipin: error in onHeadersReceived interceptor", {
            requestId: details.requestId,
            error: err instanceof Error ? err.message : String(err)
        });
        // §9.4 fail-closed: never let an unprocessed credential into the jar.
        return stripSetCookieHeaders(details.responseHeaders ?? []);
    }
}

// ============================================================================
// §7 Lifecycle: request cleanup, session clear, test reset
// ============================================================================

export function cleanupYangshipinRequest(details: {
    requestId?: string;
    type?: string;
}): void {
    const requestId = details?.requestId;
    if (!requestId) return;
    const binding = requestIdPlatformMap.get(requestId);
    if (
        binding &&
        (binding.platform === "pc" || binding.platform === "mobile")
    ) {
        const partition = partitionForPlatform(binding.platform);
        // §11.3: only tasks of the live generation are carried over.
        if (binding.generation === partition.generation) {
            let taskAdded = false;
            const demoteNames = pendingDemoteNamesByReq.get(requestId);
            if (demoteNames) {
                for (const name of demoteNames) {
                    if (partition.addPendingDemoteName(name)) {
                        taskAdded = true;
                    }
                }
            }
            const purgeNames = pendingPurgeNamesByReq.get(requestId);
            if (purgeNames) {
                for (const name of purgeNames) {
                    if (partition.addPendingDemoteName(name)) {
                        taskAdded = true;
                    }
                }
            }
            if (taskAdded) {
                partition.schedulePersist();
            }
        }
    }
    clearRequestScopedState(requestId);
}

/** §11.3 user-facing "clear Yangshipin session". */
export function clearYangshipinSession(): void {
    pcPartition.clearSession();
    mobilePartition.clearSession();
    logger.info("Yangshipin: session partitions cleared by user");
}

/** §7.2 test-only full reset (must not be exposed by production UI). */
export function clearYangshipinPartitions(): void {
    stateEpoch++;
    pcPartition.reset();
    mobilePartition.reset();
    requestIdPlatformMap.clear();
    pendingDemoteNamesByReq.clear();
    pendingPurgeNamesByReq.clear();
    pendingBaselineCleanReqIds.clear();
    baselineCleanCookieNamesByReq.clear();
    requestCookieNamesByReq.clear();
    pendingHostBaselineCleanByReq.clear();
    isBaselineCleanPending = true;
    // The full reset is the only way back from a tripped breaker in-process;
    // production recovers by reloading the background page.
    circuitBreakerTripped = false;
    errorWindow.length = 0;
    void persistBaselineCleanDone(false);
}

/** §12.3 manual "re-run baseline" entry point. */
export function rerunYangshipinBaseline(): void {
    pcPartition.baselineCleanedHosts.clear();
    mobilePartition.baselineCleanedHosts.clear();
    pcPartition.markChanged();
    mobilePartition.markChanged();
    pcPartition.persistNow();
    mobilePartition.persistNow();
    isBaselineCleanPending = true;
    void persistBaselineCleanDone(false);
    logger.info("Yangshipin: baseline cleaning scheduled again");
}

/**
 * §12.3 production "reinstall equivalent" reset: signs both ends out, drops
 * the materialization ledger and re-arms the baseline, so the next visit
 * behaves exactly like the first visit after a fresh install.  Jar cookies
 * are cleaned by that baseline pass, not synchronously here.
 *
 * Async and result-bearing on purpose (§11.3 / §11.4):
 * - it opens a new operation generation first, so a hydration snapshot that is
 *   still being read is discarded instead of being committed over the cleared
 *   state (the read-then-commit race);
 * - it resolves **only after the cleared partitions and the re-armed marker
 *   were confirmed written** — `waitForWrites()` alone cannot prove that,
 *   because the ordinary writer swallows failures.  It returns `false` when
 *   any of the three writes failed; the partitions stay dirty so an ordinary
 *   later change (or another reset) retries.
 *
 * The in-flight baseline navigation needs no special handling here: its
 * response carries a §11.3 generation binding (recorded before the baseline
 * branch sees the request), and `clearYangshipinSession()` below bumps both
 * partitions' generation — so that response is voided *and* drops its own
 * request-scoped registration, leaving the freshly re-armed marker unconsumed.
 */
export async function resetYangshipinForUser(): Promise<boolean> {
    stateEpoch++;
    clearYangshipinSession();
    pcPartition.materializedCopies.clear();
    mobilePartition.materializedCopies.clear();
    rerunYangshipinBaseline();
    const [pcPersisted, mobilePersisted, markerPersisted] = await Promise.all([
        pcPartition.persistNowConfirmed(),
        mobilePartition.persistNowConfirmed(),
        persistBaselineCleanDone(false)
    ]);
    const persisted = pcPersisted && mobilePersisted && markerPersisted;
    logger.info("Yangshipin: session reset to fresh-install state by user", {
        persisted
    });
    return persisted;
}

// ============================================================================
// WebExtension wiring
// ============================================================================

function toRequestDetails(details: any): YangshipinRequestDetails {
    return {
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        tabId: details.tabId,
        originUrl: details.originUrl,
        documentUrl: details.documentUrl,
        requestHeaders: details.requestHeaders
    };
}

export function initYangshipinSessionInterceptor(): void {
    initIsolationOptionWatcher();

    // §9.3 step 2: the provisional top-level host must exist before any
    // subresource of that document is issued.  A trampoline navigation
    // *invalidates* the tab's stale context instead of writing its own: the
    // shell is not an app document, and the redirect target establishes the
    // next context (§9.2 trampoline special case).
    browser.webRequest.onBeforeRequest.addListener(
        details => {
            if (details.type === "main_frame" && details.tabId >= 0) {
                if (
                    isYangshipinTrampolineNavigation({
                        type: details.type,
                        url: details.url,
                        originUrl: details.originUrl,
                        documentUrl: details.documentUrl
                    })
                ) {
                    tabTopHostByTabId.delete(details.tabId);
                    return;
                }
                const host = getHostname(details.url);
                if (host) tabTopHostByTabId.set(details.tabId, host);
            }
        },
        { urls: ["*://*/*"], types: ["main_frame"] }
    );

    // §9.3 step 2: a committed 2xx response confirms the host (each redirect
    // hop already overwrote the provisional value).  A committed trampoline
    // confirms *no* context — writing `w.yangshipin.cn` here would resurrect
    // exactly the stale verdict the navigation listener just dropped.
    browser.webRequest.onHeadersReceived.addListener(
        details => {
            if (
                details.type === "main_frame" &&
                details.tabId >= 0 &&
                typeof details.statusCode === "number" &&
                details.statusCode >= 200 &&
                details.statusCode < 300
            ) {
                if (
                    isYangshipinTrampolineNavigation({
                        type: details.type,
                        url: details.url,
                        originUrl: details.originUrl,
                        documentUrl: details.documentUrl
                    })
                ) {
                    tabTopHostByTabId.delete(details.tabId);
                    return;
                }
                const host = getHostname(details.url);
                if (host) tabTopHostByTabId.set(details.tabId, host);
            }
        },
        { urls: ["*://*/*"], types: ["main_frame"] },
        ["responseHeaders"]
    );

    browser.webRequest.onHeadersReceived.addListener(
        details =>
            handleYangshipinHeadersReceived({
                requestId: details.requestId,
                url: details.url,
                type: details.type,
                tabId: details.tabId,
                statusCode: details.statusCode,
                responseHeaders: details.responseHeaders
            } as YangshipinResponseDetails),
        { urls: ["*://*.yangshipin.cn/*"] },
        ["blocking", "responseHeaders"]
    );

    browser.webRequest.onBeforeSendHeaders.addListener(
        details => handleYangshipinBeforeSendHeaders(toRequestDetails(details)),
        { urls: ["*://*.yangshipin.cn/*"] },
        ["blocking", "requestHeaders"]
    );

    browser.webRequest.onCompleted.addListener(
        details => cleanupYangshipinRequest(details),
        { urls: ["*://*.yangshipin.cn/*"] }
    );

    browser.webRequest.onErrorOccurred.addListener(
        details => {
            if (details.type === "main_frame" && details.tabId >= 0) {
                tabTopHostByTabId.delete(details.tabId);
            }
            cleanupYangshipinRequest(details);
        },
        { urls: ["*://*/*"] }
    );

    browser.tabs.onRemoved.addListener(tabId => {
        tabTopHostByTabId.delete(tabId);
    });

    // §11.4: flush the pending debounced write before the background page goes
    // away (best effort; a lost window only costs the newest server entries).
    try {
        if (typeof window !== "undefined" && window.addEventListener) {
            window.addEventListener("unload", () => {
                pcPartition.persistNow();
                mobilePartition.persistNow();
            });
        }
    } catch {
        /* ignore */
    }
}

// Fire-and-forget warm-up.  Failures are already logged by hydrateAll; the
// catch here keeps a transient storage error from surfacing as an unhandled
// rejection at module load (the cache reset above lets later callers retry).
void ensurePartitionsHydrated().catch(() => {
    /* logged in hydrateAll */
});
