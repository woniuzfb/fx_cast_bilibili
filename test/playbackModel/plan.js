"use strict";

/**
 * The bridge's DASH load plan, evaluated from the BRIDGE'S OWN SOURCE.
 *
 * The reference model and the model-based interleavings harness must not restate
 * this arithmetic: a restatement in a test would keep passing after the bridge
 * changed, and the point of the phase-3 model is to be an oracle for what the
 * implementation DOES. `mediaServer.ts` states the pad base and the presentation
 * start as single expressions over (start, keyframe); they are extracted and
 * evaluated here once, for every consumer:
 *
 *     padDuration         the pad MEDIA the playlist carries: the pads cover
 *                         [0, padBase), so this IS the pad base
 *     presentationOffset  padBase - contentBase: the CLOCK SHIFT, never the pad
 *                         size (a mid-video restart has 581s of pads and offset 0)
 *     receiverStart       padBase + (pageStart - contentBase): the LOAD position
 *     offset              receiverStart - pageStart: what the media states
 *
 * `padRunway` and `clock` name the two answers separately, so no consumer has to
 * infer one from the other - inferring the runway from the offset is the mistake
 * this separation exists to prevent.
 *
 * Usage:
 *     const { bridgePlan, keyframeFor } = require("../playbackModel/plan");
 *     bridgePlan.plan(pageStart, keyframe)   // the plan for one generation
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const bridgeMediaServer = path.join(
    repoRoot,
    "bridge/src/bridge/components/mediaServer.ts"
);

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
    // The pad POLICY, read out of its own named function in the bridge
    // (`dashPadBaseSeconds`). It used to be restated here, which made I7 check
    // this file's copy of the formula rather than the bridge's: a change to the
    // policy would have kept the harness green.
    const padPolicyMatch = new RegExp(
        `function dashPadBaseSeconds\\([\\s\\S]*?\\)\\s*:\\s*number\\s*\\{\\s*return ([\\s\\S]*?);\\s*\\}`
    ).exec(source);
    if (!padPolicyMatch) {
        throw new Error(
            "plan: the bridge's pad policy (dashPadBaseSeconds) was not found in mediaServer.ts"
        );
    }
    // The body's own names, bound to this fixture's values: `contentBaseSeconds`
    // is the probe's keyframe and `startupPadding` the option.
    // eslint-disable-next-line no-new-func
    const padBaseExpression = new Function(
        "keyframe",
        "minPadSeconds",
        "startupPadding",
        `const CHROMECAST_MIN_PAD_SECONDS = minPadSeconds;
         const contentBaseSeconds = keyframe;
         const startupPaddingEnabled = startupPadding;
         return ${padPolicyMatch[1].trim()};`
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

/**
 * The keyframe a probe would report for a start: the last one at/before it.
 * Below the runway the video's first keyframe is 0, which is exactly what makes
 * the opening window; past it, any keyframe <= start leaves the offset at 0, so
 * only the pad count depends on the model.
 *
 * This is the FIXTURE's probe model, not the bridge's: a row that needs the
 * "probe failed" path states its own keyframe instead of asking for one here.
 */
function keyframeFor(pageStart) {
    if (pageStart < bridgePlan.minPadSeconds) return 0;
    return Math.floor(pageStart);
}

/** The bridge plan for THIS checkout, evaluated once. */
const bridgePlan = loadBridgePlan();

module.exports = { loadBridgePlan, bridgePlan, keyframeFor };
