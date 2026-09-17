#!/usr/bin/env node
"use strict";

/**
 * The page capture across an item transition, driven through the REAL capture
 * module with a webRequest seam.
 *
 * Why this exists. On the device, one part switch produced three overlapping
 * relay generations in one second, and every one of them failed the same way:
 * an init for BOTH kinds had been captured, but audio was never selected as an
 * input start, so the remux produced no stream, the readiness gate never
 * closed, the Roku never received a LOAD, and it kept polling the previous
 * playlist until it got a 404.
 *
 * The bytes were not missing because the page never fetched them. They were
 * missing because an SPA identity change (the URL catching up with the item
 * switch, ~100ms after the new representation committed) called
 * resetMediaGeneration and destroyed everything the capture had just validated:
 * the committed pair, its inits, and the candidate queues that held the NEW
 * item's already-fetched fragments. The page does not re-fetch ranges its MSE
 * already holds, and audio's few ranges had all been fetched before the
 * switch — so the successor relay received init for both kinds and not one
 * audio fragment. A 2.5 MB handoff replay could not fix that: replaying bytes
 * the capture had already dropped is not the same as not dropping them.
 *
 * This harness drives the production module through that exact sequence and
 * asserts what the successor relay is actually handed:
 *
 *   1. a committed video+audio pair resolves to a versioned snapshot;
 *   2. after a switch whose URL update arrives AFTER the commit, the new pair
 *      still resolves, its version changed, and — the decisive row — the audio
 *      fragment the page fetched BEFORE the URL update is POSTed to the new
 *      relay's endpoint;
 *   3. a half-committed switch (video moved, audio not yet) resolves to
 *      NOTHING, so no relay is built out of two different media objects;
 *   4. a pair belonging to another item is never handed out;
 *   5. the capture announces every kind of a switch, not only the first.
 *
 * Usage:
 *   node test/playback/pageCaptureTransition.js
 *   node test/playback/pageCaptureTransition.js --pre-fix            # control
 *   node test/playback/pageCaptureTransition.js --pre-fix --rev 30a2173
 *
 * `--pre-fix` bundles the SAME contract from another revision (a `git
 * worktree`) and requires rows 2 (bytes) and 5 (notification) to FAIL there:
 * without the control, a green row could mean the harness drives nothing.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const extensionSrc = path.join(repoRoot, "extension/src");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);
const {
    buildFmp4,
    playurlFor,
    renditionUrl,
    folderPathOf
} = require("../fixtures/syntheticDash");

const argv = process.argv.slice(2);
const PRE_FIX = argv.includes("--pre-fix");
/**
 * `--regress manifest-gate` rewrites the CURRENT source by putting the
 * "the newest manifest must declare the committed path" condition back into the
 * pair gate — the rule a real session falsified — and requires the manifest rows
 * to fail. Without it those rows could pass because the harness never feeds an
 * unrelated manifest.
 */
const REGRESS = argv.includes("--regress");
const VERBOSE = argv.includes("--verbose");
const revIndex = argv.indexOf("--rev");
const REV =
    revIndex >= 0 && argv[revIndex + 1] ? argv[revIndex + 1] : "30a2173";

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
    if (cond) {
        pass++;
        console.info("  ok   " + name);
    } else {
        fail++;
        failures.push(name);
        console.info(
            "  FAIL " + name + (detail === undefined ? "" : " :: " + detail)
        );
    }
};

/** A worktree of the revision under test, or the working tree. */
function resolveSourceRoot() {
    if (!PRE_FIX) return extensionSrc;
    const worktree = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cast-capture-rev-")
    );
    fs.rmSync(worktree, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--detach", worktree, REV], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "inherit"]
    });
    process.on("exit", () => {
        try {
            execFileSync("git", ["worktree", "remove", "--force", worktree], {
                cwd: repoRoot,
                stdio: "ignore"
            });
        } catch {
            // A leftover worktree must not change the test result.
        }
    });
    return path.join(worktree, "extension/src");
}

