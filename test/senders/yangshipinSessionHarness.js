#!/usr/bin/env node
"use strict";

/**
 * yangshipinSessionHarness.js
 *
 * Regression harness for the Yangshipin (央视频) PC / mobile session isolation
 * module, written against the final design in `.memory/方案修订.md` (v+8).
 *
 * What is tested: the shipped module, bundled from
 *   extension/src/background/yangshipinSession.ts
 * with esbuild, loaded into an in-memory browser simulation:
 *
 *   - an RFC 6265-ish CookieJar (domain / path / host-only / Max-Age vs Expires
 *     / HttpOnly) that mirrors what the browser network stack would keep;
 *   - a "page context" that, for every request, builds the raw `Cookie` header
 *     from the jar, runs `handleYangshipinBeforeSendHeaders` with the same
 *     requestId/type/tabId/initiator context, feeds the resulting header to a
 *     mock backend, runs `handleYangshipinHeadersReceived` with the mock's raw
 *     `Set-Cookie` rows, and then applies the *returned* response headers back
 *     to the jar.
 *
 * That loop is what makes Zero-Jar, demotion and baseline cleaning observable:
 * a `Set-Cookie` row that the module strips never reaches the jar.
 *
 * Hermetic by construction (§2.5 / assertion 28): every HTTP message, cookie
 * line and URL is an in-memory fixture generated at run time; timestamps are
 * always derived from `Date.now()`; esbuild is resolved with `require.resolve`
 * (never a hardcoded node_modules path); there are no external files and no
 * `fs.existsSync` guards around assertions.  The only file the harness reads is
 * its own source, for the fixture-hygiene check (28).
 *
 * Run: `node test/senders/yangshipinSessionHarness.js` (exit code 0 iff green).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const moduleSourcePath = path.join(
    repoRoot,
    "extension/src/background/yangshipinSession.ts"
);

// §2.5 / assertion 28: esbuild must be located through the module resolver, so
// a clean checkout with a moved/hoisted node_modules still works (and a missing
// dependency fails loudly instead of silently skipping).
const esbuildRequest = "esbuild";
const esbuildSearchPaths = [path.join(repoRoot, "extension"), repoRoot];
const esbuildResolved = require.resolve(esbuildRequest, {
    paths: esbuildSearchPaths
});
// A missing dependency must fail loudly here, never be skipped over later.
const esbuildAvailable = (() => {
    try {
        require.resolve(esbuildResolved);
        return true;
    } catch {
        return false;
    }
})();

// ============================================================================
// 1. Reporting framework
// ============================================================================

const ASSERTION_GROUPS = [
    [
        "storage-scope",
        "composite keys, scope isolation, RFC order",
        ["1A", "1B", "1C"]
    ],
    [
        "lifecycle",
        "demotion, tombstones, out-of-order responses",
        ["2", "3", "4"]
    ],
    [
        "authority",
        "server takeover, purge-only, Max-Age precedence",
        ["5", "6", "7"]
    ],
    ["shared-baseline", "Zero-Jar, global baseline", ["8", "9"]],
    [
        "classification",
        "platform rules, redirects, SameSite",
        ["10", "11", "12", "13", "14", "34"]
    ],
    [
        "persistence",
        "session cookies, writes, quota, hydrate",
        ["15", "16", "17", "18"]
    ],
    ["fail-closed", "exception handling and circuit breaker", ["19"]],
    ["guardrails", "purge landings, tombstone TTL, logout", ["20", "21", "22"]],
    ["materialize", "§13 page-visible copies", ["23"]],
    ["budgets", "header budgets and scan counters", ["24", "27"]],
    ["baseline-hosts", "per-host baseline and failure boundary", ["25", "26"]],
    ["fixtures", "hermetic fixture hygiene", ["28"]],
    ["tasks", "partition-level demotion drain", ["29"]],
    ["tab-top", "top-level host table event boundaries", ["30"]],
    [
        "snapshot",
        "tombstone snapshots, sweep order, write order",
        ["31", "32", "33"]
    ]
];

const checkIdsByGroup = new Map(ASSERTION_GROUPS.map(([id]) => [id, []]));
const groupOfAssertion = new Map();
for (const [groupId, , ids] of ASSERTION_GROUPS) {
    for (const name of ids) groupOfAssertion.set(name, groupId);
}

let unhandledRejections = 0;
process.on("unhandledRejection", () => {
    unhandledRejections++;
});

let passCount = 0;
let failCount = 0;
let placeholderCount = 0;
const failureLines = [];

function report(id, title, subs, note) {
    const failed = subs.filter(s => !s.ok);
    const label = id.padEnd(4);
    if (note) {
        placeholderCount++;
        console.log(`  --   ${label} ${title}`);
        console.log(`       ${note}`);
        return;
    }
    if (failed.length === 0) {
        passCount++;
        console.log(`  ok   ${label} ${title}`);
    } else {
        failCount++;
        console.log(`  FAIL ${label} ${title}`);
        for (const f of failed) {
            const detail =
                f.detail === undefined || f.detail === null
                    ? ""
                    : ` :: ${String(f.detail)
                          .replace(/\s+/g, " ")
                          .slice(0, 400)}`;
            console.log(`       - ${f.desc}${detail}`);
            failureLines.push(`${id}: ${f.desc}${detail}`);
        }
    }
    const group = groupOfAssertion.get(id);
    if (group) checkIdsByGroup.get(group).push({ id, ok: failed.length === 0 });
}

/** Runs one numbered assertion; never throws, always reports. */
async function assertion(id, title, body) {
    const subs = [];
    const expect = (desc, ok, detail) => {
        subs.push({ desc, ok: !!ok, detail });
        return !!ok;
    };
    try {
        await body(expect);
    } catch (err) {
        const stack = err && err.stack ? String(err.stack) : String(err);
        subs.push({
            desc: `assertion ${id} threw before completing`,
            ok: false,
            detail: stack.split("\n").slice(0, 5).join(" | ")
        });
    }
    report(id, title, subs);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// 2. Fixtures (synthetic, generated, zero realistic credentials)
// ============================================================================

const FIXTURES = [];

/** Registers a string fixture for the §17-8 hygiene scan (assertion 28). */
function fixture(value) {
    if (typeof value === "string") FIXTURES.push(value);
    return value;
}

/** A cookie name that is obviously synthetic, registered for the scan. */
function cookieName(base, suffix) {
    return fixture(`${base}${suffix === undefined ? "" : suffix}`);
}

/**
 * Expiry relative to "now": fixtures must never carry a fixed future constant
 * (§17 item 8), so every expiry is generated at call time.
 */
function expiresIn(ms) {
    const value = Date.now() + ms;
    return value;
}

function httpDate(ms) {
    return new Date(ms).toUTCString();
}

// Synthetic values only: no captured tokens, no realistic base64.
const V = {
    a: fixture("fixture-token-a"),
    b: fixture("fixture-token-b"),
    c: fixture("fixture-token-c"),
    child: fixture("fixture-session-child"),
    root: fixture("fixture-session-root"),
    js: fixture("fixture-js-value"),
    server: fixture("fixture-server-value"),
    old: fixture("fixture-old-value"),
    fresh: fixture("fixture-new-value"),
    client: fixture("fixture-client-value")
};

// ============================================================================
// 3. RFC 6265-ish CookieJar
// ============================================================================

function normalizedDomain(value) {
    return String(value || "")
        .replace(/^\.+/, "")
        .toLowerCase();
}

function requestHostName(url) {
    return new URL(url).hostname.toLowerCase();
}

function defaultPathFor(pathname) {
    if (!pathname || pathname.charAt(0) !== "/") return "/";
    const lastSlash = pathname.lastIndexOf("/");
    if (lastSlash <= 0) return "/";
    return pathname.slice(0, lastSlash);
}

function pathMatchesJar(reqPath, cookiePath) {
    if (!cookiePath || cookiePath === "/") return true;
    if (reqPath === cookiePath) return true;
    if (reqPath.startsWith(cookiePath)) {
        if (cookiePath.endsWith("/")) return true;
        if (reqPath.charAt(cookiePath.length) === "/") return true;
    }
    return false;
}

class CookieJar {
    constructor(clock = () => Date.now()) {
        this.clock = clock;
        this.cookies = new Map();
    }

    static key(name, hostOnly, domain, cookiePath) {
        return `${name}\u0001${
            hostOnly ? "host" : "domain"
        }\u0001${domain}\u0001${cookiePath}`;
    }

    /**
     * Applies one raw Set-Cookie row the way the browser network stack would.
     * `pageJs` marks a `document.cookie` write, which cannot overwrite an
     * existing HttpOnly cookie of the same identity.
     */
    setCookie(line, requestHost, requestPath = "/", options = {}) {
        const parts = String(line)
            .split(";")
            .map(s => s.trim());
        const first = parts[0] || "";
        const eq = first.indexOf("=");
        if (eq <= 0) return { action: "ignored" };
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (!name) return { action: "ignored" };

        let domainAttr = null;
        let cookiePath = null;
        let maxAge = null;
        let expiresAt = null;
        let secure = false;
        let httpOnly = false;

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            const pEq = part.indexOf("=");
            const attr = (pEq > 0 ? part.slice(0, pEq) : part)
                .trim()
                .toLowerCase();
            const attrValue = pEq > 0 ? part.slice(pEq + 1).trim() : "";
            if (attr === "domain") domainAttr = normalizedDomain(attrValue);
            else if (attr === "max-age") {
                if (/^-?\d+$/.test(attrValue)) maxAge = parseInt(attrValue, 10);
            } else if (attr === "expires") {
                const t = Date.parse(attrValue);
                if (!isNaN(t)) expiresAt = t;
            } else if (attr === "path") cookiePath = attrValue || "/";
            else if (attr === "secure") secure = true;
            else if (attr === "httponly") httpOnly = true;
        }

        const host = normalizedDomain(requestHost);
        const hostOnly = !domainAttr;
        if (
            domainAttr &&
            host !== domainAttr &&
            !host.endsWith(`.${domainAttr}`)
        ) {
            return { action: "rejected-domain" };
        }
        const scope = domainAttr || host;
        const finalPath =
            cookiePath && cookiePath.charAt(0) === "/"
                ? cookiePath
                : defaultPathFor(requestPath);
        const key = CookieJar.key(name, hostOnly, scope, finalPath);

        // RFC 6265 §5.3: Max-Age outranks Expires, always.
        let expired = false;
        if (maxAge !== null) expired = maxAge <= 0;
        else if (expiresAt !== null) expired = expiresAt <= this.clock();

        const existing = this.cookies.get(key);
        if (options.pageJs && existing && existing.httpOnly) {
            return { action: "ignored-httponly" };
        }
        if (expired) {
            this.cookies.delete(key);
            return {
                action: "deleted",
                name,
                hostOnly,
                domain: scope,
                path: finalPath
            };
        }
        const createdAt = existing ? existing.createdAt : this.clock();
        this.cookies.set(key, {
            name,
            value,
            hostOnly,
            domain: scope,
            path: finalPath,
            secure,
            httpOnly,
            createdAt,
            expires: maxAge !== null ? this.clock() + maxAge * 1000 : expiresAt
        });
        return {
            action: "set",
            name,
            hostOnly,
            domain: scope,
            path: finalPath
        };
    }

    /** Raw `Cookie` header the browser would attach to this request. */
    header(host, reqPath, isHttps) {
        const h = normalizedDomain(host);
        const now = this.clock();
        const selected = [];
        for (const cookie of this.cookies.values()) {
            if (cookie.expires !== null && cookie.expires <= now) continue;
            if (cookie.hostOnly) {
                if (cookie.domain !== h) continue;
            } else if (
                h !== cookie.domain &&
                !h.endsWith(`.${cookie.domain}`)
            ) {
                continue;
            }
            if (!pathMatchesJar(reqPath, cookie.path)) continue;
            if (cookie.secure && !isHttps) continue;
            selected.push(cookie);
        }
        selected.sort((a, b) => {
            if (b.path.length !== a.path.length)
                return b.path.length - a.path.length;
            return a.createdAt - b.createdAt;
        });
        return selected.map(c => `${c.name}=${c.value}`).join("; ");
    }

    /** Simulated `document.cookie = line` write from the page. */
    pageWrite(line, host, reqPath = "/") {
        return this.setCookie(line, host, reqPath, { pageJs: true });
    }

    find(name) {
        return Array.from(this.cookies.values()).filter(c => c.name === name);
    }

    count(name) {
        return this.find(name).length;
    }

    byScope(name, scope) {
        return this.find(name).filter(
            c => c.domain === normalizedDomain(scope)
        );
    }

    clear() {
        this.cookies.clear();
    }
}

// ============================================================================
// 4. In-memory extension storage + browser stubs
// ============================================================================

function pickStorageKeys(data, keys) {
    if (keys === undefined || keys === null) return Object.fromEntries(data);
    if (typeof keys === "string") {
        return data.has(keys) ? { [keys]: data.get(keys) } : {};
    }
    if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) {
            if (data.has(key)) out[key] = data.get(key);
        }
        return out;
    }
    if (typeof keys === "object") {
        const out = {};
        for (const [key, fallback] of Object.entries(keys)) {
            out[key] = data.has(key) ? data.get(key) : fallback;
        }
        return out;
    }
    return {};
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorageStub() {
    const localData = new Map();
    const syncData = new Map();
    const gates = [];
    const stats = {
        localGet: 0,
        localSet: 0,
        localRemove: 0,
        syncGet: 0,
        syncSet: 0,
        syncRemove: 0,
        setAttempts: [],
        inFlightSets: 0,
        maxConcurrentSets: 0,
        throwCount: 0
    };
    let setBehavior = null;

    const makeArea = (data, kind) => ({
        async get(keys) {
            stats[`${kind}Get`]++;
            return clone(pickStorageKeys(data, keys));
        },
        async set(items) {
            stats[`${kind}Set`]++;
            if (kind !== "local") {
                for (const [key, value] of Object.entries(items || {})) {
                    data.set(key, clone(value));
                }
                return;
            }
            stats.inFlightSets++;
            stats.maxConcurrentSets = Math.max(
                stats.maxConcurrentSets,
                stats.inFlightSets
            );
            const record = clone(items || {});
            stats.setAttempts.push(record);
            try {
                const mode = setBehavior ? setBehavior(record) : undefined;
                if (mode === "throw") {
                    stats.throwCount++;
                    throw new Error("simulated storage.local.set failure");
                }
                if (mode === "gate") {
                    await new Promise(resolve => gates.push(resolve));
                }
                for (const [key, value] of Object.entries(items || {})) {
                    data.set(key, clone(value));
                }
            } finally {
                stats.inFlightSets--;
            }
        },
        async remove(keys) {
            stats[`${kind}Remove`]++;
            const list = Array.isArray(keys)
                ? keys
                : typeof keys === "string"
                ? [keys]
                : Object.keys(keys || {});
            for (const key of list) data.delete(key);
        },
        async clear() {
            data.clear();
        }
    });

    const onChangedListeners = [];
    const browserStub = {
        storage: {
            local: makeArea(localData, "local"),
            sync: makeArea(syncData, "sync"),
            onChanged: {
                addListener: fn => onChangedListeners.push(fn),
                removeListener: fn => {
                    const i = onChangedListeners.indexOf(fn);
                    if (i >= 0) onChangedListeners.splice(i, 1);
                },
                hasListener: fn => onChangedListeners.includes(fn)
            }
        }
    };

    return {
        browser: browserStub,
        localData,
        syncData,
        stats,
        gates,
        setLocalState(key, value) {
            localData.set(key, clone(value));
        },
        getLocalState(key) {
            return clone(localData.get(key));
        },
        setBehavior(fn) {
            setBehavior = fn;
        },
        releaseGate() {
            const resolve = gates.shift();
            if (resolve) {
                resolve();
                return true;
            }
            return false;
        },
        pendingGates() {
            return gates.length;
        }
    };
}

/**
 * Full `browser` stub, plus the listener registry the harness drives to test
 * the real wiring in `initYangshipinSessionInterceptor()` (§9.3 / assertion 30).
 */
function createBrowserStub(storage, options = {}) {
    const listeners = {
        onBeforeRequest: [],
        onHeadersReceived: [],
        onBeforeSendHeaders: [],
        onCompleted: [],
        onErrorOccurred: [],
        tabsOnRemoved: []
    };
    const notifications = [];
    const registration = name => ({
        addListener: fn => listeners[name].push(fn),
        removeListener: fn => {
            const i = listeners[name].indexOf(fn);
            if (i >= 0) listeners[name].splice(i, 1);
        },
        hasListener: fn => listeners[name].includes(fn)
    });

    const browser = Object.assign({}, storage.browser, {
        runtime: {
            sendMessage: async () => undefined,
            onMessage: registration("onMessage"),
            onConnectNative: registration("onConnectNative"),
            getPlatformInfo: async () => ({ os: "linux" }),
            getManifest: () => ({ version: "0.0.0-test" })
        },
        webRequest: {
            onBeforeRequest: registration("onBeforeRequest"),
            onHeadersReceived: registration("onHeadersReceived"),
            onBeforeSendHeaders: registration("onBeforeSendHeaders"),
            onCompleted: registration("onCompleted"),
            onErrorOccurred: registration("onErrorOccurred")
        },
        webNavigation: { onCommitted: registration("onCommitted") },
        windows: { onFocusChanged: registration("onFocusChanged") },
        tabs: {
            query: async () => [],
            get: async () => undefined,
            onUpdated: registration("onUpdated"),
            onRemoved: registration("tabsOnRemoved")
        },
        notifications: {
            create: async payload => {
                notifications.push(payload);
                return "notification-id";
            }
        },
        scripting: { executeScript: async () => [] },
        i18n: { getMessage: key => key },
        __listeners: listeners,
        __notifications: notifications
    });
    if (options.hangLocalGet) {
        browser.storage.local.get = () => new Promise(() => undefined);
    }
    return browser;
}

// ============================================================================
// 5. Bundle the production module (esbuild), load instances
// ============================================================================

/** `window.addEventListener("unload", ...)` callbacks, for the §11.4 flush. */
const domUnloadListeners = [];

/** Minimal DOM stubs: `lib/options` and the interceptor read `window`. */
function installDomStubs() {
    const noop = () => {};
    global.window = global;
    global.window.addEventListener = (type, listener) => {
        if (type === "unload" && typeof listener === "function") {
            domUnloadListeners.push(listener);
        }
    };
    global.window.removeEventListener = noop;
    global.document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ setAttribute: noop })
    };
}

const EXPORT_LIST = [
    "classifyYangshipinPlatform",
    "isYangshipinDocHost",
    "isYangshipinTrampoline",
    "isYangshipinTrampolineUrl",
    "getPathname",
    "isYangshipinTrampolineNavigation",
    "handleYangshipinBeforeSendHeaders",
    "handleYangshipinHeadersReceived",
    "pcPartition",
    "mobilePartition",
    "clearYangshipinPartitions",
    "clearYangshipinSession",
    "rerunYangshipinBaseline",
    "rehydrateYangshipinPartitions",
    "ensurePartitionsHydrated",
    "ensurePartitionsHydratedWithinTimeout",
    "persistSessionPartitionsNow",
    "isYangshipinBaselinePending",
    "getYangshipinDiagnostics",
    "isYangshipinIsolationEnabled",
    "getClientDomainKey",
    "getCompositeCookieKey",
    "getEntryCompositeKey",
    "normalizeCookieScope",
    "fingerprint",
    "parseSetCookieLine",
    "hasInvalidDomainAttribute",
    "defaultCookiePath",
    "matchesCookieScope",
    "pathMatches",
    "domainMatches",
    "tabTopHostByTabId",
    "requestIdPlatformMap",
    "cleanupYangshipinRequest",
    "cleanupRequestIdPlatform",
    "initYangshipinSessionInterceptor",
    "recordRequestIdBinding"
];

let workDir = null;
let bundlePath = null;

async function bundleProductionModule() {
    const esbuild = require(esbuildResolved);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-ysp-session-"));
    const entry = path.join(workDir, "entry.js");
    bundlePath = path.join(workDir, "bundle.cjs");
    fs.writeFileSync(
        entry,
        `export {\n${EXPORT_LIST.map(n => `    ${n}`).join(
            ",\n"
        )}\n} from ${JSON.stringify(moduleSourcePath)};\n`
    );
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile: bundlePath,
        logLevel: "error",
        define: {
            BRIDGE_NAME: '"fx_cast_bilibili_bridge"',
            BRIDGE_VERSION: '"0.0.0-test"',
            MIRRORING_APP_ID: '"TESTMIRROR"'
        }
    });
}

/** Loads a fresh module instance against a fresh browser stub. */
function createWorld(options = {}) {
    const storage = options.storage || createStorageStub();
    const browser = createBrowserStub(storage, options);
    global.browser = browser;
    delete require.cache[require.resolve(bundlePath)];
    const mod = require(bundlePath);
    const world = {
        mod,
        storage,
        browser,
        jar: new CookieJar(),
        sim: null,
        expectedUnhandled: []
    };
    if (options.initWiring !== false) mod.initYangshipinSessionInterceptor();
    world.sim = new BrowserSim(world);
    return world;
}

// ============================================================================
// 6. Browser request simulation
// ============================================================================

let requestCounter = 0;

class BrowserSim {
    constructor(world) {
        this.world = world;
        this.mod = world.mod;
        this.jar = world.jar;
        this.storage = world.storage;
        this.browser = world.browser;
        /** Current document URL per tab (set by every main_frame request). */
        this.tabPageUrl = new Map();
    }

    nextRequestId(prefix = "req") {
        requestCounter++;
        return `${prefix}-${requestCounter}`;
    }

    /** The real §9.3 navigation-start listener (provisional top host). */
    fireNavStart(details) {
        for (const fn of this.browser.__listeners.onBeforeRequest) {
            fn({
                requestId: details.requestId,
                url: details.url,
                type: details.type || "main_frame",
                tabId: details.tabId,
                method: details.method || "GET"
            });
        }
    }

    /** The real §9.3 2xx commit-confirm listener. */
    fireCommitConfirm(details) {
        for (const fn of this.browser.__listeners.onHeadersReceived) {
            fn({
                requestId: details.requestId,
                url: details.url,
                type: details.type || "main_frame",
                tabId: details.tabId,
                statusCode: details.statusCode
            });
        }
    }

    /** The real §9.3 failure listener (drops the provisional top host). */
    fireError(details) {
        for (const fn of this.browser.__listeners.onErrorOccurred) {
            fn({
                requestId: details.requestId,
                url: details.url,
                type: details.type,
                tabId: details.tabId
            });
        }
    }

    fireTabRemoved(tabId) {
        for (const fn of this.browser.__listeners.tabsOnRemoved) fn(tabId);
    }

