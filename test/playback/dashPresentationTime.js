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
        estimatePopupMediaTime,
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

    // ---- the receiver's position is REMUX-relative, not page time ---------
    //
    // Measured on a Roku cast (console export 2026-09-17 01:50): the session
    // reported 8.795 while its media stated dashStart 636.2016 and offset 0, and
    // the popup published 8.795 — so the bar started at 0:00 and counted up from
    // there. The conversion is dashStart + raw - offset, and it is ONE place.
    const deviceManagerSourceForMapping = fs.readFileSync(
        path.join(extensionSrc, "background/deviceManager.ts"),
        "utf8"
    );
    check(
        "mapping: the receiver position is converted with dashStart + raw - offset",
        /Math\.max\(0, dashStart \+ raw - presentationOffset\)/.test(
            deviceManagerSourceForMapping
        ),
        "the mapping still drops dashStart (the popup then starts each cast at 0:00)"
    );
    check(
        "mapping: a media that states no dashStart is refused instead of anchored at 0",
        /DASH current time NOT mapped \(no dashStart\)/.test(
            deviceManagerSourceForMapping
        ),
        "a missing dashStart would be treated as page 0"
    );
    check(
        "mapping: the identity map carries dashStart alongside the offset (periodic reports drop customData)",
        /dashPresentationByMedia = new Map</.test(
            deviceManagerSourceForMapping
        ) &&
            /\{ offsetSeconds: number; dashStart: number \}/.test(
                deviceManagerSourceForMapping
            ),
        "the recalled shift has no dashStart to convert with"
    );
    // The numbers from that cast, as the popup would receive them.
    const rokuSample = {
        mediaId: "roku-media",
        // deviceManager's output for raw 8.795 with dashStart 636.2016, offset 0.
        currentTime: 636.2015791209959 + 8.795,
        duration: 6022,
        now: 2_000_000,
        contentId: "http://10.0.0.111:9555/s/gen/index.m3u8?v=1",
        playerSettled: true,
        isPlaying: true,
        dashRemux: true,
        dashStart: 636.2015791209959
    };
    const rokuTimeline = updatePopupMediaTimeline(
        { mediaId: "", currentTime: 0, updatedAt: 0, duration: 0 },
        rokuSample
    );
    check(
        "popup timeline (Roku): a cast 636s in shows 636s, not 0:00",
        Math.abs(rokuTimeline.currentTime - 644.9965791209959) < 1e-6,
        JSON.stringify({
            stored: rokuTimeline.currentTime,
            dashStart: rokuSample.dashStart,
            raw: 8.795
        })
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

    // ---- the CCTV optimistic bar must stop being optimistic ---------------
    //
    // The live relay publishes an optimistic media entry so a Roku's bar
    // appears before the receiver consumes the stream. A CHROMECAST's real
    // media arrives over the cast session and never replaces that entry, so the
    // entry's customData survived for the whole session — and with it
    // optimisticRelayMedia, which freezes the popup's elapsed clock. Symptom:
    // the bar showed a position and never moved again.
    const dvrSample = {
        mediaId: "relay:req-1",
        currentTime: 32,
        duration: 7232,
        now: 1_000_000,
        playerSettled: true,
        isPlaying: true,
        hlsDvr: true
    };
    const optimisticTimeline = updatePopupMediaTimeline(
        { mediaId: "", currentTime: 0, updatedAt: 0, duration: 0 },
        dvrSample
    );
    check(
        "CCTV bar: a settled hlsDvr position anchors the timeline",
        optimisticTimeline.currentTime === 32 &&
            optimisticTimeline.updatedAt === dvrSample.now,
        JSON.stringify(optimisticTimeline)
    );
    check(
        "CCTV bar: the elapsed clock advances while the receiver plays",
        estimatePopupMediaTime(
            optimisticTimeline,
            true,
            dvrSample.now + 5000
        ) === 37,
        JSON.stringify({
            at0: estimatePopupMediaTime(
                optimisticTimeline,
                true,
                dvrSample.now
            ),
            at5: estimatePopupMediaTime(
                optimisticTimeline,
                true,
                dvrSample.now + 5000
            )
        })
    );
    check(
        "CCTV bar: the clock is FROZEN while the media is flagged optimistic (why a stale flag shows as a dead bar)",
        estimatePopupMediaTime(
            optimisticTimeline,
            false,
            dvrSample.now + 5000
        ) === 32,
        JSON.stringify({
            frozen: estimatePopupMediaTime(
                optimisticTimeline,
                false,
                dvrSample.now + 5000
            )
        })
    );
    // The cleanup the fix performs: the optimistic entry is dropped once the
    // receiver's own media lands, so the popup's flag turns false and the clock
    // runs. Asserted at the source level because the decision lives in
    // background wiring (castManager + deviceManager), not in the timeline.
    const castManagerSource = fs.readFileSync(
        path.join(extensionSrc, "background/castManager.ts"),
        "utf8"
    );
    const deviceManagerSource = fs.readFileSync(
        path.join(extensionSrc, "background/deviceManager.ts"),
        "utf8"
    );
    check(
        "CCTV bar: the optimistic relay media is only registered for Roku devices",
        /getDeviceById\(relayDeviceId\)\?\.deviceType === "roku"/.test(
            castManagerSource
        ) &&
            /synthetic DVR playlist constructed" && relayIsRoku/.test(
                castManagerSource
            ),
        "the optimistic bar is registered for cast devices again"
    );
    check(
        "CCTV bar: a cast device's own media clears the optimistic entry",
        /clearOptimisticRelayMedia\(device\.id\);/.test(deviceManagerSource) &&
            /clearOptimisticRelayMedia\(deviceId: string\)/.test(
                deviceManagerSource
            ) &&
            /deviceType === "roku"\) return;/.test(deviceManagerSource),
        "nothing clears the stale optimistic entry"
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