/**
 * The negative control's rewrite: put back "the newest manifest must declare the
 * committed path" inside the pair gate's per-kind lookup. A real session showed
 * that rule refuses a good pair as soon as ANY playurl response replaces the
 * manifest map — including the extension's own.
 */
function regressedSource(sourcePath) {
    const original = fs.readFileSync(sourcePath, "utf8");
    const anchor = `        if (expectedItem && itemFolderOf(found.path) !== expectedItem)
            return undefined;`;
    if (original.split(anchor).length - 1 !== 1) {
        throw new Error(
            "--regress manifest-gate could not find the pair gate's item check"
        );
    }
    const rewritten = original.replace(
        anchor,
        `${anchor}
        if (
            state.representations.size &&
            !state.representations.has(found.path)
        )
            return undefined;`
    );
    if (!rewritten.includes("!state.representations.has(found.path)")) {
        throw new Error(
            "--regress manifest-gate could not install the manifest condition"
        );
    }
    const target = path.join(
        path.dirname(sourcePath),
        "bilibiliPageCapture.regressControl.ts"
    );
    fs.writeFileSync(target, rewritten);
    process.on("exit", () => {
        try {
            fs.rmSync(target, { force: true });
        } catch {
            // A leftover file in the tree must not change the test result.
        }
    });
    return target;
}

async function buildCapture(sourceRoot) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-capture-"));
    const outfile = path.join(workDir, "capture.cjs");
    const sourcePath = path.join(
        sourceRoot,
        "background/bilibiliPageCapture.ts"
    );
    const esbuild = require(esbuildPath);
    await esbuild.build({
        entryPoints: [REGRESS ? regressedSource(sourcePath) : sourcePath],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        nodePaths: [path.join(repoRoot, "extension/node_modules")]
    });
    return { module: require(outfile), workDir };
}

// ---------------------------------------------------------------------------
// The page: a webRequest seam and the module's own driver surface
// ---------------------------------------------------------------------------

/**
 * A synthetic page. Everything the capture observes about the page goes through
 * the listeners the module registered itself (`webRequest.*`, `tabs.*`,
 * `runtime.onMessage`), so the module's file:line decisions — which request
 * creates a candidate, when a candidate commits, what survives an identity
 * change — are production code, not a re-implementation.
 */