    /**
     * Outbound half of a request: builds the raw Cookie header from the jar and
     * runs the production `onBeforeSendHeaders` handler.
     */
    async begin(opts) {
        const requestId = opts.requestId || this.nextRequestId(opts.idPrefix);
        const url = opts.url;
        const type = opts.type || "xmlhttprequest";
        const method = (opts.method || "GET").toUpperCase();
        const tabId = opts.tabId === undefined ? 1 : opts.tabId;
        const target = new URL(url);

        if (type === "main_frame") {
            this.fireNavStart({ tabId, url, requestId, type, method });
            // The tab renders this document: derived requests are initiated by
            // it unless the call passes an explicit initiator.
            this.tabPageUrl.set(tabId, url);
        }

        const rawCookie =
            opts.rawCookie !== undefined
                ? opts.rawCookie
                : opts.noJarHeader
                ? ""
                : this.jar.header(
                      target.hostname,
                      target.pathname || "/",
                      target.protocol === "https:"
                  );

        // Fidelity: a real browser always reports the initiating document for
        // a page-initiated request.  Default it to the tab's current page
        // unless the caller supplies one (or opts out with `noInitiator`).
        const explicitInitiator =
            opts.documentUrl !== undefined || opts.originUrl !== undefined;
        let documentUrl = opts.documentUrl;
        let originUrl = opts.originUrl;
        if (
            !explicitInitiator &&
            opts.noInitiator !== true &&
            type !== "main_frame"
        ) {
            const pageUrl = this.tabPageUrl.get(tabId);
            if (pageUrl) {
                documentUrl = pageUrl;
                originUrl = new URL(pageUrl).origin;
            }
        }
        if (originUrl === undefined && documentUrl !== undefined) {
            originUrl = new URL(documentUrl).origin;
        }

        const requestHeaders = [];
        if (rawCookie)
            requestHeaders.push({ name: "Cookie", value: rawCookie });
        if (opts.cookieHeaderAlways && !rawCookie) {
            requestHeaders.push({ name: "Cookie", value: "" });
        }
        if (originUrl)
            requestHeaders.push({ name: "Origin", value: originUrl });
        if (opts.referer) {
            requestHeaders.push({ name: "Referer", value: opts.referer });
        }
        for (const extra of opts.extraRequestHeaders || []) {
            requestHeaders.push({ ...extra });
        }

        const details = {
            requestId,
            url,
            type,
            method,
            tabId,
            originUrl: opts.originUrl,
            documentUrl,
            requestHeaders
        };
        const blocking = await this.mod.handleYangshipinBeforeSendHeaders(
            details
        );
        const outboundHeaders =
            blocking.requestHeaders || details.requestHeaders;
        const cookieEntry = outboundHeaders.find(
            h => h.name.toLowerCase() === "cookie"
        );
        return {
            requestId,
            url,
            type,
            method,
            tabId,
            details,
            blocking,
            outboundHeaders,
            outboundCookie: cookieEntry ? cookieEntry.value || "" : ""
        };
    }

    /** Inbound half: mock backend -> onHeadersReceived -> jar. */
    async finish(handle, opts = {}) {
        const url = handle.url;
        const target = new URL(url);
        const backend = opts.backend || (() => ({}));
        const produced =
            backend({
                url,
                method: handle.method,
                cookieHeader: handle.outboundCookie,
                rawCookie:
                    handle.details.requestHeaders.find(
                        h => h.name.toLowerCase() === "cookie"
                    )?.value || ""
            }) || {};

        const responseHeaders = [];
        for (const header of produced.headers || [
            { name: "Content-Type", value: "application/json" }
        ]) {
            responseHeaders.push({ ...header });
        }
        for (const line of produced.setCookies || []) {
            responseHeaders.push({ name: "Set-Cookie", value: line });
        }
        for (const header of opts.extraResponseHeaders || []) {
            responseHeaders.push({ ...header });
        }

        const statusCode =
            produced.statusCode === undefined ? 200 : produced.statusCode;
        const blocking = await this.mod.handleYangshipinHeadersReceived({
            requestId: handle.requestId,
            url,
            type: handle.type,
            tabId: handle.tabId,
            statusCode,
            responseHeaders
        });
        const finalHeaders = blocking.responseHeaders || responseHeaders;
        const applied = this.applyResponseToJar(url, finalHeaders);

        if (handle.type === "main_frame") {
            this.fireCommitConfirm({
                tabId: handle.tabId,
                url,
                statusCode,
                type: handle.type
            });
        }
        this.mod.cleanupYangshipinRequest({
            requestId: handle.requestId,
            type: handle.type
        });

        return {
            ...handle,
            statusCode,
            responseHeaders: finalHeaders,
            setCookieLines: collectSetCookieLines(finalHeaders),
            received: blocking,
            appliedToJar: applied
        };
    }

    /** One full request/response cycle. */
    async request(opts) {
        const handle = await this.begin(opts);
        return await this.finish(handle, opts);
    }

    /** Error/cancel path: no response ever arrives. */
    fail(handle) {
        this.fireError({
            requestId: handle.requestId,
            url: handle.url,
            type: handle.type,
            tabId: handle.tabId
        });
        this.mod.cleanupYangshipinRequest({
            requestId: handle.requestId,
            type: handle.type
        });
    }

    applyResponseToJar(url, headers) {
        const target = new URL(url);
        const applied = [];
        for (const header of headers) {
            if (!header || header.name.toLowerCase() !== "set-cookie") continue;
            for (const line of String(header.value || "").split(/\r\n|\n|\r/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                applied.push(
                    Object.assign(
                        { line: trimmed },
                        this.jar.setCookie(
                            trimmed,
                            target.hostname,
                            target.pathname || "/"
                        )
                    )
                );
            }
        }
        return applied;
    }
}

function collectSetCookieLines(headers) {
    const lines = [];
    for (const header of headers) {
        if (!header || header.name.toLowerCase() !== "set-cookie") continue;
        for (const line of String(header.value || "").split(/\r\n|\n|\r/)) {
            const trimmed = line.trim();
            if (trimmed) lines.push(trimmed);
        }
    }
    return lines;
}

function hasSetCookie(headers) {
    return headers.some(h => h.name.toLowerCase() === "set-cookie");
}

function findSetCookieLine(lines, regex) {
    return lines.find(line => regex.test(line));
}

function cookieNamesFromHeader(header) {
    return String(header || "")
        .split(";")
        .map(pair => pair.trim())
        .filter(Boolean)
        .map(pair => pair.slice(0, pair.indexOf("=")))
        .filter(name => name.length > 0);
}

// ============================================================================
// 7. Group setup: reset + drain the global baseline + prime per-host markers
// ============================================================================

const DOC_HOSTS = {
    pc: "www.yangshipin.cn",
    mobileW: "w.yangshipin.cn",
    mobileM: "m.yangshipin.cn"
};

/**
 * The mobile H5 *business* document.  `https://w.yangshipin.cn/` (bare root) is
 * a meta-refresh trampoline that hands the visitor to the PC site (§9.2), so
 * every fixture meaning "the mobile document" uses a real business path.
 */
const MOBILE_DOC_PATH = "/home";
const MOBILE_DOC_URL = `https://${DOC_HOSTS.mobileW}${MOBILE_DOC_PATH}`;
const MOBILE_DOC_URL_M = `https://${DOC_HOSTS.mobileM}${MOBILE_DOC_PATH}`;
/** The redirect shell itself: 200 + `<meta http-equiv="refresh">` to the PC site. */
const TRAMPOLINE_URL = `https://${DOC_HOSTS.mobileW}/`;

const SHARED_HOSTS = {
    h5access: "h5access.yangshipin.cn",
    ucenter: "ucenter-api.yangshipin.cn",
    liveinfo: "liveinfo.yangshipin.cn"
};

/**
 * `clearYangshipinPartitions()` resets the global baseline marker to pending
 * (§7.2), so every group first has to drain it with one `main_frame`
 * navigation to a document host plus that navigation's response.  Non-document
 * hosts used by the group are then primed through the §12.2 per-host baseline.
 */
async function freshGroup(options = {}) {
    const world = createWorld(options.world || {});
    const sim = world.sim;
    world.mod.clearYangshipinPartitions();
    await settleWrites(world);

    const docHost = options.docHost || DOC_HOSTS.pc;
    const drained = await sim.request({
        url: `https://${docHost}/`,
        type: "main_frame",
        tabId: options.tabId === undefined ? 1 : options.tabId
    });
    world.baselineNav = drained;

    for (const host of options.apiHosts || []) {
        const platform = host.platform || "pc";
        const doc =
            platform === "mobile"
                ? options.mobileDocumentUrl || MOBILE_DOC_URL
                : options.documentUrl || `https://${DOC_HOSTS.pc}/`;
        const partition =
            platform === "mobile"
                ? world.mod.mobilePartition
                : world.mod.pcPartition;
        if (partition.baselineCleanedHosts.has(host.host)) continue;
        await sim.request({
            url: `https://${host.host}/__baseline__`,
            type: "xmlhttprequest",
            documentUrl: doc,
            tabId: options.tabId === undefined ? 1 : options.tabId
        });
    }
    world.jar.clear();
    return world;
}

async function settleWrites(world, ticks = 3) {
    for (let i = 0; i < ticks; i++) {
        await world.mod.pcPartition.waitForWrites();
        await world.mod.mobilePartition.waitForWrites();
        await sleep(0);
    }
}

function serverEntry(overrides) {
    return Object.assign(
        {
            name: "fixture-entry",
            value: V.a,
            host: DOC_HOSTS.pc,
            path: "/",
            isHostOnly: true,
            domain: undefined,
            secure: false,
            httpOnly: false,
            expires: expiresIn(3600 * 1000),
            source: "server",
            createdAt: Date.now(),
            valueRev: 0
        },
        overrides
    );
}

// ============================================================================
// 8. Fixture names — every one obviously synthetic, all scanned by check 28
// ============================================================================

const NAMES = {
    sid: fixture("sid"),
    sidAlt: fixture("sid-alt"),
    sidChild: fixture("sid-child"),
    sidResid: fixture("sid-resid"),
    roster: fixture("roster-name"),
    nseq: fixture("nseqId"),
    deadCred: fixture("deadcred"),
    rollVal: fixture("rollval"),
    takeover: fixture("takeover"),
    serverWin: fixture("srvwin"),
    serverWinApi: fixture("srvwin-api"),
    maxAgeCred: fixture("maxage-cred"),
    mobileCred: fixture("mobcred"),
    legacyOne: fixture("legacy-one"),
    legacyTwo: fixture("legacy-two"),
    thirdPartyCred: fixture("thirdparty-cred"),
    iframeCred: fixture("iframe-cred"),
    pcOnly: fixture("pconly"),
    mobileOnly: fixture("mobonly"),
    ssStrict: fixture("ss-strict"),
    ssLax: fixture("ss-lax"),
    ssNone: fixture("ss-none"),
    ssInsecure: fixture("ss-insecure"),
    sessionCred: fixture("session-cred"),
    persistCred: fixture("persist-cred"),
    expiredCred: fixture("expired-cred"),
    sessPc: fixture("sess-pc"),
    persPc: fixture("pers-pc"),
    clientPc: fixture("client-pc"),
    nonHttpPc: fixture("nonhttp-pc"),
    sessMob: fixture("sess-mob"),
    persMob: fixture("pers-mob"),
    clientMob: fixture("client-mob"),
    nonHttpMob: fixture("nonhttp-mob"),
    quotaOne: fixture("quota-one"),
    quotaTwo: fixture("quota-two"),
    failCred: fixture("fail-cred"),
    purgeKnown: fixture("purge-known"),
    purgeFirst: fixture("purge-first"),
    tombName: fixture("tomb-name"),
    ttlOnly: fixture("ttl-only"),
    ttlFp: fixture("ttl-fp"),
    capPrefix: fixture("cap"),
    httpA: fixture("http-a"),
    httpB: fixture("http-b"),
    openCred: fixture("open-cred"),
    rotatedCred: fixture("rotated-cred"),
    otherKeyCred: fixture("other-key-cred"),
    repeatCred: fixture("repeat-cred"),
    resurrectCred: fixture("resurrect-cred"),
    loginType: fixture("logintype"),
    endTime: fixture("endtime"),
    secretCred: fixture("secret-cred"),
    flipCred: fixture("flip-cred"),
    conflictCred: fixture("conflict-cred"),
    swapCred: fixture("swap-cred"),
    ledgerCred: fixture("ledger-cred"),
    demoteCred: fixture("demote-cred"),
    budgetClient: fixture("budget-client"),
    budgetOpen: fixture("budget-open"),
    budgetHttp: fixture("budget-http"),
    hostResidue: fixture("host-residue"),
    domainResidue: fixture("domain-residue"),
    adoptLater: fixture("adopt-later"),
    retryResidue: fixture("retry-residue"),
    windowResidue: fixture("window-residue"),
    freshCred: fixture("fresh-cred"),
    baselineOne: fixture("baseline-one"),
    baselineTwo: fixture("baseline-two"),
    baselineThree: fixture("baseline-three"),
    perfPrefix: fixture("perf"),
    drainOne: fixture("drain-one"),
    drainTwo: fixture("drain-two"),
    drainServer: fixture("drain-server"),
    drainLate: fixture("drain-late"),
    mobileMark: fixture("mobile-mark"),
    snapshot: fixture("snapshot"),
    expiredServer: fixture("expired-server"),
    expiredMaterial: fixture("expired-material"),
    writeOne: fixture("write-one"),
    writeTwo: fixture("write-two"),
    writeThree: fixture("write-three"),
    badDomain: fixture("bad-domain"),
    plainHostOnly: fixture("plain-hostonly"),
    plainDomain: fixture("plain-domain"),
    copyStale: fixture("copy-stale"),
    copyDeleted: fixture("copy-deleted"),
    lruPrefix: fixture("lru-entry"),
    liveParam: fixture("live-param"),
    trampolineHostOnly: fixture("trampoline-hostonly"),
    trampolineDomain: fixture("trampoline-domain"),
    mobileClientMark: fixture("mobile-client-mark")
};

function utf8Length(value) {
    return Buffer.byteLength(String(value || ""), "utf8");
}

function entriesNamed(partition, name) {
    return Array.from(partition.entries.values()).filter(e => e.name === name);
}

/** True when a blocking response left the headers untouched (§6.2 / §5.2). */
function leftUntouched(blocking, key) {
    return !(key in (blocking || {}));
}

/**
 * Materialized §13 page copies always carry the source expiry and never a
 * Domain attribute or `Max-Age=0` (`buildMaterializedCopyLine`).  Filtering on
 * that shape separates them from the purge / demotion / baseline delete rows
 * that legitimately share a response.
 */
function materializedCopyLines(lines) {
    return lines.filter(
        line => /;\s*Expires=/i.test(line) && !/Max-Age=0/i.test(line)
    );
}

// ============================================================================
// 9. Assertions 1A ... 33 (§8.2 / §8.3)
// ============================================================================

const ASSERTION_RUNNERS = [];

ASSERTION_RUNNERS.push([
    "1A",
    "同名凭据跨 Host / 跨 Path 存储共存 (composite keys coexist)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;
        const sid = NAMES.sid;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/sub/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${sid}=${V.child}; Path=/sub`] })
        });
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            backend: () => ({
                setCookies: [`${sid}=${V.root}; Path=/; Domain=.yangshipin.cn`]
            })
        });
        const hostKey = mod.getCompositeCookieKey(
            sid,
            SHARED_HOSTS.h5access,
            true,
            "/sub"
        );
        const domainKey = mod.getCompositeCookieKey(
            sid,
            "yangshipin.cn",
            false,
            "/"
        );
        const hostEntry = pc.entries.get(hostKey);
        const domainEntry = pc.entries.get(domainKey);
        expect(
            "host-only /sub credential kept under its own composite key",
            hostEntry && hostEntry.value === V.child,
            JSON.stringify(hostEntry)
        );
        expect(
            "parent-domain / credential kept under its own composite key",
            domainEntry && domainEntry.value === V.root,
            JSON.stringify(domainEntry)
        );
        expect(
            "the two keys differ (no overwrite / flush)",
            hostKey !== domainKey
        );
        const req = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/sub/data`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        const out = req.outboundCookie;
        expect(
            "outbound carries sid=CHILD",
            out.includes(`${sid}=${V.child}`),
            out
        );
        expect(
            "outbound carries sid=ROOT",
            out.includes(`${sid}=${V.root}`),
            out
        );
        expect(
            "deeper Path sorts first and the name is not de-duplicated",
            out.indexOf(`${sid}=${V.child}`) < out.indexOf(`${sid}=${V.root}`),
            out
        );
        const controlName = NAMES.sidChild;
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            backend: () => ({ setCookies: [`${controlName}=${V.a}; Path=/`] })
        });
        const control = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/sub/data`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "host-only www control credential is not sent to h5access",
            !control.outboundCookie.includes(controlName),
            control.outboundCookie
        );
    }
]);

ASSERTION_RUNNERS.push([
    "1B",
    "严格作用域隔离与零回填 (scope isolation, no re-emission)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const name = NAMES.roster;
        const subKey = mod.getCompositeCookieKey(
            name,
            SHARED_HOSTS.h5access,
            true,
            "/sub"
        );
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/sub/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${name}=${V.child}; Path=/sub`] })
        });
        expect(
            "the /sub server entry is stored",
            pc.entries.get(subKey)?.value === V.child
        );
        const root = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "a /sub partition entry is not a candidate for a root-path request",
            !root.outboundCookie.includes(name),
            root.outboundCookie
        );

        // A jar item that reaches the raw header (so the browser really would
        // send it) but is rejected by the server-authority branch is never
        // re-emitted: the server entry stays the only authority.
        jar.setCookie(`${name}=${V.b}; Path=/`, SHARED_HOSTS.h5access);
        const rejected = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/raw`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "raw residue of a server-managed name is not re-emitted",
            !rejected.outboundCookie.includes(`${name}=${V.b}`),
            rejected.outboundCookie
        );
        expect(
            "the raw value does not replace the server authority",
            pc.entries.get(subKey)?.value === V.child
        );

        // Same for a tombstone-rejected raw item.
        const dead = NAMES.tombName;
        pc.tombstone(dead, SHARED_HOSTS.h5access, true, "/", V.old);
        jar.setCookie(`${dead}=${V.old}; Path=/`, SHARED_HOSTS.h5access);
        const blocked = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/tomb`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "tombstoned raw residue is not re-emitted",
            !blocked.outboundCookie.includes(dead),
            blocked.outboundCookie
        );
        expect(
            "no new client entry is created for the tombstoned name",
            !pc.entries.has(mod.getClientDomainKey(dead))
        );
    }
]);

ASSERTION_RUNNERS.push([
    "1C",
    "RFC 6265 §5.4 排序与不去重 (order, refresh stability, source exclusivity)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;
        const sid = NAMES.sidAlt;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/a`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${sid}=${V.a}; Path=/sub`] })
        });
        await sleep(2);
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/b`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${sid}=${V.b}; Path=/`] })
        });
        await sleep(2);
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            backend: () => ({
                setCookies: [`${sid}=${V.c}; Path=/; Domain=.yangshipin.cn`]
            })
        });
        const target = `https://${SHARED_HOSTS.h5access}/sub/x`;
        const first = await sim.request({
            url: target,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        const occurrences = cookieNamesFromHeader(first.outboundCookie).filter(
            n => n === sid
        ).length;
        expect(
            "all three same-name entries are sent (no de-duplication)",
            occurrences === 3,
            first.outboundCookie
        );
        const idxA = first.outboundCookie.indexOf(`${sid}=${V.a}`);
        const idxB = first.outboundCookie.indexOf(`${sid}=${V.b}`);
        const idxC = first.outboundCookie.indexOf(`${sid}=${V.c}`);
        expect(
            "order is A (deepest Path), then B and C (equal Path, createdAt ascending)",
            idxA >= 0 && idxB > idxA && idxC > idxB,
            first.outboundCookie
        );
        const bKey = mod.getCompositeCookieKey(
            sid,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        const bCreatedAt = pc.entries.get(bKey)?.createdAt;
        await sleep(2);
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/b2`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${sid}=${V.fresh}; Path=/`] })
        });
        expect(
            "a same-key refresh keeps createdAt (RFC 6265 §5.3)",
            pc.entries.get(bKey)?.createdAt === bCreatedAt,
            `${pc.entries.get(bKey)?.createdAt} vs ${bCreatedAt}`
        );
        const second = await sim.request({
            url: target,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        const sA = second.outboundCookie.indexOf(`${sid}=${V.a}`);
        const sB = second.outboundCookie.indexOf(`${sid}=${V.fresh}`);
        const sC = second.outboundCookie.indexOf(`${sid}=${V.c}`);
        expect(
            "order does not jump after the refresh",
            sA >= 0 && sB > sA && sC > sB,
            second.outboundCookie
        );

        // Source exclusivity, both directions.
        const n1 = NAMES.sidResid;
        world.jar.pageWrite(
            `${n1}=${V.js}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "the page write is adopted as a client entry",
            pc.entries.get(mod.getClientDomainKey(n1))?.source === "client"
        );
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${n1}=${V.server}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "a server issue revokes the same-name client entry",
            !pc.entries.has(mod.getClientDomainKey(n1))
        );
        const serverOnly = entriesNamed(pc, n1);
        expect(
            "only the server entry remains for that name",
            serverOnly.length === 1 && serverOnly[0].source === "server",
            JSON.stringify(serverOnly.map(e => e.source))
        );
        world.jar.setCookie(`${n1}=${V.client}; Path=/`, SHARED_HOSTS.h5access);
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/again`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        const afterReverse = entriesNamed(pc, n1);
        expect(
            "reverse direction: a raw header cannot create a client entry either",
            afterReverse.length === 1 && afterReverse[0].source === "server",
            JSON.stringify(afterReverse.map(e => e.source))
        );
    }
]);

