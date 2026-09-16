#!/usr/bin/env node
"use strict";

/**
 * Playback coordinator: what happens when the receiver moves the OTHER way.
 *
 * Reported from a real session: with a PAUSE still pending, a press of PLAY on
 * the physical Roku remote left the popup's button showing PLAY for several
 * seconds before it turned back into PAUSE. The hypothesis under test is about
 * the interaction between two real modules:
 *
 *   `background/playbackCommand.ts` - the coordinator. A sample that MATCHES the
 *   pending intent terminates the command; a sample that CONTRADICTS it
 *   (`opposite`) is only published, so the command stays active.
 *
 *   `playbackView.ts` - the popup's derivation. While a command is active it
 *   offers the INVERSE of that command's intent, whatever the receiver is
 *   actually doing.
 *
 * Together: PAUSE pending + receiver observed PLAYING => the button keeps
 * offering PLAY until the receiver watchdog finally terminates the command, even
 * though the coordinator already knows the receiver is playing.
 *
 * This drives the REAL bundled modules (esbuild, like the other decision-level
 * tests), with a fake clock so the watchdog can be fired deliberately, and
 * records for both scenarios:
 *
 *   classification of the accepted sample
 *   command lifecycle / receiverPhase / receiverPending
 *   the popup's next intent, from the real `nextPlaybackIntentFor`
 *
 * Usage:
 *   node test/playback/coordinatorObservation.js            # current (gap) facts
 *   node test/playback/coordinatorObservation.js --fixed    # post-fix contract
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const esbuildPath = path.join(
    repoRoot,
    "extension/node_modules/esbuild/lib/main.js"
);

const fixedExpectation = process.argv.slice(2).includes("--fixed");

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
    fs.writeFileSync(
        entry,
        `export {
            configurePlaybackCommands,
            setPlaybackDeviceLookup,
            setRokuMediaIdentityFields,
            nextRokuLoadGeneration,
            classifyObservation,
            acceptReceiverObservation,
            dispatchPlaybackCommand,
            playbackCommandSnapshot
        } from ${JSON.stringify(
            path.join(repoRoot, "extension/src/background/playbackCommand.ts")
        )};\n` +
            `export { PlayerState } from ${JSON.stringify(
                path.join(repoRoot, "extension/src/cast/sdk/media/enums.ts")
            )};\n` +
            `export { nextPlaybackIntentFor, intentForPlaybackState } from ${JSON.stringify(
                path.join(repoRoot, "extension/src/playbackView.ts")
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

/** Fake clock: watchdogs are fired deliberately, never by wall time. */
function installFakeClock() {
    const timers = new Map();
    let nextId = 1;
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms) => {
        const id = nextId++;
        timers.set(id, fn);
        return id;
    };
    global.clearTimeout = id => {
        timers.delete(id);
    };
    return {
        pending: () => timers.size,
        /** Fire every armed watchdog, oldest first. */
        fireAll: () => {
            const callbacks = [...timers.values()];
            timers.clear();
            for (const fn of callbacks) fn();
        },
        restore: () => {
            global.setTimeout = realSetTimeout;
        }
    };
}

function makeDevice(PlayerState) {
    return {
        id: "roku-HARNESS0001",
        name: "Harness Roku",
        deviceType: "roku",
        playbackCommand: undefined,
        mediaStatus: { playerState: PlayerState.PLAYING, currentTime: 10 }
    };
}

function mediaStatus(PlayerState, playerState, currentTime = 10) {
    return {
        playerState,
        mediaSessionId: 1,
        currentTime,
        idleReason: undefined
    };
}

/**
 * One scenario: dispatch a PAUSE, let the receiver leg become `requested`, then
 * accept ONE sample of the given observed state.
 */