function createPage() {
    const hooks = {
        beforeRequest: [],
        headersReceived: [],
        completed: [],
        errorOccurred: [],
        updated: [],
        removed: [],
        message: []
    };
    const filters = new Map();
    /** uploads the capture POSTed, as `${rid}:${kind}:${start}-${end}`. */
    const posts = [];
    /** messages the capture sent to the tab (the sender's notification path). */
    const notifications = [];
    let request = 0;

    /**
     * The module registers several beforeRequest listeners with DIFFERENT
     * filters (main-frame navigation, playurl, every media request). A seam that
     * called all of them would fire the main-frame navigation reset on every
     * media request and delete the tab's state — the test would then be
     * measuring the stub, not the capture. So the filters are honoured here.
     */
    const matches = (entry, details) => {
        const { types, urls } = entry.filter ?? {};
        if (types && !types.includes(details.type)) return false;
        if (!urls) return true;
        return urls.some(pattern =>
            urlPattern(pattern).test(details.url ?? "")
        );
    };
    const urlPattern = pattern => {
        if (pattern === "<all_urls>") return /^.*$/;
        const escaped = pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`);
    };

    global.browser = {
        webRequest: {
            filterResponseData: requestId => {
                const filter = {
                    ondata: undefined,
                    onstop: undefined,
                    onerror: undefined,
                    write: () => undefined,
                    close: () => undefined,
                    disconnect: () => undefined
                };
                filters.set(requestId, filter);
                return filter;
            },
            onBeforeRequest: {
                addListener: (fn, filter) =>
                    hooks.beforeRequest.push({ fn, filter })
            },
            onHeadersReceived: {
                addListener: (fn, filter) =>
                    hooks.headersReceived.push({ fn, filter })
            },
            onCompleted: {
                addListener: (fn, filter) =>
                    hooks.completed.push({ fn, filter })
            },
            onErrorOccurred: {
                addListener: (fn, filter) =>
                    hooks.errorOccurred.push({ fn, filter })
            }
        },
        tabs: {
            query: async () => [],
            onUpdated: { addListener: fn => hooks.updated.push(fn) },
            onRemoved: { addListener: fn => hooks.removed.push(fn) },
            sendMessage: async (tabId, message) => {
                notifications.push({ tabId, message });
            }
        },
        runtime: {
            onMessage: {
                addListener: fn => hooks.message.push(fn),
                removeListener: () => undefined
            }
        }
    };
    global.fetch = async (url, init) => {
        const parsed = new URL(url);
        posts.push({
            rid: parsed.searchParams.get("rid"),
            generation: Number(parsed.searchParams.get("gen")),
            kind: parsed.searchParams.get("kind"),
            start: Number(parsed.searchParams.get("start")),
            end: Number(parsed.searchParams.get("end")),
            bytes: init?.body?.byteLength ?? 0
        });
        return { ok: true, status: 204, statusText: "No Content" };
    };

    const toArrayBuffer = buffer =>
        buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength
        );

    /**
     * The page's playurl response for one item: what authorises a
     * representation to be committed (its SegmentBase indexRange) and what the
     * pair gate reads back as "the page's latest manifest".
     */
    function manifest(
        tabId,
        folder,
        { videoInitEnd, audioInitEnd, cid, videoCode, audioCode }
    ) {
        const id = `playurl-${++request}`;
        const details = {
            requestId: id,
            tabId,
            type: "xmlhttprequest",
            url:
                `https://api.bilibili.com/x/player/playurl?bvid=BVtest` +
                `&cid=${cid ?? folder}&qn=80&fnval=16`
        };
        for (const entry of hooks.beforeRequest)
            if (matches(entry, details)) entry.fn(details);
        const filter = filters.get(id);
        const body = Buffer.from(
            JSON.stringify(
                playurlFor({
                    folder,
                    videoInitEnd,
                    audioInitEnd,
                    videoCode,
                    audioCode
                })
            )
        );
        filter.ondata({ data: toArrayBuffer(body) });
        filter.onstop();
    }

    /** One Range response of one rendition, exactly as the phase reads it. */
    function mediaRange(tabId, folder, kind, representation, range) {
        const id = `media-${++request}`;
        const url = renditionUrl(folder, kind);
        const details = {
            requestId: id,
            tabId,
            type: "xmlhttprequest",
            url
        };
        for (const entry of hooks.beforeRequest)
            if (matches(entry, details)) entry.fn(details);
        const filter = filters.get(id);
        const { start, end } = range;
        const headers = {
            requestId: id,
            tabId,
            responseHeaders: [
                {
                    name: "Content-Range",
                    value: `bytes ${start}-${end}/${representation.total}`
                }
            ],
            type: "xmlhttprequest",
            url
        };
        for (const entry of hooks.headersReceived)
            if (matches(entry, headers)) entry.fn(headers);
        // Chunked, like a real response: the phase must assemble the whole
        // declared range before it treats the response as complete.
        const body = representation.body.subarray(start, end + 1);
        const half = Math.max(1, Math.floor(body.length / 2));
        filter.ondata({ data: toArrayBuffer(body.subarray(0, half)) });
        filter.ondata({ data: toArrayBuffer(body.subarray(half)) });
        filter.onstop();
        const completed = { requestId: id, tabId, type: "xmlhttprequest", url };
        for (const entry of hooks.completed)
            if (matches(entry, completed)) entry.fn(completed);
    }

    /** Range 0 = init + sidx, the response a candidate must complete. */
    function initResponse(tabId, folder, kind, representation) {
        mediaRange(tabId, folder, kind, representation, {
            start: 0,
            end: representation.initEnd - 1
        });
    }

    function fragmentResponse(tabId, folder, kind, representation, index) {
        const fragment = representation.fragments[index];
        mediaRange(tabId, folder, kind, representation, {
            start: fragment.start,
            end: fragment.end
        });
    }

    /** An SPA URL change, the way tabs.onUpdated reports it. */
    function navigate(tabId, url) {
        for (const fn of hooks.updated) fn(tabId, { url }, { id: tabId, url });
    }

    function getCapturedMedia(tabId, item) {
        return hooks.message[0](
            { subject: "bilibili:getCapturedMedia", data: { item } },
            { tab: { id: tabId } }
        );
    }

    const settle = () => new Promise(resolve => setTimeout(resolve, 30));

    return {
        hooks,
        posts,
        notifications,
        manifest,
        initResponse,
        fragmentResponse,
        navigate,
        getCapturedMedia,
        settle,
        postsFor: rid => posts.filter(post => post.rid === rid),
        pageIdentity: folder =>
            `https://www.bilibili.com/video/BVtest/?p=${folder}`
    };
}