ASSERTION_RUNNERS.push([
    "2",
    "JS 重复写入同值触发降级 (repeat same-value write still demotes)",
    async expect => {
        const world = await freshGroup({});
        const { sim, jar, mod } = world;
        const name = NAMES.nseq;
        jar.pageWrite(`${name}=4; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "first pass leaves no parent-domain copy in the jar",
            jar.byScope(name, "yangshipin.cn").length === 0,
            JSON.stringify(jar.find(name))
        );
        expect(
            "the rebuild is host-only on the document host",
            jar.byScope(name, DOC_HOSTS.pc).length === 1
        );
        jar.pageWrite(`${name}=4; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        expect(
            "the page write re-creates the parent-domain copy",
            jar.byScope(name, "yangshipin.cn").length === 1
        );
        const second = await sim.request({
            url: `https://${DOC_HOSTS.pc}/video`,
            type: "main_frame"
        });
        expect(
            "the response still purges the parent-domain copy",
            second.setCookieLines.includes(
                `${name}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
            ),
            second.setCookieLines.join(" | ")
        );
        expect(
            "and rebuilds the host-only copy",
            findSetCookieLine(
                second.setCookieLines,
                new RegExp(`^${name}=4; Path=/; SameSite=Lax`)
            ) !== undefined,
            second.setCookieLines.join(" | ")
        );
        expect(
            "the jar has no parent-domain copy afterwards",
            jar.byScope(name, "yangshipin.cn").length === 0
        );
    }
]);

ASSERTION_RUNNERS.push([
    "3",
    "墓碑全链路防御死凭据复活 (tombstone blocks raw header and candidates)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const name = NAMES.deadCred;
        const key = mod.getCompositeCookieKey(
            name,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${name}=${V.a}; Path=/; Max-Age=3600`]
            })
        });
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/logout`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${name}=; Max-Age=0; Path=/`] })
        });
        expect(
            "the deleted credential is tombstoned with its last value",
            pc.tombstones.get(key)?.valueFingerprint === mod.fingerprint(V.a),
            JSON.stringify(pc.tombstones.get(key))
        );
        expect("the entry itself is gone", !pc.entries.has(key));

        // An older parent-domain client entry still lives in the partition.
        jar.pageWrite(`${name}=${V.a}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/page`,
            type: "main_frame"
        });
        const clientKey = mod.getClientDomainKey(name);
        expect(
            "a parent-domain client entry exists in the partition",
            pc.entries.get(clientKey)?.value === V.a,
            JSON.stringify(entriesNamed(pc, name).map(e => [e.source, e.value]))
        );
        jar.pageWrite(`${name}=${V.a}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        const beforeEntries = pc.entries.size;
        const beforeBlocked = mod.getYangshipinDiagnostics().tombstoneBlocked;
        const beforeCreatedAt = pc.entries.get(clientKey).createdAt;
        const res = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "the raw residual is stripped from the outbound header",
            !res.outboundCookie.includes(name),
            res.outboundCookie
        );
        expect(
            "the partition candidate carrying the dead value is filtered too",
            res.outboundCookie === "",
            res.outboundCookie
        );
        expect(
            "nothing was adopted as a new key",
            pc.entries.size === beforeEntries &&
                pc.entries.get(clientKey).createdAt === beforeCreatedAt
        );
        expect(
            "the tombstone counter moved",
            mod.getYangshipinDiagnostics().tombstoneBlocked > beforeBlocked
        );
    }
]);

ASSERTION_RUNNERS.push([
    "4",
    "高并发乱序响应不发生值回滚 (no value rollback on out-of-order responses)",
    async expect => {
        const world = await freshGroup({});
        const { sim, jar, mod } = world;
        const name = NAMES.rollVal;
        jar.pageWrite(`${name}=3; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        const late = await sim.begin({
            url: `https://${DOC_HOSTS.pc}/early`,
            type: "main_frame"
        });
        expect(
            "request A captured value 3 into the partition",
            mod.pcPartition.entries.get(mod.getClientDomainKey(name))?.value ===
                "3"
        );
        jar.pageWrite(`${name}=4; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        const first = await sim.request({
            url: `https://${DOC_HOSTS.pc}/later`,
            type: "main_frame"
        });
        expect(
            "B's response rebuilds from the response-time value (4)",
            findSetCookieLine(
                first.setCookieLines,
                new RegExp(`^${name}=4; Path=/; SameSite=Lax`)
            ) !== undefined,
            first.setCookieLines.join(" | ")
        );
        const finished = await sim.finish(late, {});
        expect(
            "A's late response rebuilds from the response-time value (4, not 3)",
            findSetCookieLine(
                finished.setCookieLines,
                new RegExp(`^${name}=4; Path=/; SameSite=Lax`)
            ) !== undefined,
            finished.setCookieLines.join(" | ")
        );
        expect(
            "A's late response never re-emits the stale value 3",
            !finished.setCookieLines.some(l => l.startsWith(`${name}=3;`)),
            finished.setCookieLines.join(" | ")
        );
    }
]);

ASSERTION_RUNNERS.push([
    "5",
    "服务端接管即刻注销客户端副本 (server takeover revokes the client copy)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [
                { host: SHARED_HOSTS.h5access },
                { host: SHARED_HOSTS.ucenter }
            ]
        });
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const name = NAMES.takeover;
        jar.pageWrite(`${name}=${V.js}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        const clientKey = mod.getClientDomainKey(name);
        expect(
            "client entry registered from the page write",
            pc.entries.get(clientKey)?.source === "client"
        );
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${name}=${V.server}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "the same-name client entry is physically deleted on takeover",
            !pc.entries.has(clientKey)
        );
        const remaining = entriesNamed(pc, name);
        expect(
            "only the server entry remains",
            remaining.length === 1 && remaining[0].source === "server",
            JSON.stringify(remaining.map(e => e.source))
        );
        const other = await sim.request({
            url: `https://${SHARED_HOSTS.ucenter}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "another host receives no N at all (the revoked client copy is not re-sent)",
            !other.outboundCookie.includes(name),
            other.outboundCookie
        );
    }
]);

ASSERTION_RUNNERS.push([
    "6",
    "服务端同名项禁止客户端降级覆盖 (purge-only, never a client rebuild)",
    async expect => {
        const docWorld = await freshGroup({});
        const docName = NAMES.serverWin;
        docWorld.jar.pageWrite(
            `${docName}=3; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const docRes = await docWorld.sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            backend: () => ({
                setCookies: [
                    `${docName}=${V.server}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "document-host response purges the parent-domain client copy",
            docRes.setCookieLines.includes(
                `${docName}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
            ),
            docRes.setCookieLines.join(" | ")
        );
        expect(
            "no non-HttpOnly client rebuild is emitted over the server authority",
            !docRes.setCookieLines.some(l =>
                new RegExp(`^${docName}=3; Path=/; SameSite=Lax`).test(l)
            ),
            docRes.setCookieLines.join(" | ")
        );
        expect(
            "the server credential itself is kept for the document host",
            docRes.setCookieLines.some(
                l =>
                    l.startsWith(`${docName}=${V.server};`) &&
                    l.includes("HttpOnly")
            ),
            docRes.setCookieLines.join(" | ")
        );

        const apiWorld = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const apiName = NAMES.serverWinApi;
        apiWorld.jar.pageWrite(
            `${apiName}=3; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const apiRes = await apiWorld.sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${apiName}=${V.server}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "shared-API response purges the stale parent-domain copy",
            apiRes.setCookieLines.includes(
                `${apiName}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
            ),
            apiRes.setCookieLines.join(" | ")
        );
        expect(
            "shared-API response never rebuilds a client copy",
            !apiRes.setCookieLines.some(l => l.startsWith(`${apiName}=3;`)),
            apiRes.setCookieLines.join(" | ")
        );
        expect(
            "the server credential is not handed to the jar on a shared API host",
            !apiRes.setCookieLines.some(l => l.includes(`=${V.server}`)),
            apiRes.setCookieLines.join(" | ")
        );
    }
]);

ASSERTION_RUNNERS.push([
    "7",
    "RFC Max-Age 优先与非法 Domain (Max-Age precedence, RFC 6265 §5.3 step 6)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;
        const name = NAMES.maxAgeCred;
        const key = mod.getCompositeCookieKey(
            name,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        const line = `${name}=${V.a}; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [line] })
        });
        const entry = pc.entries.get(key);
        expect(
            "the credential is stored as a live entry",
            entry && entry.value === V.a,
            JSON.stringify(entry)
        );
        expect(
            "expiry comes from Max-Age, not from the past Expires",
            entry && entry.expires > Date.now(),
            entry && String(entry.expires)
        );
        expect("it was not tombstoned as a deletion", !pc.tombstones.has(key));
        const parsed = mod.parseSetCookieLine(line, SHARED_HOSTS.h5access);
        expect(
            "parseSetCookieLine: isDeletion is false",
            parsed && parsed.isDeletion === false,
            JSON.stringify(parsed)
        );
        expect(
            "parseSetCookieLine: expires is in the future",
            parsed && parsed.expires > Date.now()
        );
        const reverse = mod.parseSetCookieLine(
            `${name}=; Max-Age=0; Expires=${httpDate(
                expiresIn(24 * 3600 * 1000)
            )}; Path=/`,
            SHARED_HOSTS.h5access
        );
        expect(
            "Max-Age=0 wins over a future Expires (deletion)",
            reverse && reverse.isDeletion === true,
            JSON.stringify(reverse)
        );

        // RFC 6265 §5.3 step 6: a Domain attribute that does not domain-match
        // the response host invalidates the whole line and must never be
        // "repaired" into a host-only cookie.
        const invalidLine = `${NAMES.badDomain}=${V.a}; Domain=evil.example; Path=/; Max-Age=3600`;
        expect(
            "an invalid Domain attribute makes the whole line invalid",
            mod.parseSetCookieLine(invalidLine, SHARED_HOSTS.h5access) ===
                undefined,
            JSON.stringify(
                mod.parseSetCookieLine(invalidLine, SHARED_HOSTS.h5access)
            )
        );
        expect(
            "hasInvalidDomainAttribute reports the reason",
            mod.hasInvalidDomainAttribute(
                invalidLine,
                SHARED_HOSTS.h5access
            ) === true
        );
        expect(
            "hasInvalidDomainAttribute stays false for a valid Domain",
            mod.hasInvalidDomainAttribute(
                `${NAMES.plainDomain}=${V.a}; Domain=.yangshipin.cn; Path=/`,
                SHARED_HOSTS.h5access
            ) === false
        );
        const hostOnlyParsed = mod.parseSetCookieLine(
            `${NAMES.plainHostOnly}=${V.a}; Path=/; Max-Age=3600`,
            SHARED_HOSTS.h5access
        );
        expect(
            "a missing Domain attribute is still a host-only cookie",
            hostOnlyParsed &&
                hostOnlyParsed.isHostOnly === true &&
                hostOnlyParsed.domain === undefined,
            JSON.stringify(hostOnlyParsed)
        );
        const domainParsed = mod.parseSetCookieLine(
            `${NAMES.plainDomain}=${V.a}; Domain=.yangshipin.cn; Path=/; Max-Age=3600`,
            SHARED_HOSTS.h5access
        );
        expect(
            "a matching Domain attribute is still a domain cookie",
            domainParsed &&
                domainParsed.isHostOnly === false &&
                domainParsed.domain === "yangshipin.cn",
            JSON.stringify(domainParsed)
        );
    }
]);

ASSERTION_RUNNERS.push([
    "8",
    "共享子域零落盘、跨端零泄漏与非法 Domain (Zero-Jar, invalid Domain rejected)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [
                { host: SHARED_HOSTS.h5access },
                { host: SHARED_HOSTS.h5access, platform: "mobile" }
            ]
        });
        const { sim, jar, mod } = world;
        const name = NAMES.mobileCred;
        const res = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api/login`,
            documentUrl: MOBILE_DOC_URL,
            backend: () => ({
                setCookies: [`${name}=${V.a}; HttpOnly; Path=/; Max-Age=3600`]
            })
        });
        expect(
            "the response handed to the browser has no Set-Cookie header at all",
            !hasSetCookie(res.responseHeaders),
            res.setCookieLines.join(" | ")
        );
        expect(
            "the shared-API credential never reached the jar",
            jar.count(name) === 0
        );
        expect(
            "it is registered in the mobile partition instead",
            entriesNamed(mod.mobilePartition, name).length === 1
        );
        const pcReq = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api/other`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "the PC request sends none of the mobile credentials",
            !pcReq.outboundCookie.includes(name),
            pcReq.outboundCookie
        );
        expect(
            "the PC partition holds no copy of the mobile credential",
            entriesNamed(mod.pcPartition, name).length === 0
        );

        // RFC 6265 §5.3 step 6 on the wire: an invalid Domain attribute must
        // never be repaired into a host-only cookie, while a missing Domain
        // attribute still is host-only and a matching one is a domain cookie.
        const invalidBefore = mod.getYangshipinDiagnostics().invalidDomains;
        const apiInvalid = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api/domain`,
            documentUrl: MOBILE_DOC_URL,
            backend: () => ({
                setCookies: [
                    `${NAMES.badDomain}=${V.a}; Domain=evil.example; Path=/; Max-Age=3600`,
                    `${NAMES.plainHostOnly}=${V.b}; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "an invalid-Domain line is never registered on a shared API host",
            entriesNamed(mod.mobilePartition, NAMES.badDomain).length === 0,
            JSON.stringify(entriesNamed(mod.mobilePartition, NAMES.badDomain))
        );
        expect(
            "the invalid Domain is counted as such",
            mod.getYangshipinDiagnostics().invalidDomains === invalidBefore + 1,
            String(mod.getYangshipinDiagnostics().invalidDomains)
        );
        expect(
            "the shared-API response still carries no Set-Cookie at all",
            !hasSetCookie(apiInvalid.responseHeaders)
        );
        expect(
            "the valid sibling line is still registered (host-only, no Domain)",
            entriesNamed(mod.mobilePartition, NAMES.plainHostOnly)[0]
                ?.isHostOnly === true
        );

        const docInvalidBefore = mod.getYangshipinDiagnostics().invalidDomains;
        const docInvalid = await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            backend: () => ({
                setCookies: [
                    `${NAMES.badDomain}=${V.c}; Domain=evil.example; Path=/; Max-Age=3600`,
                    `${NAMES.plainDomain}=${V.c}; Domain=.yangshipin.cn; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "an invalid-Domain line is dropped from a document-host response too",
            !docInvalid.setCookieLines.some(l =>
                l.startsWith(`${NAMES.badDomain}=`)
            ) && entriesNamed(mod.pcPartition, NAMES.badDomain).length === 0,
            docInvalid.setCookieLines.join(" | ")
        );
        expect(
            "the jar never received the invalid-Domain cookie",
            jar.count(NAMES.badDomain) === 0,
            JSON.stringify(jar.find(NAMES.badDomain))
        );
        expect(
            "the document-host invalid Domain is counted",
            mod.getYangshipinDiagnostics().invalidDomains ===
                docInvalidBefore + 1
        );
        expect(
            "a matching Domain line is kept with the Domain attribute stripped",
            docInvalid.setCookieLines.some(
                l =>
                    l.startsWith(`${NAMES.plainDomain}=${V.c};`) &&
                    !/;\s*Domain=/i.test(l)
            ),
            docInvalid.setCookieLines.join(" | ")
        );
        expect(
            "and is registered as a parent-domain entry (not host-only)",
            entriesNamed(mod.pcPartition, NAMES.plainDomain)[0]?.isHostOnly ===
                false &&
                entriesNamed(mod.pcPartition, NAMES.plainDomain)[0]?.domain ===
                    "yangshipin.cn",
            JSON.stringify(entriesNamed(mod.pcPartition, NAMES.plainDomain))
        );
    }
]);

ASSERTION_RUNNERS.push([
    "9",
    "初始化基线清洗事件边界 (global baseline, once only)",
    async expect => {
        const world = createWorld();
        const { sim, jar, mod } = world;
        mod.clearYangshipinPartitions();
        await settleWrites(world);
        expect(
            "the marker is pending after the reset",
            mod.isYangshipinBaselinePending() === true
        );
        expect(
            "the persisted marker is false after the reset",
            world.storage.getLocalState("fxcast_ysp_baseline_clean_done") ===
                false
        );
        jar.pageWrite(
            `${NAMES.legacyOne}=${V.a}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        jar.pageWrite(
            `${NAMES.legacyTwo}=${V.b}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const nav = await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "the baseline navigation empties the outbound Cookie header",
            nav.outboundCookie === "",
            nav.outboundCookie
        );
        for (const name of [NAMES.legacyOne, NAMES.legacyTwo]) {
            expect(
                `response carries the parent-domain delete row for ${name}`,
                nav.setCookieLines.includes(
                    `${name}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
                ),
                nav.setCookieLines.join(" | ")
            );
            expect(
                `response carries the host-only delete row for ${name}`,
                nav.setCookieLines.includes(`${name}=; Max-Age=0; Path=/`),
                nav.setCookieLines.join(" | ")
            );
        }
        expect(
            "the in-memory marker flips after the first response",
            mod.isYangshipinBaselinePending() === false
        );
        await sleep(5);
        expect(
            "the global single storage key is persisted as true",
            world.storage.getLocalState("fxcast_ysp_baseline_clean_done") ===
                true
        );
        expect(
            "the baseline is counted once",
            mod.getYangshipinDiagnostics().baselineCleans === 1
        );
        expect(
            "§12.3: the baseline completion tells the user to sign in again",
            world.browser.__notifications.some(n =>
                /sign in .*again/i.test(String(n && n.message))
            ),
            JSON.stringify(world.browser.__notifications)
        );
        jar.pageWrite(
            `${NAMES.legacyOne}=${V.a}; Domain=.yangshipin.cn`,
            DOC_HOSTS.mobileW
        );
        const second = await sim.request({
            url: MOBILE_DOC_URL,
            type: "main_frame",
            tabId: 2
        });
        expect(
            "the other platform's first document navigation goes straight to steady state",
            second.outboundCookie.includes(`${NAMES.legacyOne}=${V.a}`),
            second.outboundCookie
        );
        expect(
            "it emits no baseline host-only delete row",
            !second.setCookieLines.includes(
                `${NAMES.legacyOne}=; Max-Age=0; Path=/`
            ),
            second.setCookieLines.join(" | ")
        );
        expect(
            "the baseline is still counted once (shared jar, one clean)",
            mod.getYangshipinDiagnostics().baselineCleans === 1
        );
    }
]);

ASSERTION_RUNNERS.push([
    "10",
    "第三方发起不注入 (external initiator is never injected)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const third = "third-party.example";
        mod.tabTopHostByTabId.set(9, third);
        const raw = `${NAMES.thirdPartyCred}=${V.a}`;
        const details = {
            url: `https://${SHARED_HOSTS.h5access}/api`,
            type: "xmlhttprequest",
            tabId: 9,
            originUrl: `https://${third}/`,
            documentUrl: `https://${third}/page`
        };
        expect(
            "classified external",
            mod.classifyYangshipinPlatform(details) === "external",
            mod.classifyYangshipinPlatform(details)
        );
        const handle = await sim.begin(
            Object.assign({ rawCookie: raw }, details)
        );
        expect(
            "no requestHeaders key on the returned object (native behaviour kept)",
            leftUntouched(handle.blocking, "requestHeaders")
        );
        expect(
            "the raw header is not rewritten",
            handle.outboundCookie === raw,
            handle.outboundCookie
        );
        expect(
            "no partition entry is touched",
            mod.pcPartition.entries.size === 0 &&
                mod.mobilePartition.entries.size === 0
        );
        const done = await sim.finish(handle, {
            backend: () => ({
                setCookies: [`${NAMES.thirdPartyCred}2=${V.b}; Path=/`]
            })
        });
        expect(
            "an external response has every Set-Cookie stripped",
            !hasSetCookie(done.responseHeaders),
            done.setCookieLines.join(" | ")
        );
    }
]);

ASSERTION_RUNNERS.push([
    "11",
    "嵌入式 iframe (third-party top level, yangshipin frame -> external)",
    async expect => {
        const world = await freshGroup({});
        const { sim, mod } = world;
        const third = "third-party.example";
        mod.tabTopHostByTabId.set(11, third);
        expect(
            "the yangshipin sub_frame under a third-party top level is external",
            mod.classifyYangshipinPlatform({
                url: `https://${DOC_HOSTS.mobileW}/embed`,
                type: "sub_frame",
                tabId: 11,
                documentUrl: `https://${DOC_HOSTS.mobileW}/embed`
            }) === "external"
        );
        expect(
            "a resource inside that iframe is external too",
            mod.classifyYangshipinPlatform({
                url: `https://${SHARED_HOSTS.h5access}/api`,
                type: "xmlhttprequest",
                tabId: 11,
                originUrl: `https://${DOC_HOSTS.mobileW}`,
                documentUrl: `https://${DOC_HOSTS.mobileW}/embed`
            }) === "external"
        );
        const handle = await sim.begin({
            url: `https://${DOC_HOSTS.mobileW}/embed`,
            type: "sub_frame",
            tabId: 11,
            documentUrl: `https://${DOC_HOSTS.mobileW}/embed`,
            rawCookie: `${NAMES.iframeCred}=${V.a}`
        });
        expect(
            "the frame's Cookie header is left alone",
            handle.outboundCookie === `${NAMES.iframeCred}=${V.a}`,
            handle.outboundCookie
        );
        expect(
            "nothing is registered in either partition",
            mod.pcPartition.entries.size === 0 &&
                mod.mobilePartition.entries.size === 0
        );
        const done = await sim.finish(handle, {
            backend: () => ({
                setCookies: [`${NAMES.iframeCred}=${V.a}; Path=/`]
            })
        });
        expect(
            "the embedded response keeps nothing in the jar",
            !hasSetCookie(done.responseHeaders)
        );
        mod.tabTopHostByTabId.delete(11);
        expect(
            "with no top-level entry at all the same frame is unknown (fail-closed)",
            mod.classifyYangshipinPlatform({
                url: `https://${DOC_HOSTS.mobileW}/embed`,
                type: "sub_frame",
                tabId: 11,
                documentUrl: `https://${DOC_HOSTS.mobileW}/embed`
            }) === "unknown"
        );
        mod.tabTopHostByTabId.set(11, DOC_HOSTS.mobileW);
        expect(
            "with a doc-host top-level entry the frame is mobile (R1 by target host)",
            mod.classifyYangshipinPlatform({
                url: `https://${DOC_HOSTS.mobileW}/embed`,
                type: "sub_frame",
                tabId: 11,
                documentUrl: `https://${DOC_HOSTS.mobileW}/embed`
            }) === "mobile"
        );
        expect(
            "sub_frame keeps R1 even without an initiator (target doc host wins)",
            mod.classifyYangshipinPlatform({
                url: `https://${DOC_HOSTS.mobileW}/embed`,
                type: "sub_frame",
                tabId: 11
            }) === "mobile"
        );
        expect(
            "a non-navigation resource still needs an initiator (the context is not one)",
            mod.classifyYangshipinPlatform({
                url: `https://${SHARED_HOSTS.h5access}/api`,
                type: "xmlhttprequest",
                tabId: 11
            }) === "unknown"
        );
    }
]);

ASSERTION_RUNNERS.push([
    "12",
    "重定向跨平台 (each hop re-classified, R0)",
    async expect => {
        const world = await freshGroup({});
        const { sim, mod } = world;
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            backend: () => ({
                setCookies: [`${NAMES.pcOnly}=${V.a}; Path=/`]
            })
        });
        await sim.request({
            url: MOBILE_DOC_URL,
            type: "main_frame",
            tabId: 2,
            backend: () => ({
                setCookies: [`${NAMES.mobileOnly}=${V.b}; Path=/`]
            })
        });
        const requestId = "redirect-chain-12";
        const hopOne = await sim.begin({
            requestId,
            url: `https://${DOC_HOSTS.pc}/start`,
            type: "main_frame",
            tabId: 3
        });
        expect(
            "the first hop binds the pc partition",
            mod.requestIdPlatformMap.get(requestId)?.platform === "pc"
        );
        expect(
            "the first hop injects the pc credential",
            hopOne.outboundCookie.includes(NAMES.pcOnly),
            hopOne.outboundCookie
        );
        const hopTwo = await sim.begin({
            requestId,
            url: `https://${DOC_HOSTS.mobileW}/next`,
            type: "main_frame",
            tabId: 3
        });
        expect(
            "the second hop is re-classified by its target host",
            mod.requestIdPlatformMap.get(requestId)?.platform === "mobile",
            mod.requestIdPlatformMap.get(requestId)?.platform
        );
        expect(
            "the mobile partition (not the pc one) is injected",
            hopTwo.outboundCookie.includes(NAMES.mobileOnly) &&
                !hopTwo.outboundCookie.includes(NAMES.pcOnly),
            hopTwo.outboundCookie
        );
        await sim.finish(hopTwo, {});
    }
]);