async function runScenario(mod, PlayerState, clock, label, observedState) {
    const device = makeDevice(PlayerState);
    const views = [];
    mod.setPlaybackDeviceLookup(id => (id === device.id ? device : undefined));
    mod.configurePlaybackCommands({
        onViewChanged: () => {},
        deviceRouteAttempt: () => true
    });
    const generation = mod.nextRokuLoadGeneration(device.id);
    mod.setRokuMediaIdentityFields(device.id, {
        contentId: "harness-content",
        ownerId: "session:harness",
        loadGeneration: generation
    });

    const dispatched = await mod.dispatchPlaybackCommand(
        device,
        "PAUSE",
        mediaStatus(PlayerState, PlayerState.PLAYING, 10)
    );
    const afterDispatch = {
        view: device.playbackCommand && {
            lifecycle: device.playbackCommand.lifecycle,
            receiverPhase: device.playbackCommand.receiverPhase,
            receiverPending: device.playbackCommand.receiverPending,
            intent: device.playbackCommand.intent
        },
        intent: mod.nextPlaybackIntentFor(
            device,
            mediaStatus(PlayerState, PlayerState.PLAYING, 10)
        ),
        dispatched: dispatched && {
            disposition: dispatched.disposition,
            receiverRequested: dispatched.receiverRequested
        }
    };

    const status = mediaStatus(PlayerState, observedState, 12);
    const classification = mod.classifyObservation("PAUSE", observedState);
    mod.acceptReceiverObservation(
        device.id,
        status,
        {
            source: "ecp-poll",
            pollStartedAt:
                (device.playbackCommand &&
                    device.playbackCommand.receiverDispatchStartedAt) + 1,
            sequence: 2
        },
        Date.now(),
        generation
    );
    views.push(device.playbackCommand);
    const afterObservation = {
        classification,
        lifecycle: device.playbackCommand && device.playbackCommand.lifecycle,
        receiverPhase:
            device.playbackCommand && device.playbackCommand.receiverPhase,
        receiverPending:
            device.playbackCommand && device.playbackCommand.receiverPending,
        lastObservation:
            device.playbackCommand && device.playbackCommand.lastObservation,
        intent: mod.nextPlaybackIntentFor(device, status),
        watchdogTimers: clock.pending()
    };

    // Only now does the receiver watchdog run, which is what the popup has to
    // wait for today.
    clock.fireAll();
    const afterWatchdog = {
        lifecycle: device.playbackCommand && device.playbackCommand.lifecycle,
        terminalReason:
            device.playbackCommand && device.playbackCommand.terminalReason,
        intent: mod.nextPlaybackIntentFor(device, status)
    };

    return { label, device, afterDispatch, afterObservation, afterWatchdog };
}

/**
 * The receiver moved a SECOND time, back to the state the command asked for.
 *
 * Measured shape:
 *
 *   PAUSE pending, receiver seen PLAYING  (opposite recorded -> button PAUSE)
 *   receiver then seen PAUSED             (-> button becomes PLAY again)
 *
 * Worth pinning as a SEQUENCE, with one caveat stated rather than implied: the
 * second sample MATCHES the intent, so the coordinator terminates the command on
 * it and the affordance then derives from the observed state on the ordinary
 * terminal path. This row therefore does not separate "follows the live
 * observation" from "follows the recorded classification" — it asserts the end
 * result of the whole sequence, so a change that left a matched command active
 * without updating the affordance would fail here.
 */
async function runReturnScenario(mod, PlayerState, clock) {
    const device = makeDevice(PlayerState);
    mod.setPlaybackDeviceLookup(id => (id === device.id ? device : undefined));
    mod.configurePlaybackCommands({
        onViewChanged: () => {},
        deviceRouteAttempt: () => true
    });
    const generation = mod.nextRokuLoadGeneration(device.id);
    mod.setRokuMediaIdentityFields(device.id, {
        contentId: "harness-content",
        ownerId: "session:harness",
        loadGeneration: generation
    });

    await mod.dispatchPlaybackCommand(
        device,
        "PAUSE",
        mediaStatus(PlayerState, PlayerState.PLAYING, 10)
    );
    const dispatchedAt =
        device.playbackCommand.receiverDispatchStartedAt ?? 0;

    const oppositeStatus = mediaStatus(PlayerState, PlayerState.PLAYING, 12);
    mod.acceptReceiverObservation(
        device.id,
        oppositeStatus,
        { source: "ecp-poll", pollStartedAt: dispatchedAt + 1, sequence: 2 },
        Date.now(),
        generation
    );
    const atOpposite = {
        lastObservation: device.playbackCommand.lastObservation,
        intent: mod.nextPlaybackIntentFor(device, oppositeStatus)
    };

    // The receiver answers the pending PAUSE after all, while the SAME command is
    // still active (the coordinator has not terminated it yet).
    const returnedStatus = mediaStatus(PlayerState, PlayerState.PAUSED, 14);
    mod.acceptReceiverObservation(
        device.id,
        returnedStatus,
        { source: "ecp-poll", pollStartedAt: dispatchedAt + 2000, sequence: 3 },
        Date.now(),
        generation
    );
    const atReturned = {
        lifecycle: device.playbackCommand && device.playbackCommand.lifecycle,
        lastObservation: device.playbackCommand.lastObservation,
        intent: mod.nextPlaybackIntentFor(device, returnedStatus)
    };

    return { device, atOpposite, atReturned };
}

