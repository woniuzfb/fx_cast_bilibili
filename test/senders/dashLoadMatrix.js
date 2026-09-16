#!/usr/bin/env node
"use strict";

/**
 * One plan for every entry point: the Chromecast DASH load matrix.
 *
 * ## The invariant this file pins
 *
 * A Bilibili DASH load plan is a function of the MEDIA-TIMELINE INPUTS - the page
 * start, the content base (the probed keyframe), the startup-padding policy and
 * the required pad duration. It is NOT a function of the request origin:
 *
 *     pageStart           the page position the remux is generated from
 *     contentBase         where the real content begins in page time (keyframe)
 *     padDuration         the pad MEDIA the playlist carries: the pads are
 *                         [0, padBase), so this is the pad base itself
 *     presentationOffset  padBase - contentBase: the CLOCK SHIFT, never the pad size
 *     receiverStart       padBase + (pageStart - contentBase): the LOAD position
 *     offset              receiverStart - pageStart (what the media states)
 *
 * Whether a playlist carries a bootstrap runway is
 * `padDuration >= requiredPadDuration`, and that does not depend on the target
 * either. 0:00 is still the position that matters most in practice - it is where
 * viewers drag the bar, and where a new video starts - so the matrix pins every
 * entry point at the positions that matter:
 *
 *     initial cast at 0  ==  new-video switch at 0  ==  page progress bar to 0
 *                        ==  popup seek to 0  ==  BLE skip to 0
 *
 * That equivalence is a CONSEQUENCE of the plan being a function of its inputs,
 * not its definition: a row that disagrees is a row that let an origin leak into
 * the arithmetic.
 *
 * The defects this arrangement exists to catch are the ones where a fix for one
 * entry point silently changes another: an item change that stops padding, a
 * page seek that forgets the presentation start, a popup seek that uses the old
 * receiver clock, a switch whose own plan is destroyed by a later action.
 *
 * ## Method
 *
 * Three layers, ONE case matrix:
 *
 *   1. the bridge's arithmetic, lifted out of `mediaServer.ts` (the constant and
 *      the `presentationStartTime` expression are EVALUATED, not restated), so
 *      the numbers cannot drift from the implementation;
 *   2. the real bundled sender, driven through every production entry point —
 *      `loadMedia` (initial cast / reload), `beginDashItemTransition` +
 *      `updateMedia` (new video / quality change), `seekDashRemux` (popup),
 *      `controlFromBleRemote` (BLE skip), and the element's own
 *      gesture-gated `seeking`/`seeked` (the page's progress bar). Each row
 *      asserts the full tuple the receiver is handed: the bridge request's
 *      `startTime`, the LOAD `currentTime`, the media's `dashStart` and
 *      `presentationOffsetSeconds`, and the page element's own position;
 *   3. the CONTINUOUS sequences: the flows a viewer produces — the progress bar
 *      to 0:00, a popup seek to 0:00, popup to 5:00 then back to 0:00 (both in
 *      one debounce window and with the first generation already in flight), a
 *      video switch to 0:00, a switch followed by either seek, a quality change
 *      with the page at 0:00, a BLE skip back to 0:00, the player's own seek,
 *      and the receiver's talk in between — run on ONE live cast with nothing
 *      reset between steps. Every step whose target is the start of the video
 *      must reproduce the FIRST opening cast's tuple, whatever the previous step
 *      did. That cross-step agreement is the property a per-entry-point fix
 *      cannot break silently.
 *
 * The bridge half of a row is answered from the same plan function the
 * arithmetic layer is checked against, so a row is not "the sender was told X";
 * it is "the sender asked for X, the bridge's own rule turned X into Y, and the
 * sender LOADed at Y".
 *
 * ## Gap rows, and the two modes
 *
 * Three behaviours contradict documented rules elsewhere in the sender. They are
 * carried as GAP rows rather than fixed here, because each needs a decision, not
 * a patch:
 *
 *   G1  an autonomous page `seeked` (no gesture, not a BLE skip) restarts the
 *       remux — `onSeeked`'s gate tests the `{ble, page}` OBJECT returned by
 *       `consumeBleArm`, which is always truthy, so the gesture gate never
 *       applies. The documented rule ("Bilibili's autonomous events ... are
 *       ignored so they can't hijack the receiver") says it must not.
 *   G2  a popup seek that arrives while an item/quality change's LOAD is in
 *       flight is COALESCED and then dropped by `markItemSettled`, so an
 *       explicit user intent is silently lost. `markItemSettled`'s rationale
 *       ("the item's own LOAD was taken at the page's position, and the page is
 *       the position authority") holds only for the page-clock-master path
 *       (Roku capture); on a Chromecast the receiver was loaded at a position
 *       the user has already left.
 *   G3  a BURST of seeks that arrives during one flight ends on the OLDEST of
 *       the burst: `requestSeek` queues every accepted intent and the
 *       transaction loop drains them newest-first, so [250, 260] is served as
 *       260 and then 250 — one generation for a target that has already been
 *       superseded, and the receiver left where the older click put it while
 *       the popup is showing the newer.
 *
 * Usage:
 *   node test/senders/dashLoadMatrix.js              # the CONTRACT (what CI runs)
 *   node test/senders/dashLoadMatrix.js --legacy     # the pre-fix facts; they must
 *                                                    # FAIL now that the fixes landed
 *   node test/senders/dashLoadMatrix.js --pre-fix [rev]
 *                                                    # the contract against an older
 *                                                    # checkout; must FAIL there
 *
 * The modes are each other's control: a row that holds in BOTH is not in dispute,
 * and every row that flips names a behaviour the fix changed.
 *
 * Boundary: this is decision- and arithmetic-level evidence. It runs no ffmpeg,
 * no bridge HTTP server and no receiver, so it cannot observe the served
 * playlist rows or the receiver's segment requests. The playlist SHAPE is
 * checked arithmetically here and by execution in
 * `test/bridge/dashRemuxTimeline.js`; what the receiver does with it needs a
 * real session. Roku (page-clock-master) capture, CCTV's synthetic DVR and the
 * seek-scoped capture priming are different code paths and are covered by
 * `dashSeekSync.js` / `playbackIntentOwnership.js`.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "../..");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);
const bridgeMediaServer = path.join(
    repoRoot,
    "bridge/src/bridge/components/mediaServer.ts"
);

const argv = process.argv.slice(2);
/**
 * The default mode is the CONTRACT: `npm run test:senders` must never be green
 * because a known defect is still present. The other side of the pair is opt-in:
 *
 *   --legacy         asserts the pre-fix facts (they fail once the fixes land,
 *                    which is the point: the control cannot outlive the defect)
 *   --pre-fix [rev]  builds the sender from another revision in a git worktree
 *                    and requires the contract above to FAIL there, so the
 *                    contract rows are measured against a source that must
 *                    violate them. The revision has to carry this refactor's API
 *                    (the bundled sender must expose the same entry points), so
 *                    it only becomes usable once the fixes are committed.
 */
const PRE_FIX_INDEX = argv.indexOf("--pre-fix");
const PRE_FIX = PRE_FIX_INDEX >= 0;
const PRE_FIX_REV = PRE_FIX ? argv[PRE_FIX_INDEX + 1] ?? "HEAD" : undefined;
const LEGACY = argv.includes("--legacy");
if (LEGACY && PRE_FIX) {
    throw new Error(
        "dashLoadMatrix: --legacy asserts the current source's old facts; --pre-fix asserts the contract against an older source. Pick one."
    );
}
/** `--fixed` is accepted as an explicit spelling of the default. */
const FIXED = !LEGACY;

/**
 * Where the sender under test lives. `--pre-fix` checks out another revision in
 * a git worktree so the same bundle, the same fixture and the same assertions run
 * against the source the contract is supposed to catch. The bridge source is
 * always the working tree: the contract's runway arithmetic is the bridge's, and
 * an old bridge has none to run.
 */
const sendersDir = (() => {
    if (!PRE_FIX) return path.join(repoRoot, "extension/src/cast/senders");
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fx-cast-rev-"));
    fs.rmSync(worktree, { recursive: true, force: true });
    execFileSync(
        "git",
        ["worktree", "add", "--detach", worktree, PRE_FIX_REV],
        {
            cwd: repoRoot,
            stdio: ["ignore", "ignore", "inherit"]
        }
    );
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
    return path.join(worktree, "extension/src/cast/senders");
})();

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

const PlayerState = {
    IDLE: "IDLE",
    PLAYING: "PLAYING",
    PAUSED: "PAUSED",
    BUFFERING: "BUFFERING"
};

const noop = () => {};
/** Set by main(): the bridge's plan, evaluated from the bridge's own source. */
let bridgePlan;

// ---------------------------------------------------------------------------
// 1. The bridge's plan, evaluated from the bridge's own source
// ---------------------------------------------------------------------------

/**
 * `mediaServer.ts` states the pad base and the presentation start as single
 * expressions over (start, keyframe). They are extracted here and evaluated, so
 * this file's plan IS the bridge's arithmetic: a restatement would keep passing
 * after the implementation changed.
 *
 * The pad runway and the clock shift are DERIVED from those two numbers and kept
 * apart: the pads cover `[0, padBase)`, so `padDuration` IS the pad base, while
 * `padBase - contentBase` is only the CLOCK OFFSET. A playlist can therefore carry
 * hundreds of seconds of pads and still have offset 0 (a mid-video restart), and a
 * padded playlist can still have a SHORT runway (keyframe 4 padded to 32 carries
 * 32s, not the 28s its offset suggests). Neither number is a proxy for the other,
 * and `padRunway` / `clock` name both answers so nothing downstream has to infer
 * one from the other.
 */
function loadBridgePlan() {
    const source = fs.readFileSync(bridgeMediaServer, "utf8");

    const minMatch = /const CHROMECAST_MIN_PAD_SECONDS = (\d+);/.exec(source);
    const padSegmentMatch = /const padSegmentSeconds = (\d+);/.exec(source);
    if (!minMatch || !padSegmentMatch) {
        throw new Error(
            "dashLoadMatrix: the bridge's pad constants were not found in mediaServer.ts"
        );
    }
    const minPadSeconds = Number(minMatch[1]);
    const padSegmentSeconds = Number(padSegmentMatch[1]);

    const marker = "startTime: normalizedStartTime,";
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
        throw new Error(
            "dashLoadMatrix: the mediaServerStarted startTime field was not found"
        );
    }
    const expression =
        /presentationStartTime:\s*([\s\S]*?),\n\s*padBaseSeconds,/.exec(
            source.slice(markerIndex)
        );
    if (!expression) {
        throw new Error(
            "dashLoadMatrix: presentationStartTime is not computed where expected"
        );
    }
    // presentationStartTime is published through a named helper (the Chromecast
    // window is sized against the same value), so the right-hand side may be a
    // call: resolve the helper's own body instead of evaluating an unbound name.
    let presentationSource = expression[1].trim();
    const helperName = /^([A-Za-z_$][\w$]*)\(\)$/.exec(presentationSource);
    if (helperName) {
        const helper = new RegExp(
            `const ${helperName[1]} = \\(\\) =>\\s*([\\s\\S]*?);\\n`
        ).exec(source);
        if (!helper) {
            throw new Error(
                `dashLoadMatrix: ${helperName[1]}() is called but its body was not found in mediaServer.ts`
            );
        }
        presentationSource = helper[1].trim();
    }
    // eslint-disable-next-line no-new-func
    const presentationExpression = new Function(
        "padBaseSeconds",
        "normalizedStartTime",
        "contentBaseSeconds",
        `return ${presentationSource};`
    );
    // The arm the source uses for the Chromecast path: `useStartupPadding` is
    // true for every non-Roku cast while the option is on (its default), which
    // is the configuration every receiver row below runs in.
    // eslint-disable-next-line no-new-func
    const padBaseExpression = new Function(
        "keyframe",
        "minPadSeconds",
        "startupPadding",
        `return startupPadding ? Math.max(keyframe, minPadSeconds) : keyframe;`
    );

    return {
        minPadSeconds,
        padSegmentSeconds,
        /**
         * One bridge decision for a requested page start and the keyframe the
         * probe would report for it.
         *
         * Three quantities, deliberately kept apart - conflating the first two is
         * the mistake that made an earlier version of this file call a 581s pad
         * runway "no runway":
         *
         *   contentBase          where the real content begins in PAGE time (the
         *                        keyframe the remux starts from)
         *   padBase              how far the pads cover in PRESENTATION time; the
         *                        pads are [0, padBase), so this is also their
         *                        total duration - the pad runway the playlist
         *                        actually carries
         *   presentationOffset   padBase - contentBase: the CLOCK SHIFT
         *                        (receiverTime = pageTime + offset), which is what
         *                        `presentationOffsetSeconds` states and what the
         *                        sender subtracts. It is NOT the pad duration.
         *
         * A mid-video restart at page 581.605 (keyframe 581) therefore has 581
         * seconds of pads AND an offset of 0; a restart at page 36 with keyframe 4
         * has 32 seconds of pads AND an offset of 28. Pad sufficiency asks only
         * about the runway (`padDuration >= requiredPadDuration`), and the target
         * is not part of that question either.
         */
        plan(requestedStart, keyframe, startupPadding = true) {
            const pageStart = Math.max(0, Number(requestedStart));
            const contentBase = Math.max(0, Number(keyframe));
            const padBase = padBaseExpression(
                contentBase,
                minPadSeconds,
                startupPadding
            );
            const receiverStart = presentationExpression(
                padBase,
                pageStart,
                contentBase
            );
            const padCount = Math.floor(padBase / padSegmentSeconds);
            const padRemainder = padBase - padCount * padSegmentSeconds;
            const padEntries = padCount + (padRemainder > 0.05 ? 1 : 0);
            const presentationOffset = padBase - contentBase;
            return {
                pageStart,
                contentBase,
                padBase,
                receiverStart,
                /** What the generated media states: receiverStart - pageStart. */
                offset: receiverStart - pageStart,
                /** The pad MEDIA the playlist carries ([0, padBase) is pads). */
                padDuration: padBase,
                requiredPadDuration: minPadSeconds,
                padsSufficient: padBase >= minPadSeconds,
                /** The clock shift between the two timelines (receiver - page). */
                presentationOffset,
                padRunway:
                    padBase === 0
                        ? "no-pad-runway"
                        : padBase >= minPadSeconds
                        ? "full-pad-runway"
                        : "short-pad-runway",
                clock: presentationOffset === 0 ? "no-offset" : "shifted",
                padEntries,
                // The playlist the receiver would fetch: the pads, then the real
                // content. `rewritePlaylist` inserts them in front of the first
                // `#EXTINF`, which is the shape asserted here.
                firstSegment: padEntries > 0 ? "pad.ts" : "segment-000000.ts"
            };
        }
    };
}