ASSERTION_RUNNERS.push([
    "13",
    "SameSite (Strict / Lax / None enforcement on re-injection)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim } = world;
        const strict = NAMES.ssStrict;
        const lax = NAMES.ssLax;
        const none = NAMES.ssNone;
        const insecure = NAMES.ssInsecure;
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/set`,
            type: "main_frame",
            backend: () => ({
                setCookies: [
                    `${strict}=${V.a}; Path=/; Domain=.yangshipin.cn; SameSite=Strict; Secure; Max-Age=3600`,
                    `${lax}=${V.a}; Path=/; Domain=.yangshipin.cn; SameSite=Lax; Max-Age=3600`,
                    `${none}=${V.a}; Path=/; Domain=.yangshipin.cn; SameSite=None; Secure; Max-Age=3600`,
                    `${insecure}=${V.a}; Path=/; Domain=.yangshipin.cn; SameSite=None; Max-Age=3600`
                ]
            })
        });
        const sameSite = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "Strict is sent to a same-site initiator",
            sameSite.outboundCookie.includes(strict),
            sameSite.outboundCookie
        );
        expect(
            "Lax is sent to a same-site initiator",
            sameSite.outboundCookie.includes(lax),
            sameSite.outboundCookie
        );
        expect(
            "SameSite=None without Secure is never sent",
            !sameSite.outboundCookie.includes(insecure),
            sameSite.outboundCookie
        );

        const crossTop = await sim.request({
            url: `https://${DOC_HOSTS.pc}/landing`,
            type: "main_frame",
            tabId: 4,
            originUrl: "https://third-party.example/",
            documentUrl: "https://third-party.example/"
        });
        expect(
            "Strict is not sent on a cross-site top-level navigation",
            !crossTop.outboundCookie.includes(strict),
            crossTop.outboundCookie
        );
        expect(
            "Lax is sent on a cross-site top-level GET navigation",
            crossTop.outboundCookie.includes(lax),
            crossTop.outboundCookie
        );
        expect(
            "SameSite=None+Secure is sent on a cross-site request",
            crossTop.outboundCookie.includes(none),
            crossTop.outboundCookie
        );

        // NOTE: a real cross-site subresource is classified `external` (§9.1 /
        // §9.3) and therefore never injected at all, so the "Lax is not sent in
        // a cross-site subresource" clause is only reachable through the R1
        // target-document-host classification path exercised here.
        const crossSub = await sim.request({
            url: `https://${DOC_HOSTS.pc}/embed`,
            type: "sub_frame",
            tabId: 4,
            originUrl: "https://third-party.example/",
            referer: "https://third-party.example/page"
        });
        expect(
            "Strict is not sent by a cross-site subresource",
            !crossSub.outboundCookie.includes(strict),
            crossSub.outboundCookie
        );
        expect(
            "Lax is not sent by a cross-site subresource",
            !crossSub.outboundCookie.includes(lax),
            crossSub.outboundCookie
        );
        expect(
            "SameSite=None+Secure is still sent",
            crossSub.outboundCookie.includes(none),
            crossSub.outboundCookie
        );
    }
]);

// 14 is a numbered placeholder kept for cross-reference stability.
ASSERTION_RUNNERS.push([
    "14",
    "容器与隐私窗口隔离 (withdrawn)",
    null,
    "placeholder: no assertion. Withdrawn by D1 = B / §10 — no `cookies` permission, " +
        "containers share one partition as a documented limitation, private windows are out of scope."
]);

ASSERTION_RUNNERS.push([
    "15",
    "冷启动状态恢复与过期保持 (cold start recovery: two-sided sessions, no baseline rerun, original expiry)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;

        const sessPc = NAMES.sessPc;
        const persPc = NAMES.persPc;
        const clientPc = NAMES.clientPc;
        const nonHttpPc = NAMES.nonHttpPc;

        const sessMob = NAMES.sessMob;
        const persMob = NAMES.persMob;
        const clientMob = NAMES.clientMob;
        const nonHttpMob = NAMES.nonHttpMob;

        const expired = NAMES.expiredCred;
        const futureExpiry = Date.now() + 3600 * 1000;
        const pastExpiry = Date.now() - 1000;

        // 1. PC 登录与页面物化
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/pc-login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${sessPc}=pc-sess-val; Path=/; HttpOnly`,
                    `${persPc}=pc-pers-val; Path=/; Max-Age=3600; HttpOnly`,
                    `${nonHttpPc}=pc-page-val; Path=/`
                ]
            })
        });
        world.jar.pageWrite(
            `${clientPc}=pc-client-val; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const pcDocPre = await sim.request({
            url: `https://${DOC_HOSTS.pc}/home`,
            type: "main_frame"
        });
        expect(
            "PC document response materialized non-HttpOnly credential before restart",
            pcDocPre.setCookieLines.some(l =>
                l.includes(`${nonHttpPc}=pc-page-val`)
            ),
            pcDocPre.setCookieLines.join(" | ")
        );

        // 2. Mobile 登录与页面物化
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/mobile-login`,
            documentUrl: MOBILE_DOC_URL,
            backend: () => ({
                setCookies: [
                    `${sessMob}=mob-sess-val; Path=/; HttpOnly`,
                    `${persMob}=mob-pers-val; Path=/; Max-Age=3600; HttpOnly`,
                    `${nonHttpMob}=mob-page-val; Path=/`
                ]
            })
        });
        world.jar.pageWrite(
            `${clientMob}=mob-client-val; Domain=.yangshipin.cn`,
            DOC_HOSTS.mobileW
        );
        const mobDocPre = await sim.request({
            url: `https://${DOC_HOSTS.mobileW}/home`,
            type: "main_frame"
        });
        expect(
            "Mobile document response materialized non-HttpOnly credential before restart",
            mobDocPre.setCookieLines.some(l =>
                l.includes(`${nonHttpMob}=mob-page-val`)
            ),
            mobDocPre.setCookieLines.join(" | ")
        );

        // 过期条目放入分区，验证不会复活
        const expKey = mod.getCompositeCookieKey(
            expired,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        pc.set(
            serverEntry({
                name: expired,
                value: V.c,
                host: SHARED_HOSTS.h5access,
                isHostOnly: true,
                path: "/",
                httpOnly: true,
                expires: pastExpiry
            })
        );
        expect(
            "expired entry placed in PC partition before persist",
            pc.entries.has(expKey)
        );

        // 3. 持久化并检查落盘 payload
        await mod.persistSessionPartitionsNow();
        await settleWrites(world);

        const storedPc = world.storage.getLocalState("fxcast_ysp_partition_pc");
        const storedMob = world.storage.getLocalState(
            "fxcast_ysp_partition_mobile"
        );
        const sessPcKey = mod.getCompositeCookieKey(
            sessPc,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        const persPcKey = mod.getCompositeCookieKey(
            persPc,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        const clientPcKey = mod.getClientDomainKey(clientPc);
        const sessMobKey = mod.getCompositeCookieKey(
            sessMob,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        const clientMobKey = mod.getClientDomainKey(clientMob);

        expect(
            "stored PC payload keeps the session entry",
            !!(storedPc && storedPc.entries && sessPcKey in storedPc.entries)
        );
        expect(
            "stored PC payload keeps the client entry",
            !!(storedPc && storedPc.entries && clientPcKey in storedPc.entries)
        );
        expect(
            "stored PC payload keeps the persistent entry",
            !!(storedPc && storedPc.entries && persPcKey in storedPc.entries)
        );
        expect(
            "stored Mobile payload keeps the session entry",
            !!(
                storedMob &&
                storedMob.entries &&
                sessMobKey in storedMob.entries
            )
        );
        expect(
            "stored Mobile payload keeps the client entry",
            !!(
                storedMob &&
                storedMob.entries &&
                clientMobKey in storedMob.entries
            )
        );

        // 4. 全新模块冷启动（复用 storage，清除内存 jar）
        const coldWorld = createWorld({
            storage: world.storage
        });
        const coldSim = coldWorld.sim;
        const coldMod = coldWorld.mod;
        const coldPc = coldMod.pcPartition;

        await coldMod.ensurePartitionsHydrated();

        // 契约：重启不重新执行基线
        expect(
            "cold start does not rerun global baseline",
            coldMod.isYangshipinBaselinePending() === false
        );

        // 契约：已过期条目不复活，未过期条目保持原到期时间（不续期）
        expect(
            "expired entry is not restored on cold start",
            !coldPc.entries.has(expKey)
        );
        expect(
            "persistent entry retains original expiry timestamp without renewal",
            coldPc.entries.get(persPcKey)?.expires !== null &&
                Math.abs(coldPc.entries.get(persPcKey).expires - futureExpiry) <
                    5000,
            String(coldPc.entries.get(persPcKey)?.expires)
        );

        // 5. 两端首次访问仍保持各自状态
        // PC 访问文档主机：入向恢复页面可读副本（同时包含非 HttpOnly server 凭据与 client 凭据！）
        const pcFirstDoc = await coldSim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "PC document response re-materializes non-HttpOnly server copy on cold start",
            pcFirstDoc.setCookieLines.some(l =>
                l.includes(`${nonHttpPc}=pc-page-val`)
            ),
            pcFirstDoc.setCookieLines.join(" | ")
        );
        expect(
            "PC document response re-materializes client page copy on cold start",
            pcFirstDoc.setCookieLines.some(l =>
                l.includes(`${clientPc}=pc-client-val`)
            ),
            pcFirstDoc.setCookieLines.join(" | ")
        );

        expect(
            "PC partition records docHost as materialized after first commit",
            coldPc.materializedDocHosts.has(DOC_HOSTS.pc) === true
        );

        // 同一会话第二次访问文档主机：不重复下发已物化的副本
        const pcSecondDoc = await coldSim.request({
            url: `https://${DOC_HOSTS.pc}/page2`,
            type: "main_frame",
            noJarHeader: true
        });
        expect(
            "PC second document response does NOT re-emit already materialized copies",
            !pcSecondDoc.setCookieLines.some(l => l.includes(`${clientPc}=`)) &&
                !pcSecondDoc.setCookieLines.some(l =>
                    l.includes(`${nonHttpPc}=`)
                ),
            pcSecondDoc.setCookieLines.join(" | ")
        );

        // PC 访问 API 主机：出向携带 PC session、client 与 persistent 凭据，绝对不带 Mobile 凭据
        const pcApiReq = await coldSim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            type: "xmlhttprequest"
        });
        expect(
            "PC API request carries PC session and client credentials",
            pcApiReq.outboundCookie.includes(`${sessPc}=pc-sess-val`) &&
                pcApiReq.outboundCookie.includes(`${clientPc}=pc-client-val`) &&
                pcApiReq.outboundCookie.includes(`${persPc}=pc-pers-val`),
            pcApiReq.outboundCookie
        );
        expect(
            "PC API request carries NO Mobile credentials",
            !pcApiReq.outboundCookie.includes(sessMob) &&
                !pcApiReq.outboundCookie.includes(clientMob) &&
                !pcApiReq.outboundCookie.includes(persMob),
            pcApiReq.outboundCookie
        );

        // Mobile 访问文档主机：入向恢复页面可读副本
        const mobFirstDoc = await coldSim.request({
            url: MOBILE_DOC_URL,
            type: "main_frame"
        });
        expect(
            "Mobile document response re-materializes non-HttpOnly server copy on cold start",
            mobFirstDoc.setCookieLines.some(l =>
                l.includes(`${nonHttpMob}=mob-page-val`)
            ),
            mobFirstDoc.setCookieLines.join(" | ")
        );
        expect(
            "Mobile document response re-materializes client page copy on cold start",
            mobFirstDoc.setCookieLines.some(l =>
                l.includes(`${clientMob}=mob-client-val`)
            ),
            mobFirstDoc.setCookieLines.join(" | ")
        );

        // Mobile 访问 API 主机：出向携带 Mobile session、client 与 persistent 凭据，绝对不带 PC 凭据
        const mobApiReq = await coldSim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: MOBILE_DOC_URL,
            type: "xmlhttprequest"
        });
        expect(
            "Mobile API request carries Mobile session and client credentials",
            mobApiReq.outboundCookie.includes(`${sessMob}=mob-sess-val`) &&
                mobApiReq.outboundCookie.includes(
                    `${clientMob}=mob-client-val`
                ) &&
                mobApiReq.outboundCookie.includes(`${persMob}=mob-pers-val`),
            mobApiReq.outboundCookie
        );
        expect(
            "Mobile API request carries NO PC credentials",
            !mobApiReq.outboundCookie.includes(sessPc) &&
                !mobApiReq.outboundCookie.includes(clientPc) &&
                !mobApiReq.outboundCookie.includes(persPc),
            mobApiReq.outboundCookie
        );

        // 6. 验证“条目已落盘之后才新增任务”以及“任务排空后重启不再恢复旧任务”
        // A. 当前 coldPc 稳态持久化，pendingDemoteNames 为空
        await coldMod.persistSessionPartitionsNow();
        await settleWrites(coldWorld);
        const storedBeforeTask = coldWorld.storage.getLocalState(
            "fxcast_ysp_partition_pc"
        );
        expect(
            "pending tasks empty in storage before new API task",
            !storedBeforeTask.pendingDemoteNames ||
                storedBeforeTask.pendingDemoteNames.length === 0,
            JSON.stringify(storedBeforeTask.pendingDemoteNames)
        );

        // B. API 请求写入新 client 参数（产生待降级任务）
        const taskClientName = "taskClientKey";
        coldWorld.jar.pageWrite(
            `${taskClientName}=task-val; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        await coldSim.request({
            url: `https://${SHARED_HOSTS.h5access}/api-task`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            type: "xmlhttprequest"
        });
        expect(
            "API response adds task to memory pendingDemoteNames",
            coldPc.pendingDemoteNames.has(taskClientName)
        );
        expect(
            "adding task marks persistent state dirty (has pending writes)",
            coldPc.hasPendingWrites() === true
        );

        // C. 持久化并验证存储包含该任务
        await coldMod.persistSessionPartitionsNow();
        await settleWrites(coldWorld);
        const storedWithTask = coldWorld.storage.getLocalState(
            "fxcast_ysp_partition_pc"
        );
        expect(
            "storage now persists the pending demote task",
            Array.isArray(storedWithTask.pendingDemoteNames) &&
                storedWithTask.pendingDemoteNames.includes(taskClientName),
            JSON.stringify(storedWithTask.pendingDemoteNames)
        );

        // D. 全新模块冷启动，验证冷启动能恢复该任务
        const coldWorldWithTask = createWorld({
            storage: coldWorld.storage
        });
        await coldWorldWithTask.mod.ensurePartitionsHydrated();
        expect(
            "cold start restores the pending demote task",
            coldWorldWithTask.mod.pcPartition.pendingDemoteNames.has(
                taskClientName
            )
        );

        // E. 文档响应排空该任务
        const drainDoc = await coldWorldWithTask.sim.request({
            url: `https://${DOC_HOSTS.pc}/drain-task`,
            type: "main_frame"
        });
        expect(
            "document response drains the task and purges domain copy",
            drainDoc.setCookieLines.some(l =>
                l.includes(`${taskClientName}=; Max-Age=0`)
            ),
            drainDoc.setCookieLines.join(" | ")
        );
        expect(
            "drained task is deleted from memory pendingDemoteNames",
            !coldWorldWithTask.mod.pcPartition.pendingDemoteNames.has(
                taskClientName
            )
        );
        expect(
            "task deletion marks persistent state dirty",
            coldWorldWithTask.mod.pcPartition.hasPendingWrites() === true
        );

        // F. 持久化后再次冷启动，验证已排空任务不会复活
        await coldWorldWithTask.mod.persistSessionPartitionsNow();
        await settleWrites(coldWorldWithTask);
        const storedDrained = coldWorldWithTask.storage.getLocalState(
            "fxcast_ysp_partition_pc"
        );
        expect(
            "storage no longer contains the drained task",
            !storedDrained.pendingDemoteNames ||
                !storedDrained.pendingDemoteNames.includes(taskClientName),
            JSON.stringify(storedDrained.pendingDemoteNames)
        );

        const coldWorldFinal = createWorld({
            storage: coldWorldWithTask.storage
        });
        await coldWorldFinal.mod.ensurePartitionsHydrated();
        expect(
            "final cold start does not resurrect drained task",
            !coldWorldFinal.mod.pcPartition.pendingDemoteNames.has(
                taskClientName
            )
        );

        // G. 错误清理路径主动安排持久化
        const errClientName = "errCleanTask";
        coldWorldFinal.jar.pageWrite(
            `${errClientName}=err-val; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const errHandle = await coldWorldFinal.sim.begin({
            url: `https://${DOC_HOSTS.pc}/err-fail`,
            type: "main_frame"
        });
        coldWorldFinal.sim.fail(errHandle);
        expect(
            "cleanupYangshipinRequest transfers task to partition and marks pending writes",
            coldWorldFinal.mod.pcPartition.pendingDemoteNames.has(
                errClientName
            ) && coldWorldFinal.mod.pcPartition.hasPendingWrites() === true
        );

        // 验证 schema 不匹配依然丢弃
        coldWorld.storage.setLocalState("fxcast_ysp_schema", 2);
        await coldMod.rehydrateYangshipinPartitions();
        expect(
            "a higher stored schema discards every hydrated entry and tombstone",
            coldPc.entries.size === 0 && coldPc.tombstones.size === 0,
            `${coldPc.entries.size} entries / ${coldPc.tombstones.size} tombstones`
        );
        coldWorld.storage.setLocalState("fxcast_ysp_schema", 1);
    }
]);

ASSERTION_RUNNERS.push([
    "16",
    "client 条目不落盘 (100 value updates, zero writes)",
    async expect => {
        const world = await freshGroup({});
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const name = NAMES.nseq;
        const before = world.storage.stats.localSet;
        for (let i = 0; i < 100; i++) {
            jar.pageWrite(
                `${name}=sequence-${i}; Domain=.yangshipin.cn`,
                DOC_HOSTS.pc
            );
            await sim.request({
                url: `https://${DOC_HOSTS.pc}/n/${i}`,
                type: "xmlhttprequest"
            });
        }
        expect(
            "0 storage.local.set calls for 100 client value updates",
            world.storage.stats.localSet - before === 0,
            `set calls: ${world.storage.stats.localSet - before}`
        );
        const entry = pc.entries.get(mod.getClientDomainKey(name));
        expect(
            "the client entry tracks the newest value",
            entry?.value === "sequence-99",
            JSON.stringify(entry)
        );
        expect(
            "exactly one client entry exists for the name",
            entriesNamed(pc, name).length === 1
        );
        expect(
            "the entry is marked as a client source",
            entry?.source === "client"
        );
        await mod.persistSessionPartitionsNow();
        const stored = world.storage.getLocalState("fxcast_ysp_partition_pc");
        const clientKey = mod.getClientDomainKey(name);
        expect(
            "the client entry is persisted with its newest value on persist",
            stored &&
                stored.entries &&
                stored.entries[clientKey]?.value === "sequence-99",
            JSON.stringify(stored && stored.entries)
        );
    }
]);

ASSERTION_RUNNERS.push([
    "17",
    "配额失败 (storage.local.set throws, retried later)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;
        const one = NAMES.quotaOne;
        const two = NAMES.quotaTwo;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${one}=${V.a}; HttpOnly; Path=/; Max-Age=3600`]
            })
        });
        await settleWrites(world);
        const oneKey = mod.getCompositeCookieKey(
            one,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        world.storage.setBehavior(() => "throw");
        const failed = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/logout`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${one}=; Max-Age=0; Path=/`] })
        });
        await settleWrites(world);
        expect(
            "request handling is unaffected by the storage failure",
            Array.isArray(failed.setCookieLines) && failed.received !== null
        );
        expect(
            "the tombstone is still applied in memory",
            pc.tombstones.has(oneKey)
        );
        expect(
            "the write was attempted and failed",
            world.storage.stats.throwCount >= 1,
            String(world.storage.stats.throwCount)
        );
        expect(
            "dirty is retained after the failed write",
            pc.hasPendingWrites() === true
        );
        world.storage.setBehavior(null);
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/login2`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${two}=${V.b}; HttpOnly; Path=/; Max-Age=3600`]
            })
        });
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/logout2`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${two}=; Max-Age=0; Path=/`] })
        });
        await settleWrites(world);
        expect(
            "the next change retries and the shared queue drains",
            pc.hasPendingWrites() === false,
            `stateRev=${pc.stateRev}`
        );
        await sleep(10);
        expect(
            "no unhandled rejection escapes the persistence entry point",
            unhandledRejections === 0,
            String(unhandledRejections)
        );
    }
]);

ASSERTION_RUNNERS.push([
    "18",
    "hydrate 竞态 (bounded wait, fail-closed)",
    async expect => {
        const world = createWorld({ hangLocalGet: true });
        const { sim, mod } = world;
        const started = Date.now();
        const handle = await sim.begin({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            rawCookie: `${NAMES.failCred}=${V.a}`
        });
        const elapsed = Date.now() - started;
        expect(
            "the outbound handler gives up after ~500 ms instead of hanging",
            elapsed >= 450 && elapsed < 2000,
            `${elapsed} ms`
        );
        expect(
            "fail-closed: the Cookie header is emptied",
            handle.outboundCookie === "",
            handle.outboundCookie
        );
        expect(
            "the hydrate timeout is counted",
            mod.getYangshipinDiagnostics().hydrateTimeouts >= 1,
            String(mod.getYangshipinDiagnostics().hydrateTimeouts)
        );
        const finished = await sim.finish(handle, {
            backend: () => ({
                setCookies: [`${NAMES.failCred}=${V.a}; Path=/`]
            })
        });
        expect(
            "the inbound handler fails closed too (no Set-Cookie reaches the jar)",
            !hasSetCookie(finished.responseHeaders)
        );
        const ok = await mod.ensurePartitionsHydratedWithinTimeout(50);
        expect(
            "ensurePartitionsHydratedWithinTimeout reports the failure",
            ok === false
        );
        expect(
            "no exception escaped either handler",
            unhandledRejections === 0,
            String(unhandledRejections)
        );
    }
]);

ASSERTION_RUNNERS.push([
    "19",
    "异常 fail-closed 与熔断 (exception counting + circuit breaker)",
    async expect => {
        const world = await freshGroup({});
        const { sim, mod } = world;
        const badUrl = "https://[";
        const raw = `${NAMES.failCred}=${V.a}`;
        const errorsBefore = mod.getYangshipinDiagnostics().errors;
        const outbound = await mod.handleYangshipinBeforeSendHeaders({
            requestId: "bad-outbound-19",
            url: badUrl,
            type: "xmlhttprequest",
            tabId: 1,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            requestHeaders: [{ name: "Cookie", value: raw }]
        });
        const outCookie = (outbound.requestHeaders || []).find(
            h => h.name.toLowerCase() === "cookie"
        );
        expect(
            "an outbound exception empties the Cookie header (fail-closed)",
            !outCookie || outCookie.value === "",
            JSON.stringify(outCookie)
        );
        const bound = await sim.begin({
            url: `https://${DOC_HOSTS.pc}/bound`,
            type: "main_frame"
        });
        const inbound = await mod.handleYangshipinHeadersReceived({
            requestId: bound.requestId,
            url: badUrl,
            type: "main_frame",
            responseHeaders: [
                {
                    name: "Set-Cookie",
                    value: `${NAMES.failCred}=${V.a}; Path=/`
                }
            ]
        });
        expect(
            "an inbound exception strips every Set-Cookie (fail-closed)",
            !hasSetCookie(inbound.responseHeaders || [])
        );
        expect(
            "both exceptions are counted",
            mod.getYangshipinDiagnostics().errors - errorsBefore >= 2,
            String(mod.getYangshipinDiagnostics().errors - errorsBefore)
        );
        expect(
            "no credential entered the partition",
            mod.pcPartition.entries.size === 0 &&
                mod.mobilePartition.entries.size === 0
        );
        for (let i = 0; i < 5; i++) {
            await mod.handleYangshipinBeforeSendHeaders({
                requestId: `bad-19-${i}`,
                url: badUrl,
                type: "xmlhttprequest",
                tabId: 1,
                documentUrl: `https://${DOC_HOSTS.pc}/`,
                requestHeaders: [{ name: "Cookie", value: raw }]
            });
        }
        expect(
            "reaching the threshold trips the circuit breaker",
            mod.isYangshipinIsolationEnabled() === false
        );
        expect(
            "the trip raises a notification",
            world.browser.__notifications.length >= 1,
            String(world.browser.__notifications.length)
        );
        const afterTrip = await sim.begin({
            url: `https://${DOC_HOSTS.pc}/after-trip`,
            type: "main_frame",
            rawCookie: raw
        });
        expect(
            "while disabled the handler leaves the request untouched",
            leftUntouched(afterTrip.blocking, "requestHeaders") &&
                afterTrip.outboundCookie === raw,
            JSON.stringify(afterTrip.blocking)
        );
        mod.clearYangshipinPartitions();
        await settleWrites(world);
        expect(
            "the test reset is the in-process recovery path for the breaker",
            mod.isYangshipinIsolationEnabled() === true
        );
    }
]);