/**
 * A finished command must not keep answering for the device.
 *
 * Reported from a real session: after a cast had been stopped and a NEW one
 * started, the console filled with
 *
 *   Observation from a different LOAD generation ignored
 *   { commandId: 4, commandLoadGeneration: 1, observationLoadGeneration: 2 }
 *
 * once per 3s poll for as long as the new cast lasted - naming a command that
 * had already completed (its own "Playback command finished" line is earlier in
 * the same log). The command registry kept the terminal command in the device's
 * slot, and the receiver-observation feed reads that slot as "the command this
 * device is running", so every sample of the new cast was measured against the
 * OLD cast's media identity.
 *
 * This scenario drives that exact sequence and captures the coordinator's own
 * log output, because the defect's only symptom IS that line.
 */
async function runFinishedCommandScenario(mod, PlayerState) {
    const device = makeDevice(PlayerState);
    mod.setPlaybackDeviceLookup(id => (id === device.id ? device : undefined));
    mod.configurePlaybackCommands({
        onViewChanged: () => {},
        deviceRouteAttempt: () => true
    });

    // Cast 1: a command is dispatched and the receiver confirms it.
    const generation1 = mod.nextRokuLoadGeneration(device.id);
    mod.setRokuMediaIdentityFields(device.id, {
        contentId: "cast-1",
        ownerId: "session:1",
        loadGeneration: generation1
    });
    await mod.dispatchPlaybackCommand(
        device,
        "PLAY",
        mediaStatus(PlayerState, PlayerState.PAUSED, 5)
    );
    const dispatchedAt = device.playbackCommand.receiverDispatchStartedAt ?? 0;
    mod.acceptReceiverObservation(
        device.id,
        mediaStatus(PlayerState, PlayerState.PLAYING, 6),
        { source: "ecp-poll", pollStartedAt: dispatchedAt + 1, sequence: 2 },
        Date.now(),
        generation1
    );
    const afterConfirmation = {
        registry: mod.playbackCommandSnapshot(),
        view: device.playbackCommand && device.playbackCommand.lifecycle
    };

    // Cast 2: the user re-casts, so the extension creates a NEW load
    // generation, and the ECP poll feed keeps reporting samples.
    const generation2 = mod.nextRokuLoadGeneration(device.id);
    const logged = [];
    const realInfo = console.info;
    console.info = (...args) => logged.push(args.map(String).join(" "));
    try {
        for (let sequence = 3; sequence < 6; sequence++) {
            mod.acceptReceiverObservation(
                device.id,
                mediaStatus(PlayerState, PlayerState.PLAYING, 7),
                {
                    source: "ecp-poll",
                    pollStartedAt: dispatchedAt + sequence * 3000,
                    sequence
                },
                Date.now(),
                generation2
            );
        }
    } finally {
        console.info = realInfo;
    }

    return {
        afterConfirmation,
        registryAfterNextCast: mod.playbackCommandSnapshot(),
        generationMismatchLogs: logged.filter(line =>
            line.includes("different LOAD generation")
        )
    };
}