// ---------------------------------------------------------------------------
// 2. The case matrix
// ---------------------------------------------------------------------------

/**
 * The targets, with the keyframe a probe would report for each and the plan the
 * bridge's own expressions must produce.
 *
 * `expect` is written by hand (the plan derives its numbers from the bridge's
 * source), and it asserts the three quantities SEPARATELY - pad duration, clock
 * offset and LOAD position - because they are what an earlier version of this
 * file conflated:
 *
 *   page 36, keyframe 4   32s of pads, offset 28
 *   page 60, keyframe 28  32s of pads, offset 4
 *   page 581.605, kf 581  581s of pads, offset 0
 *
 * All three are `full-pad-runway`; only their clock offsets differ. The rows in
 * `NO_PADDING_TARGET_CASES` below are the ones where the pads are actually
 * insufficient, and they exist because `padBase = max(keyframe, required)` can
 * only fail to provide them when the startup-padding option is OFF.
 */
const TARGET_CASES = [
    // the video's first frame
    {
        target: 0,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 32,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    // the startup race: 0 and 0.001 must not differ in shape
    {
        target: 0.001,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 32.001,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    {
        target: 0.2,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 32.2,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    {
        target: 2.864,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 34.864,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    {
        target: 8,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 40,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    // still inside the bootstrap window
    {
        target: 25.5,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 57.5,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    {
        target: 28,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 60,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    // PAST the minimum pad base, first keyframe 0: the pads are still full
    {
        target: 32,
        keyframe: 0,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 32,
            receiverStart: 64,
            offset: 32,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    // 32s of pads AND an offset of 28 - the case that used to be called '28s of runway'
    {
        target: 36,
        keyframe: 4,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 28,
            receiverStart: 64,
            offset: 28,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    // the mid-video health control: pads from the keyframe, no offset
    {
        target: 40,
        keyframe: 40,
        expect: {
            padDuration: 40,
            padsSufficient: true,
            presentationOffset: 0,
            receiverStart: 40,
            offset: 0,
            padEntries: 10,
            padRunway: "full-pad-runway",
            clock: "no-offset"
        }
    },
    // 32s of pads, offset 16
    {
        target: 44,
        keyframe: 16,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 16,
            receiverStart: 60,
            offset: 16,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    // 32s of pads, offset 4
    {
        target: 60,
        keyframe: 28,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 4,
            receiverStart: 64,
            offset: 4,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "shifted"
        }
    },
    // 32s of pads, no offset
    {
        target: 64,
        keyframe: 32,
        expect: {
            padDuration: 32,
            padsSufficient: true,
            presentationOffset: 0,
            receiverStart: 64,
            offset: 0,
            padEntries: 8,
            padRunway: "full-pad-runway",
            clock: "no-offset"
        }
    },
    // 581s of pads AND no offset: offset 0 does not mean 'no pads'
    {
        target: 581.605,
        keyframe: 581,
        expect: {
            padDuration: 581,
            padsSufficient: true,
            presentationOffset: 0,
            receiverStart: 581.605,
            offset: 0,
            padEntries: 146,
            padRunway: "full-pad-runway",
            clock: "no-offset"
        }
    },
    // the values behind dashCastOffset.js's control
    {
        target: 1431.805,
        keyframe: 1431,
        expect: {
            padDuration: 1431,
            padsSufficient: true,
            presentationOffset: 0,
            receiverStart: 1431.805,
            offset: 0,
            padEntries: 358,
            padRunway: "full-pad-runway",
            clock: "no-offset"
        }
    }
];

/**
 * The same arithmetic with the startup-padding option OFF (`padBase = keyframe`),
 * which is the only configuration in which the pads can be insufficient: an
 * opening cast then carries no pads at all - the historical Chromecast failure the
 * option exists to fix - while a mid-video restart still carries hundreds of
 * seconds of them.
 */
const NO_PADDING_TARGET_CASES = [
    // the historical Chromecast failure: no pads to bootstrap from
    {
        target: 0,
        keyframe: 0,
        expect: {
            padDuration: 0,
            padsSufficient: false,
            presentationOffset: 0,
            receiverStart: 0,
            offset: 0,
            padEntries: 0,
            padRunway: "no-pad-runway",
            clock: "no-offset"
        }
    },
    {
        target: 0.001,
        keyframe: 0,
        expect: {
            padDuration: 0,
            padsSufficient: false,
            presentationOffset: 0,
            receiverStart: 0.001,
            offset: 0,
            padEntries: 0,
            padRunway: "no-pad-runway",
            clock: "no-offset"
        }
    },
    {
        target: 2.864,
        keyframe: 0,
        expect: {
            padDuration: 0,
            padsSufficient: false,
            presentationOffset: 0,
            receiverStart: 2.864,
            offset: 0,
            padEntries: 0,
            padRunway: "no-pad-runway",
            clock: "no-offset"
        }
    },
    // a SHORT pad runway: 4s, still not enough
    {
        target: 36,
        keyframe: 4,
        expect: {
            padDuration: 4,
            padsSufficient: false,
            presentationOffset: 0,
            receiverStart: 36,
            offset: 0,
            padEntries: 1,
            padRunway: "short-pad-runway",
            clock: "no-offset"
        }
    },
    // mid-video still carries its own hundreds of seconds
    {
        target: 581.605,
        keyframe: 581,
        expect: {
            padDuration: 581,
            padsSufficient: true,
            presentationOffset: 0,
            receiverStart: 581.605,
            offset: 0,
            padEntries: 146,
            padRunway: "full-pad-runway",
            clock: "no-offset"
        }
    }
];

/**
 * Every entry point that can start a remux generation. `needsLiveCast` marks the
 * ones that only exist on top of a running cast, which is why their rows run a
 * baseline load first (the shape every real one has).
 */
const ORIGINS = [
    {
        id: "initial-cast",
        label: "initial cast",
        needsLiveCast: false
    },
    {
        // The same call as an initial cast, with a different meaning: a reload
        // that takes the page's position (an auto-recovery rebuild has this
        // shape). Its row exists to prove that the plan is not conditional on
        // "is this the first load".
        id: "reload",
        label: "unconditioned reload (page-position authority)",
        needsLiveCast: false
    },
    {
        id: "item-change",
        label: "new-video switch (new element at the target)",
        needsLiveCast: true
    },
    {
        id: "quality-change",
        label: "quality change (same element, same video)",
        needsLiveCast: true
    },
    {
        id: "page-seek",
        label: "page progress bar (gesture + seeking/seeked)",
        needsLiveCast: true
    },
    {
        id: "popup-seek",
        label: "popup seek",
        needsLiveCast: true
    },
    {
        id: "ble-seek",
        label: "BLE skip back to the target",
        needsLiveCast: true
    }
];

/** The page position a live cast sits at before an action is applied to it. */
const BASELINE_PAGE_TIME = 100;
/** Mirrors MediaSender.DASH_SEEK_DEBOUNCE_MS; the harness's clock is not real. */
const SEEK_DEBOUNCE_MS = 800;
const PAGE_DURATION = 6000;
const BILIBILI_REFERER = "https://www.bilibili.com/video/BVtest";

// ---------------------------------------------------------------------------
// 3. The fixture: DOM, browser, cast SDK stub, real bundled sender
// ---------------------------------------------------------------------------

/** Per-fixture option overlay; null means the production defaults. */
let fixtureOptions = null;
/** Monotonic totals of receiver-side commands, per fixture. */
const receiverCommands = { pause: 0, play: 0, seek: 0 };
/** True while a row is holding the page's `seeked` back. */
let pageSeeksDeferred = false;
const timers = { timeouts: [] };
let timerId = 0;
let latestInterval;
/** window handlers, so a real user gesture can be dispatched. */
const windowListeners = new Map();

function installGlobals() {
    global.window = {
        location: {
            protocol: "moz-extension:",
            href: "moz-extension://test/sender.html"
        },
        setInterval: fn => {
            latestInterval = fn;
            return ++timerId;
        },
        clearInterval: noop,
        setTimeout: (fn, ms) => {
            const id = ++timerId;
            timers.timeouts.push({ id, fn, ms, cleared: false });
            return id;
        },
        clearTimeout: id => {
            const entry = timers.timeouts.find(item => item.id === id);
            if (entry) entry.cleared = true;
        },
        addEventListener: (type, fn) => {
            if (!windowListeners.has(type))
                windowListeners.set(type, new Set());
            windowListeners.get(type).add(fn);
        },
        removeEventListener: (type, fn) => {
            windowListeners.get(type)?.delete(fn);
        }
    };
    /**
     * A real user gesture (a pointer/key event on the page). This is what
     * arms the sender's gesture gate; without it every page event must be
     * treated as the player's own, which is exactly the distinction the matrix
     * asserts.
     */
    global.__dispatchGesture = () => {
        for (const fn of [...(windowListeners.get("pointerdown") ?? [])]) fn();
    };
    global.HTMLMediaElement = class HTMLMediaElement {};
    global.HTMLVideoElement = class HTMLVideoElement extends (
        global.HTMLMediaElement
    ) {};
    global.HTMLImageElement = class HTMLImageElement {};
    global.document = {
        addEventListener: noop,
        removeEventListener: noop,
        querySelector: () => null,
        querySelectorAll: () => []
    };
    global.browser = {
        storage: {
            sync: {
                get: async () => ({
                    options: {
                        mediaSyncElement: true,
                        mediaStopOnUnload: true,
                        localMediaEnabled: true,
                        localMediaServerPort: 9555,
                        cctvDebugEnabled: false,
                        rokuTranscodePreset: "veryfast",
                        chromecastDashStartupPadding: true,
                        ...(fixtureOptions ?? {})
                    }
                })
            }
        },
        runtime: {
            sendMessage: async () => undefined,
            onMessage: { addListener: noop, removeListener: noop },
            getPlatformInfo: async () => ({ os: "mac" })
        },
        i18n: { getMessage: key => key },
        tabs: { get: async () => undefined },
        menus: { getTargetElement: () => undefined }
    };
}

/** Fire the pending, uncleared timers registered for exactly `ms`. */
function fireTimeout(ms) {
    const due = timers.timeouts.filter(
        entry => !entry.cleared && entry.ms === ms
    );
    for (const entry of due) {
        entry.cleared = true;
        entry.fn();
    }
    return due.length;
}

const flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};

function writeStub(stubDir) {
    fs.writeFileSync(
        path.join(stubDir, "exportStub.js"),
        `"use strict";
const noop = () => {};
const PlayerState = { IDLE: "IDLE", PLAYING: "PLAYING", PAUSED: "PAUSED", BUFFERING: "BUFFERING" };
const IdleReason = { CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED", FINISHED: "FINISHED", ERROR: "ERROR" };
class MediaInfo {
    constructor(url, contentType) { this.url = url; this.contentType = contentType; this.tracks = []; this.metadata = new GenericMediaMetadata(); }
}
class GenericMediaMetadata {}
class LoadRequest { constructor(media) { this.media = media; this.autoplay = false; this.currentTime = 0; this.activeTrackIds = []; } }
class SeekRequest { constructor() { this.currentTime = 0; this.resumeState = undefined; } }
class Track { constructor(id, type) { this.trackId = id; this.trackType = type; } }
class Image { constructor(url) { this.url = url; } }
const media = {
    PlayerState,
    IdleReason,
    DEFAULT: "DEFAULT",
    DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845",
    MediaInfo,
    GenericMediaMetadata,
    LoadRequest,
    SeekRequest,
    Track,
    Image,
    TrackType: { TEXT: "TEXT", AUDIO: "AUDIO", VIDEO: "VIDEO" },
    TextTrackType: { SUBTITLES: "SUBTITLES", CAPTIONS: "CAPTIONS", DESCRIPTIONS: "DESCRIPTIONS", CHAPTERS: "CHAPTERS", METADATA: "METADATA" },
    StreamType: { BUFFERED: "BUFFERED", LIVE: "LIVE", OTHER: "OTHER" }
};
const cast = {
    media,
    Capability: { VIDEO_OUT: "VIDEO_OUT", VIDEO_IN: "VIDEO_IN", AUDIO_OUT: "AUDIO_OUT", AUDIO_IN: "AUDIO_IN" },
    ReceiverAvailability: { AVAILABLE: "AVAILABLE", UNAVAILABLE: "UNAVAILABLE" },
    ReceiverAction: { CAST: "CAST", STOP: "STOP" },
    AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: "TAB_AND_ORIGIN_SCOPED", ORIGIN_SCOPED: "ORIGIN_SCOPED", PAGE_SCOPED: "PAGE_SCOPED" },
    ApiConfig: class { constructor(sessionRequest, sessionListener, receiverListener, autoJoinPolicy) { Object.assign(this, { sessionRequest, sessionListener, receiverListener, autoJoinPolicy }); } },
    SessionRequest: class { constructor(appId, capabilities) { Object.assign(this, { appId, capabilities }); } },
    Image,
    addReceiverActionListener: noop,
    removeReceiverActionListener: noop,
    initialize: noop,
    requestSession: noop
};
async function ensureInit() {
    const listeners = [];
    const port = {
        addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
        removeEventListener: (type, fn) => {
            const index = listeners.indexOf(fn);
            if (index >= 0) listeners.splice(index, 1);
        },
        start: noop,
        disconnect: noop,
        postMessage: message => { if (global.__onCastPortMessage) global.__onCastPortMessage(message); }
    };
    global.__castPort = port;
    global.__castPortDispatch = message => {
        listeners.slice().forEach(fn => fn({ data: message }));
    };
    return port;
}
module.exports = cast;
module.exports.default = cast;
module.exports.ensureInit = ensureInit;
`
    );
}

async function buildSender() {
    const workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fx-cast-load-matrix-")
    );
    const entry = path.join(workDir, "entry.ts");
    const outfile = path.join(workDir, "sender.cjs");
    const stubDir = path.join(workDir, "stub");
    fs.mkdirSync(stubDir, { recursive: true });
    writeStub(stubDir);
    fs.writeFileSync(
        entry,
        `import MediaSender from ${JSON.stringify(
            path.join(sendersDir, "media.ts")
        )};\nexport { MediaSender };\n`
    );

    const esbuild = require(esbuildPath).build
        ? require(esbuildPath)
        : require(esbuildPath).default;
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
        },
        plugins: [
            {
                name: "stub-cast-sdk",
                setup(build) {
                    build.onResolve({ filter: /^\.\.\/export$/ }, () => ({
                        path: path.join(stubDir, "exportStub.js")
                    }));
                }
            }
        ]
    });
    return { outfile, workDir };
}

/** A page media element with its own listener set and observable calls. */
function makeElement({ paused, currentTime, asyncSeek = true }) {
    const calls = { play: 0, pause: 0, writes: [] };
    const handlers = new Map();
    /**
     * A real element fires `seeking`/`seeked` only for a move that CHANGED its
     * position, and those events are the browser's, not the extension's: a write
     * that was a no-op (the sender's own guard skips it) produces no event at
     * all. Tracking it is what keeps a programmatic echo from being invented -
     * and an invented echo is a PAGE SEEK as far as the sender can tell.
     */
    let pendingWriteEcho = false;
    const element = new global.HTMLMediaElement();
    element.paused = paused;
    element._currentTime = currentTime;
    element.asyncSeek = asyncSeek;
    /**
     * The seek the element is ON ITS WAY to (`undefined` when it is going
     * nowhere), and whether it is still travelling.
     *
     * A browser seek is a REQUEST, not an assignment: assigning `currentTime`
     * starts a seek, the element reports `seeking`, and it reaches the position -
     * firing `seeked` - only once it has the data. For a DASH page player that is
     * a fetch plus a decode, and if the target is outside what that player can
     * reach, nothing arrives at all. The fixture models that two-phase shape on
     * purpose: a synchronous stub makes "the page has been ASKED to go there" and
     * "the page HAS arrived" the same fact, which is exactly the distinction the
     * seek handoff has to get right.
     */
    element.pendingSeek = undefined;
    element.seeking = false;
    /** Off by default; a row turns it on to model the page player's real rule. */
    element.pausedPlayerModel = false;
    // Long enough that the mid-video rows are inside the media and a BLE skip
    // is not clamped by the fixture rather than by the sender.
    element.duration = PAGE_DURATION;
    element.muted = false;
    element.textTracks = [];
    Object.defineProperty(element, "currentTime", {
        get: () => element._currentTime,
        set: value => {
            if (Math.abs(value - element._currentTime) > 1e-9) {
                pendingWriteEcho = true;
            }
            calls.writes.push(value);
            if (!element.asyncSeek) {
                element._currentTime = value;
                return;
            }
            element.pendingSeek = value;
            if (!element.seeking) {
                element.seeking = true;
                // `seeking` is the element acknowledging the REQUEST, so it is
                // fired by the write itself; `seeked` belongs to whoever delivers
                // the data (see completePageSeek).
                element.emit("seeking");
            }
        }
    });
    /**
     * The harness stating where the page IS - not a seek: the position lands
     * immediately, nothing is owed and no event is fired. Used for the inputs a
     * row supplies itself (where the page already is), never for a move the code
     * under test asked for.
     */
    element.placeAt = value => {
        element._currentTime = value;
        element.pendingSeek = undefined;
        element.seeking = false;
        element.takeWriteEcho();
    };
    /** The element arrives: the seek's target becomes its position. */
    element.completePageSeek = () => {
        if (element.pendingSeek === undefined) return false;
        element._currentTime = element.pendingSeek;
        element.pendingSeek = undefined;
        element.seeking = false;
        element.emit("seeked");
        return true;
    };
    /** Claim the event pair this element owes for its last move, if any. */
    element.takeWriteEcho = () => {
        const owed = pendingWriteEcho;
        pendingWriteEcho = false;
        return owed;
    };
    element.play = () => {
        calls.play++;
        if (element.paused) {
            element.paused = false;
            element.emit("play");
        }
        // The page player only fetches/decodes the target range once it is
        // PLAYING again: a seek requested while it is paused lands here.
        if (element.pausedPlayerModel && element.pendingSeek !== undefined) {
            element.completePageSeek();
        }
        return Promise.resolve();
    };
    element.pause = () => {
        calls.pause++;
        if (!element.paused) {
            element.paused = true;
            element.emit("pause");
        }
    };
    element.addEventListener = (type, handler) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(handler);
    };
    element.removeEventListener = (type, handler) => {
        handlers.get(type)?.delete(handler);
    };
    /** Fire an element event synchronously, as the browser would later. */
    element.emit = type => {
        for (const handler of [...(handlers.get(type) ?? [])]) handler();
    };
    element.listenerCount = type => (handlers.get(type) ?? new Set()).size;
    element.calls = calls;
    return element;
}

/**
 * A receiver media session, shaped like the real `cast/sdk/media/Media`:
 * `mediaSessionId` plus a nested MediaInfo carrying the contentId, because the
 * sender's presentation adapter matches a report on exactly those two.
 */
function makeMedia(playerState, estimatedTime, mediaSessionId, contentId) {
    const calls = { pause: 0, play: 0, seek: 0 };
    return {
        playerState,
        idleReason: undefined,
        mediaSessionId,
        media: { contentId, duration: PAGE_DURATION },
        currentTime: estimatedTime,
        getEstimatedTime: () => estimatedTime,
        addUpdateListener: noop,
        removeUpdateListener: noop,
        pause: () => {
            calls.pause++;
            receiverCommands.pause++;
            return Promise.resolve();
        },
        play: () => {
            calls.play++;
            receiverCommands.play++;
            return Promise.resolve();
        },
        seek: () => {
            calls.seek++;
            receiverCommands.seek++;
        },
        calls
    };
}

/**
 * A Bilibili Chromecast sender: DASH remux (a separate audio URL), page
 * controls forwarded with the production gesture gate ON, position sync on.
 */
async function makeSender(MediaSender, opts = {}) {
    // Set BEFORE the sender's constructor: its init() reads the options once.
    fixtureOptions =
        opts.startupPadding === undefined
            ? null
            : { chromecastDashStartupPadding: opts.startupPadding };
    receiverCommands.pause = 0;
    receiverCommands.play = 0;
    receiverCommands.seek = 0;
    pageSeeksDeferred = false;
    timers.timeouts.length = 0;
    windowListeners.clear();
    const element = makeElement({
        paused: opts.pagePaused ?? false,
        currentTime: opts.pageTime ?? 0
    });
    // The page key of the media being played. A new element (a new video) gets a
    // new one; the initial cast starts on `video-a`.
    let mediaIdentity = "video-a";
    let mediaIdentityGeneration = 0;
    const sender = new MediaSender({
        mediaUrl: opts.mediaUrl ?? "https://example.invalid/video.m4s",
        mediaElement: element,
        mediaContentType: "application/x-mpegURL",
        mediaTitle: "matrix",
        mediaIdentity,
        isVideo: true,
        remoteProxy: {
            referer: BILIBILI_REFERER,
            audioUrl: opts.audioUrl ?? "https://example.invalid/audio.m4s"
        },
        forwardPageControls: true,
        gestureGatedControls: true,
        debug: noop
    });

    const sessionState = { media: [], loadRequests: [] };
    const started = [];
    const state = {
        sender,
        element,
        started,
        loadRequests: sessionState.loadRequests,
        /** Remux generations this sender has started (the observable restart). */
        restarts: () => started.length,
        tick: async () => {
            if (latestInterval) latestInterval();
            await flush();
        },
        /** The requestId of the generation the receiver is currently served. */
        liveRequestId: () => started.at(-1)?.requestId,
        /** The page key of the media being played right now. */
        mediaIdentity: () => mediaIdentity,
        /** The key a switch will adopt: a different video. */
        nextMediaIdentity: () =>
            `video-${String.fromCharCode(97 + ++mediaIdentityGeneration)}`,
        /** The content id a session for the live generation reports. */
        contentIdForGeneration: requestId =>
            `http://127.0.0.1:9555/s/${requestId}/index.m3u8`,
        setReceiverState: (
            playerState,
            estimatedTime,
            mediaSessionId,
            requestId = started.at(-1)?.requestId
        ) => {
            const media = makeMedia(
                playerState,
                estimatedTime,
                mediaSessionId,
                state.contentIdForGeneration(requestId)
            );
            sessionState.media = [...sessionState.media.slice(-2), media];
            return media;
        },
        lastLoad: () => sessionState.loadRequests.at(-1),
        /**
         * Hold the element's `seeked` back: the page has been ASKED to move and
         * has not arrived. The state a row uses to prove that nothing downstream
         * may start on an unconfirmed target.
         */
        deferPageSeeks: () => {
            pageSeeksDeferred = true;
        },
        /**
         * Deliver the element's `seeked`: the page has arrived. The CURRENT
         * element, not the one the fixture was built with - a switch replaces it
         * (see driveItemChange).
         */
        completePageSeek: () => state.element.completePageSeek(),
        /** The fixture's own arrival, for rows that are not testing the wait. */
        autoCompletePageSeek: () => {
            if (pageSeeksDeferred) return;
            // With the paused-player model the fixture may only deliver the
            // arrival if the element is playing - that rule IS the reported
            // symptom (pause the page, write currentTime, and the position waits
            // for something to play the page again).
            if (state.element.pausedPlayerModel && state.element.paused) return;
            state.element.completePageSeek();
        },
        /**
         * Model the page player as it really behaves: a seek requested while it is
         * PAUSED does not land until it is played again (`element.play()`, which
         * is what the receiver's PLAYING report causes through resumePage).
         */
        modelPausedPagePlayer: () => {
            state.element.pausedPlayerModel = true;
        },
        /**
         * Every receiver-side play/pause/seek the sender has issued, MONOTONIC
         * across sessions (a session window that slides must not make the total go
         * down). "Did the sender COMMAND the receiver" is a different question from
         * "what state did the receiver report": a status report must never produce
         * a command, and a skip must never produce a play.
         */
        receiverCommandTotals: () => ({ ...receiverCommands }),
        resolveLoad: media => {
            const entry = sessionState.loadRequests.at(-1);
            if (!entry) return false;
            entry.onSuccess(media ?? entry.media);
            return true;
        }
    };

    sender.session = {
        receiver: { label: "Chromecast-MATRIX" },
        get media() {
            return sessionState.media;
        },
        set media(value) {
            sessionState.media = value;
        },
        loadMedia: (request, onSuccess, onError) => {
            sessionState.loadRequests.push({
                request,
                onSuccess,
                onError,
                // A LOAD callback's own Media can be the previous session's
                // object (the real SDK behaves this way). The rows that need a
                // specific session pass one explicitly to resolveLoad.
                media: makeMedia(
                    PlayerState.PLAYING,
                    request.currentTime ?? 0,
                    sessionState.loadRequests.length + 1,
                    state.contentIdForGeneration(undefined)
                )
            });
        },
        addUpdateListener: noop,
        removeUpdateListener: noop,
        stop: noop,
        sendMessage: noop
    };

    latestInterval = undefined;
    sender.addMediaElementListeners(element);
    global.__onCastPortMessage = message => {
        if (message?.subject === "bridge:startRemoteMediaServer") {
            started.push(message.data);
        }
    };
    await flush();
    return state;
}

/**
 * Answer the newest `bridge:startRemoteMediaServer` with the plan for the page
 * position it asked for and the keyframe the probe would report. This is the
 * only place a bridge answer is fabricated, and it is fabricated from the
 * bridge's own arithmetic (layer 1).
 */
async function answerBridgeWithPlan(plan) {
    const requestId = global.__lastStartedRequestId;
    global.__castPortDispatch({
        subject: "mediaCast:mediaServerStarted",
        data: {
            requestId,
            // Generation-scoped, as the bridge serves it; the sender appends its
            // own cache-busting query on top.
            mediaPath: `s/${requestId}/index.m3u8`,
            localAddress: "127.0.0.1",
            mode: "dash-remux",
            startTime: plan.pageStart,
            padBaseSeconds: plan.padBase,
            probedKeyframeSeconds: plan.contentBase,
            presentationStartTime: plan.receiverStart,
            pageDuration: PAGE_DURATION
        }
    });
    await flush();
}

// ---------------------------------------------------------------------------
// 4. Driving the origin's entry point
// ---------------------------------------------------------------------------

/** A real user drag on the site's progress bar: gesture, then the event pair. */
async function drivePageSeek(h, target, { gesture = true } = {}) {
    if (gesture) global.__dispatchGesture();
    h.element.placeAt(target);
    // This pair IS the element's echo of the move above (a user's own drag), so
    // nothing is left owed for a later programmatic-write echo to invent.
    h.element.emit("seeking");
    h.element.emit("seeked");
    await flush();
    await fireSeekDebounce(h);
}

/** The popup's seek route (background/castManager -> page sender). */
async function drivePopupSeek(h, target) {
    h.sender.seekDashRemux(target);
    await flush();
    await fireSeekDebounce(h);
}

/**
 * Fire the seek debounce and let the page arrive.
 *
 * The restart's own page hold is a WRITE; the element then reports `seeked` when
 * it has the data, and the sender's handoff waits for exactly that before it
 * starts the generation (see MediaSender#ensurePageAtTarget). A row that is
 * proving the wait holds the arrival back itself (see deferPageSeeks), which is
 * why this is a helper and not something baked into the driver's actions.
 */
async function fireSeekDebounce(h) {
    fireTimeout(SEEK_DEBOUNCE_MS);
    await flush();
    h.autoCompletePageSeek();
    await flush();
}

/**
 * The browser's echo of the extension's OWN page write.
 *
 * `writePageTime` moves the element, and a real element then queues a
 * `seeking`/`seeked` pair for that move; the sender attributes that pair to its
 * own write. A harness whose setter fires nothing leaves the attribution window
 * open for the full PAGE_WRITE_ACK_WINDOW_MS and the NEXT user seek gets
 * swallowed by it - a harness artifact, not a product behaviour. It is emitted
 * only when the element actually moved: a write the sender skipped (the page was
 * already at the target) produces no event in a browser either, and inventing one
 * would be indistinguishable from a page seek.
 */
async function echoProgrammaticWrite(h) {
    if (!h.element.takeWriteEcho()) return false;
    // The write fired its own `seeking` (the element acknowledging the request);
    // this is the arrival, which the fixture delivers now unless the row is
    // deliberately holding it back (see deferPageSeeks).
    h.autoCompletePageSeek();
    await flush();
    return true;
}

/** A BLE skip that lands on `target`: the page sits one step ahead of it. */
async function driveBleSeek(h, target, step = 30) {
    h.element.placeAt(target + step);
    h.sender.controlFromBleRemote("seek_backward", step, 0);
    await flush();
    await fireSeekDebounce(h);
}

/**
 * A new video (or a new element for the same video): the page sender's own
 * sequence — the transition window opens BEFORE the reload, then the updated
 * element is handed to `updateMedia`.
 */
async function driveItemChange(
    h,
    target,
    { sameElement = false, identity } = {}
) {
    const element = sameElement
        ? h.element
        : makeElement({ paused: false, currentTime: target });
    if (!sameElement) {
        // The harness states where the new page is; that is not a browser event
        // for a later programmatic-write echo to claim.
        element.placeAt(target);
        h.element = element;
    }
    // A new page element is a NEW video, so its key changes; a quality change is
    // the same video (and the same key), which is what lets a pending seek survive
    // one and not the other (see MediaSender#adoptMediaIdentity).
    const mediaIdentity =
        identity ?? (sameElement ? h.mediaIdentity() : h.nextMediaIdentity());
    h.sender.beginDashItemTransition();
    h.sender.prepareUpdatedMediaElement(element);
    void h.sender
        .updateMedia({
            mediaUrl: sameElement
                ? "https://example.invalid/video-quality-2.m4s"
                : "https://example.invalid/video-next.m4s",
            mediaTitle: "matrix-next",
            mediaContentType: "application/x-mpegURL",
            mediaElement: element,
            mediaIdentity,
            isVideo: true,
            remoteProxy: {
                referer: BILIBILI_REFERER,
                audioUrl: "https://example.invalid/audio-next.m4s"
            },
            forwardPageControls: true,
            gestureGatedControls: true,
            debug: noop
        })
        .catch(() => undefined);
    await flush();
    return element;
}

/**
 * Run one full load on a live cast: the entry point produces the bridge request,
 * the bridge answers with the plan built from the position it was asked for, and
 * the receiver accepts the LOAD. Returns what the whole chain produced.
 */
async function runOrigin(
    MediaSender,
    origin,
    target,
    keyframe,
    planFor,
    startupPadding = true
) {
    const h = await makeSender(MediaSender, {
        pageTime: origin.needsLiveCast ? BASELINE_PAGE_TIME : target,
        startupPadding
    });

    // ---- baseline: a running cast for the origins that only exist on one ----
    let baselineLoads = 0;
    if (origin.needsLiveCast) {
        h.sender.loadMedia().catch(() => undefined);
        await flush();
        const baselinePlan = planFor(BASELINE_PAGE_TIME, BASELINE_PAGE_TIME);
        global.__lastStartedRequestId = h.started.at(-1)?.requestId;
        await answerBridgeWithPlan(baselinePlan);
        h.resolveLoad(
            makeMedia(
                PlayerState.PLAYING,
                baselinePlan.receiverStart,
                1,
                h.contentIdForGeneration(h.liveRequestId())
            )
        );
        await flush();
        await h.tick();
        baselineLoads = h.loadRequests.length;
    }
    const generationsBefore = h.restarts();
    const loadsBefore = h.loadRequests.length;

    // ---- the action -------------------------------------------------------
    let expectedPageStart = target;
    if (origin.id === "page-seek") {
        await drivePageSeek(h, target);
    } else if (origin.id === "popup-seek") {
        await drivePopupSeek(h, target);
    } else if (origin.id === "ble-seek") {
        await driveBleSeek(h, target);
    } else if (origin.id === "item-change") {
        await driveItemChange(h, target);
    } else if (origin.id === "quality-change") {
        // The quality change keeps the element and the video: the media URL
        // changes, and the page is wherever playback has reached. The harness
        // has no real player, so "playback has reached the target" is stated by
        // moving the element there - the same input a playing page would supply.
        // It is deliberately NOT a seek: no events, no intent.
        expectedPageStart = target;
        h.element.placeAt(target);
        await driveItemChange(h, target, { sameElement: true });
    } else {
        // initial-cast / reload: the load takes the page's current position.
        expectedPageStart = h.element.currentTime;
        h.sender.loadMedia().catch(() => undefined);
        await flush();
    }

    const generated = h.started.length - generationsBefore;
    if (generated !== 1) {
        return {
            h,
            generated,
            loads: h.loadRequests.length - loadsBefore,
            expectedPageStart,
            plan: planFor(expectedPageStart, keyframe, startupPadding),
            observed: undefined
        };
    }

    const started = h.started.at(-1);
    const plan = planFor(expectedPageStart, keyframe, startupPadding);
    global.__lastStartedRequestId = started.requestId;
    await answerBridgeWithPlan(plan);
    const loadEntry = h.loadRequests.at(-1);
    if (loadEntry) {
        h.resolveLoad(
            makeMedia(
                PlayerState.PLAYING,
                plan.receiverStart,
                (baselineLoads || 0) + 2,
                h.contentIdForGeneration(started.requestId)
            )
        );
        await flush();
    }
    const loads = h.loadRequests.length - loadsBefore;

    return {
        h,
        generated,
        loads,
        started,
        plan,
        expectedPageStart,
        observed: loadEntry
            ? {
                  bridgeStart: started.startTime,
                  load: loadEntry.request.currentTime,
                  offset: loadEntry.request.media?.customData
                      ?.presentationOffsetSeconds,
                  dashStart: loadEntry.request.media?.customData?.dashStart,
                  page: h.element.currentTime
              }
            : undefined
    };
}

// ---------------------------------------------------------------------------
// 5. Assertions
// ---------------------------------------------------------------------------

const EPSILON = 1e-6;

function mismatch(observed, expected) {
    const out = [];
    for (const key of Object.keys(expected)) {
        const want = expected[key];
        const got = observed[key];
        const ok =
            typeof want === "number"
                ? typeof got === "number" && Math.abs(got - want) < EPSILON
                : got === want;
        if (!ok) out.push(`${key}=${got} (expected ${want})`);
    }
    return out.join(", ");
}

/** The plan a step's tuple is judged against, in one comparable string. */
function planKey(plan) {
    return [
        plan.pageStart,
        plan.contentBase,
        plan.padDuration,
        plan.requiredPadDuration,
        plan.padsSufficient,
        plan.presentationOffset,
        plan.receiverStart,
        plan.offset,
        plan.padEntries,
        plan.firstSegment,
        plan.padRunway,
        plan.clock
    ]
        .map(value =>
            typeof value === "number" ? Number(value.toFixed(6)) : value
        )
        .join("|");
}

/** The tuple an entry point produced, in one comparable string. */
function timelineKey(run) {
    if (!run?.observed) return "no-observation";
    return [
        run.observed.bridgeStart,
        run.observed.load,
        run.observed.offset,
        run.observed.dashStart,
        run.observed.page,
        planKey(run.plan)
    ]
        .map(value =>
            typeof value === "number" ? Number(value.toFixed(6)) : value
        )
        .join("|");
}

// ---------------------------------------------------------------------------
// 6. The matrix
// ---------------------------------------------------------------------------

async function runMatrix(MediaSender, bridge) {
    const planFor = (pageStart, keyframe, startupPadding = true) =>
        bridge.plan(pageStart, keyframe, startupPadding);

    console.info("");
    console.info(
        `=== the plan matrix: ${ORIGINS.length} entry points x ${TARGET_CASES.length} targets ===`
    );

    const groups = [
        {
            label: "startup padding ON",
            cases: TARGET_CASES,
            startupPadding: true
        },
        {
            label: "startup padding OFF",
            cases: NO_PADDING_TARGET_CASES,
            startupPadding: false
        }
    ];
    for (const group of groups) {
        console.info("");
        console.info(`  -- ${group.label} --`);
        for (const targetCase of group.cases) {
            const plan = planFor(
                targetCase.target,
                targetCase.keyframe,
                group.startupPadding
            );
            const label = `${group.label} | page ${targetCase.target}s, keyframe ${targetCase.keyframe} → ${plan.padRunway}, ${plan.clock} (pads ${plan.padDuration}s/${plan.requiredPadDuration}s, offset ${plan.presentationOffset}s)`;

            // ---- the bridge's own plan for these inputs ------------------------
            check(
                `bridge: ${label}`,
                mismatch(plan, targetCase.expect) === "" &&
                    plan.padsSufficient ===
                        plan.padDuration >= plan.requiredPadDuration,
                mismatch(plan, targetCase.expect) ||
                    `padsSufficient=${plan.padsSufficient} does not follow from padDuration ${plan.padDuration} >= required ${plan.requiredPadDuration}`
            );

            // ---- every entry point must produce that plan ----------------------
            const runs = [];
            for (const origin of ORIGINS) {
                const run = await runOrigin(
                    MediaSender,
                    origin,
                    targetCase.target,
                    targetCase.keyframe,
                    planFor,
                    group.startupPadding
                );
                runs.push({ origin, run });
            }
            const expectedTuple = {
                bridgeStart: targetCase.target,
                load: plan.receiverStart,
                offset: plan.offset,
                dashStart: targetCase.target,
                page: targetCase.target
            };
            const offenders = [];
            for (const { origin, run } of runs) {
                if (run.generated !== 1 || run.loads !== 1 || !run.observed) {
                    offenders.push(
                        `${origin.label}: generations=${run.generated}, loads=${run.loads}`
                    );
                    continue;
                }
                const detail = mismatch(run.observed, expectedTuple);
                if (detail) offenders.push(`${origin.label}: ${detail}`);
                if (timelineKey(run) !== timelineKey(runs[0].run)) {
                    offenders.push(
                        `${origin.label}: ${timelineKey(run)} != ${
                            runs[0].origin.label
                        }'s ${timelineKey(runs[0].run)}`
                    );
                }
            }
            check(
                `entries: ${label} → LOAD ${plan.receiverStart}, offset ${plan.offset}, ${plan.padEntries} pads, all ${ORIGINS.length} entry points identical`,
                offenders.length === 0,
                offenders.join("; ")
            );
        }
    }

    // ---- the statements that must hold ACROSS the matrix -------------------
    console.info("");
    console.info(
        "=== pad / offset statements (no target is special-cased) ==="
    );
    const opening = planFor(0, 0);
    check(
        `pads: the required startup pad runway is ${bridge.minPadSeconds}s = ${
            bridge.minPadSeconds / bridge.padSegmentSeconds
        } x ${bridge.padSegmentSeconds}s pads`,
        opening.padDuration === bridge.minPadSeconds &&
            opening.requiredPadDuration === bridge.minPadSeconds &&
            opening.padsSufficient === true &&
            opening.padEntries ===
                bridge.minPadSeconds / bridge.padSegmentSeconds &&
            opening.firstSegment === "pad.ts",
        JSON.stringify(opening)
    );
    check(
        "pads: pad duration is padBase, NOT padBase - contentBase (the latter is the clock offset)",
        planFor(581.605, 581).padDuration === 581 &&
            planFor(581.605, 581).presentationOffset === 0 &&
            planFor(36, 4).padDuration === 32 &&
            planFor(36, 4).presentationOffset === 28,
        JSON.stringify([planFor(581.605, 581), planFor(36, 4)])
    );
    check(
        "pads: offset 0 does NOT mean 'no pads' - a mid-video restart carries hundreds of seconds and is a no-offset clock",
        planFor(1431.805, 1431).padRunway === "full-pad-runway" &&
            planFor(1431.805, 1431).clock === "no-offset" &&
            planFor(1431.805, 1431).padsSufficient === true &&
            planFor(1431.805, 1431).padEntries ===
                Math.floor(1431 / bridge.padSegmentSeconds) + 1,
        JSON.stringify(planFor(1431.805, 1431))
    );
    check(
        "pads: a target PAST the minimum pad base still carries the whole runway when the content's first keyframe is 0 (not a 0:00 case)",
        planFor(32, 0).padsSufficient === true &&
            planFor(32, 0).padDuration === bridge.minPadSeconds &&
            planFor(32, 0).clock === "shifted",
        JSON.stringify(planFor(32, 0))
    );
    check(
        "pads: insufficient pads exist only with startup padding OFF - an opening cast then has NO runway, and a mid-video one still has plenty",
        planFor(0, 0, false).padDuration === 0 &&
            planFor(0, 0, false).padsSufficient === false &&
            planFor(0, 0, false).padRunway === "no-pad-runway" &&
            planFor(0, 0, false).firstSegment === "segment-000000.ts" &&
            planFor(36, 4, false).padDuration === 4 &&
            planFor(36, 4, false).padRunway === "short-pad-runway" &&
            planFor(581.605, 581, false).padRunway === "full-pad-runway",
        JSON.stringify([
            planFor(0, 0, false),
            planFor(36, 4, false),
            planFor(581.605, 581, false)
        ])
    );
    const nearZero = planFor(0.001, 0);
    check(
        "pads: 0 and 0.001 differ by exactly the page position (no shape discontinuity)",
        nearZero.padBase === opening.padBase &&
            Math.abs(nearZero.receiverStart - (opening.receiverStart + 0.001)) <
                EPSILON,
        JSON.stringify({ opening, nearZero })
    );
    const mid = planFor(1431.805, 1431);
    check(
        "pads (health control): mid-video keeps pad base = keyframe, LOAD = page position, offset 0",
        mid.padBase === 1431 &&
            mid.receiverStart === 1431.805 &&
            mid.offset === 0 &&
            mid.presentationOffset === 0 &&
            mid.padDuration === 1431,
        JSON.stringify(mid)
    );

    return planFor;
}

// ---------------------------------------------------------------------------
// 7. Continuous sequences: the flows a viewer actually produces
// ---------------------------------------------------------------------------

/**
 * Everything above measures ONE action in isolation, from a fresh fixture. These
 * scenarios measure the actions the way they really arrive: on ONE live cast,
 * one after another, with the receiver's sessions evolving in between and
 * NOTHING reset between steps. A step's plan therefore has to be right for the
 * state the previous step left behind - which is the property "fix one, break
 * another" kept destroying.
 *
 * Nothing here is judged by whether the target is 0:00. A step is judged by its
 * PLAN: its pad runway (`padDuration >= requiredPadDuration`) and its clock
 * (`shifted` / `no-offset`), both derived from the plan's own inputs - whatever
 * the previous step did: a mid-video seek, a popup seek, a
 * video switch, a quality change, a pause, or a burst of seeks that ended
 * somewhere else. 0:00 appears in the flows because that is where viewers drag
 * the bar, not because it decides anything.
 *
 * The flows, all of them continuous:
 *
 *   A  the page's progress bar to 0:00, mid-video      (+ status, + a repeat)
 *   B  the popup's seek to 0:00                        (+ the write's echo)
 *   C  popup to 5:00 then back to 0:00 in ONE debounce window (a fast drag)
 *   D  popup to 5:00 then back to 0:00, first generation already in flight
 *   E  switch to a new video that starts at 0:00       (+ its own seek to 0)
 *   F  switch to 0:00, then the popup back to 0:00
 *   G  switch to 0:00, then the PAGE's progress bar to 0:00
 *   H  a popup seek during the switch's load (the intent a switch swallows)
 *   I  page seek to 0:00, then a quality change with the page at 0:00
 *   J  page seek to 0:00 -> popup to 5:00 -> page back to 0:00
 *   K  a BLE skip back to 0:00
 *   L  the player's own (ungestured) seek during playback
 *   M  session hygiene: a stop after a seek
 *   N  a page seek during the switch's load (listeners detached: not forwarded)
 */

/**
 * The keyframe a probe would report for a start: the last one at/before it.
 * Below the runway the video's first keyframe is 0, which is exactly what makes
 * the opening window; past it, any keyframe <= start leaves the offset at 0, so
 * only the pad count depends on the model.
 */
function keyframeFor(pageStart) {
    if (pageStart < bridgePlan.minPadSeconds) return 0;
    return Math.floor(pageStart);
}

/** The tuple a step is judged on: the plan AND the page position it left. */
function timelineOf(entry, plan, pageSeconds) {
    return [
        entry.startTime,
        entry.load.request.currentTime,
        entry.load.request.media?.customData?.presentationOffsetSeconds,
        entry.load.request.media?.customData?.dashStart,
        plan.padDuration,
        plan.padEntries,
        plan.firstSegment,
        plan.padRunway,
        plan.clock,
        pageSeconds
    ]
        .map(value =>
            typeof value === "number" ? Number(value.toFixed(6)) : value
        )
        .join("|");
}

/**
 * ONE live cast, driven step by step. Every method is a production entry point;
 * the only thing the driver adds is the counterpart each entry point needs: the
 * bridge's answer (built from the bridge's own arithmetic), a receiver that
 * accepts the LOAD and then reports its own position, and the browser's echo of
 * the extension's own page writes.
 */
async function startCast(MediaSender, { pageTime = 0 } = {}) {
    const h = await makeSender(MediaSender, { pageTime });
    const answered = new Set();
    const generations = [];
    let sessionId = 1;

    const cast = {
        h,
        generations,
        plan: pageStart => bridgePlan.plan(pageStart, keyframeFor(pageStart)),

        /**
         * Answer the newest unanswered generation: the bridge states the plan
         * for the position the sender asked for, the receiver accepts the LOAD,
         * and then reports where it was loaded (the padded position) on its own
         * clock. That report is also what closes an item transition and releases
         * a seek's priming window, so it belongs in every step.
         */
        async answerNewest() {
            const started = h.started.at(-1);
            if (!started || answered.has(started.requestId)) return false;
            answered.add(started.requestId);
            const plan = cast.plan(started.startTime);
            cast.lastPlan = plan;
            global.__lastStartedRequestId = started.requestId;
            await answerBridgeWithPlan(plan);
            const load = h.lastLoad();
            const session = ++sessionId;
            // What the receiver does with the LOAD follows its `autoplay`, which
            // is the sender's statement of the USER's playback intent: a reload
            // for a paused user loads paused and stays paused. A harness that
            // always reported PLAYING here would make "the pause survived" and
            // "the pause was overwritten" indistinguishable.
            const receiverState =
                load?.request?.autoplay === false
                    ? PlayerState.PAUSED
                    : PlayerState.PLAYING;
            h.resolveLoad(
                makeMedia(
                    receiverState,
                    plan.receiverStart,
                    session,
                    h.contentIdForGeneration(started.requestId)
                )
            );
            await flush();
            h.setReceiverState(
                receiverState,
                plan.receiverStart,
                session,
                started.requestId
            );
            await h.tick();
            generations.push({
                requestId: started.requestId,
                startTime: started.startTime,
                plan,
                load
            });
            return true;
        },

        /**
         * Answer the newest generation's bridge request and then have the
         * receiver REFUSE the LOAD (the SDK error callback). The rows about a
         * FAILED item load need this: the question is what happens to an explicit
         * seek that the failed load had coalesced.
         */
        async answerAndRefuseNewest(reason = "INTERRUPTED") {
            const started = h.started.at(-1);
            if (!started || answered.has(started.requestId)) return false;
            answered.add(started.requestId);
            const plan = cast.plan(started.startTime);
            cast.lastPlan = plan;
            global.__lastStartedRequestId = started.requestId;
            await answerBridgeWithPlan(plan);
            const load = h.lastLoad();
            generations.push({
                requestId: started.requestId,
                startTime: started.startTime,
                plan,
                load,
                refused: true
            });
            load?.onError?.({ code: "INVALID_REQUEST", description: reason });
            await flush();
            return true;
        },

        /** Await the bridge request a just-started action is going to post. */
        async waitForGeneration(rounds = 40) {
            for (let i = 0; i < rounds; i++) {
                const started = h.started.at(-1);
                if (started && !answered.has(started.requestId)) return started;
                await flush(2);
            }
            return undefined;
        },

        /**
         * Drain the transaction loop. A burst that was queued while one
         * generation was in flight is served one generation per intent, so the
         * loop's own sequencing is part of what a step measures.
         */
        async settle(max = 8) {
            // The page's own arrival is part of "settled": a row that is not
            // testing the wait must not have to deliver it by hand. It is
            // re-checked every round, because a restart the settle itself
            // releases can owe a fresh one.
            for (let round = 0; round < max; round++) {
                h.autoCompletePageSeek();
                if (!(await cast.answerNewest())) break;
                h.autoCompletePageSeek();
                await flush();
            }
            h.autoCompletePageSeek();
            return cast;
        },

        /** The cast's own load (an initial cast, or a recovery-shaped reload). */
        async boot() {
            h.sender.loadMedia().catch(() => undefined);
            await flush();
            return cast.settle();
        },

        // ---- the user's actions ------------------------------------------
        /** The page's progress bar: a gesture, then the browser's event pair. */
        /**
         * Hold the element's `seeked` back: the page has been ASKED to move and
         * has not arrived. This is the state a row uses to prove nothing
         * downstream may start on an unconfirmed target.
         */
        deferPageSeeks() {
            h.deferPageSeeks();
            return cast;
        },

        /**
         * Model the page player as it really behaves: a seek asked for while it is
         * PAUSED only lands once it is played again.
         */
        modelPausedPagePlayer() {
            h.modelPausedPagePlayer();
            return cast;
        },

        /** Deliver the element's `seeked`: the page has arrived. */
        async completePageSeek() {
            pageSeeksDeferred = false;
            h.completePageSeek();
            await flush();
            return cast;
        },

        /** The fixture's own arrival, for rows that are not testing the wait. */
        autoCompletePageSeek() {
            h.autoCompletePageSeek();
            return cast;
        },

        async pageSeek(seconds, { gesture = true } = {}) {
            if (gesture) global.__dispatchGesture();
            h.element.placeAt(seconds);
            // The pair below IS the element's event for that move.
            h.element.emit("seeking");
            h.element.emit("seeked");
            await flush();
            await fireSeekDebounce(h);
            return cast;
        },

        /** The player's own seek (buffering, quality, navigation): no gesture. */
        autonomousSeek(seconds) {
            return cast.pageSeek(seconds, { gesture: false });
        },

        /**
         * The popup's seek. `debounce: false` leaves it queued inside the
         * debounce window, which is what a second drag before the first restart
         * begins looks like; the default fires the window, starting the restart.
         */
        async popupSeek(seconds, { debounce = true } = {}) {
            h.sender.seekDashRemux(seconds);
            await flush();
            // The hold parks the page at the target; the element's echo of that
            // write belongs to the write (see echoProgrammaticWrite).
            await echoProgrammaticWrite(h);
            if (debounce) await fireSeekDebounce(h);
            return cast;
        },

        /** A BLE skip that lands on `seconds`: the page sits one step ahead. */
        /**
         * A raw BLE remote command, with no help from the page.
         *
         * `at` places the page exactly there first, and `target` places it one step
         * away from a skip's landing position - both are "where the page already
         * is", written without events, because that is the input the command needs.
         * Without either, the page stays where it is, which is what the no-op rows
         * (a skip at a boundary) and the play/pause rows need.
         */
        async ble(action, { target, at, step = 30 } = {}) {
            if (at !== undefined) {
                h.element.placeAt(at);
            } else if (target !== undefined) {
                h.element.placeAt(
                    action === "seek_backward" ? target + step : target - step
                );
            }
            h.sender.controlFromBleRemote(
                action,
                action === "seek_backward" ? step : 0,
                action === "seek_forward" ? step : 0
            );
            await flush();
            await echoProgrammaticWrite(h);
            await fireSeekDebounce(h);
            return cast;
        },

        /** A BLE backward skip that lands on `seconds`. */
        bleSeek(seconds, step = 30) {
            return cast.ble("seek_backward", { target: seconds, step });
        },

        /**
         * A video switch: a new element for a new video, at `at`. `identity`
         * overrides the page key the switch adopts (the cross-video rows name the
         * videos they mean).
         */
        async switchVideo(at, options = {}) {
            await driveItemChange(h, at, options);
            return cast;
        },

        /**
         * A quality change: the same element, the same video, a new URL. The
         * page is wherever playback has reached, so "the page is at `at`" is
         * stated by moving the element there - deliberately not a seek: no
         * events, no intent.
         */
        async qualityChange(at) {
            // "Playback reached here" is not a browser event either.
            h.element.placeAt(at);
            await driveItemChange(h, at, { sameElement: true });
            return cast;
        },

        async pause() {
            h.sender.controlPlayback({
                intent: "PAUSE",
                commandId: `matrix-${++cast.commandId}`,
                mediaIdentity: "matrix"
            });
            await flush();
            fireTimeout(2000);
            await flush();
            return cast;
        },

        async play() {
            h.sender.controlPlayback({
                intent: "PLAY",
                commandId: `matrix-${++cast.commandId}`,
                mediaIdentity: "matrix"
            });
            await flush();
            fireTimeout(2000);
            await flush();
            return cast;
        },

        /**
         * A receiver session report, from ANY generation - including one that no
         * longer exists, which is the order a real receiver produces after a
         * reload: the old session keeps broadcasting while the new one starts.
         */
        async report(playerState, seconds, mediaSessionId, requestId) {
            h.setReceiverState(
                playerState,
                seconds,
                mediaSessionId,
                requestId ?? h.liveRequestId()
            );
            await h.tick();
            return cast;
        },

        /**
         * The receiver keeps talking after every action: its session reports
         * positions on its own (padded) clock, and a generation that no longer
         * exists can still broadcast. None of that may start a generation or
         * move the page.
         */
        async noise() {
            const current = h.liveRequestId();
            const padded = cast.lastPlan ? cast.lastPlan.receiverStart : 0;
            for (const [playerState, seconds] of [
                [PlayerState.PLAYING, padded],
                [PlayerState.PLAYING, 0],
                [PlayerState.PAUSED, padded],
                [PlayerState.BUFFERING, padded + 12],
                [PlayerState.PLAYING, padded + 40]
            ]) {
                h.setReceiverState(playerState, seconds, ++sessionId, current);
                await h.tick();
            }
            h.setReceiverState(
                PlayerState.PLAYING,
                999,
                999,
                "stale-generation"
            );
            await h.tick();
            return cast;
        }
    };
    cast.commandId = 0;
    return cast;
}

/** The opening cast every 0:00 step is compared against. */
async function captureOpeningReference(MediaSender) {
    const cast = await startCast(MediaSender, { pageTime: 0 });
    await cast.boot();
    const final = cast.generations.at(-1);
    return {
        key: timelineOf(final, final.plan, cast.h.element.currentTime),
        plan: final.plan
    };
}

const SCENARIOS = [
    {
        id: "A",
        name: "页面进度条拖到 0:00（cast 在 10:00 播放）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "页面拖到 0:00",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0,
                    autoplay: true
                }
            },
            {
                name: "接收端照常上报（含过期 session）后仍停在 0:00",
                run: cast => cast.noise(),
                contract: { generations: 0, pageAt: 0 }
            },
            {
                name: "再 popup 拖到 0:00（同一目标重复）",
                run: cast => cast.popupSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0,
                    autoplay: true
                }
            },
            {
                name: "popup 暂停再播放",
                run: async cast => {
                    await cast.pause();
                    await cast.play();
                },
                contract: { generations: 0 }
            }
        ]
    },
    {
        id: "B",
        name: "popup seek 到 0:00（cast 在 10:00 播放）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "popup 拖到 0:00（hold 写页 + 其回声）",
                run: cast => cast.popupSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "接收端照常上报",
                run: cast => cast.noise(),
                contract: { generations: 0, pageAt: 0 }
            }
        ]
    },
    {
        id: "C",
        name: "popup 到 5:00 再拖回 0:00（同一次 debounce 窗口内，快速拖动）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "popup 5:00 后立刻 popup 0:00（契约：只有最新的一次生效）",
                run: async cast => {
                    await cast.popupSeek(300, { debounce: false });
                    await cast.popupSeek(0);
                },
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                },
                gap: {
                    finalTarget: 300,
                    generations: 2,
                    pageAt: 0,
                    pads: "full-pad-runway",
                    clock: "no-offset"
                }
            }
        ]
    },
    {
        id: "D",
        name: "popup 到 5:00，再拖回 0:00（第一代已经在飞）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "popup 5:00（触发重启）后 popup 0:00（契约：页面与接收端都停在 0:00）",
                run: async cast => {
                    await cast.popupSeek(300);
                    await cast.popupSeek(0);
                },
                contract: {
                    finalTarget: 0,
                    generations: 2,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                },
                gap: {
                    finalTarget: 0,
                    generations: 2,
                    pageAt: 300,
                    pads: "full-pad-runway",
                    clock: "shifted"
                }
            }
        ]
    },
    {
        id: "E",
        name: "页面切换视频（新视频从 0:00 开始）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到新视频（页面 0:00）",
                run: cast => cast.switchVideo(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "播放器自己把新 video seek 到 0:00（无手势；契约：不得多出一代）",
                run: cast => cast.autonomousSeek(0),
                contract: { generations: 0, pageAt: 0 },
                gap: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "接收端照常上报（旧 session 与新 session 交替）",
                run: cast => cast.noise(),
                contract: { generations: 0, pageAt: 0 }
            }
        ]
    },
    {
        id: "F",
        name: "切到新视频（0:00）后再 popup 拖回 0:00",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到新视频",
                run: cast => cast.switchVideo(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "popup 拖到 0:00",
                run: cast => cast.popupSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "G",
        name: "切到新视频（0:00）后用页面进度条拖到 0:00",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到新视频",
                run: cast => cast.switchVideo(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "页面拖到 0:00（新元素上的监听已重挂）",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "H",
        name: "切视频加载期间 popup 拖到 2:00（切换会吞掉这个意图）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到 0:00 的新视频，加载中 popup 拖到 2:00（契约：2:00 生效；gap：什么都没发生）",
                run: async cast => {
                    await cast.switchVideo(0);
                    await cast.popupSeek(120);
                },
                contract: {
                    finalTarget: 120,
                    generations: 2,
                    pageAt: 120,
                    pads: "full-pad-runway",
                    clock: "no-offset"
                },
                gap: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "I",
        name: "页面拖到 0:00 后切画质（页面恰好在 0:00）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "页面拖到 0:00",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "切画质（同一视频、同一元素，页面在 0:00）",
                run: cast => cast.qualityChange(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "J",
        name: "页面拖到 0:00 → popup 到 5:00 → 页面拖回 0:00",
        start: { pageTime: 600 },
        steps: [
            {
                name: "页面拖到 0:00",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "popup 拖到 5:00",
                run: cast => cast.popupSeek(300),
                contract: {
                    finalTarget: 300,
                    generations: 1,
                    pageAt: 300,
                    pads: "full-pad-runway",
                    clock: "no-offset"
                }
            },
            {
                name: "页面拖回 0:00",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "K",
        name: "BLE 跳回 0:00（cast 在 10:00 播放）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "BLE 后退 30s 到 0:00",
                run: cast => cast.bleSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "L",
        name: "播放中播放器自己的 seek（无手势、非 BLE）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "播放器自己 seek 到 2:00（契约：不得重启 remux）",
                run: cast => cast.autonomousSeek(120),
                contract: { generations: 0, pageAt: 120 },
                gap: {
                    finalTarget: 120,
                    generations: 1,
                    pageAt: 120,
                    pads: "full-pad-runway",
                    clock: "no-offset"
                }
            }
        ]
    },
    {
        id: "M",
        name: "会话卫生：seek 之后 stop",
        start: { pageTime: 600 },
        steps: [
            {
                name: "popup 拖到 5:00",
                run: cast => cast.popupSeek(300),
                contract: {
                    finalTarget: 300,
                    generations: 1,
                    pageAt: 300,
                    pads: "full-pad-runway",
                    clock: "no-offset"
                }
            },
            {
                name: "stop：之后不得再有 LOAD，coordinator 回到 idle 且无 pending intent",
                run: async cast => {
                    cast.h.sender.stop();
                    await flush();
                    cast.loadsBeforeStop = cast.h.loadRequests.length;
                    // A bridge answer that arrives after the stop must be
                    // discarded instead of starting a LOAD on a dead session.
                    const started = cast.h.started.at(-1);
                    if (started) {
                        global.__lastStartedRequestId = started.requestId;
                        await answerBridgeWithPlan(
                            cast.plan(started.startTime)
                        );
                    }
                    await cast.h.tick();
                },
                contract: { generations: 0 },
                custom: (cast, mismatches) => {
                    const coordinator = cast.h.sender.getPlaybackCoordinator();
                    if (cast.h.loadRequests.length !== cast.loadsBeforeStop) {
                        mismatches.push("a LOAD followed the stop");
                    }
                    if (
                        coordinator.getPhase() !== "idle" ||
                        coordinator.peekIntent() !== undefined
                    ) {
                        mismatches.push(
                            `coordinator left at ${coordinator.getPhase()} with intent ${JSON.stringify(
                                coordinator.peekIntent()
                            )}`
                        );
                    }
                }
            }
        ]
    },
    {
        id: "N",
        name: "切视频加载期间页面自己拖到 0:00（元素监听已摘，事件不上报）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到 0:00 的新视频，加载中页面拖到 0:00（事实行：切换的一代是唯一的一代）",
                run: async cast => {
                    await cast.switchVideo(0);
                    await cast.pageSeek(0);
                },
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "O",
        name: "页面拖到 0:00 期间旧/新 session 状态乱序",
        start: { pageTime: 600 },
        steps: [
            {
                name: "页面拖到 0:00",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            },
            {
                name: "旧 session PLAYING → PAUSED → 新 session BUFFERING → PLAYING（乱序上报不改目标）",
                run: async cast => {
                    const previous = cast.generations.at(-2);
                    await cast.report(
                        PlayerState.PLAYING,
                        600,
                        4,
                        previous?.requestId
                    );
                    await cast.report(
                        PlayerState.PAUSED,
                        600,
                        4,
                        previous?.requestId
                    );
                    await cast.report(PlayerState.BUFFERING, 0, 5);
                    await cast.report(PlayerState.PLAYING, 0, 6);
                },
                contract: { generations: 0, pageAt: 0 }
            }
        ]
    },
    {
        id: "Q",
        name: "切视频加载期间 popup 5:00 与 BLE 0:00 竞争（最新的显式意图应胜）",
        start: { pageTime: 600 },
        steps: [
            {
                // A BLE skip used to be dropped here, because it reached the
                // receiver through the page-event closure and `loadCurrentItem`
                // detaches that closure for the reload - so of two racing explicit
                // intents the OLDER one won. The skip now enters the coordinator
                // directly (`controlFromBleRemote` -> `bleSeekTarget` ->
                // `seekDashRemux`), so the newest intent wins.
                name: "切到 2:00 的新视频（加载中）→ popup 拖到 5:00 → BLE 跳回 0:00（最新意图 0:00 胜）",
                run: async cast => {
                    await cast.switchVideo(120);
                    await cast.popupSeek(300, { debounce: false });
                    await cast.bleSeek(0);
                },
                contract: {
                    finalTarget: 0,
                    generations: 2,
                    pageAt: 0,
                    pads: "full-pad-runway",
                    clock: "shifted"
                },
                gap: {
                    finalTarget: 300,
                    generations: 2,
                    pageAt: 300,
                    pads: "full-pad-runway",
                    clock: "no-offset"
                }
            }
        ]
    },
    {
        id: "S",
        name: "popup 暂停期间页面拖到 0:00",
        start: { pageTime: 600 },
        steps: [
            {
                name: "popup 暂停",
                run: cast => cast.pause(),
                contract: { generations: 0 }
            },
            {
                // A seek changes the POSITION, not the user's playback intent:
                // the LOAD has to inherit `autoplay` from the state the user last
                // asked for, or a position transaction silently edits the
                // play/pause intent that another owner holds. The row asserts the
                // plan AND that the pause survived the reload.
                name: "页面拖到 0:00（暂停必须跨过这次 seek）",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0,
                    autoplay: false
                },
                gap: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0,
                    autoplay: true
                }
            },
            {
                name: "旧 PLAYING 迟到 + 新 BUFFERING：不得改变目标、不得创建 Generation、不得命令接收端",
                run: async cast => {
                    cast.beforeCommands = cast.h.receiverCommandTotals();
                    const previous = cast.generations.at(-2);
                    await cast.report(
                        PlayerState.PLAYING,
                        600,
                        4,
                        previous?.requestId
                    );
                    await cast.report(PlayerState.BUFFERING, 0, 5);
                },
                contract: {
                    generations: 0,
                    pageAt: 0,
                    custom: (cast, mismatches) => {
                        const before = cast.beforeCommands;
                        const after = cast.h.receiverCommandTotals();
                        const delta = {
                            pause: after.pause - before.pause,
                            play: after.play - before.play,
                            seek: after.seek - before.seek
                        };
                        if (delta.pause || delta.play || delta.seek) {
                            mismatches.push(
                                `a status report produced receiver commands ${JSON.stringify(
                                    delta
                                )} (an observation is not a command)`
                            );
                        }
                    }
                }
            },
            {
                name: "之后再 seek 一次：暂停意图仍在（LOAD autoplay 仍为 false）",
                run: cast => cast.pageSeek(0),
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0,
                    autoplay: false
                }
            }
        ]
    },
    {
        id: "T",
        name: "切换加载期间（页面控制被摘）的 BLE 指令",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到 0:00 的新视频，加载中 BLE 暂停再播放（契约：各一条接收端命令，绝不变成 seek）",
                run: async cast => {
                    cast.beforeCommands = cast.h.receiverCommandTotals();
                    await cast.switchVideo(0);
                    await cast.ble("pause");
                    await cast.ble("play");
                },
                contract: { generations: 1, pageAt: 0 },
                custom: (cast, mismatches) => {
                    const before = cast.beforeCommands;
                    const after = cast.h.receiverCommandTotals();
                    const delta = {
                        pause: after.pause - before.pause,
                        play: after.play - before.play,
                        seek: after.seek - before.seek
                    };
                    if (
                        delta.pause !== 1 ||
                        delta.play !== 1 ||
                        delta.seek !== 0
                    ) {
                        mismatches.push(
                            `receiver commands ${JSON.stringify(
                                delta
                            )} (expected one pause, one play, no seek: a BLE play/pause is not a skip)`
                        );
                    }
                }
            },
            {
                name: "BLE 后退到 0:00 边界（页面已在 0:00）：no-op，不得产生 Generation",
                run: cast => cast.ble("seek_backward"),
                contract: { generations: 0 }
            },
            {
                name: "BLE 前进到片尾边界：no-op，不得产生 Generation",
                run: cast => cast.ble("seek_forward", { at: PAGE_DURATION }),
                contract: { generations: 0 }
            },
            {
                name: "控制重挂之后 BLE 后退仍是真 Seek（0:00 的 opening 计划）",
                run: async cast => {
                    await cast.settle();
                    await cast.bleSeek(0);
                },
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                }
            }
        ]
    },
    {
        id: "U",
        name: "跨视频的残留 seek（B 加载期间 seek，B 的 LOAD 失败，页面已切到 C）",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到视频 B（0:00）+ popup 拖到 2:00 + B 的 LOAD 被拒（意图保留）",
                run: async cast => {
                    await cast.switchVideo(0, { identity: "video-B" });
                    await cast.popupSeek(120);
                    await cast.waitForGeneration();
                    await cast.answerAndRefuseNewest();
                },
                contract: { generations: 1, pageAt: 0 }
            },
            {
                name: "页面切到视频 C（0:00）：B 的 2:00 不得应用到 C",
                run: async cast => {
                    await cast.switchVideo(0, { identity: "video-C" });
                },
                contract: {
                    finalTarget: 0,
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    pageAt: 0
                },
                custom: (cast, mismatches) => {
                    const intent = cast.h.sender
                        .getPlaybackCoordinator()
                        .peekIntent();
                    if (intent) {
                        mismatches.push(
                            `a seek for another video survived the switch: ${JSON.stringify(
                                intent
                            )}`
                        );
                    }
                }
            }
        ]
    },
    {
        id: "V",
        name: "popup seek 到 opening 范围：页面必须在不等播放的情况下到达目标（已知缺陷）",
        start: { pageTime: 300 },
        steps: [
            {
                /**
                 * KNOWN DEFECT (red on purpose).
                 *
                 * The page player models reality here: a seek asked for while the
                 * element is PAUSED does not land - it lands when the element plays
                 * again. The sender pauses the page and THEN writes the target
                 * (onDashSeekStart), so the write is the request and the arrival
                 * waits for the receiver's PLAYING report (resumePage) - which is
                 * the reported symptom: the page sits paused at the OLD position
                 * until the Chromecast starts playing.
                 *
                 * The contract is the user-visible one: a seek to 10s must put the
                 * page at 10s without waiting for playback.
                 */
                name: "popup 拖到 10s（opening）→ 页面必须立即到 10s，不得等接收端 PLAYING",
                run: async cast => {
                    cast.modelPausedPagePlayer();
                    await cast.popupSeek(10);
                    // Sampled HERE, inside the run: the runner's own settle
                    // delivers the receiver's PLAYING, which resumes the page and
                    // lets the late arrival happen - checking after that would
                    // test the wrong moment.
                    cast.pageAtSeekTime = cast.h.element.currentTime;
                    cast.pageSeekStillPending =
                        cast.h.element.pendingSeek !== undefined;
                },
                contract: {
                    generations: 1,
                    pads: "full-pad-runway",
                    clock: "shifted",
                    /**
                     * Checked HERE, before the runner's settle delivers the
                     * receiver's PLAYING (which is what resumes the page and lets
                     * the late arrival happen): the user-visible claim is about the
                     * moment the seek is made, not about a minute later.
                     */
                    custom: (cast, mismatches) => {
                        if (Math.abs(cast.pageAtSeekTime - 10) > 0.1) {
                            mismatches.push(
                                `the page was at ${cast.pageAtSeekTime} when the seek returned (still on its way: pending=${cast.pageSeekStillPending}), not 10 - the position waits for the receiver's PLAYING to resume the page`
                            );
                        }
                    }
                }
            },
            {
                name: "接收端 PLAYING（resumePage 把页面重新 play）之后页面才到 10s —— 迟到的到达",
                run: async cast => {
                    await cast.report(PlayerState.PLAYING, 42, 4);
                    await cast.settle();
                },
                contract: { generations: 0, pageAt: 10 }
            }
        ]
    },
    {
        id: "R",
        name: "切换视频的 LOAD 被拒时仍有未满足的用户 seek",
        start: { pageTime: 600 },
        steps: [
            {
                name: "切到 0:00 的新视频 + popup 拖到 2:00，然后 LOAD 被拒（不得在没有页面控制时服务，也不得丢失意图）",
                run: async cast => {
                    await cast.switchVideo(0);
                    await cast.popupSeek(120);
                    await cast.waitForGeneration();
                    await cast.answerAndRefuseNewest();
                },
                contract: { generations: 1, pageAt: 0 },
                custom: (cast, mismatches) => {
                    const coordinator = cast.h.sender.getPlaybackCoordinator();
                    const intent = coordinator.peekIntent();
                    if (intent?.targetPageSeconds !== 120) {
                        mismatches.push(
                            `the pending seek was lost: ${JSON.stringify(
                                intent
                            )}`
                        );
                    }
                    if (coordinator.getPhase() !== "idle") {
                        mismatches.push(
                            `the coordinator is still holding the page: ${coordinator.getPhase()}`
                        );
                    }
                }
            },
            {
                name: "下一次成功 LOAD 时才服务它（2:00 目标）",
                run: async cast => {
                    // Whatever loads again is where the kept intent is served; a
                    // reload is the simplest honest stand-in for that.
                    cast.h.sender.loadMedia().catch(() => undefined);
                    await flush();
                    await cast.settle();
                },
                contract: {
                    finalTarget: 120,
                    generations: 2,
                    pageAt: 120,
                    pads: "full-pad-runway",
                    clock: "no-offset"
                }
            }
        ]
    }
];