ASSERTION_RUNNERS.push([
    "20",
    "接管残留拔除 (both purge landings, no rebuild)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [
                { host: SHARED_HOSTS.h5access },
                { host: SHARED_HOSTS.h5access, platform: "mobile" }
            ]
        });
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const known = NAMES.purgeKnown;
        const first = NAMES.purgeFirst;
        const serverLine = `${known}=${V.server}; HttpOnly; Path=/; Max-Age=3600`;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [serverLine] })
        });
        jar.pageWrite(`${known}=${V.old}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        expect(
            "the jar holds a parent-domain residue of the server-managed name",
            jar.byScope(known, "yangshipin.cn").length === 1
        );
        const landing1 = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/other`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "landing 3a: any yangshipin response purges the jar's domain copy",
            landing1.setCookieLines.includes(
                `${known}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
            ),
            landing1.setCookieLines.join(" | ")
        );
        expect(
            "landing 3a: no client copy is rebuilt",
            !landing1.setCookieLines.some(l =>
                l.startsWith(`${known}=${V.old}`)
            ),
            landing1.setCookieLines.join(" | ")
        );
        expect(
            "the residue is gone from the jar",
            jar.byScope(known, "yangshipin.cn").length === 0
        );
        const otherPlatform = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: MOBILE_DOC_URL
        });
        expect(
            "the other platform's request no longer carries the name",
            !otherPlatform.outboundCookie.includes(known),
            otherPlatform.outboundCookie
        );

        jar.pageWrite(`${first}=${V.old}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        const landing2 = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/login2`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${first}=${V.server}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "landing 3 (non-document branch): the first takeover purges in the same response",
            landing2.setCookieLines.includes(
                `${first}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
            ),
            landing2.setCookieLines.join(" | ")
        );
        expect(
            "the same-response purge does not queue a partition-level task",
            !pc.pendingDemoteNames.has(first)
        );
        expect(
            "the client copy is revoked by the takeover",
            !pc.entries.has(mod.getClientDomainKey(first))
        );
        expect(
            "the residue is gone from the jar",
            jar.byScope(first, "yangshipin.cn").length === 0
        );
    }
]);

ASSERTION_RUNNERS.push([
    "21",
    "墓碑不永久封名 (fingerprint, TTL, capacity)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;
        const name = NAMES.tombName;
        const key = mod.getCompositeCookieKey(
            name,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        pc.tombstone(name, SHARED_HOSTS.h5access, true, "/", V.old);
        expect(
            "tombstone carries the last-value fingerprint",
            pc.tombstones.get(key)?.valueFingerprint === mod.fingerprint(V.old)
        );
        const blocked = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/same`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            rawCookie: `${name}=${V.old}`
        });
        expect(
            "same-value residue is dropped from the outbound header",
            !blocked.outboundCookie.includes(name),
            blocked.outboundCookie
        );
        expect(
            "same-value residue is not adopted as a client entry",
            !pc.entries.has(mod.getClientDomainKey(name))
        );
        const admitted = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/new`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            rawCookie: `${name}=${V.fresh}`
        });
        expect(
            "a different value is admitted as a new key",
            pc.entries.get(mod.getClientDomainKey(name))?.value === V.fresh
        );
        expect(
            "the new value is passed through",
            admitted.outboundCookie.includes(`${name}=${V.fresh}`),
            admitted.outboundCookie
        );
        expect(
            "the tombstone is cleared by the new write",
            !pc.tombstones.has(key)
        );

        const idempotent = NAMES.rollVal;
        const idemKey = mod.getCompositeCookieKey(
            idempotent,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        expect(
            "first tombstone is a change",
            pc.tombstone(
                idempotent,
                SHARED_HOSTS.h5access,
                true,
                "/",
                V.old
            ) === true
        );
        const stamp = pc.tombstones.get(idemKey).timestamp;
        expect(
            "a repeat delete without a new last value returns false",
            pc.tombstone(idempotent, SHARED_HOSTS.h5access, true, "/") === false
        );
        expect(
            "the repeat delete keeps the fingerprint and the original TTL stamp",
            pc.tombstones.get(idemKey).valueFingerprint ===
                mod.fingerprint(V.old) &&
                pc.tombstones.get(idemKey).timestamp === stamp
        );

        pc.tombstones.clear();
        const ttlOnly = NAMES.ttlOnly;
        pc.tombstone(ttlOnly, SHARED_HOSTS.h5access, true, "/");
        const ttlKey = mod.getCompositeCookieKey(
            ttlOnly,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        pc.tombstones.get(ttlKey).timestamp = Date.now() - 25 * 3600 * 1000;
        expect(
            "name-only tombstones expire after 24 h",
            pc.evictTombstones() >= 1 && !pc.tombstones.has(ttlKey)
        );
        const ttlFp = NAMES.ttlFp;
        pc.tombstone(ttlFp, SHARED_HOSTS.h5access, true, "/", V.old);
        const fpKey = mod.getCompositeCookieKey(
            ttlFp,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        pc.tombstones.get(fpKey).timestamp = Date.now() - 25 * 3600 * 1000;
        expect(
            "fingerprinted tombstones survive 25 h (7-day TTL)",
            pc.evictTombstones() === 0 && pc.tombstones.has(fpKey),
            String(pc.tombstones.size)
        );
        pc.tombstones.get(fpKey).timestamp = Date.now() - 8 * 24 * 3600 * 1000;
        expect(
            "fingerprinted tombstones expire after 7 days",
            pc.evictTombstones() >= 1 && !pc.tombstones.has(fpKey)
        );
        for (let i = 0; i < 260; i++) {
            pc.tombstone(
                `${NAMES.capPrefix}${i}`,
                SHARED_HOSTS.h5access,
                true,
                "/"
            );
        }
        expect(
            "the tombstone population is capped at 256 (FIFO)",
            pc.tombstones.size <= 256,
            String(pc.tombstones.size)
        );
    }
]);

ASSERTION_RUNNERS.push([
    "22",
    "登出不依赖 URL (protocol-driven termination, rotation, generation)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;
        const httpA = NAMES.httpA;
        const httpB = NAMES.httpB;
        const open = NAMES.openCred;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${httpA}=${V.a}; HttpOnly; Path=/; Max-Age=3600`,
                    `${httpB}=${V.b}; HttpOnly; Path=/; Max-Age=3600`,
                    `${open}=${V.c}; Path=/; Max-Age=3600`
                ]
            })
        });
        const keyOf = name =>
            mod.getCompositeCookieKey(name, SHARED_HOSTS.h5access, true, "/");
        const generation = pc.generation;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api/v9/arbitrary/not-a-logout-path?x=1`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${httpA}=; Max-Age=0; Path=/`] })
        });
        expect(
            "session termination is detected from the protocol properties alone",
            pc.generation === generation + 1,
            `${pc.generation} vs ${generation}`
        );
        expect(
            "every HttpOnly server entry is tombstoned",
            !pc.entries.has(keyOf(httpA)) && !pc.entries.has(keyOf(httpB))
        );
        expect(
            "tombstones carry the last-value fingerprints",
            pc.tombstones.get(keyOf(httpA))?.valueFingerprint ===
                mod.fingerprint(V.a) &&
                pc.tombstones.get(keyOf(httpB))?.valueFingerprint ===
                    mod.fingerprint(V.b)
        );
        expect(
            "non-HttpOnly entries are untouched",
            pc.entries.has(keyOf(open))
        );

        const rotated = NAMES.rotatedCred;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/set-rotated`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${rotated}=${V.old}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        const beforeRotation = pc.generation;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/rotate`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${rotated}=; Max-Age=0; Path=/`,
                    `${rotated}=${V.fresh}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "token rotation (same key deleted then re-issued) does not terminate",
            pc.generation === beforeRotation,
            `${pc.generation} vs ${beforeRotation}`
        );
        expect(
            "the rotated value is stored",
            pc.entries.get(keyOf(rotated))?.value === V.fresh
        );

        const otherKey = NAMES.otherKeyCred;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/set-other-key`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${otherKey}=${V.old}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        const beforeOtherKey = pc.generation;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/issue-other-key`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${otherKey}=; Max-Age=0; Path=/`,
                    `${otherKey}=${V.fresh}; HttpOnly; Path=/sub; Max-Age=3600`
                ]
            })
        });
        expect(
            "a same-name different-key issue is not a re-issue (termination still fires)",
            pc.generation === beforeOtherKey + 1,
            `${pc.generation} vs ${beforeOtherKey}`
        );

        const repeated = NAMES.repeatCred;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/set-repeated`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${repeated}=${V.old}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        const beforeRepeated = pc.generation;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/delete-twice`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${repeated}=; Max-Age=0; Path=/`,
                    `${repeated}=; Max-Age=0; Path=/`
                ]
            })
        });
        expect(
            "a repeated delete keeps the first identity and still terminates",
            pc.generation === beforeRepeated + 1,
            `${pc.generation} vs ${beforeRepeated}`
        );
        expect(
            "the tombstone keeps the pre-delete value fingerprint",
            pc.tombstones.get(keyOf(repeated))?.valueFingerprint ===
                mod.fingerprint(V.old),
            JSON.stringify(pc.tombstones.get(keyOf(repeated)))
        );

        const httpC = NAMES.failCred;
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/set-late`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${httpC}=${V.a}; HttpOnly; Path=/; Max-Age=3600`]
            })
        });
        const inFlight = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/inflight`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/terminate`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({ setCookies: [`${httpC}=; Max-Age=0; Path=/`] })
        });
        const resurrect = NAMES.resurrectCred;
        const late = await sim.finish(inFlight, {
            backend: () => ({
                setCookies: [
                    `${resurrect}=${V.a}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "a stale-generation response strips every Set-Cookie",
            !hasSetCookie(late.responseHeaders),
            late.setCookieLines.join(" | ")
        );
        expect(
            "a stale-generation response registers nothing",
            entriesNamed(pc, resurrect).length === 0
        );

        // §11.3 user clear: entries / tombstones / partition tasks go,
        // generation advances, request-level bindings stay for the generation
        // comparison so an in-flight pre-clear response cannot resurrect state.
        const inFlightClear = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/keep-binding`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        pc.pendingDemoteNames.add(NAMES.purgeKnown);
        const generationBeforeClear = pc.generation;
        const tombstoneBeforeClear = pc.tombstones.size;
        mod.clearYangshipinSession();
        expect(
            "clearSession empties the entries and tombstones",
            pc.entries.size === 0 && pc.tombstones.size === 0,
            `${pc.entries.size} entries / ${pc.tombstones.size} tombstones (was ${tombstoneBeforeClear})`
        );
        expect(
            "clearSession drops the partition-level demotion tasks",
            pc.pendingDemoteNames.size === 0
        );
        expect(
            "clearSession advances the generation",
            pc.generation === generationBeforeClear + 1,
            `${pc.generation} vs ${generationBeforeClear}`
        );
        expect(
            "clearSession keeps request-level bindings for the generation check",
            mod.requestIdPlatformMap.has(inFlightClear.requestId)
        );
        const lateClear = await sim.finish(inFlightClear, {
            backend: () => ({
                setCookies: [
                    `${resurrect}=${V.a}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "a pre-clear in-flight response registers nothing",
            entriesNamed(pc, resurrect).length === 0 &&
                !hasSetCookie(lateClear.responseHeaders),
            lateClear.setCookieLines.join(" | ")
        );
    }
]);