async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-playback-"));
    const bundlePath = path.join(workDir, "playback.cjs");
    console.log("bundling playbackCommand.ts + playbackView.ts");
    await bundle(bundlePath, workDir);

    const clock = installFakeClock();
    const mod = require(bundlePath);
    const states = mod.PlayerState;

    const matched = await runScenario(
        mod,
        states,
        clock,
        "PAUSE pending, receiver observed PAUSED (matched)",
        states.PAUSED
    );
    const opposite = await runScenario(
        mod,
        states,
        clock,
        "PAUSE pending, receiver observed PLAYING (opposite)",
        states.PLAYING
    );
    const returned = await runReturnScenario(mod, states, clock);
    const finished = await runFinishedCommandScenario(mod, states);
    clock.restore();

    console.log("\n=== scenario facts ===");
    for (const r of [matched, opposite]) {
        console.log(`\n[${r.label}]`);
        console.log("  after dispatch:", JSON.stringify(r.afterDispatch));
        console.log("  after sample:  ", JSON.stringify(r.afterObservation));
        console.log("  after watchdog:", JSON.stringify(r.afterWatchdog));
    }
    console.log("\n[PAUSE pending, receiver seen PLAYING then PAUSED]");
    console.log("  at opposite:  ", JSON.stringify(returned.atOpposite));
    console.log("  after return: ", JSON.stringify(returned.atReturned));
    console.log("\n[a completed command, then the next cast's samples]");
    console.log(
        "  after confirmation:",
        JSON.stringify(finished.afterConfirmation)
    );
    console.log(
        "  after the next cast's samples:",
        JSON.stringify(finished.registryAfterNextCast),
        `(generation-mismatch logs: ${finished.generationMismatchLogs.length})`
    );

    console.log("\n=== assertions ===");
    check(
        "matched sample: the command completes (lifecycle terminal, reason completed)",
        matched.afterObservation.classification === "matched" &&
            matched.afterObservation.lifecycle === "terminal" &&
            matched.afterWatchdog.terminalReason === "completed",
        JSON.stringify(matched.afterObservation)
    );
    check(
        "matched sample: the popup offers PLAY (the receiver is PAUSED)",
        matched.afterObservation.intent === "PLAY",
        JSON.stringify({ intent: matched.afterObservation.intent })
    );

    check(
        "opposite sample: it is classified as opposite and the command is STILL active",
        opposite.afterObservation.classification === "opposite" &&
            opposite.afterObservation.lifecycle === "active",
        JSON.stringify(opposite.afterObservation)
    );

    if (fixedExpectation) {
        check(
            "post-fix: a confirmed command leaves the device's slot (nothing is left to answer for the device)",
            finished.afterConfirmation.registry.length === 0 &&
                finished.afterConfirmation.view === "terminal",
            JSON.stringify(finished.afterConfirmation)
        );
        check(
            "post-fix: the next cast's samples are not judged against the finished command (no 'different LOAD generation' verdict)",
            finished.generationMismatchLogs.length === 0 &&
                finished.registryAfterNextCast.length === 0,
            JSON.stringify({
                logs: finished.generationMismatchLogs,
                registry: finished.registryAfterNextCast
            })
        );
    }

    if (fixedExpectation) {
        check(
            "post-fix: the popup follows the OBSERVED receiver state - a stale active PAUSE no longer owns the button (it offers PAUSE again, immediately)",
            opposite.afterObservation.intent === "PAUSE",
            JSON.stringify({
                intent: opposite.afterObservation.intent,
                lastObservation: opposite.afterObservation.lastObservation
            })
        );
        check(
            "post-fix: the whole sequence lands on the observed state - opposite offers PAUSE, the receiver answering PAUSED offers PLAY again",
            returned.atOpposite.intent === "PAUSE" &&
                returned.atOpposite.lastObservation === "opposite" &&
                returned.atReturned.intent === "PLAY",
            JSON.stringify(returned)
        );
    } else {
        check(
            "the receiver had already moved opposite to the pending command, but the stale active intent continued to own the popup button",
            opposite.afterObservation.classification === "opposite" &&
                opposite.afterObservation.lifecycle === "active" &&
                opposite.afterObservation.intent === "PLAY",
            JSON.stringify({
                intent: opposite.afterObservation.intent,
                lifecycle: opposite.afterObservation.lifecycle,
                lastObservation: opposite.afterObservation.lastObservation
            })
        );
        check(
            "the button only flips once the receiver watchdog terminates the command",
            opposite.afterObservation.intent !== opposite.afterWatchdog.intent &&
                opposite.afterWatchdog.lifecycle === "terminal",
            JSON.stringify({
                before: opposite.afterObservation.intent,
                after: opposite.afterWatchdog.intent
            })
        );
    }

    console.log(`\n${pass}/${pass + fail} checks passed`);
    if (fail) {
        console.log("\nfailures:");
        for (const f of failures) console.log("  -", f.name, f.detail || "");
        process.exit(1);
    }
    console.log("work dir:", workDir);
}

main().catch(err => {
    console.error("coordinatorObservation ERROR", err);
    process.exit(1);
});
