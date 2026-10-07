#!/usr/bin/env node
"use strict";

/**
 * Unit test for Yangshipin default highest quality enforcement:
 * 1. Sanitizing liveinfo requests: default to 1080P 'fhd' and playdurantion=0.
 * 2. Playlist quality ranking: 1080P outranks 720P, 540P, and audio-only.
 * 3. Yangshipin live page URL detection.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const yangshipinLiveSource = path.join(
    repoRoot,
    "extension/src/background/yangshipinLive.ts"
);
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, detail) => {
    if (cond) {
        pass++;
        console.log("  ok  ", name);
    } else {
        fail++;
        failures.push({ name, detail });
        console.log("  FAIL", name, detail === undefined ? "" : detail);
    }
};

async function bundle(outfile, workDir) {
    const esbuild = require(esbuildPath);
    const entry = path.join(workDir, "entry.js");
    const yangshipinApiPath = path.join(
        repoRoot,
        "extension/src/background/yangshipinApi.ts"
    );
    fs.writeFileSync(
        entry,
        `export {
            isYangshipinLivePage,
            isYangshipinHookPage,
            sanitizeLiveInfoUrl,
            getYangshipinPlaylistRank,
            getYangshipinStreamKey,
            getYangshipinChannelName,
            getYangshipinChannelInfo,
            sanitizeH5CookieHeader
        } from ${JSON.stringify(yangshipinLiveSource)};
        export { createYangshipinCKey } from ${JSON.stringify(
            yangshipinApiPath
        )};\n`
    );
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        define: {
            BRIDGE_NAME: '"fx_cast_bilibili_bridge"',
            BRIDGE_VERSION: '"0.0.0-test"',
            MIRRORING_APP_ID: '"TESTMIRROR"'
        }
    });
}

function installBrowserStub() {
    const noop = () => {};
    global.window = global;
    global.window.addEventListener = noop;
    global.window.removeEventListener = noop;
    global.window.matchMedia = () => ({
        matches: false,
        addEventListener: noop,
        removeEventListener: noop,
        addListener: noop,
        removeListener: noop
    });
    global.document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ setAttribute: () => {} })
    };
    const listener = {
        addListener: noop,
        removeListener: noop,
        hasListener: () => false
    };
    global.browser = {
        storage: {
            local: { get: async () => ({}), set: async () => {} },
            sync: { get: async () => ({}), set: async () => {} },
            onChanged: listener
        },
        runtime: {
            sendMessage: async () => undefined,
            onMessage: listener,
            onConnectNative: listener,
            getPlatformInfo: async () => ({ os: "mac" })
        },
        webRequest: {
            onBeforeRequest: listener
        },
        webNavigation: {
            onCommitted: listener
        },
        windows: {
            onFocusChanged: listener
        },
        tabs: {
            query: async () => [],
            get: async () => undefined,
            onUpdated: listener,
            onRemoved: listener
        },
        notifications: {
            create: async () => {}
        },
        scripting: {
            executeScript: async () => []
        },
        i18n: { getMessage: key => key }
    };
}

async function main() {
    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-yangshipin-quality-")
    );
    const outfile = path.join(workDir, "bundle.js");

    try {
        installBrowserStub();
        await bundle(outfile, workDir);
        const {
            isYangshipinLivePage,
            isYangshipinHookPage,
            sanitizeLiveInfoUrl,
            getYangshipinPlaylistRank,
            getYangshipinStreamKey,
            getYangshipinChannelName,
            getYangshipinChannelInfo,
            createYangshipinCKey,
            sanitizeH5CookieHeader
        } = require(outfile);

        console.log("Yangshipin default quality & sanitizer tests");

        // 1. isYangshipinLivePage tests
        check(
            "isYangshipinLivePage: matches live video with type=2",
            isYangshipinLivePage(
                "https://w.yangshipin.cn/video?type=2&pid=610003121"
            ) === true
        );
        check(
            "isYangshipinLivePage: matches mobile live URL",
            isYangshipinLivePage(
                "https://m.yangshipin.cn/video?type=2&pid=610003121"
            ) === true
        );
        check(
            "isYangshipinLivePage: matches tv/home page with pid",
            isYangshipinLivePage(
                "https://www.yangshipin.cn/tv/home?pid=600099502"
            ) === true
        );
        check(
            "isYangshipinLivePage: matches tv/home page without pid",
            isYangshipinLivePage("https://www.yangshipin.cn/tv/home") === true
        );
        check(
            "isYangshipinLivePage: matches live detail page with pid",
            isYangshipinLivePage(
                "https://www.yangshipin.cn/live/detail?pid=610003420"
            ) === true
        );
        check(
            "isYangshipinLivePage: matches live detail page without pid",
            isYangshipinLivePage("https://www.yangshipin.cn/live/detail") ===
                true
        );
        check(
            "isYangshipinLivePage: rejects non-Yangshipin URL",
            isYangshipinLivePage(
                "https://www.bilibili.com/video/BV1xx411c7mD"
            ) === false
        );

        // 1.1 isYangshipinHookPage tests (covers any Yangshipin page)
        check(
            "isYangshipinHookPage: matches PC homepage",
            isYangshipinHookPage("https://www.yangshipin.cn/") === true
        );
        check(
            "isYangshipinHookPage: matches PC live detail",
            isYangshipinHookPage(
                "https://www.yangshipin.cn/live/detail?pid=610003406"
            ) === true
        );
        check(
            "isYangshipinHookPage: matches mobile video page",
            isYangshipinHookPage(
                "https://w.yangshipin.cn/video?type=2&pid=610003406&vid=2050639703"
            ) === true
        );
        check(
            "isYangshipinHookPage: rejects non-Yangshipin URL",
            isYangshipinHookPage("https://www.bilibili.com/") === false
        );

        // Channel name lookup tests
        check(
            "getYangshipinChannelName: resolves pid 600099502 to CCTV16 4K",
            getYangshipinChannelName("600099502") === "CCTV16 4K"
        );
        check(
            "getYangshipinChannelName: resolves pid 600001859 to CCTV1综合",
            getYangshipinChannelName("600001859") === "CCTV1综合"
        );
        check(
            "getYangshipinChannelName: resolves pid 600001818 to CCTV5体育",
            getYangshipinChannelName("600001818") === "CCTV5体育"
        );
        check(
            "getYangshipinChannelName: returns undefined for unknown pid",
            getYangshipinChannelName("999999999") === undefined
        );

        // Channel info lookup tests
        const cctv16Info = getYangshipinChannelInfo("600099502");
        check(
            "getYangshipinChannelInfo: resolves CCTV16 4K channelId and defn",
            cctv16Info &&
                cctv16Info.channelId === "2027249301" &&
                cctv16Info.defn === "fhd"
        );
        const hjInfo = getYangshipinChannelInfo("600099620");
        check(
            "getYangshipinChannelInfo: resolves CCTV怀旧剧场 defn=shd",
            hjInfo && hjInfo.channelId === "2026874303" && hjInfo.defn === "shd"
        );

        // cKey generation tests
        const ticket = createYangshipinCKey("2027249301");
        check(
            "createYangshipinCKey: produces valid cKey starting with --01",
            typeof ticket.cKey === "string" && ticket.cKey.startsWith("--01")
        );
        check(
            "createYangshipinCKey: produces guid and flowId",
            typeof ticket.guid === "string" &&
                ticket.guid.length === 32 &&
                typeof ticket.flowId === "string"
        );

        // 2. sanitizeLiveInfoUrl tests
        const autoResult = sanitizeLiveInfoUrl(
            "https://liveinfo.yangshipin.cn/?callback=jsonp1&defn=auto&cnlid=2050622703&playdurantion=51"
        );
        check(
            "sanitizeLiveInfoUrl: rewrites defn=auto to defn=fhd",
            new URL(autoResult.url).searchParams.get("defn") === "fhd"
        );
        check(
            "sanitizeLiveInfoUrl: rewrites playdurantion=51 to 0",
            new URL(autoResult.url).searchParams.get("playdurantion") === "0"
        );
        check(
            "sanitizeLiveInfoUrl: changed flag is true when modified",
            autoResult.changed === true
        );

        const hdResult = sanitizeLiveInfoUrl(
            "https://liveinfo.yangshipin.cn/?callback=jsonp1&defn=hd&cnlid=2050622703"
        );
        check(
            "sanitizeLiveInfoUrl: upgrades stale defn=hd to defn=fhd",
            new URL(hdResult.url).searchParams.get("defn") === "fhd"
        );

        const missingDefnResult = sanitizeLiveInfoUrl(
            "https://liveinfo.yangshipin.cn/?callback=jsonp1&cnlid=2050622703"
        );
        check(
            "sanitizeLiveInfoUrl: missing defn defaults to defn=fhd",
            new URL(missingDefnResult.url).searchParams.get("defn") === "fhd"
        );

        const shdResult = sanitizeLiveInfoUrl(
            "https://liveinfo.yangshipin.cn/?callback=jsonp1&defn=shd&cnlid=2050622703&playdurantion=0"
        );
        check(
            "sanitizeLiveInfoUrl: preserves explicit user selection defn=shd",
            new URL(shdResult.url).searchParams.get("defn") === "shd" &&
                shdResult.changed === false
        );

        // 3. getYangshipinPlaylistRank tests
        const fhdRank = getYangshipinPlaylistRank(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2050622703.m3u8?from=player"
        );
        const shdRank = getYangshipinPlaylistRank(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2050622702.m3u8?from=player"
        );
        const hdRank = getYangshipinPlaylistRank(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2050622701.m3u8?from=player"
        );
        const audioRank = getYangshipinPlaylistRank(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2050622704.m3u8?from=player"
        );

        check("rank: 1080P fhd rank is 100", fhdRank === 100);
        check("rank: 720P shd rank is 50", shdRank === 50);
        check("rank: 540P hd rank is 20", hdRank === 20);
        check("rank: audio rank is 1", audioRank === 1);
        check(
            "rank: 1080P > 720P > 540P > audio ladder holds strictly",
            fhdRank > shdRank && shdRank > hdRank && hdRank > audioRank
        );

        // _web and _dlna rank tests
        check(
            "rank: _web 1080P fhd rank is 100",
            getYangshipinPlaylistRank(
                "https://hlslive-tx-cdn.ysp.cctv.cn/live/2027249303_web.m3u8"
            ) === 100
        );
        check(
            "rank: _web 720P shd rank is 50",
            getYangshipinPlaylistRank(
                "https://hlslive-tx-cdn.ysp.cctv.cn/live/2027249302_web.m3u8"
            ) === 50
        );
        check(
            "rank: _dlna 1080P fhd rank is 100",
            getYangshipinPlaylistRank(
                "https://hlslive-tx-cdn.ysp.cctv.cn/live/2027249303_dlna.m3u8"
            ) === 100
        );

        // 4. getYangshipinStreamKey tests
        const angle1Key = getYangshipinStreamKey(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2050631003.m3u8"
        );
        const angle1ShdKey = getYangshipinStreamKey(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2050631002.m3u8"
        );
        const angle2Key = getYangshipinStreamKey(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2050597203.m3u8"
        );
        const webStreamKey = getYangshipinStreamKey(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2027249303_web.m3u8"
        );
        const dlnaStreamKey = getYangshipinStreamKey(
            "https://hlslive-tx-cdn.ysp.cctv.cn/live/2027249301_dlna.m3u8"
        );

        check(
            "streamKey: extracts base ID without quality digit",
            angle1Key === "205063100"
        );
        check(
            "streamKey: same camera angle different qualities share stream key",
            angle1Key === angle1ShdKey
        );
        check(
            "streamKey: different camera angles have distinct stream keys",
            angle1Key !== angle2Key && angle2Key === "205059720"
        );
        check(
            "streamKey: strips _web and _dlna suffixes to compare stream identity",
            webStreamKey === "202724930" && webStreamKey === dlnaStreamKey
        );

        // 5. sanitizeH5CookieHeader tests
        const stalePcCookie =
            "guid=muus8qwb; vplatform=109; appid=1400867594; pc_version=1.1.16; ysp_uinfo_pc=test; vusession=oldSes; endtime=1700000000; uinfo_vuid=123";
        const sanitized = sanitizeH5CookieHeader(stalePcCookie, 1750000000000);
        check(
            "sanitizeH5CookieHeader: modified is true for PC conflict and expired session",
            sanitized.modified === true
        );
        check(
            "sanitizeH5CookieHeader: rewrites vplatform to 2",
            sanitized.cookie.includes("vplatform=2")
        );
        check(
            "sanitizeH5CookieHeader: rewrites appid to 1400227916",
            sanitized.cookie.includes("appid=1400227916")
        );
        check(
            "sanitizeH5CookieHeader: removes pc_version",
            !sanitized.cookie.includes("pc_version")
        );
        check(
            "sanitizeH5CookieHeader: removes ysp_uinfo_pc",
            !sanitized.cookie.includes("ysp_uinfo_pc")
        );
        check(
            "sanitizeH5CookieHeader: strips expired vusession",
            !sanitized.cookie.includes("vusession")
        );
        check(
            "sanitizeH5CookieHeader: strips expired endtime",
            !sanitized.cookie.includes("endtime")
        );
        check(
            "sanitizeH5CookieHeader: preserves unexpired guid and uinfo_vuid",
            sanitized.cookie.includes("guid=muus8qwb") &&
                sanitized.cookie.includes("uinfo_vuid=123")
        );

        // Valid H5 cookie not expired
        const validH5Cookie =
            "guid=muus8qwb; vplatform=2; appid=1400227916; vusession=validSes; endtime=1800000000";
        const validSanitized = sanitizeH5CookieHeader(
            validH5Cookie,
            1700000000000
        );
        check(
            "sanitizeH5CookieHeader: clean valid H5 cookie unmodified",
            validSanitized.modified === false
        );
        check(
            "sanitizeH5CookieHeader: preserves valid vusession",
            validSanitized.cookie.includes("vusession=validSes")
        );

        console.log(`\n${pass}/${pass + fail} checks passed`);
        if (fail > 0) {
            process.exitCode = 1;
        }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

void main().catch(err => {
    console.error("Test harness died with error:", err);
    process.exit(1);
});