ASSERTION_RUNNERS.push([
    "23",
    "非 HttpOnly 服务端凭据物化 (§13 page-visible copies)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [
                { host: SHARED_HOSTS.h5access },
                { host: SHARED_HOSTS.h5access, platform: "mobile" }
            ]
        });
        const { sim, mod } = world;
        const pc = mod.pcPartition;
        const mp = mod.mobilePartition;
        const loginType = NAMES.loginType;
        const endTime = NAMES.endTime;
        const secret = NAMES.secretCred;
        const apiSet = (
            path,
            lines,
            documentUrl = `https://${DOC_HOSTS.pc}/`
        ) =>
            sim.request({
                url: `https://${SHARED_HOSTS.h5access}${path}`,
                documentUrl,
                backend: () => ({ setCookies: lines })
            });
        const docGet = (url = `https://${DOC_HOSTS.pc}/`, tabId = 1) =>
            sim.request({ url, type: "main_frame", tabId });

        await apiSet("/login", [
            `${loginType}=${V.a}; Path=/; Max-Age=3600`,
            `${endTime}=${V.b}; Path=/; Max-Age=3600`,
            `${secret}=${V.c}; HttpOnly; Path=/; Max-Age=3600`
        ]);
        const pcKey = mod.getCompositeCookieKey(
            loginType,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        const copyKey = `${pcKey}#${DOC_HOSTS.pc}`;
        const first = await docGet();
        const firstLine = findSetCookieLine(
            first.setCookieLines,
            new RegExp(`^${loginType}=${V.a}; Path=/`)
        );
        expect(
            "a non-HttpOnly server credential is materialized to the document host",
            firstLine !== undefined,
            first.setCookieLines.join(" | ")
        );
        expect(
            "the materialized copy keeps the expiry and adds Secure",
            firstLine !== undefined &&
                firstLine.includes("Expires=") &&
                firstLine.includes("Secure"),
            firstLine
        );
        expect(
            "an HttpOnly credential is never materialized",
            !first.setCookieLines.some(l => l.startsWith(`${secret}=`)),
            first.setCookieLines.join(" | ")
        );
        expect(
            "the ledger records the copy keyed by composite key + document host",
            pc.materializedCopies.has(copyKey),
            JSON.stringify(Array.from(pc.materializedCopies.keys()))
        );
        const second = await docGet();
        expect(
            "unchanged content is not re-sent",
            materializedCopyLines(second.setCookieLines).every(
                l => !l.startsWith(`${loginType}=`)
            ),
            second.setCookieLines.join(" | ")
        );
        await apiSet("/refresh", [
            `${loginType}=${V.fresh}; Path=/; Max-Age=7200`
        ]);
        const third = await docGet();
        expect(
            "a value/expiry change re-materializes the copy",
            materializedCopyLines(third.setCookieLines).some(l =>
                l.startsWith(`${loginType}=${V.fresh};`)
            ),
            third.setCookieLines.join(" | ")
        );

        // `w` and `m` are accounted separately.
        await apiSet(
            "/mobile-login",
            [`${loginType}=${V.c}; Path=/; Max-Age=3600`],
            MOBILE_DOC_URL
        );
        const onW = await docGet(MOBILE_DOC_URL, 2);
        expect(
            "materialized on w",
            onW.setCookieLines.some(l => l.startsWith(`${loginType}=${V.c};`)),
            onW.setCookieLines.join(" | ")
        );
        const onM = await docGet(MOBILE_DOC_URL_M, 3);
        expect(
            "m materializes independently (w progress does not represent m)",
            onM.setCookieLines.some(l => l.startsWith(`${loginType}=${V.c};`)),
            onM.setCookieLines.join(" | ")
        );
        const ledgerKeys = Array.from(mp.materializedCopies.keys());
        expect(
            "the mobile ledger keys are per document host",
            ledgerKeys.some(k => k.endsWith(`#${DOC_HOSTS.mobileW}`)) &&
                ledgerKeys.some(k => k.endsWith(`#${DOC_HOSTS.mobileM}`)),
            JSON.stringify(ledgerKeys)
        );

        // Deletion revokes the page copy on the recorded Path.
        await apiSet("/delete", [`${loginType}=; Max-Age=0; Path=/`]);
        const revoked = await docGet();
        expect(
            "a deleted source revokes the page copy on the recorded Path",
            revoked.setCookieLines.includes(`${loginType}=; Max-Age=0; Path=/`),
            revoked.setCookieLines.join(" | ")
        );
        expect(
            "the ledger record is removed after the revoke",
            !pc.materializedCopies.has(copyKey)
        );
        await apiSet("/relogin", [
            `${loginType}=${V.js}; Path=/; Max-Age=3600`
        ]);
        const recreated = await docGet();
        expect(
            "a deleted-then-recreated key materializes again (valueRev not reused)",
            recreated.setCookieLines.some(l =>
                l.startsWith(`${loginType}=${V.js};`)
            ),
            recreated.setCookieLines.join(" | ")
        );

        // HttpOnly flip -> disqualification -> revoke.
        const flip = NAMES.flipCred;
        await apiSet("/flip-on", [`${flip}=${V.a}; Path=/; Max-Age=3600`]);
        await docGet();
        const flipKey = `${mod.getCompositeCookieKey(
            flip,
            SHARED_HOSTS.h5access,
            true,
            "/"
        )}#${DOC_HOSTS.pc}`;
        expect(
            "the flip candidate is materialized first",
            pc.materializedCopies.has(flipKey)
        );
        await apiSet("/flip-httponly", [
            `${flip}=${V.a}; HttpOnly; Path=/; Max-Age=3600`
        ]);
        const flipped = await docGet();
        expect(
            "an HttpOnly flip revokes the page copy",
            flipped.setCookieLines.includes(`${flip}=; Max-Age=0; Path=/`),
            flipped.setCookieLines.join(" | ")
        );
        expect(
            "the ledger record is removed after the flip revoke",
            !pc.materializedCopies.has(flipKey)
        );

        // Same (name, path) from two sources: only the RFC 6265 §5.4 first wins.
        const conflict = NAMES.conflictCred;
        await apiSet("/conflict-host", [
            `${conflict}=${V.a}; Path=/; Max-Age=3600`
        ]);
        await sleep(2);
        const conflictDoc = await sim.request({
            url: `https://${DOC_HOSTS.pc}/conflict`,
            type: "main_frame",
            backend: () => ({
                setCookies: [
                    `${conflict}=${V.b}; Path=/; Domain=.yangshipin.cn; Max-Age=3600`
                ]
            })
        });
        const conflictLines = materializedCopyLines(
            conflictDoc.setCookieLines
        ).filter(l => l.startsWith(`${conflict}=`));
        expect(
            "a (name, path) conflict emits exactly one final copy row",
            conflictLines.length === 1,
            conflictDoc.setCookieLines.join(" | ")
        );
        expect(
            "the first entry in RFC 6265 §5.4 order wins",
            conflictLines[0]?.startsWith(`${conflict}=${V.a};`),
            conflictLines.join(" | ")
        );

        // Stale ledger record + new winner for the same copy key: only the
        // final copy is emitted (no separate delete row).
        const swap = NAMES.swapCred;
        await apiSet("/swap-a", [`${swap}=${V.a}; Path=/; Max-Age=3600`]);
        await docGet();
        await apiSet("/swap-b", [
            `${swap}=; Max-Age=0; Path=/`,
            `${swap}=${V.b}; Path=/; Domain=.yangshipin.cn; Max-Age=3600`
        ]);
        const swapped = await docGet();
        const swapLines = materializedCopyLines(swapped.setCookieLines).filter(
            l => l.startsWith(`${swap}=`)
        );
        expect(
            "a copy key with a new winner emits exactly one final copy row",
            swapLines.length === 1 &&
                swapLines[0].startsWith(`${swap}=${V.b};`),
            swapped.setCookieLines.join(" | ")
        );
        expect(
            "no separate delete row is emitted for the stale ledger record",
            !swapped.setCookieLines.includes(`${swap}=; Max-Age=0; Path=/`),
            swapped.setCookieLines.join(" | ")
        );

        // Commit boundary: an exception during the ledger commit must not
        // commit the ledger (same boundary as the demotion tasks).
        const ledgerCred = NAMES.ledgerCred;
        await apiSet("/ledger", [`${ledgerCred}=${V.a}; Path=/; Max-Age=3600`]);
        const ledgerKey = `${mod.getCompositeCookieKey(
            ledgerCred,
            SHARED_HOSTS.h5access,
            true,
            "/"
        )}#${DOC_HOSTS.pc}`;
        const realLedger = pc.materializedCopies;
        const faulty = new Map(realLedger);
        faulty.set = () => {
            throw new Error("simulated materialization commit failure");
        };
        pc.materializedCopies = faulty;
        const errorsBefore = mod.getYangshipinDiagnostics().errors;
        const failedCommit = await docGet();
        pc.materializedCopies = realLedger;
        expect(
            "a commit exception fails the response closed",
            !hasSetCookie(failedCommit.responseHeaders),
            failedCommit.setCookieLines.join(" | ")
        );
        expect("the ledger was not committed", !realLedger.has(ledgerKey));
        expect(
            "the exception is counted",
            mod.getYangshipinDiagnostics().errors > errorsBefore
        );

        // ------------------------------------------------------------------
        // §11.3 page-copy revocation guard (review fix).  A page copy can
        // outlive its source entry (session clear, server deletion); until the
        // owed revocation response removes it, the stale raw cookie must not be
        // re-admitted as a wider-scoped client entry.
        // ------------------------------------------------------------------
        const staleName = NAMES.copyStale;
        const clearWorld = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const clearSim = clearWorld.sim;
        const clearPc = clearWorld.mod.pcPartition;
        await clearSim.request({
            url: `https://${SHARED_HOSTS.h5access}/copy-login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${staleName}=${V.a}; Path=/; Max-Age=3600`]
            })
        });
        const copyDoc = await clearSim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "the credential is materialized onto the document host first",
            copyDoc.setCookieLines.some(l =>
                l.startsWith(`${staleName}=${V.a};`)
            ),
            copyDoc.setCookieLines.join(" | ")
        );
        const staleLedgerKey = `${clearWorld.mod.getCompositeCookieKey(
            staleName,
            SHARED_HOSTS.h5access,
            true,
            "/"
        )}#${DOC_HOSTS.pc}`;
        expect(
            "the ledger records the page copy",
            clearPc.materializedCopies.has(staleLedgerKey)
        );
        clearWorld.mod.clearYangshipinSession();
        expect(
            "the session clear keeps the ledger (a revocation is still owed)",
            clearPc.materializedCopies.has(staleLedgerKey) &&
                clearPc.entries.size === 0,
            `${clearPc.materializedCopies.size} ledger records / ${clearPc.entries.size} entries`
        );
        const suppressedBefore =
            clearWorld.mod.getYangshipinDiagnostics().pendingCopySuppressed;
        const staleRequest = await clearSim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "the stale page copy is not re-admitted as a client entry",
            entriesNamed(clearPc, staleName).length === 0 &&
                !clearPc.entries.has(
                    clearWorld.mod.getClientDomainKey(staleName)
                ),
            JSON.stringify(entriesNamed(clearPc, staleName))
        );
        expect(
            "the stale value is not re-sent outbound",
            !staleRequest.outboundCookie.includes(staleName),
            staleRequest.outboundCookie
        );
        expect(
            "the pending-copy suppression is counted exactly once",
            clearWorld.mod.getYangshipinDiagnostics().pendingCopySuppressed ===
                suppressedBefore + 1,
            String(
                clearWorld.mod.getYangshipinDiagnostics().pendingCopySuppressed
            )
        );
        expect(
            "the response carries the ledger revocation on the recorded path",
            staleRequest.setCookieLines.includes(
                `${staleName}=; Max-Age=0; Path=/`
            ),
            staleRequest.setCookieLines.join(" | ")
        );
        expect(
            "the ledger record is dropped, releasing the suppression",
            !clearPc.materializedCopies.has(staleLedgerKey)
        );
        clearWorld.jar.pageWrite(
            `${staleName}=${V.fresh}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const readmitted = await clearSim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "a new page write is admitted once the revocation is done",
            clearPc.entries.get(clearWorld.mod.getClientDomainKey(staleName))
                ?.value === V.fresh &&
                readmitted.outboundCookie.includes(`${staleName}=${V.fresh}`),
            readmitted.outboundCookie
        );

        // The same guard after a plain server deletion (not a session clear):
        // the tombstone lives on the API host and cannot match the document
        // host, so only the revocation guard can stop the re-admission.
        const deletedName = NAMES.copyDeleted;
        const deleteWorld = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const deleteSim = deleteWorld.sim;
        const deletePc = deleteWorld.mod.pcPartition;
        await deleteSim.request({
            url: `https://${SHARED_HOSTS.h5access}/copy-del-login`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${deletedName}=${V.a}; Path=/; Max-Age=3600`]
            })
        });
        await deleteSim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        const deletedLedgerKey = `${deleteWorld.mod.getCompositeCookieKey(
            deletedName,
            SHARED_HOSTS.h5access,
            true,
            "/"
        )}#${DOC_HOSTS.pc}`;
        expect(
            "the deletion case materialized a page copy as well",
            deletePc.materializedCopies.has(deletedLedgerKey)
        );
        await deleteSim.request({
            url: `https://${SHARED_HOSTS.h5access}/copy-del-server`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${deletedName}=; Max-Age=0; Path=/`]
            })
        });
        const deletedEntryKey = deleteWorld.mod.getCompositeCookieKey(
            deletedName,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        expect(
            "the server entry is gone and only an API-host tombstone remains",
            entriesNamed(deletePc, deletedName).length === 0 &&
                deletePc.tombstones.has(deletedEntryKey),
            JSON.stringify(deletePc.tombstones.get(deletedEntryKey))
        );
        const deletedSuppressedBefore =
            deleteWorld.mod.getYangshipinDiagnostics().pendingCopySuppressed;
        const deletedRequest = await deleteSim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "the stale page copy is not re-admitted after a server deletion either",
            entriesNamed(deletePc, deletedName).length === 0 &&
                !deletedRequest.outboundCookie.includes(deletedName),
            deletedRequest.outboundCookie
        );
        expect(
            "the revocation guard (not the API-host tombstone) suppressed it",
            deleteWorld.mod.getYangshipinDiagnostics().pendingCopySuppressed ===
                deletedSuppressedBefore + 1,
            String(
                deleteWorld.mod.getYangshipinDiagnostics().pendingCopySuppressed
            )
        );
        expect(
            "the deletion case also revokes the page copy and drops the ledger",
            deletedRequest.setCookieLines.includes(
                `${deletedName}=; Max-Age=0; Path=/`
            ) && !deletePc.materializedCopies.has(deletedLedgerKey),
            deletedRequest.setCookieLines.join(" | ")
        );
    }
]);

ASSERTION_RUNNERS.push([
    "24",
    "出向头体积、单值上限与 LRU 淘汰 (header budget, oversize, true LRU)",
    async expect => {
        const budgetWorld = await freshGroup({});
        const bpc = budgetWorld.mod.pcPartition;
        const mk = (name, value, source, httpOnly) =>
            serverEntry({
                name,
                value,
                source,
                httpOnly,
                host: DOC_HOSTS.pc,
                isHostOnly: true,
                path: "/",
                expires: null
            });
        bpc.set(mk(NAMES.budgetClient, "c".repeat(1000), "client", false));
        bpc.set(mk(NAMES.budgetOpen, "o".repeat(5000), "server", false));
        bpc.set(mk(NAMES.budgetHttp, "h".repeat(3500), "server", true));
        const budgetBefore =
            budgetWorld.mod.getYangshipinDiagnostics().headerOverflowEvictions;
        const handle = await budgetWorld.sim.begin({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "xmlhttprequest",
            tabId: 1
        });
        const out = handle.outboundCookie;
        expect(
            "client entries are evicted first",
            !out.includes(NAMES.budgetClient),
            `len=${utf8Length(out)}`
        );
        expect(
            "non-HttpOnly server entries are evicted next",
            !out.includes(NAMES.budgetOpen)
        );
        expect(
            "HttpOnly server credentials are evicted last",
            out.includes(NAMES.budgetHttp)
        );
        expect(
            "the Cookie header stays within MAX_COOKIE_HEADER_BYTES (8192)",
            utf8Length(out) <= 8192,
            String(utf8Length(out))
        );
        expect(
            "exactly two entries were evicted and counted",
            budgetWorld.mod.getYangshipinDiagnostics().headerOverflowEvictions -
                budgetBefore ===
                2,
            String(
                budgetWorld.mod.getYangshipinDiagnostics()
                    .headerOverflowEvictions - budgetBefore
            )
        );

        const clientOnly = await freshGroup({});
        clientOnly.mod.pcPartition.set(
            mk(NAMES.budgetClient, "c".repeat(9000), "client", false)
        );
        const clientBefore =
            clientOnly.mod.getYangshipinDiagnostics().headerOverflowEvictions;
        const clientHandle = await clientOnly.sim.begin({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "xmlhttprequest",
            tabId: 1
        });
        expect(
            "a lone oversized client entry is dropped and counted",
            clientHandle.outboundCookie === "" &&
                clientOnly.mod.getYangshipinDiagnostics()
                    .headerOverflowEvictions -
                    clientBefore ===
                    1,
            `${clientHandle.outboundCookie} / ${clientBefore}`
        );

        const oversizeWorld = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const huge = "z".repeat(4200);
        const opc = oversizeWorld.mod.pcPartition;
        const beforeOversize =
            oversizeWorld.mod.getYangshipinDiagnostics().oversizeValues;
        const inboundKey = oversizeWorld.mod.getCompositeCookieKey(
            NAMES.freshCred,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        await oversizeWorld.sim.request({
            url: `https://${SHARED_HOSTS.h5access}/huge`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${NAMES.freshCred}=${huge}; Path=/; Max-Age=3600`]
            })
        });
        expect(
            "an oversized inbound value is dropped and counted",
            !opc.entries.has(inboundKey) &&
                oversizeWorld.mod.getYangshipinDiagnostics().oversizeValues >
                    beforeOversize,
            JSON.stringify(opc.entries.get(inboundKey))
        );
        await oversizeWorld.sim.request({
            url: `https://${SHARED_HOSTS.h5access}/huge-raw`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            rawCookie: `${NAMES.adoptLater}=${huge}`
        });
        expect(
            "an oversized raw-header value is not adopted and is counted",
            !opc.entries.has(
                oversizeWorld.mod.getClientDomainKey(NAMES.adoptLater)
            )
        );

        // ------------------------------------------------------------------
        // §11.3 entry-cap eviction is genuine LRU, not creation order.
        // ------------------------------------------------------------------
        const lruWorld = await freshGroup({});
        const lpc = lruWorld.mod.pcPartition;
        const lruName = index => `${NAMES.lruPrefix}${index}`;
        const lruKey = name =>
            lruWorld.mod.getCompositeCookieKey(name, DOC_HOSTS.pc, true, "/");
        for (let i = 0; i < 200; i++) {
            lpc.set(
                serverEntry({
                    name: lruName(i),
                    value: V.a,
                    host: DOC_HOSTS.pc,
                    isHostOnly: true,
                    path: "/",
                    expires: null
                })
            );
            await sleep(1);
        }
        expect(
            "the partition is filled exactly to the 200-entry cap",
            lpc.entries.size === 200,
            String(lpc.entries.size)
        );
        await sleep(2);
        lpc.markUsed(lruKey(lruName(0)));
        const lruEvictionsBefore =
            lruWorld.mod.getYangshipinDiagnostics().sizeEvictions;
        lpc.set(
            serverEntry({
                name: lruName(200),
                value: V.a,
                host: DOC_HOSTS.pc,
                isHostOnly: true,
                path: "/",
                expires: null
            })
        );
        expect(
            "the recently used (oldest) entry survives the overflow",
            lpc.entries.has(lruKey(lruName(0))) && lpc.entries.size === 200,
            `${lpc.entries.size} entries`
        );
        expect(
            "the least recently used entry is evicted instead",
            !lpc.entries.has(lruKey(lruName(1))),
            `lru1 present: ${lpc.entries.has(lruKey(lruName(1)))}`
        );
        expect(
            "the size eviction is counted",
            lruWorld.mod.getYangshipinDiagnostics().sizeEvictions ===
                lruEvictionsBefore + 1,
            String(lruWorld.mod.getYangshipinDiagnostics().sizeEvictions)
        );

        // The outbound path refreshes recency too: the touched entry is the
        // only one whose scope matches the request, so only it is marked used.
        const touchWorld = await freshGroup({});
        const tpc = touchWorld.mod.pcPartition;
        const touchName = `${NAMES.lruPrefix}-touched`;
        tpc.set(
            serverEntry({
                name: touchName,
                value: V.a,
                host: DOC_HOSTS.pc,
                isHostOnly: true,
                path: "/deep",
                expires: null
            })
        );
        for (let i = 0; i < 199; i++) {
            tpc.set(
                serverEntry({
                    name: `${NAMES.lruPrefix}-other${i}`,
                    value: V.a,
                    host: DOC_HOSTS.pc,
                    isHostOnly: true,
                    path: "/other",
                    expires: null
                })
            );
        }
        expect(
            "200 entries, only one of which matches the request path",
            tpc.entries.size === 200 &&
                tpc.entries.get(
                    touchWorld.mod.getCompositeCookieKey(
                        touchName,
                        DOC_HOSTS.pc,
                        true,
                        "/deep"
                    )
                ) !== undefined
        );
        await sleep(2);
        await touchWorld.sim.request({
            url: `https://${DOC_HOSTS.pc}/deep/x`,
            type: "xmlhttprequest"
        });
        await sleep(2);
        tpc.set(
            serverEntry({
                name: `${NAMES.lruPrefix}-extra`,
                value: V.a,
                host: DOC_HOSTS.pc,
                isHostOnly: true,
                path: "/other",
                expires: null
            })
        );
        expect(
            "an entry sent outbound is marked used and survives the overflow",
            tpc.entries.has(
                touchWorld.mod.getCompositeCookieKey(
                    touchName,
                    DOC_HOSTS.pc,
                    true,
                    "/deep"
                )
            ),
            String(tpc.entries.size)
        );
    }
]);

ASSERTION_RUNNERS.push([
    "25",
    "基线按主机 (per-host baseline: pass through, adopt nothing)",
    async expect => {
        const world = await freshGroup({});
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const host = SHARED_HOSTS.h5access;
        const hostOnly = NAMES.hostResidue;
        const domain = NAMES.domainResidue;
        jar.setCookie(`${hostOnly}=${V.a}; Path=/`, host);
        jar.setCookie(`${domain}=${V.b}; Path=/; Domain=.yangshipin.cn`, host);
        const first = await sim.request({
            url: `https://${host}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "the first request passes the residue through untouched",
            first.outboundCookie.includes(`${hostOnly}=${V.a}`) &&
                first.outboundCookie.includes(`${domain}=${V.b}`),
            first.outboundCookie
        );
        expect(
            "nothing is adopted into the partition",
            pc.entries.size === 0,
            JSON.stringify(Array.from(pc.entries.keys()))
        );
        for (const name of [hostOnly, domain]) {
            expect(
                `${name}: host-only Max-Age=0 row`,
                first.setCookieLines.includes(`${name}=; Max-Age=0; Path=/`),
                first.setCookieLines.join(" | ")
            );
            expect(
                `${name}: Domain=.yangshipin.cn Max-Age=0 row`,
                first.setCookieLines.includes(
                    `${name}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
                ),
                first.setCookieLines.join(" | ")
            );
        }
        expect(
            "the host is recorded after the response",
            pc.baselineCleanedHosts.has(host)
        );
        expect(
            "the per-host clean is counted once",
            mod.getYangshipinDiagnostics().hostBaselineCleans === 1
        );
        expect(
            "it is independent of the (already completed) global baseline marker",
            mod.isYangshipinBaselinePending() === false
        );
        expect(
            "the jar residue is physically gone",
            jar.count(hostOnly) === 0 && jar.count(domain) === 0,
            JSON.stringify(jar.find(hostOnly).concat(jar.find(domain)))
        );
        jar.pageWrite(
            `${NAMES.adoptLater}=${V.c}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const second = await sim.request({
            url: `https://${host}/api2`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "a second request on the same host is not cleaned again",
            !second.setCookieLines.includes(
                `${NAMES.adoptLater}=; Max-Age=0; Path=/`
            ),
            second.setCookieLines.join(" | ")
        );
        expect(
            "the standard flow adopts the (now live) residue",
            pc.entries.has(mod.getClientDomainKey(NAMES.adoptLater))
        );

        // Failure boundary: a failed first request must not record the host.
        const host2 = SHARED_HOSTS.ucenter;
        const retryName = NAMES.retryResidue;
        jar.setCookie(`${retryName}=${V.a}; Path=/`, host2);
        const attempt = await sim.begin({
            url: `https://${host2}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "the first attempt still passes the residue through",
            attempt.outboundCookie.includes(retryName),
            attempt.outboundCookie
        );
        sim.fail(attempt);
        expect(
            "a failed first request does not record the host",
            !pc.baselineCleanedHosts.has(host2)
        );
        const retried = await sim.request({
            url: `https://${host2}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "the next request retries the per-host clean and records the host",
            retried.setCookieLines.includes(
                `${retryName}=; Max-Age=0; Path=/`
            ) && pc.baselineCleanedHosts.has(host2),
            retried.setCookieLines.join(" | ")
        );

        // Concurrent window: requests issued before the first response are all
        // "pass through, adopt nothing" and all carry the delete headers.
        const host3 = SHARED_HOSTS.liveinfo;
        const windowName = NAMES.windowResidue;
        jar.setCookie(`${windowName}=${V.a}; Path=/`, host3);
        const one = await sim.begin({
            url: `https://${host3}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        const two = await sim.begin({
            url: `https://${host3}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "both in-window requests pass through and adopt nothing",
            one.outboundCookie.includes(windowName) &&
                two.outboundCookie.includes(windowName) &&
                !pc.entries.has(mod.getClientDomainKey(windowName)),
            `${one.outboundCookie} / ${two.outboundCookie}`
        );
        const twoDone = await sim.finish(two, {});
        expect(
            "an in-window response carries the double delete too",
            twoDone.setCookieLines.includes(
                `${windowName}=; Max-Age=0; Path=/`
            ) &&
                twoDone.setCookieLines.includes(
                    `${windowName}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
                ),
            twoDone.setCookieLines.join(" | ")
        );
        const oneDone = await sim.finish(one, {});
        expect(
            "the in-flight sibling still receives the idempotent delete rows",
            oneDone.setCookieLines.includes(`${windowName}=; Max-Age=0; Path=/`)
        );
        expect(
            "each newly cleaned host is counted exactly once (h5access, ucenter, liveinfo)",
            mod.getYangshipinDiagnostics().hostBaselineCleans === 3,
            String(mod.getYangshipinDiagnostics().hostBaselineCleans)
        );

        // A credential issued in the same response is unaffected by the delete
        // rows and never reaches the jar.
        const host4 = "api-fresh.yangshipin.cn";
        const leftover = NAMES.baselineThree;
        const fresh = NAMES.freshCred;
        jar.setCookie(`${leftover}=${V.a}; Path=/`, host4);
        const freshRes = await sim.request({
            url: `https://${host4}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [`${fresh}=${V.b}; HttpOnly; Path=/; Max-Age=3600`]
            })
        });
        expect(
            "a credential issued in the same response is registered in the partition",
            entriesNamed(pc, fresh).length === 1 &&
                entriesNamed(pc, fresh)[0].source === "server"
        );
        expect(
            "the issued credential never reaches the jar",
            jar.count(fresh) === 0
        );
        expect(
            "only the carried residue gets the delete rows",
            freshRes.setCookieLines.includes(
                `${leftover}=; Max-Age=0; Path=/`
            ) &&
                !freshRes.setCookieLines.some(
                    l => l.startsWith(`${fresh}=`) && l.includes("Max-Age=0")
                ),
            freshRes.setCookieLines.join(" | ")
        );

        // Regression from a real trace (2026-10-12): Zero-Jar left the jar
        // empty on the shared API hosts, so "let the residue through" must not
        // also suppress this partition's own candidates — the first call of an
        // uncleaned host has to carry them, otherwise the site's request
        // legality check fails (observed on the trace: ucenter-api
        // //v1/user/userinfo -> 10011 请求不合法).  Isolated group: the
        // parent-domain entry used here must not leak into the checks above.
        {
            const injectWorld = await freshGroup({});
            const injectSim = injectWorld.sim;
            const injectJar = injectWorld.jar;
            const injectMod = injectWorld.mod;
            const injectPc = injectMod.pcPartition;
            const injectHost = SHARED_HOSTS.liveinfo;
            const injectOwned = NAMES.nseq;
            const injectCarried = NAMES.legacyOne;
            injectPc.set(
                serverEntry({
                    name: injectOwned,
                    value: V.server,
                    host: DOC_HOSTS.pc,
                    domain: ".yangshipin.cn",
                    isHostOnly: false,
                    path: "/",
                    expires: null
                })
            );
            injectJar.setCookie(`${injectOwned}=${V.old}; Path=/`, injectHost);
            injectJar.setCookie(
                `${injectCarried}=${V.old}; Path=/`,
                injectHost
            );
            const injected = await injectSim.request({
                url: `https://${injectHost}/api`,
                documentUrl: `https://${DOC_HOSTS.pc}/`
            });
            expect(
                "an uncleaned host still receives this partition's candidates",
                injected.outboundCookie.includes(`${injectOwned}=${V.server}`),
                injected.outboundCookie
            );
            expect(
                "the partition value shadows the same-name jar residue",
                !injected.outboundCookie.includes(`${injectOwned}=${V.old}`),
                injected.outboundCookie
            );
            expect(
                "a residue name the partition does not carry is still let through",
                injected.outboundCookie.includes(`${injectCarried}=${V.old}`),
                injected.outboundCookie
            );
            expect(
                "neither residue is adopted while the host is uncleaned",
                !injectPc.entries.has(
                    injectMod.getClientDomainKey(injectCarried)
                ) &&
                    injectPc.entries.get(
                        injectMod.getCompositeCookieKey(
                            injectOwned,
                            "yangshipin.cn",
                            false,
                            "/"
                        )
                    )?.source === "server",
                JSON.stringify(Array.from(injectPc.entries.keys()))
            );
            expect(
                "the carried residue is deleted and the host recorded",
                injected.setCookieLines.includes(
                    `${injectCarried}=; Max-Age=0; Path=/`
                ) && injectPc.baselineCleanedHosts.has(injectHost),
                injected.setCookieLines.join(" | ")
            );

            // §12.2 放行 must not bypass a decision this partition already
            // made for a name: a tombstoned value and a name that is
            // server-authoritative elsewhere (host-only on another host, so
            // it legitimately does not scope-match this request) must not be
            // re-sent just because the host is uncleaned.
            // A *still uncleaned* host is required: on a cleaned host the
            // admission step (not the residue append) would decide.
            const hardHost = SHARED_HOSTS.ucenter;
            const deadName = NAMES.deadCred;
            const managedName = NAMES.pcOnly;
            injectPc.tombstone(deadName, hardHost, true, "/", V.old);
            injectPc.set(
                serverEntry({
                    name: managedName,
                    value: V.server,
                    host: SHARED_HOSTS.h5access,
                    isHostOnly: true,
                    path: "/",
                    expires: null
                })
            );
            injectJar.setCookie(`${deadName}=${V.old}; Path=/`, hardHost);
            injectJar.setCookie(`${managedName}=${V.old}; Path=/`, hardHost);
            const hardened = await injectSim.request({
                url: `https://${hardHost}/api2`,
                documentUrl: `https://${DOC_HOSTS.pc}/`
            });
            expect(
                "a tombstoned residue value is not let through",
                !hardened.outboundCookie.includes(deadName),
                hardened.outboundCookie
            );
            expect(
                "a name that is server-managed elsewhere is not let through",
                !hardened.outboundCookie.includes(managedName),
                hardened.outboundCookie
            );
            // The pending-copy-revocation guard is kept here as defence in
            // depth; ledger records only ever exist for document hosts, which
            // never take the per-host branch, so it cannot fire on this path.
        }
    }
]);