/**
 * One step: run it, drain the generations it started, let the receiver talk, and
 * judge the whole result against the mode's expectation. The mode pair is what
 * makes this file a control as well as a contract: a step that differs between
 * the two modes is a behaviour that contradicts a documented rule, and every
 * other step must hold in BOTH.
 */
async function runScenarioStep(cast, scenario, index, step, reference) {
    const expect = FIXED ? step.contract : step.gap ?? step.contract;
    const before = {
        generations: cast.h.restarts(),
        loads: cast.h.loadRequests.length
    };

    await step.run(cast);
    await cast.settle();
    const afterAction = cast.h.restarts();
    await cast.noise();

    const mismatches = [];
    const addedGenerations = afterAction - before.generations;
    const addedLoads = cast.h.loadRequests.length - before.loads;
    const final = cast.generations.at(-1);

    if (addedGenerations !== expect.generations) {
        mismatches.push(
            `generations +${addedGenerations} (expected +${expect.generations})`
        );
    }
    if (addedLoads !== addedGenerations) {
        mismatches.push(
            `+${addedLoads} LOAD(s) for +${addedGenerations} generation(s)`
        );
    }
    if (cast.h.restarts() !== afterAction) {
        mismatches.push(
            `the receiver's own reports started ${
                cast.h.restarts() - afterAction
            } more generation(s)`
        );
    }
    if (expect.finalTarget !== undefined) {
        const wanted = cast.plan(expect.finalTarget);
        if (!final) {
            mismatches.push("no generation to inspect");
        } else {
            const loaded = final.load.request.currentTime;
            const offset =
                final.load.request.media?.customData?.presentationOffsetSeconds;
            const dashStart = final.load.request.media?.customData?.dashStart;
            if (Math.abs(final.startTime - expect.finalTarget) > EPSILON) {
                mismatches.push(
                    `bridge asked for ${final.startTime} (expected ${expect.finalTarget})`
                );
            }
            if (Math.abs(loaded - wanted.receiverStart) > EPSILON) {
                mismatches.push(
                    `LOAD ${loaded} (expected ${wanted.receiverStart})`
                );
            }
            if (Math.abs(offset - wanted.offset) > EPSILON) {
                mismatches.push(`offset ${offset} (expected ${wanted.offset})`);
            }
            if (
                expect.autoplay !== undefined &&
                final.load.request.autoplay !== expect.autoplay
            ) {
                mismatches.push(
                    `autoplay ${final.load.request.autoplay} (expected ${expect.autoplay}: a reload carries the USER's playback intent)`
                );
            }
            if (Math.abs(dashStart - expect.finalTarget) > EPSILON) {
                mismatches.push(
                    `dashStart ${dashStart} (expected ${expect.finalTarget})`
                );
            }
            // ---- the pads and the clock, kept apart --------------------------
            // The expectation is stated as pad sufficiency and as a clock, never
            // as "the target is 0:00". A step whose plan carries a full pad
            // runway must carry the same 8 pads the first opening cast got; a
            // step's clock is either shifted or not shifted - and a mid-video
            // restart is the legal combination "full pads AND no offset", which
            // is why the two are separate expectations rather than one mode.
            if (expect.pads === "full-pad-runway") {
                if (
                    wanted.padsSufficient !== true ||
                    wanted.padRunway !== "full-pad-runway"
                ) {
                    mismatches.push(
                        `pads ${wanted.padDuration}s of the required ${wanted.requiredPadDuration}s (${wanted.padRunway})`
                    );
                }
                if (wanted.firstSegment !== "pad.ts") {
                    mismatches.push(
                        "a sufficient pad runway must open the playlist (pad.ts first)"
                    );
                }
            } else if (expect.pads === "no-pad-runway") {
                if (
                    wanted.padDuration !== 0 ||
                    wanted.padsSufficient !== false
                ) {
                    mismatches.push(
                        `pads ${wanted.padDuration}s (expected none)`
                    );
                }
            }
            if (expect.clock !== undefined && wanted.clock !== expect.clock) {
                mismatches.push(
                    `clock ${wanted.clock} (offset ${wanted.presentationOffset}s, expected ${expect.clock})`
                );
            }
            // The very first opening cast, compared literally - because this
            // step's plan has the SAME inputs as that cast's (page 0, keyframe
            // 0), not because the target happens to be the beginning of the
            // video.
            if (
                reference &&
                wanted.pageStart === reference.plan.pageStart &&
                wanted.contentBase === reference.plan.contentBase
            ) {
                const key = timelineOf(
                    final,
                    wanted,
                    cast.h.element.currentTime
                );
                if (key !== reference.key) {
                    mismatches.push(
                        `tuple ${key} != the first opening cast's ${reference.key}`
                    );
                }
            }
        }
    } else if (expect.generations !== 0 && !final) {
        mismatches.push("no generation to inspect");
    }
    if (
        expect.pageAt !== undefined &&
        Math.abs(cast.h.element.currentTime - expect.pageAt) > EPSILON
    ) {
        mismatches.push(
            `page ${cast.h.element.currentTime} (expected ${expect.pageAt})`
        );
    }
    if (typeof expect.custom === "function") {
        expect.custom(cast, mismatches);
    }
    if (typeof step.custom === "function") {
        step.custom(cast, mismatches);
    }

    const summary =
        expect.finalTarget === undefined
            ? "+0 generation"
            : `final gen @ ${expect.finalTarget}s = load ${
                  cast.plan(expect.finalTarget).receiverStart
              }, offset ${cast.plan(expect.finalTarget).offset}, ${
                  cast.plan(expect.finalTarget).bootstrap
              }`;
    const modeTag = step.gap ? (LEGACY ? " [legacy 事实]" : " [契约]") : "";
    check(
        `${scenario.id}.${index} ${step.name} → ${summary}${modeTag}`,
        mismatches.length === 0,
        mismatches.join(", ")
    );
}

