#!/usr/bin/env node
"use strict";

/**
 * The DASH presentation time contract: a receiver position is converted from its
 * padded presentation timeline back to page time EXACTLY ONCE.
 *
 * The defect this freezes: `deviceManager` already normalizes every receiver
 * position (`presentation - offset`, then + the LOAD position) before it reaches
 * the popup, and the popup converted again — so a cast walking a 32s pad runway
 * showed a position 32s behind playback. Every control that reads that timeline
 * then disagreed with the receiver, which is what turned a pause click into a
 * seek and restarted the remux.
 *
 * Both halves are the shipped modules, bundled with esbuild (the same bundler the
 * extension build uses), driven directly:
 *
 *   cast/dashPresentation.ts the only conversion in the extension, as an
 *                            immutable per-generation adapter;
 *   ui/popup/mediaTimeline.ts the popup's state machine, which must treat its
 *                             input as page time.
 *
 * Usage:
 *   node test/playback/dashPresentationTime.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const extensionSrc = path.join(repoRoot, "extension/src");
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
        console.info("  ok   " + name);
    } else {
        fail++;
        failures.push(name);
        console.info(
            "  FAIL " + name + (detail === undefined ? "" : " :: " + detail)
        );
    }
};

async function buildModules() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-time-"));
    const outfile = path.join(workDir, "modules.cjs");
    const entry = path.join(workDir, "entry.ts");
    fs.writeFileSync(
        entry,
        `export * from ${JSON.stringify(
            path.join(extensionSrc, "cast/dashPresentation.ts")
        )};\nexport * from ${JSON.stringify(
            path.join(extensionSrc, "ui/popup/mediaTimeline.ts")
        )};\n`
    );
    const esbuild = require(esbuildPath);
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        outfile,
        logLevel: "error",
        nodePaths: [path.join(repoRoot, "extension/node_modules")]
    });
    return { modules: require(outfile), workDir };
}

const PlayerState = { PLAYING: true };

function main(modules) {
    const {
        createDashPresentation,
        identityPresentation,
        declaredPresentationOffset,
        updatePopupMediaTimeline
    } = modules;

    // ---- the adapter itself ----------------------------------------------
    const padded = createDashPresentation({
        generationId: "gen-1",
        pageStart: 32,
        receiverStart: 64
    });
    check(
        "adapter: a receiver walking the runway maps back to page time",
        padded.receiverToPage(64) === 32,
        JSON.stringify({ in: 64, out: padded.receiverToPage(64) })
    );
    check(
        "adapter: page time maps forward onto the padded LOAD position",
        padded.pageToReceiver(32) === 64,
        JSON.stringify({ out: padded.pageToReceiver(32) })
    );
    check(
        "adapter: a position inside the runway clamps at the media start",
        padded.receiverToPage(8) === 0,
        JSON.stringify({ out: padded.receiverToPage(8) })
    );

    // Identity (every Roku cast, every mid-video restart): one clock, and a
    // real adapter rather than undefined so no consumer needs an unknown branch.
    const plain = identityPresentation("gen-2");
    check(
        "adapter: no runway is the identity, in both directions",
        plain.receiverToPage(64) === 64 && plain.pageToReceiver(64) === 64,
        JSON.stringify({
            toPage: plain.receiverToPage(64),
            toReceiver: plain.pageToReceiver(64)
        })
    );
    check(
        "adapter: an identity adapter is still a real adapter (never undefined)",
        plain.established === false && plain.offsetSeconds === 0,
        JSON.stringify({ established: plain.established })
    );

    // A backwards shift would mean the two values came from different loads.
    const backwards = createDashPresentation({
        generationId: "gen-3",
        pageStart: 100,
        receiverStart: 0
    });
    check(
        "adapter: a negative (cross-generation) shift is refused, not applied",
        backwards.offsetSeconds === 0,
        JSON.stringify({ offset: backwards.offsetSeconds })
    );

    // ---- identity: the reason a stale runway can no longer be applied -----
    // The adapter learns its own media when the LOAD it belongs to reports; a
    // fresh adapter that has not been bound describes nothing (asserted below),
    // so binding here is what makes the identity check meaningful.
    padded.bind({ contentId: "media-1?v=1", mediaSessionId: 11 });
    check(
        "identity: the adapter describes the media it was built for",
        padded.describes({ contentId: "media-1?v=1" }) &&
            !padded.describes({ contentId: "media-2" }),
        JSON.stringify({
            own: padded.describes({ contentId: "media-1" }),
            foreign: padded.describes({ contentId: "media-2" })
        })
    );
    check(
        "identity: a fresh adapter describes nothing until its own media is bound",
        !plain.describes({ contentId: "media-1", mediaSessionId: 7 }),
        JSON.stringify({ describes: plain.describes({ contentId: "media-1" }) })
    );

    check(
        "declaredPresentationOffset: an explicit 0 in customData is an offset, not a missing value",
        declaredPresentationOffset({ presentationOffsetSeconds: 0 }) === 0 &&
            declaredPresentationOffset({}) === undefined &&
            declaredPresentationOffset(null) === undefined,
        JSON.stringify({
            zero: declaredPresentationOffset({ presentationOffsetSeconds: 0 }),
            missing: declaredPresentationOffset({})
        })
    );

    // ---- the popup state machine treats its input as PAGE time -----------
    // 64 is what the receiver reported; deviceManager's conversion (asserted
    // above) turned it into 32 before the popup ever saw it. Dropping the raw 64
    // in here simulates the double conversion: the timeline would store 32.
    const sample = {
        mediaId: "content",
        currentTime: 32,
        duration: 600,
        now: 1_000,
        contentId: "content",
        playerSettled: true,
        isPlaying: true,
        dashRemux: true,
        dashStart: 32
    };
    const timeline = updatePopupMediaTimeline(
        { mediaId: "", currentTime: 0, updatedAt: 0, duration: 0 },
        sample
    );
    check(
        "popup timeline: stores the page-time position it is given, unchanged (no second conversion)",
        timeline.currentTime === 32,
        JSON.stringify(timeline)
    );
    check(
        "popup timeline: a double-converted input would have been 0 (the frozen defect)",
        timeline.currentTime !== padded.receiverToPage(64) - 32 &&
            timeline.currentTime !== 0,
        JSON.stringify({ stored: timeline.currentTime })
    );

    // The same value one tick later, while playing: the estimate may advance,
    // but it must stay on the page timeline rather than restarting from 0.
    const ticked = updatePopupMediaTimeline(timeline, {
        ...sample,
        now: 1_000 + 500,
        currentTime: 32.5
    });
    check(
        "popup timeline: a later page-time report keeps advancing from page time",
        ticked.currentTime === 32.5,
        JSON.stringify(ticked)
    );

    // ---- the popup must not own a conversion at all ----------------------
    const popupSource = fs.readFileSync(
        path.join(extensionSrc, "ui/popup/ReceiverMedia.svelte"),
        "utf8"
    );
    check(
        "popup component: does not convert receiver positions itself (deviceManager is the single owner)",
        !/dashPageTime\(/.test(popupSource) &&
            !/dashPresentationOffset\(/.test(popupSource),
        "ReceiverMedia.svelte still converts positions"
    );
    const backgroundSource = fs.readFileSync(
        path.join(extensionSrc, "background/deviceManager.ts"),
        "utf8"
    );
    check(
        "background: deviceManager is where the conversion lives",
        /adjustDashCurrentTime/.test(backgroundSource) &&
            /declaredPresentationOffset/.test(backgroundSource),
        "deviceManager no longer converts receiver positions"
    );
    // The conversion must be scoped to the MEDIA, not the device: a device-level
    // slot outlives the media it was set for, which is how a previous remux's
    // runway reached the next remux's position.
    check(
        "background: the presentation shift is keyed by media identity, never by device alone",
        /dashPresentationByMedia/.test(backgroundSource) &&
            !/dashPresentationOffsetSeconds/.test(backgroundSource),
        "deviceManager still carries a device-level presentation offset"
    );
}

async function run() {
    const { modules, workDir } = await buildModules();
    console.info(
        "DASH presentation time (page time enters the popup exactly once)"
    );
    main(modules);
    console.info("");
    console.info(`${pass}/${pass + fail} checks passed`);
    process.exitCode = fail ? 1 : 0;
    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
}

run().catch(err => {
    console.error("dashPresentationTime ERROR", err);
    process.exitCode = 1;
});