ASSERTION_RUNNERS.push([
    "26",
    "基线失败边界 (failure retry, 3xx completion, parallel tabs)",
    async expect => {
        const world = createWorld();
        const { sim, jar, mod } = world;
        mod.clearYangshipinPartitions();
        await settleWrites(world);
        expect(
            "the reset arms the global baseline again",
            mod.isYangshipinBaselinePending() === true
        );
        jar.setCookie(
            `${NAMES.baselineOne}=${V.a}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const cancelled = await sim.begin({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "the baseline navigation empties the outbound header",
            cancelled.outboundCookie === ""
        );
        sim.fail(cancelled);
        expect(
            "a cancelled baseline navigation keeps the marker pending",
            mod.isYangshipinBaselinePending() === true
        );
        expect(
            "the storage marker is not written to true",
            world.storage.getLocalState("fxcast_ysp_baseline_clean_done") !==
                true
        );
        const retried = await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "the next document navigation retries the baseline",
            retried.outboundCookie === "" &&
                retried.setCookieLines.includes(
                    `${NAMES.baselineOne}=; Max-Age=0; Path=/`
                ),
            retried.setCookieLines.join(" | ")
        );
        expect(
            "the retry flips the marker",
            mod.isYangshipinBaselinePending() === false
        );

        // A redirect chain completes on the first response, including 3xx.
        mod.clearYangshipinPartitions();
        await settleWrites(world);
        jar.clear();
        jar.setCookie(
            `${NAMES.baselineTwo}=${V.a}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const redirect = await sim.begin({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        const redirectDone = await sim.finish(redirect, {
            backend: () => ({
                statusCode: 302,
                headers: [
                    { name: "Location", value: `https://${DOC_HOSTS.pc}/next` }
                ]
            })
        });
        expect(
            "the first response (3xx) completes the baseline",
            mod.isYangshipinBaselinePending() === false &&
                redirectDone.setCookieLines.includes(
                    `${NAMES.baselineTwo}=; Max-Age=0; Path=/`
                ),
            redirectDone.setCookieLines.join(" | ")
        );

        // Parallel tabs: both are emptied, the marker is committed once.
        mod.clearYangshipinPartitions();
        await settleWrites(world);
        jar.clear();
        jar.setCookie(
            `${NAMES.baselineThree}=${V.a}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        const tabA = await sim.begin({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            tabId: 21
        });
        const tabB = await sim.begin({
            url: MOBILE_DOC_URL,
            type: "main_frame",
            tabId: 22
        });
        expect(
            "both parallel baseline navigations are emptied",
            tabA.outboundCookie === "" && tabB.outboundCookie === ""
        );
        const baselineBefore = mod.getYangshipinDiagnostics().baselineCleans;
        const doneA = await sim.finish(tabA, {});
        const doneB = await sim.finish(tabB, {});
        expect(
            "both responses carry the idempotent cleaning headers",
            doneA.setCookieLines.includes(
                `${NAMES.baselineThree}=; Max-Age=0; Path=/`
            ) &&
                doneB.setCookieLines.includes(
                    `${NAMES.baselineThree}=; Max-Age=0; Path=/`
                ),
            `${doneA.setCookieLines.join(" | ")} // ${doneB.setCookieLines.join(
                " | "
            )}`
        );
        expect(
            "the baseline completion is counted exactly once",
            mod.getYangshipinDiagnostics().baselineCleans ===
                baselineBefore + 1,
            String(mod.getYangshipinDiagnostics().baselineCleans)
        );
    }
]);

ASSERTION_RUNNERS.push([
    "27",
    "性能与扫描计数 (no per-item linear scans, p99 budget)",
    async expect => {
        const world = await freshGroup({});
        const { mod } = world;
        const pc = mod.pcPartition;
        const iter = { count: 0 };
        class CountingMap extends Map {
            values() {
                iter.count++;
                return super.values();
            }
            keys() {
                iter.count++;
                return super.keys();
            }
            entries() {
                iter.count++;
                return super.entries();
            }
            forEach(callback, thisArg) {
                iter.count++;
                return super.forEach(callback, thisArg);
            }
            [Symbol.iterator]() {
                iter.count++;
                return super[Symbol.iterator]();
            }
        }
        const originalEntries = pc.entries;
        pc.entries = new CountingMap(originalEntries);
        const total = 200;
        for (let i = 0; i < total; i++) {
            pc.set(
                serverEntry({
                    name: `${NAMES.perfPrefix}${i}`,
                    value: `${V.a}${i}`,
                    host: DOC_HOSTS.pc,
                    isHostOnly: true,
                    path: "/",
                    expires: null
                })
            );
        }
        expect(
            "200 entries populated",
            pc.entries.size === 200,
            String(pc.entries.size)
        );
        const scansPerRequest = [];
        const runOutbound = i =>
            mod.handleYangshipinBeforeSendHeaders({
                requestId: `perf-scan-${i}`,
                url: `https://${DOC_HOSTS.pc}/scan/${i}`,
                type: "xmlhttprequest",
                tabId: 1,
                documentUrl: `https://${DOC_HOSTS.pc}/`,
                requestHeaders: [{ name: "Cookie", value: "" }]
            });
        for (let i = 0; i < 50; i++) {
            const before = iter.count;
            await runOutbound(i);
            scansPerRequest.push(iter.count - before);
        }
        expect(
            "the outbound path partitions entries exactly twice per request (sweepExpired + candidate collection)",
            scansPerRequest.every(n => n === 2),
            JSON.stringify(Array.from(new Set(scansPerRequest)))
        );
        const beforePerItem = iter.count;
        const emptySnapshot = mod.pcPartition.createTombstoneSnapshot();
        for (let i = 0; i < 2000; i++) {
            pc.hasServerManagedName(`absent-name-${i}`);
            pc.hasMatchingTombstone(
                emptySnapshot,
                `absent-name-${i}`,
                DOC_HOSTS.pc,
                "/",
                "value"
            );
        }
        expect(
            "per-item queries (hasServerManagedName / hasMatchingTombstone) never linearly scan entries",
            iter.count === beforePerItem,
            `${iter.count - beforePerItem} iterations`
        );

        const timings = [];
        const timingLoops = 1000;
        for (let i = 0; i < timingLoops; i++) {
            const start = process.hrtime.bigint();
            await runOutbound(i);
            timings.push(Number(process.hrtime.bigint() - start) / 1e6);
        }
        timings.sort((a, b) => a - b);
        const percentile = p =>
            timings[
                Math.min(timings.length - 1, Math.floor(timings.length * p))
            ];
        const p50 = percentile(0.5);
        const p99 = percentile(0.99);
        // Printed unconditionally so the measured number is visible on green
        // runs too (§14.2 budget evidence).
        console.log(
            `       [27] entries=${pc.entries.size} loops=${timingLoops} ` +
                `p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms ` +
                `max=${timings[timings.length - 1].toFixed(3)}ms ` +
                `scans/request=${JSON.stringify(
                    Array.from(new Set(scansPerRequest))
                )}`
        );
        expect(
            "p99 outbound handling stays inside the §14.2 budget (2 ms) with 200 entries",
            p99 < 2,
            `p99=${p99.toFixed(3)}ms p50=${p50.toFixed(
                3
            )}ms loops=${timingLoops}`
        );
        pc.entries = originalEntries;
    }
]);

ASSERTION_RUNNERS.push([
    "28",
    "夹具与环境卫生 (fixture hygiene, hermetic resolution)",
    async expect => {
        const source = fs.readFileSync(__filename, "utf8");
        const markers = [
            ["uinfo_vuid", /\buinfo_vuid\b/],
            ["vusession", /\bvusession\b/i],
            ["vuserid", /\bvuserid\b/i],
            ["openid", /\bopenid\b/i],
            ["accesstoken", /\baccesstoken\b/i],
            ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\./],
            ["AWS key", /\bAKIA[0-9A-Z]{12,}\b/],
            ["GitHub token", /\bghp_[A-Za-z0-9]{20,}\b/],
            ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
            ["bearer token", /Bearer\s+[A-Za-z0-9._-]{10,}/]
        ];
        const hits = [];
        for (const value of FIXTURES) {
            for (const [label, pattern] of markers) {
                if (pattern.test(value)) hits.push(`${label}: ${value}`);
            }
        }
        expect(
            "no fixture matches a real-credential marker",
            hits.length === 0,
            hits.join("; ")
        );
        const entropy = [];
        for (const value of FIXTURES) {
            for (const token of String(value).split(/[\s;,=]+/)) {
                if (token.length < 24) continue;
                if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) continue;
                if (new Set(token).size < 8) continue;
                entropy.push(token);
            }
        }
        expect(
            "no fixture carries a high-entropy token",
            entropy.length === 0,
            entropy.join(", ")
        );
        expect(
            "every fixture value is obviously synthetic",
            FIXTURES.every(v => /^[a-z0-9-]+$/i.test(v)),
            FIXTURES.filter(v => !/^[a-z0-9-]+$/i.test(v)).join(", ")
        );
        expect(
            "expiry fixtures are generated relative to Date.now() and land in the future",
            expiresIn(60 * 1000) > Date.now() &&
                expiresIn(3600 * 1000) > Date.now()
        );
        expect(
            "no 13-digit epoch-millisecond literal is frozen into the harness",
            !/\b\d{13}\b/.test(source)
        );
        expect(
            "esbuild is located through require.resolve with explicit search paths",
            source.includes("require.resolve(esbuildRequest, {") &&
                esbuildAvailable
        );
        const forbidden = [
            ["developer absolute path", ["/", "Users/"].join("")],
            ["temp directory absolute path", ["/", "tmp/"].join("")],
            ["hardcoded esbuild path", ["node_modules", "/esbuild"].join("")],
            ["network archive reference", [".", "har"].join("")],
            ["conditional-skip guard", ["fs", ".", "existsSync("].join("")]
        ];
        for (const [label, needle] of forbidden) {
            expect(
                `harness source contains no ${label}`,
                !source.includes(needle),
                needle
            );
        }
    }
]);

ASSERTION_RUNNERS.push([
    "29",
    "降级任务分区级排空 (partition-level demotion drain)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const one = NAMES.drainOne;
        const two = NAMES.drainTwo;
        jar.pageWrite(`${one}=${V.a}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        const apiResponse = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "an API-host response moves the task into the partition-level set",
            pc.pendingDemoteNames.has(one),
            JSON.stringify(Array.from(pc.pendingDemoteNames))
        );
        expect(
            "the request-level record is reclaimed",
            !mod.requestIdPlatformMap.has(apiResponse.requestId)
        );
        jar.pageWrite(`${two}=${V.b}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        const cancelled = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/api2`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        sim.fail(cancelled);
        expect(
            "a cancelled request transfers its task before cleanup",
            pc.pendingDemoteNames.has(two),
            JSON.stringify(Array.from(pc.pendingDemoteNames))
        );
        expect(
            "the cancelled request's binding is reclaimed",
            !mod.requestIdPlatformMap.has(cancelled.requestId)
        );

        jar.pageWrite(`${one}=${V.c}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api3`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        const drain = await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        for (const name of [one, two]) {
            expect(
                `${name}: drained with a parent-domain purge row`,
                drain.setCookieLines.includes(
                    `${name}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
                ),
                drain.setCookieLines.join(" | ")
            );
        }
        expect(
            "the rebuild reads the response-time partition value (one = latest)",
            drain.setCookieLines.includes(
                `${one}=${V.c}; Path=/; SameSite=Lax; Secure`
            ),
            drain.setCookieLines.join(" | ")
        );
        expect(
            "the rebuild reads the response-time partition value (two = original)",
            drain.setCookieLines.includes(
                `${two}=${V.b}; Path=/; SameSite=Lax; Secure`
            ),
            drain.setCookieLines.join(" | ")
        );
        expect(
            "processed names are committed only on the success path",
            !pc.pendingDemoteNames.has(one) && !pc.pendingDemoteNames.has(two)
        );

        const serverName = NAMES.drainServer;
        jar.pageWrite(
            `${serverName}=${V.a}; Domain=.yangshipin.cn`,
            DOC_HOSTS.pc
        );
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api4`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "a plain client name is queued at partition level",
            pc.pendingDemoteNames.has(serverName)
        );
        await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api5`,
            documentUrl: `https://${DOC_HOSTS.pc}/`,
            backend: () => ({
                setCookies: [
                    `${serverName}=${V.server}; HttpOnly; Path=/; Max-Age=3600`
                ]
            })
        });
        const purgeOnly = await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "a name taken over by the server is drained purge-only",
            purgeOnly.setCookieLines.includes(
                `${serverName}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
            ),
            purgeOnly.setCookieLines.join(" | ")
        );
        expect(
            "purge-only never rebuilds a client copy",
            !purgeOnly.setCookieLines.some(l =>
                l.startsWith(`${serverName}=${V.a};`)
            ),
            purgeOnly.setCookieLines.join(" | ")
        );

        // A name queued while the drain is committing must survive: the commit
        // removes only the names it processed, never the whole set.
        const late = NAMES.drainLate;
        const drainedName = NAMES.drainTwo;
        const realPending = pc.pendingDemoteNames;
        pc.pendingDemoteNames.add(drainedName);
        const patched = new Set(pc.pendingDemoteNames);
        let injected = false;
        patched.delete = function (name) {
            if (!injected) {
                injected = true;
                Set.prototype.add.call(this, late);
            }
            return Set.prototype.delete.call(this, name);
        };
        pc.pendingDemoteNames = patched;
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        pc.pendingDemoteNames = realPending;
        expect(
            "removal is per-name: a task added during the commit window survives",
            patched.has(late),
            JSON.stringify(Array.from(patched))
        );
        expect(
            "the processed name itself was removed",
            !patched.has(drainedName),
            JSON.stringify(Array.from(patched))
        );
    }
]);

ASSERTION_RUNNERS.push([
    "30",
    "顶层主机表事件边界 (context precondition, never an initiator substitute)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access, platform: "mobile" }]
        });
        const { sim, mod } = world;
        const tab = 42;
        const mark = NAMES.mobileMark;
        // The credential lives in the *pc* partition: whether it is injected
        // proves which input decided the platform.
        mod.pcPartition.set(
            serverEntry({
                name: mark,
                value: V.a,
                host: SHARED_HOSTS.h5access,
                isHostOnly: true,
                path: "/",
                expires: null
            })
        );
        sim.fireNavStart({
            tabId: tab,
            url: `https://${DOC_HOSTS.mobileW}/video`,
            requestId: sim.nextRequestId()
        });
        expect(
            "navigation start writes the provisional top host",
            mod.tabTopHostByTabId.get(tab) === DOC_HOSTS.mobileW,
            String(mod.tabTopHostByTabId.get(tab))
        );
        const unknownBefore = mod.getYangshipinDiagnostics().unknownPlatform;
        const early = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            type: "xmlhttprequest",
            tabId: tab,
            documentUrl: `https://${DOC_HOSTS.pc}/video`,
            rawCookie: `${mark}=${V.a}`
        });
        expect(
            "a subresource on that tab with a pc initiator is classified pc (not by the top-level host)",
            mod.classifyYangshipinPlatform({
                url: `https://${SHARED_HOSTS.h5access}/api`,
                type: "xmlhttprequest",
                tabId: tab,
                documentUrl: `https://${DOC_HOSTS.pc}/video`
            }) === "pc",
            mod.classifyYangshipinPlatform({
                url: `https://${SHARED_HOSTS.h5access}/api`,
                type: "xmlhttprequest",
                tabId: tab,
                documentUrl: `https://${DOC_HOSTS.pc}/video`
            })
        );
        expect(
            "and its Cookie header is injected, not stripped",
            early.outboundCookie.includes(`${mark}=${V.a}`),
            early.outboundCookie
        );
        expect(
            "the fail-closed unknown path is not taken",
            mod.getYangshipinDiagnostics().unknownPlatform === unknownBefore,
            `${unknownBefore} -> ${
                mod.getYangshipinDiagnostics().unknownPlatform
            }`
        );

        // A committed document-host page on the same tab: the simulator now
        // derives the initiator from the tab's page (the production rule needs
        // an initiator even though the context is established).
        const committed = await sim.request({
            url: `https://${DOC_HOSTS.pc}/video`,
            type: "main_frame",
            tabId: tab
        });
        expect(
            "the 2xx document commit confirms the top-level host",
            mod.tabTopHostByTabId.get(tab) === DOC_HOSTS.pc,
            String(mod.tabTopHostByTabId.get(tab))
        );
        const derived = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            type: "xmlhttprequest",
            tabId: tab,
            rawCookie: `${mark}=${V.a}`
        });
        expect(
            "a request without an explicit initiator derives it from the tab page and is injected",
            derived.outboundCookie.includes(`${mark}=${V.a}`),
            derived.outboundCookie
        );
        expect(
            "the committed document response materializes the pc credential for the page",
            committed.setCookieLines.some(l => l.startsWith(`${mark}=${V.a};`)),
            committed.setCookieLines.join(" | ")
        );

        // Established doc-host context but no initiator at all: the context is
        // a precondition, never an initiator substitute -> unknown, stripped.
        const noInitiatorBefore =
            mod.getYangshipinDiagnostics().unknownPlatform;
        const noInitiator = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            type: "xmlhttprequest",
            tabId: tab,
            rawCookie: `${mark}=${V.a}`,
            noInitiator: true
        });
        expect(
            "a doc-host context without an initiator is unknown and stripped",
            noInitiator.outboundCookie === "" &&
                mod.getYangshipinDiagnostics().unknownPlatform ===
                    noInitiatorBefore + 1,
            `${noInitiator.outboundCookie} / ${noInitiatorBefore} -> ${
                mod.getYangshipinDiagnostics().unknownPlatform
            }`
        );

        sim.fireNavStart({
            tabId: 43,
            url: `https://${DOC_HOSTS.pc}/a`,
            requestId: "hop-30"
        });
        sim.fireNavStart({
            tabId: 43,
            url: `https://${DOC_HOSTS.mobileW}/b`,
            requestId: "hop-30"
        });
        expect(
            "each redirect hop overwrites the provisional host",
            mod.tabTopHostByTabId.get(43) === DOC_HOSTS.mobileW
        );
        sim.fireCommitConfirm({
            tabId: 43,
            url: `https://${DOC_HOSTS.mobileM}/final`,
            statusCode: 302,
            requestId: "hop-30"
        });
        expect(
            "a 3xx response does not confirm the host",
            mod.tabTopHostByTabId.get(43) === DOC_HOSTS.mobileW
        );
        sim.fireCommitConfirm({
            tabId: 43,
            url: `https://${DOC_HOSTS.mobileM}/final`,
            statusCode: 200,
            requestId: "hop-30"
        });
        expect(
            "a 2xx response confirms the committed host",
            mod.tabTopHostByTabId.get(43) === DOC_HOSTS.mobileM,
            String(mod.tabTopHostByTabId.get(43))
        );

        sim.fireNavStart({
            tabId: 44,
            url: `https://${DOC_HOSTS.pc}/failing`,
            requestId: "fail-30"
        });
        sim.fireError({
            tabId: 44,
            url: `https://${DOC_HOSTS.pc}/failing`,
            type: "main_frame",
            requestId: "fail-30"
        });
        expect(
            "a failed navigation drops the table entry",
            !mod.tabTopHostByTabId.has(44)
        );
        const missingContextBefore =
            mod.getYangshipinDiagnostics().unknownPlatform;
        const unknown = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            type: "xmlhttprequest",
            tabId: 44,
            documentUrl: `https://${DOC_HOSTS.pc}/failing`,
            rawCookie: `${mark}=${V.a}`
        });
        expect(
            "with the context gone the initiator alone is not enough: unknown and stripped",
            unknown.outboundCookie === "" &&
                mod.getYangshipinDiagnostics().unknownPlatform ===
                    missingContextBefore + 1,
            `${unknown.outboundCookie} / ${missingContextBefore} -> ${
                mod.getYangshipinDiagnostics().unknownPlatform
            }`
        );
        const bare = await sim.begin({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            type: "xmlhttprequest",
            tabId: 44,
            rawCookie: `${mark}=${V.a}`,
            noInitiator: true
        });
        expect(
            "no context and no initiator also fails closed",
            bare.outboundCookie === "",
            bare.outboundCookie
        );

        sim.fireNavStart({
            tabId: 45,
            url: `https://${DOC_HOSTS.mobileW}/x`,
            requestId: "tab-45"
        });
        expect("tab 45 has a context", mod.tabTopHostByTabId.has(45));
        sim.fireTabRemoved(45);
        expect(
            "closing the tab drops the table entry",
            !mod.tabTopHostByTabId.has(45)
        );
    }
]);
ASSERTION_RUNNERS.push([
    "31",
    "同请求新旧值墓碑快照 (immutable snapshot adjudication)",
    async expect => {
        for (const mode of ["host", "domain"]) {
            for (const order of ["new-old", "old-new"]) {
                const label = `${mode}/${order}`;
                const world = await freshGroup({
                    apiHosts: [{ host: SHARED_HOSTS.h5access }]
                });
                const { sim, mod } = world;
                const pc = mod.pcPartition;
                const name = `${NAMES.snapshot}-${mode}-${order}`;
                const hostOnly = mode === "host";
                const scope = hostOnly
                    ? SHARED_HOSTS.h5access
                    : "yangshipin.cn";
                pc.tombstone(name, scope, hostOnly, "/", V.old);
                const tombstoneKey = mod.getCompositeCookieKey(
                    name,
                    scope,
                    hostOnly,
                    "/"
                );
                const raw =
                    order === "new-old"
                        ? `${name}=${V.fresh}; ${name}=${V.old}`
                        : `${name}=${V.old}; ${name}=${V.fresh}`;
                const response = await sim.request({
                    url: `https://${SHARED_HOSTS.h5access}/snapshot`,
                    documentUrl: `https://${DOC_HOSTS.pc}/`,
                    rawCookie: raw
                });
                expect(
                    `${label}: the new value is adopted as a new key`,
                    pc.entries.get(mod.getClientDomainKey(name))?.value ===
                        V.fresh
                );
                expect(
                    `${label}: the outbound header carries the new value`,
                    response.outboundCookie.includes(`${name}=${V.fresh}`),
                    response.outboundCookie
                );
                expect(
                    `${label}: the old value is not re-emitted`,
                    !response.outboundCookie.includes(`${name}=${V.old}`),
                    response.outboundCookie
                );
                expect(
                    `${label}: the tombstone is cleared afterwards`,
                    !pc.tombstones.has(tombstoneKey)
                );
                const drain = await sim.request({
                    url: `https://${DOC_HOSTS.pc}/`,
                    type: "main_frame"
                });
                expect(
                    `${label}: the old value joins the demotion list`,
                    drain.setCookieLines.includes(
                        `${name}=; Max-Age=0; Path=/; Domain=.yangshipin.cn`
                    ),
                    drain.setCookieLines.join(" | ")
                );
                expect(
                    `${label}: the rebuild uses the live value`,
                    drain.setCookieLines.some(l =>
                        l.startsWith(`${name}=${V.fresh};`)
                    ),
                    drain.setCookieLines.join(" | ")
                );
            }
        }
    }
]);

ASSERTION_RUNNERS.push([
    "32",
    "过期剔除顺序 (sweepExpired before adjudication and materialization)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.h5access }]
        });
        const { sim, jar, mod } = world;
        const pc = mod.pcPartition;
        const name = NAMES.expiredServer;
        const serverKey = mod.getCompositeCookieKey(
            name,
            SHARED_HOSTS.h5access,
            true,
            "/"
        );
        pc.set(
            serverEntry({
                name,
                value: V.old,
                host: SHARED_HOSTS.h5access,
                isHostOnly: true,
                path: "/",
                httpOnly: true,
                expires: Date.now() - 1000
            })
        );
        pc.set(
            serverEntry({
                name,
                value: V.fresh,
                host: "yangshipin.cn",
                domain: ".yangshipin.cn",
                isHostOnly: false,
                path: "/",
                httpOnly: false,
                expires: null,
                source: "client"
            })
        );
        expect(
            "the expired server entry and the client entry coexist",
            pc.entries.size === 2,
            String(pc.entries.size)
        );
        // The request deliberately carries no raw `name` cookie: this isolates
        // the sweep (which tombstones the expired entry with its last value)
        // from the raw-header admission, which would clear that very tombstone
        // as a "differently fingerprinted new write" (§11.5).
        const response = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/api`,
            documentUrl: `https://${DOC_HOSTS.pc}/`
        });
        expect(
            "the expired server entry is swept before adjudication",
            !pc.entries.has(serverKey),
            JSON.stringify(Array.from(pc.entries.keys()))
        );
        expect(
            "the sweep tombstones it with its last value",
            pc.tombstones.get(serverKey)?.valueFingerprint ===
                mod.fingerprint(V.old),
            JSON.stringify(pc.tombstones.get(serverKey))
        );
        expect(
            "the expired entry no longer blocks client admission",
            pc.entries.get(mod.getClientDomainKey(name))?.value === V.fresh,
            JSON.stringify(pc.entries.get(mod.getClientDomainKey(name)))
        );
        expect(
            "the outbound header carries only the live client value",
            response.outboundCookie.includes(`${name}=${V.fresh}`) &&
                !response.outboundCookie.includes(V.old),
            response.outboundCookie
        );
        expect(
            "the name index has no stale residue",
            pc.hasServerManagedName(name) === false
        );

        const material = NAMES.expiredMaterial;
        pc.set(
            serverEntry({
                name: material,
                value: V.a,
                host: SHARED_HOSTS.h5access,
                isHostOnly: true,
                path: "/",
                httpOnly: false,
                expires: Date.now() - 1000
            })
        );
        const doc = await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame"
        });
        expect(
            "an expired entry never reaches the materialization output",
            !doc.setCookieLines.some(l => l.startsWith(`${material}=`)),
            doc.setCookieLines.join(" | ")
        );
    }
]);