async function runSequences(MediaSender, reference) {
    console.info("");
    console.info(
        "=== continuous sequences (one live cast per flow, nothing reset between steps) ==="
    );
    if (reference) {
        console.info(
            `  reference (a cast that starts at page 0, keyframe 0): ${reference.key}`
        );
        console.info(
            `    = pads ${reference.plan.padDuration}s / required ${reference.plan.requiredPadDuration}s (${reference.plan.padRunway}), ${reference.plan.padEntries} pads, clock ${reference.plan.clock} (offset ${reference.plan.presentationOffset}s), receiver start ${reference.plan.receiverStart}`
        );
    }
    for (const scenario of SCENARIOS) {
        const cast = await startCast(MediaSender, scenario.start);
        await cast.boot();
        console.info(`\n  -- ${scenario.name} --`);
        let index = 0;
        for (const step of scenario.steps) {
            index++;
            await runScenarioStep(cast, scenario, index, step, reference);
        }
    }
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. Static audits: source SHAPE, not behaviour
// ---------------------------------------------------------------------------

/**
 * Properties a behaviour test can only catch by luck, because they are about
 * WHERE code sits rather than what it does when driven. Both have already been
 * broken once.
 *
 *   1. `serveSeekPendingFromItemChange` has exactly ONE call site, at the end of
 *      the LOAD success callback - after `addMediaElementListeners` re-attaches
 *      the page controls, so the generation it starts can park the page at its
 *      target. Serving it from `clearDashItemTransition` (which also runs from the
 *      deadline, a rejected load, and a session report) could start a generation
 *      whose hold is silently dropped, leaving the page where the previous step
 *      left it while the receiver played the new target.
 *   2. `clearDashItemTransition` therefore does not serve it, and the guard is
 *      this check rather than the comment above the method.
 *
 * Reading the source is the point: the correct call site LOOKS callable from
 * anywhere, and only its position makes it right.
 */
function runStaticAudits() {
    console.info("");
    console.info("=== static audits (source shape, not behaviour) ===");
    const source = fs.readFileSync(path.join(sendersDir, "media.ts"), "utf8");
    const callSites =
        source.split("this.serveSeekPendingFromItemChange()").length - 1;
    const definitions =
        source.split("private serveSeekPendingFromItemChange(").length - 1;
    check(
        "media.ts: serveSeekPendingFromItemChange has exactly ONE call site (plus its definition)",
        callSites === 1 && definitions === 1,
        JSON.stringify({ callSites, definitions })
    );
    const clearStart = source.indexOf("private clearDashItemTransition(");
    const serveStart = source.indexOf(
        "private serveSeekPendingFromItemChange("
    );
    check(
        "media.ts: clearDashItemTransition does not serve a pending seek (deadline / load-rejected / session-report paths have no page controls)",
        clearStart > 0 &&
            serveStart > clearStart &&
            !source
                .slice(clearStart, serveStart)
                .includes("serveSeekPendingFromItemChange()"),
        JSON.stringify({ clearStart, serveStart })
    );
    const lastReattach = source.lastIndexOf(
        "this.addMediaElementListeners(this.mediaElement);"
    );
    check(
        "media.ts: the call site sits AFTER the page controls are re-attached",
        lastReattach > 0 &&
            source.indexOf("this.serveSeekPendingFromItemChange()") >
                lastReattach,
        JSON.stringify({
            lastReattach,
            callSite: source.indexOf("this.serveSeekPendingFromItemChange()")
        })
    );
}

async function main() {
    const bridge = loadBridgePlan();
    bridgePlan = bridge;
    const { outfile, workDir } = await buildSender();
    installGlobals();
    const { MediaSender } = require(outfile);
    if (typeof MediaSender !== "function") {
        throw new Error(
            "dashLoadMatrix: the bundle did not export MediaSender"
        );
    }

    await runMatrix(MediaSender, bridge);
    // The reference a step is compared against whenever its plan has the same
    // inputs as the first opening cast (page 0, keyframe 0). It is measured, not
    // restated, so the comparison is with the agreement itself.
    const reference = await captureOpeningReference(MediaSender);
    await runSequences(MediaSender, reference);
    runStaticAudits();

    console.info("");
    console.info(
        `${pass}/${pass + fail} checks passed (source: ${
            PRE_FIX ? `${PRE_FIX_REV} via worktree` : "working tree"
        }, mode: ${LEGACY ? "--legacy / pre-fix facts" : "contract"})`
    );
    if (PRE_FIX) {
        // The control: against the pre-fix source the contract MUST fail, or the
        // rows measure nothing.
        if (fail === 0) {
            console.error(
                `dashLoadMatrix: --pre-fix expected failures at ${PRE_FIX_REV}, but every check passed`
            );
            process.exitCode = 1;
        } else {
            console.info(
                `  pre-fix control (${PRE_FIX_REV}): ${fail} contract check(s) failed as expected`
            );
            for (const name of failures) console.info("  - " + name);
            process.exitCode = 0;
        }
    } else {
        if (failures.length) {
            console.info("  failures: " + failures.join("; "));
        }
        process.exitCode = fail ? 1 : 0;
    }

    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
        // A leftover temp dir must not change the test result.
    }
}

main().catch(err => {
    if (PRE_FIX) {
        // The reverse control needs a revision that exposes the same sender API:
        // a checkout taken before the fixes but after the refactor they sit in.
        // A revision that predates the API cannot be measured at all, and saying
        // so is the answer - it is neither a passing contract nor a failure of
        // the contract.
        console.error(
            `dashLoadMatrix: --pre-fix at ${PRE_FIX_REV} could not drive the sender: ${
                err instanceof Error ? err.message : String(err)
            }`
        );
        console.error(
            "  Nothing was measured. Point --pre-fix at a revision that already carries this refactor (e.g. the commit that introduces the fixes)."
        );
        process.exitCode = 1;
        return;
    }
    console.error("dashLoadMatrix ERROR", err);
    process.exitCode = 1;
});