/** Silence the module's own logging while a case runs. */
async function quiet(fn) {
    const buffered = [];
    const original = { info: console.info, warn: console.warn };
    if (!VERBOSE) {
        console.info = (...args) => buffered.push(args.join(" "));
        console.warn = (...args) => buffered.push(args.join(" "));
    }
    try {
        return await fn();
    } finally {
        console.info = original.info;
        console.warn = original.warn;
        if (VERBOSE && buffered.length) console.info(buffered.join("\n"));
    }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const VIDEO = buildFmp4({ segments: 6, segmentBytes: 4096 });
const AUDIO = buildFmp4({ segments: 6, segmentBytes: 1024 });

/**
 * Does the uploaded range set cover `[from, to]` contiguously? That — not "some
 * payload was posted" — is what the bridge's input selection needs: it picks the
 * first sidx fragment whose ENTIRE byte range is present. A relay handed a
 * fragment's first half cannot use it, which is how "2.5 MB replayed" still
 * meant "audio never selected".
 */
function covers(ranges, from, to) {
    const ordered = ranges
        .map(range => range.split("-").map(Number))
        .sort((left, right) => left[0] - right[0]);
    let reached = from - 1;
    for (const [start, end] of ordered) {
        if (start > reached + 1) break;
        if (end > reached) reached = end;
        if (reached >= to) return true;
    }
    return reached >= to;
}

/** Item A committed and a relay armed on it — the state a switch starts from. */
async function committedItem(capture, page, tabId, folder, rid, port) {
    // The page is on this item. Without a tab URL the capture has no state for
    // the tab at all (in production tabs.onUpdated is what creates it), and the
    // manifest/media listeners would return before doing anything.
    page.navigate(tabId, page.pageIdentity(folder));
    page.manifest(tabId, folder, {
        videoInitEnd: VIDEO.initEnd,
        audioInitEnd: AUDIO.initEnd
    });
    page.initResponse(tabId, folder, "video", VIDEO);
    page.initResponse(tabId, folder, "audio", AUDIO);
    capture.beginBilibiliPageCapture(tabId, rid);
    capture.armBilibiliPageCapture(tabId, rid, port, 2);
    await page.settle();
}

/**
 * The switch: the page starts fetching the NEXT item's renditions (candidate
 * phase), commits both, and only THEN the SPA URL catches up.
 */
function switchTo(next, { commitAudio = true } = {}) {
    const { page, tabId, folder, video, audio } = next;
    page.manifest(tabId, folder, {
        videoInitEnd: video.initEnd,
        audioInitEnd: audio.initEnd
    });
    // The candidate phase: init+index, then the fragments the page needs to
    // keep playing. Audio's ranges are the ones that matter — they are already
    // in the page's buffer, so the page will never ask for them again.
    page.initResponse(tabId, folder, "video", video);
    page.fragmentResponse(tabId, folder, "video", video, 0);
    page.initResponse(tabId, folder, "audio", audio);
    page.fragmentResponse(tabId, folder, "audio", audio, 0);
    page.fragmentResponse(tabId, folder, "audio", audio, 1);
    if (!commitAudio) return;
}

async function caseBaselinePair(capture, page) {
    const tabId = 101;
    await quiet(async () => {
        await committedItem(capture, page, tabId, "1001", "rid-a", 9001);
        const snapshot = await page.getCapturedMedia(tabId, "1001");
        check(
            "baseline: a committed video+audio pair resolves to a snapshot",
            Boolean(snapshot?.videoUrl && snapshot?.audioUrl),
            JSON.stringify(snapshot)
        );
        check(
            "baseline: the snapshot is versioned and reports both inits",
            typeof snapshot?.captureGeneration === "number" &&
                snapshot?.initEndExclusive?.video === VIDEO.initEnd &&
                snapshot?.initEndExclusive?.audio === AUDIO.initEnd,
            JSON.stringify(snapshot)
        );
        const again = await page.getCapturedMedia(tabId, "1001");
        check(
            "baseline: reading twice does not move the version",
            again?.captureGeneration === snapshot?.captureGeneration,
            `${snapshot?.captureGeneration} -> ${again?.captureGeneration}`
        );
    });
}

async function caseSwitchKeepsTheNewPair(capture, page) {
    const tabId = 202;
    await quiet(async () => {
        await committedItem(capture, page, tabId, "1001", "rid-a", 9001);
        const before = await page.getCapturedMedia(tabId, "1001");

        const next = {
            page,
            tabId,
            folder: "1002",
            video: VIDEO,
            audio: AUDIO
        };
        switchTo(next);
        // Both kinds of one switch must be announced: the first commit
        // disarms the relay uploads, so a "is a relay armed" test would silence
        // the second kind — and the sender only learns of a switch from here.
        const announced = page.notifications
            .map(entry => entry.message)
            .filter(
                message =>
                    message.subject === "bilibili:capturedRepresentationChanged"
            )
            .map(message => message.data?.kind);
        check(
            "switch: both kinds of the switch are announced",
            announced.includes("video") && announced.includes("audio"),
            JSON.stringify(announced)
        );

        // The URL catches up AFTER the commit — the measured order.
        page.navigate(tabId, page.pageIdentity("1002"));
        await page.settle();

        const after = await page.getCapturedMedia(tabId, "1002");
        check(
            "switch: the new pair resolves after the URL caught up",
            Boolean(after?.videoUrl && after?.audioUrl),
            JSON.stringify(after)
        );
        check(
            "switch: the pair's version moved with the switch",
            after?.captureGeneration !== undefined &&
                after.captureGeneration !== before?.captureGeneration,
            `${before?.captureGeneration} -> ${after?.captureGeneration}`
        );

        // The successor relay: the sender begins a new generation, the capture
        // arms it, and everything it has for the new pair is handed over.
        //
        // No `resetWindow`: an item reload is not a page seek. The device log
        // says the same thing (`resetCaptureWindow: false` on the reload that
        // followed a part switch), and it matters — the seek path deliberately
        // discards the committed queue because a page seek re-primes the rolling
        // handoff tail, while an item change has no such re-prime.
        capture.beginBilibiliPageCapture(tabId, "rid-b");
        capture.armBilibiliPageCapture(tabId, "rid-b", 9002, 3);
        await page.settle();

        const handed = page.postsFor("rid-b");
        const audioRanges = handed
            .filter(post => post.kind === "audio")
            .map(post => `${post.start}-${post.end}`);
        const videoRanges = handed
            .filter(post => post.kind === "video")
            .map(post => `${post.start}-${post.end}`);
        check(
            "switch: the audio init reaches the new relay",
            handed.some(post => post.kind === "audio" && post.start === 0),
            JSON.stringify(audioRanges)
        );
        check(
            "switch: the video init reaches the new relay",
            handed.some(post => post.kind === "video" && post.start === 0),
            JSON.stringify(videoRanges)
        );
        // THE row: audio's already-fetched fragments were captured before the
        // URL update, the page will never ask for them again, and the bridge
        // cannot select a start without a complete covering fragment.
        check(
            "switch: audio's pre-URL fragments reach the new relay as a complete range",
            covers(audioRanges, AUDIO.initEnd, AUDIO.fragments[1].end),
            `need a contiguous ${AUDIO.initEnd}-${
                AUDIO.fragments[1].end
            } :: got ${JSON.stringify(audioRanges)}`
        );
        check(
            "switch: video's pre-URL fragment reaches the new relay as a complete range",
            covers(videoRanges, VIDEO.initEnd, VIDEO.fragments[0].end),
            `need a contiguous ${VIDEO.initEnd}-${
                VIDEO.fragments[0].end
            } :: got ${JSON.stringify(videoRanges)}`
        );
    });
}

async function caseHalfCommittedPair(capture, page) {
    const tabId = 303;
    await quiet(async () => {
        await committedItem(capture, page, tabId, "1001", "rid-a", 9001);
        // video moved to the next item, audio has not yet: the bridge must not
        // be handed a pair glued out of two media objects.
        page.manifest(tabId, "1002", {
            videoInitEnd: VIDEO.initEnd,
            audioInitEnd: AUDIO.initEnd
        });
        page.initResponse(tabId, "1002", "video", VIDEO);
        page.fragmentResponse(tabId, "1002", "video", VIDEO, 0);
        page.navigate(tabId, page.pageIdentity("1002"));
        await page.settle();
        check(
            "half-committed: video-only is not resolvable as a pair",
            (await page.getCapturedMedia(tabId, "1002")) === undefined,
            JSON.stringify(await page.getCapturedMedia(tabId, "1002"))
        );
    });
}

async function caseStaleItemRefused(capture, page) {
    const tabId = 404;
    await quiet(async () => {
        await committedItem(capture, page, tabId, "1001", "rid-a", 9001);
        check(
            "other item: a pair is never handed out for an item it is not",
            (await page.getCapturedMedia(tabId, "1002")) === undefined,
            "a pair for item 1001 answered a request for item 1002"
        );
        check(
            "other item: a request with no item still resolves (older caller)",
            Boolean((await page.getCapturedMedia(tabId, undefined))?.videoUrl),
            "the item-less read stopped working"
        );
        // Where the paths actually point, as evidence for the row above.
        const snapshot = await page.getCapturedMedia(tabId, undefined);
        check(
            "other item: the pair it would have handed out is item 1001's",
            snapshot?.videoPath === folderPathOf("1001", "video") &&
                snapshot?.audioPath === folderPathOf("1001", "audio"),
            JSON.stringify([snapshot?.videoPath, snapshot?.audioPath])
        );
    });
}

/**
 * The device ran a whole session in which the captured pair was never used: the
 * extension's OWN `resolveMedia()` playurl response (qn=112, AVC-preferred)
 * lands in the same manifest map the capture builds from the page's requests,
 * and it enumerates the renditions bilibili would serve THAT request — not the
 * one the page's player fetched. A gate that requires "the newest manifest
 * declares both committed paths" therefore refuses a perfectly good pair, and
 * the cast silently degrades to the playurl pair for the rest of the session.
 *
 * The contract: the manifest is a source of representations, not the authority
 * on which item a captured path belongs to. Item identity comes from the
 * caller's item (see pairResolution), so an unrelated manifest must not
 * invalidate a committed pair.
 */
async function caseUnrelatedManifestKeepsThePair(capture, page) {
    const tabId = 505;
    await quiet(async () => {
        await committedItem(capture, page, tabId, "1001", "rid-a", 9001);
        const before = await page.getCapturedMedia(tabId, "1001");
        check(
            "manifest: the committed pair resolves to begin with",
            Boolean(before?.videoUrl && before?.audioUrl),
            JSON.stringify(before)
        );
        // The extension's own playurl, for the same item, describing the AVC
        // renditions it prefers (the page fetched the AV1 ones).
        page.manifest(tabId, "1001", {
            videoInitEnd: VIDEO.initEnd,
            audioInitEnd: AUDIO.initEnd,
            videoCode: 30080,
            audioCode: 30216
        });
        const after = await page.getCapturedMedia(tabId, "1001");
        check(
            "manifest: a same-item manifest listing OTHER renditions keeps the pair",
            after?.videoPath === before?.videoPath &&
                after?.audioPath === before?.audioPath,
            JSON.stringify({ before, after })
        );
        check(
            "manifest: the pair's version is unchanged by a rendition listing",
            after?.captureGeneration === before?.captureGeneration,
            `${before?.captureGeneration} -> ${after?.captureGeneration}`
        );
    });
}

async function main() {
    const sourceRoot = resolveSourceRoot();
    const { module: capture, workDir } = await buildCapture(sourceRoot);
    const page = createPage();
    capture.initBilibiliPageCapture();

    console.info(
        `page capture transition harness (${
            REGRESS
                ? "regressed manifest gate"
                : PRE_FIX
                ? `revision ${REV}`
                : "working tree"
        })`
    );
    console.info("case: a committed pair resolves");
    await caseBaselinePair(capture, page);
    console.info("case: an item switch");
    await caseSwitchKeepsTheNewPair(capture, page);
    console.info("case: a half-committed switch");
    await caseHalfCommittedPair(capture, page);
    console.info("case: another item's pair");
    await caseStaleItemRefused(capture, page);
    console.info("case: an unrelated manifest");
    await caseUnrelatedManifestKeepsThePair(capture, page);

    console.info("");
    if (REGRESS) {
        const expected = failures.filter(name =>
            /manifest: a same-item manifest listing OTHER renditions/.test(name)
        );
        if (expected.length < 1) {
            console.error(
                `pageCaptureTransition: --regress manifest-gate expected the manifest rows to fail, saw ${expected.length}` +
                    (failures.length ? ` (${failures.join("; ")})` : "")
            );
            process.exitCode = 1;
        } else {
            console.info(
                `regress control: the manifest rows failed as required (${fail} check(s) total)`
            );
            for (const name of failures) console.info("  - " + name);
            process.exitCode = 0;
        }
    } else if (PRE_FIX) {
        // The control: without the fix the capture destroys the new pair's
        // bytes on the URL change, so the decisive rows must fail here.
        const expected = failures.filter(name =>
            /switch: the audio fragments fetched BEFORE|switch: the new pair resolves|switch: both kinds of the switch are announced|switch: the pair's version moved|half-committed: video-only is not resolvable|other item: a pair is never handed out|manifest: a same-item manifest listing OTHER renditions/.test(
                name
            )
        );
        if (expected.length < 3) {
            console.error(
                `pageCaptureTransition: --pre-fix expected the control failures, saw ${expected.length}` +
                    (failures.length ? ` (${failures.join("; ")})` : "")
            );
            process.exitCode = 1;
        } else {
            console.info(
                `pre-fix control: ${fail} check(s) failed, including the ${expected.length} expected`
            );
            for (const name of failures) console.info("  - " + name);
            process.exitCode = 0;
        }
    } else {
        console.info(`${pass}/${pass + fail} checks passed`);
        if (fail) for (const name of failures) console.info("  - " + name);
        process.exitCode = fail ? 1 : 0;
    }
    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
}

main().catch(error => {
    console.error("pageCaptureTransition ERROR", error);
    process.exitCode = 1;
});