ASSERTION_RUNNERS.push([
    "33",
    "写入顺序契约 (serial writes, stateRev, clearSession through the queue)",
    async expect => {
        // §11.4: the background page must flush pending writes before unload.
        domUnloadListeners.length = 0;
        const world = createWorld();
        const { mod, storage } = world;
        const pc = mod.pcPartition;
        mod.clearYangshipinPartitions();
        await settleWrites(world);
        const entry = name =>
            serverEntry({
                name,
                value: V.a,
                host: DOC_HOSTS.pc,
                isHostOnly: true,
                path: "/",
                expires: expiresIn(60000)
            });
        expect(
            "the background page registers an unload flush hook",
            domUnloadListeners.length >= 1,
            String(domUnloadListeners.length)
        );
        const beforeFlush = storage.stats.setAttempts.length;
        pc.set(entry(NAMES.writeOne));
        expect(
            "an ordinary in-memory change schedules no immediate write",
            storage.stats.setAttempts.length === beforeFlush
        );
        for (const listener of domUnloadListeners.slice()) listener();
        await pc.waitForWrites();
        expect(
            "the unload hook flushes the pending partition state",
            storage.stats.setAttempts.length > beforeFlush &&
                storage.stats.setAttempts.some(
                    record =>
                        record.fxcast_ysp_partition_pc &&
                        Object.keys(record.fxcast_ysp_partition_pc.entries)
                            .length > 0
                ),
            String(storage.stats.setAttempts.length - beforeFlush)
        );
        storage.stats.maxConcurrentSets = 0;
        storage.stats.setAttempts.length = 0;
        storage.setBehavior(() => "gate");
        const drainGates = async () => {
            for (let i = 0; i < 30; i++) {
                storage.releaseGate();
                await sleep(1);
            }
            await sleep(5);
        };

        pc.set(entry(NAMES.writeOne));
        pc.persistNow();
        await sleep(3);
        expect(
            "the first write is gated and in flight",
            storage.pendingGates() === 1,
            String(storage.pendingGates())
        );
        pc.set(entry(NAMES.writeTwo));
        pc.persistNow();
        await sleep(3);
        expect(
            "a second change during a write does not start a concurrent write",
            storage.stats.maxConcurrentSets === 1,
            String(storage.stats.maxConcurrentSets)
        );
        expect(
            "the new change keeps the partition dirty",
            pc.hasPendingWrites() === true
        );
        storage.releaseGate();
        await sleep(5);
        expect(
            "the newer snapshot is queued behind the in-flight one",
            storage.stats.setAttempts.length >= 2,
            String(storage.stats.setAttempts.length)
        );
        const revs = storage.stats.setAttempts
            .map(record => record.fxcast_ysp_partition_pc?.stateRev)
            .filter(value => typeof value === "number");
        expect(
            "snapshots are written in strictly increasing stateRev order",
            revs.every(
                (value, index) => index === 0 || value > revs[index - 1]
            ),
            JSON.stringify(revs)
        );
        expect(
            "an older snapshot never overwrites the newest one",
            revs[revs.length - 1] === pc.stateRev,
            `${revs[revs.length - 1]} vs ${pc.stateRev}`
        );
        await drainGates();
        await pc.waitForWrites();
        expect(
            "dirty is cleared only once the confirmed rev covers the change",
            pc.hasPendingWrites() === false
        );

        const attemptsBefore = storage.stats.setAttempts.length;
        pc.set(entry(NAMES.writeThree));
        pc.persistNow();
        await sleep(3);
        pc.clearSession();
        await sleep(3);
        expect(
            "clearSession does not bypass the serial write queue",
            storage.stats.maxConcurrentSets === 1,
            String(storage.stats.maxConcurrentSets)
        );
        await drainGates();
        await pc.waitForWrites();
        await drainGates();
        expect(
            "clearSession commits through the same write entry",
            storage.stats.setAttempts.length > attemptsBefore,
            `${storage.stats.setAttempts.length} vs ${attemptsBefore}`
        );
        expect("the partition is empty in memory", pc.entries.size === 0);
        expect(
            "dirty is cleared after the clear-session write settles",
            pc.hasPendingWrites() === false
        );
        const last =
            storage.stats.setAttempts[storage.stats.setAttempts.length - 1];
        expect(
            "the final payload reflects the cleared session",
            Object.keys(last.fxcast_ysp_partition_pc.entries).length === 0,
            JSON.stringify(Object.keys(last.fxcast_ysp_partition_pc.entries))
        );
    }
]);

ASSERTION_RUNNERS.push([
    "34",
    "根目录跳板只限顶层直连导航 (the shell is a narrow top-level exception, never an initiator verdict, §9.2)",
    async expect => {
        const world = await freshGroup({
            apiHosts: [{ host: SHARED_HOSTS.ucenter }]
        });
        const { sim, mod, jar } = world;
        const tab = 51;
        const live = NAMES.liveParam;
        const sheet = url =>
            mod.classifyYangshipinPlatform(
                Object.assign({ type: "main_frame", tabId: tab }, url)
            );
        // The tab is on the mobile H5 page (the §9.3 context precondition).
        mod.tabTopHostByTabId.set(tab, DOC_HOSTS.mobileW);

        // ------------------------------------------------------------------
        // 1. The regression that broke the mobile sign-in (HAR 2026-10-13
        //    18:38): the browser trims cross-origin referrers to their origin,
        //    so every mobile login/API call carries `Referer:
        //    https://w.yangshipin.cn/` — textually the shell URL.  No initiator
        //    URL may ever produce a trampoline verdict.
        // ------------------------------------------------------------------
        expect(
            "an api call from the mobile page with the origin-trimmed referer is mobile",
            mod.classifyYangshipinPlatform({
                url: `https://${SHARED_HOSTS.h5access}/web/auth_login?vappid=1`,
                type: "xmlhttprequest",
                tabId: tab,
                documentUrl: MOBILE_DOC_URL,
                requestHeaders: [
                    { name: "Referer", value: TRAMPOLINE_URL },
                    { name: "Origin", value: `https://${DOC_HOSTS.mobileW}` }
                ]
            }) === "mobile",
            mod.classifyYangshipinPlatform({
                url: `https://${SHARED_HOSTS.h5access}/web/auth_login?vappid=1`,
                type: "xmlhttprequest",
                tabId: tab,
                documentUrl: MOBILE_DOC_URL,
                requestHeaders: [{ name: "Referer", value: TRAMPOLINE_URL }]
            })
        );
        expect(
            "a trimmed referer alone is enough context to stay mobile",
            sheet({
                url: `https://${SHARED_HOSTS.h5access}/web/simple_user_info`,
                type: "xmlhttprequest",
                documentUrl: undefined,
                requestHeaders: [{ name: "Referer", value: TRAMPOLINE_URL }]
            }) === "mobile" ||
                mod.classifyYangshipinPlatform({
                    url: `https://${SHARED_HOSTS.h5access}/web/simple_user_info`,
                    type: "xmlhttprequest",
                    tabId: tab,
                    documentUrl: MOBILE_DOC_URL,
                    requestHeaders: [{ name: "Referer", value: TRAMPOLINE_URL }]
                }) === "mobile"
        );
        expect(
            "an in-app navigation to the shell path is an ordinary mobile document",
            sheet({ url: TRAMPOLINE_URL, documentUrl: MOBILE_DOC_URL }) ===
                "mobile",
            sheet({ url: TRAMPOLINE_URL, documentUrl: MOBILE_DOC_URL })
        );
        expect(
            "a non-navigation request to the shell path is not a trampoline either",
            mod.classifyYangshipinPlatform({
                url: TRAMPOLINE_URL,
                type: "xmlhttprequest",
                tabId: tab,
                documentUrl: MOBILE_DOC_URL
            }) === "mobile"
        );

        // Full cycle: the mobile login response must land in the *mobile*
        // partition (Zero-Jar) and be re-sent by the very next mobile call.
        const loginName = NAMES.mobileCred;
        sim.fireNavStart({
            tabId: tab,
            url: MOBILE_DOC_URL,
            requestId: sim.nextRequestId()
        });
        const login = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/web/auth_login?vappid=1`,
            method: "POST",
            type: "xmlhttprequest",
            tabId: tab,
            documentUrl: MOBILE_DOC_URL,
            referer: TRAMPOLINE_URL,
            backend: () => ({
                setCookies: [`${loginName}=${V.a}; HttpOnly; Path=/`]
            })
        });
        expect(
            "the mobile sign-in credential is registered in the mobile partition",
            entriesNamed(mod.mobilePartition, loginName).length === 1 &&
                entriesNamed(mod.pcPartition, loginName).length === 0,
            JSON.stringify(entriesNamed(mod.mobilePartition, loginName))
        );
        expect(
            "and it never reaches the jar (Zero-Jar on the shared host)",
            jar.count(loginName) === 0 && !hasSetCookie(login.responseHeaders)
        );
        const afterLogin = await sim.request({
            url: `https://${SHARED_HOSTS.h5access}/web/simple_user_info`,
            type: "xmlhttprequest",
            tabId: tab,
            documentUrl: MOBILE_DOC_URL,
            referer: TRAMPOLINE_URL
        });
        expect(
            "the next mobile call is re-populated with it",
            afterLogin.outboundCookie.includes(`${loginName}=${V.a}`),
            afterLogin.outboundCookie
        );

        // An in-app navigation to the shell path is an ordinary mobile document
        // for its *response* too: the outbound verdict must win over the URL,
        // otherwise its Set-Cookie is stranded.
        const inAppShell = await sim.request({
            url: TRAMPOLINE_URL,
            type: "main_frame",
            tabId: tab,
            documentUrl: MOBILE_DOC_URL,
            backend: () => ({
                setCookies: [
                    `${NAMES.trampolineDomain}=${V.c}; Path=/; Max-Age=3600`
                ]
            })
        });
        expect(
            "an in-app shell-path navigation keeps its own document response (the binding wins)",
            entriesNamed(mod.mobilePartition, NAMES.trampolineDomain).length ===
                1 && hasSetCookie(inAppShell.responseHeaders),
            `${JSON.stringify(
                entriesNamed(mod.mobilePartition, NAMES.trampolineDomain)
            )} / ${inAppShell.setCookieLines.join(" | ")}`
        );
        mod.mobilePartition.entries.delete(
            mod.getCompositeCookieKey(
                NAMES.trampolineDomain,
                DOC_HOSTS.mobileW,
                true,
                "/"
            )
        );
        mod.mobilePartition.entries.delete(
            mod.getCompositeCookieKey(
                NAMES.trampolineDomain,
                "yangshipin.cn",
                false,
                "/"
            )
        );

        // ------------------------------------------------------------------
        // 2. The shell itself: a top-level navigation with **no initiator**
        //    (typed URL / bookmark) is the case the exception exists for; a
        //    navigation started by the PC site is not an in-app one either.
        // ------------------------------------------------------------------
        expect(
            "the typed shell navigation is classified trampoline",
            sheet({ url: TRAMPOLINE_URL }) === "trampoline",
            sheet({ url: TRAMPOLINE_URL })
        );
        expect(
            "a pc-initiated shell navigation is trampoline, not a mobile document",
            sheet({
                url: TRAMPOLINE_URL,
                documentUrl: `https://${DOC_HOSTS.pc}/`
            }) === "trampoline",
            sheet({
                url: TRAMPOLINE_URL,
                documentUrl: `https://${DOC_HOSTS.pc}/`
            })
        );
        expect(
            "the shell predicate is host-aware but never host-only",
            mod.isYangshipinDocHost(DOC_HOSTS.mobileW) === true &&
                mod.isYangshipinTrampoline(DOC_HOSTS.mobileW) === false &&
                mod.isYangshipinTrampoline(DOC_HOSTS.mobileW, "/") === true &&
                mod.isYangshipinTrampolineUrl(TRAMPOLINE_URL) === true &&
                mod.isYangshipinTrampolineUrl(MOBILE_DOC_URL) === false &&
                mod.isYangshipinTrampolineUrl(`https://${DOC_HOSTS.pc}/`) ===
                    false
        );
        expect(
            "only a main_frame navigation qualifies",
            mod.isYangshipinTrampolineNavigation({
                type: "xmlhttprequest",
                url: TRAMPOLINE_URL
            }) === false &&
                mod.isYangshipinTrampolineNavigation({
                    type: "sub_frame",
                    url: TRAMPOLINE_URL
                }) === false &&
                mod.isYangshipinTrampolineNavigation({
                    type: "main_frame",
                    url: TRAMPOLINE_URL
                }) === true &&
                mod.isYangshipinTrampolineNavigation({
                    type: "main_frame",
                    url: TRAMPOLINE_URL,
                    documentUrl: MOBILE_DOC_URL
                }) === false
        );

        // The tab currently shows the PC site, with a live parent-domain
        // parameter in the jar for the shell to (not) destroy.
        sim.fireNavStart({
            tabId: tab,
            url: `https://${DOC_HOSTS.pc}/`,
            requestId: sim.nextRequestId()
        });
        mod.tabTopHostByTabId.set(tab, DOC_HOSTS.pc);
        jar.pageWrite(`${live}=${V.a}; Domain=.yangshipin.cn`, DOC_HOSTS.pc);

        const before = {
            pcEntries: mod.pcPartition.entries.size,
            mobileEntries: mod.mobilePartition.entries.size,
            pcDemotes: mod.pcPartition.pendingDemoteNames.size,
            mobileDemotes: mod.mobilePartition.pendingDemoteNames.size,
            pcLedger: mod.pcPartition.materializedCopies.size,
            mobileLedger: mod.mobilePartition.materializedCopies.size,
            pcCleans: mod.pcPartition.baselineCleanedHosts.size,
            mobileCleans: mod.mobilePartition.baselineCleanedHosts.size,
            trampoline: mod.getYangshipinDiagnostics().trampoline,
            unknown: mod.getYangshipinDiagnostics().unknownPlatform
        };

        const shellHandle = await sim.begin({
            url: TRAMPOLINE_URL,
            type: "main_frame",
            tabId: tab
        });
        expect(
            "the shell request carries no credential at all",
            shellHandle.outboundCookie === "",
            shellHandle.outboundCookie
        );
        expect(
            "the shell navigation invalidates the stale top-level context before its response",
            !mod.tabTopHostByTabId.has(tab),
            String(mod.tabTopHostByTabId.get(tab))
        );
        expect(
            "it is bound as its own class, not as unknown",
            mod.requestIdPlatformMap.get(shellHandle.requestId)?.platform ===
                "trampoline",
            String(
                mod.requestIdPlatformMap.get(shellHandle.requestId)?.platform
            )
        );
        const shell = await sim.finish(shellHandle, {
            backend: () => ({
                statusCode: 200,
                headers: [{ name: "Content-Type", value: "text/html" }],
                setCookies: [
                    `${NAMES.trampolineHostOnly}=${V.b}; Path=/`,
                    `${NAMES.trampolineDomain}=${V.c}; Domain=.yangshipin.cn; Path=/`
                ]
            })
        });
        expect(
            "every Set-Cookie of the shell response is stripped",
            !hasSetCookie(shell.responseHeaders) &&
                shell.setCookieLines.length === 0,
            shell.setCookieLines.join(" | ")
        );
        expect(
            "the shell response issues no delete of any kind",
            !shell.setCookieLines.some(
                line => line.includes("Domain=") || line.includes("Max-Age=0")
            ),
            shell.setCookieLines.join(" | ")
        );
        expect(
            "the parent-domain live parameter is still in the jar",
            jar.byScope(live, "yangshipin.cn").length === 1,
            JSON.stringify(jar.find(live))
        );
        expect(
            "no partition entry, demotion task, ledger row or clean marker changed",
            mod.pcPartition.entries.size === before.pcEntries &&
                mod.mobilePartition.entries.size === before.mobileEntries &&
                mod.pcPartition.pendingDemoteNames.size === before.pcDemotes &&
                mod.mobilePartition.pendingDemoteNames.size ===
                    before.mobileDemotes &&
                mod.pcPartition.materializedCopies.size === before.pcLedger &&
                mod.mobilePartition.materializedCopies.size ===
                    before.mobileLedger &&
                mod.pcPartition.baselineCleanedHosts.size === before.pcCleans &&
                mod.mobilePartition.baselineCleanedHosts.size ===
                    before.mobileCleans,
            `${mod.pcPartition.entries.size}/${mod.mobilePartition.entries.size} entries`
        );
        expect(
            "the shell is never booked as a per-host-cleaned api host",
            !mod.pcPartition.baselineCleanedHosts.has(DOC_HOSTS.mobileW) &&
                !mod.mobilePartition.baselineCleanedHosts.has(DOC_HOSTS.mobileW)
        );
        expect(
            "the shell verdict is counted as trampoline, never as unknown",
            mod.getYangshipinDiagnostics().trampoline ===
                before.trampoline + 1 &&
                mod.getYangshipinDiagnostics().unknownPlatform ===
                    before.unknown
        );
        expect(
            "the shell leaves no top-level context behind",
            !mod.tabTopHostByTabId.has(tab),
            String(mod.tabTopHostByTabId.get(tab))
        );

        // ------------------------------------------------------------------
        // 3. With no binding at all (extension reloaded between the two
        //    halves) a `main_frame` shell response is still refused — while an
        //    unbound *mobile document* response still takes the normal path,
        //    so the URL rule is not over-broad.
        // ------------------------------------------------------------------
        const unboundShell = await mod.handleYangshipinHeadersReceived({
            requestId: "unbound-shell-34",
            url: TRAMPOLINE_URL,
            type: "main_frame",
            tabId: 52,
            statusCode: 200,
            responseHeaders: [
                {
                    name: "Set-Cookie",
                    value: `${NAMES.trampolineHostOnly}=${V.b}; Path=/`
                }
            ]
        });
        expect(
            "an unbound main_frame shell response is refused by its URL alone",
            !hasSetCookie(unboundShell.responseHeaders || []) &&
                entriesNamed(mod.mobilePartition, NAMES.trampolineHostOnly)
                    .length === 0,
            JSON.stringify(unboundShell)
        );
        const unboundDoc = await mod.handleYangshipinHeadersReceived({
            requestId: "unbound-doc-34",
            url: MOBILE_DOC_URL,
            type: "main_frame",
            tabId: 52,
            statusCode: 200,
            responseHeaders: [
                {
                    name: "Set-Cookie",
                    value: `${NAMES.mobileMark}=${V.b}; Path=/; Max-Age=3600`
                }
            ]
        });
        expect(
            "an unbound mobile document response is still processed as mobile",
            entriesNamed(mod.mobilePartition, NAMES.mobileMark).length === 1 &&
                hasSetCookie(unboundDoc.responseHeaders || []),
            JSON.stringify(unboundDoc)
        );

        // ------------------------------------------------------------------
        // 4. A new request lifecycle after the shell: the meta refresh lands
        //    on the PC site, the context is rebuilt there, and the jar's live
        //    parameter reaches the pc partition instead of dying in the shell.
        // ------------------------------------------------------------------
        await sim.request({
            url: `https://${DOC_HOSTS.pc}/`,
            type: "main_frame",
            tabId: tab
        });
        expect(
            "the redirect target establishes the pc context",
            mod.tabTopHostByTabId.get(tab) === DOC_HOSTS.pc,
            String(mod.tabTopHostByTabId.get(tab))
        );
        const api = await sim.request({
            url: `https://${SHARED_HOSTS.ucenter}/v1/user/userinfo`,
            type: "xmlhttprequest",
            method: "POST",
            tabId: tab
        });
        expect(
            "the pc page's first api call still carries the parent-domain live parameter",
            api.outboundCookie.includes(`${live}=${V.a}`),
            api.outboundCookie
        );
        expect(
            "the pc partition adopted it as its own client entry",
            mod.pcPartition.entries.get(mod.getClientDomainKey(live))?.value ===
                V.a && entriesNamed(mod.mobilePartition, live).length === 0,
            JSON.stringify(
                mod.pcPartition.entries.get(mod.getClientDomainKey(live))
            )
        );
        expect(
            "the parent-domain demotion is performed by the pc document, not by the shell",
            jar.byScope(live, "yangshipin.cn").length === 0 &&
                jar.count(live) === 1,
            JSON.stringify(jar.find(live))
        );
    }
]);

// ============================================================================
// 10. main
// ============================================================================

function printGroupSummary() {
    console.log("\nAssertion group summary:");
    for (const [groupId, label] of ASSERTION_GROUPS) {
        const checks = checkIdsByGroup.get(groupId) || [];
        const failed = checks.filter(c => !c.ok).map(c => c.id);
        const okCount = checks.length - failed.length;
        console.log(
            `  ${groupId.padEnd(16)} ${okCount}/${checks.length} ok  ${label}${
                failed.length > 0 ? `  FAILED: ${failed.join(", ")}` : ""
            }`
        );
    }
}

async function main() {
    installDomStubs();
    await bundleProductionModule();
    const savedConsole = {
        info: console.info,
        warn: console.warn,
        error: console.error
    };
    let suppressed = 0;
    console.info = () => {
        suppressed++;
    };
    console.warn = () => {
        suppressed++;
    };
    console.error = () => {
        suppressed++;
    };
    try {
        console.log("Yangshipin session-isolation harness (design v+10)");
        console.log(
            `esbuild resolved via require.resolve: ${path.relative(
                repoRoot,
                esbuildResolved
            )}`
        );
        console.log(
            `production module: ${path.relative(repoRoot, moduleSourcePath)}`
        );
        console.log("");
        for (const [id, title, body, note] of ASSERTION_RUNNERS) {
            if (typeof body === "function") await assertion(id, title, body);
            else report(id, title, [], note);
        }
        printGroupSummary();
        console.log(
            `\nchecks: ${passCount} passed, ${failCount} failed, ${placeholderCount} placeholder (assertion 14, withdrawn by D1)`
        );
        console.log(
            `fixtures registered: ${FIXTURES.length}; production log lines suppressed: ${suppressed}`
        );
        if (failCount > 0) {
            console.log("\nFailing assertions:");
            for (const line of failureLines) console.log(`  - ${line}`);
            process.exitCode = 1;
        }
    } finally {
        console.info = savedConsole.info;
        console.warn = savedConsole.warn;
        console.error = savedConsole.error;
        if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    }
}

void main().catch(err => {
    console.error("Harness infrastructure failed:", err);
    process.exit(1);
});
