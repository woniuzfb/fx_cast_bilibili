/**
 * shared/pongReport.d.ts — single source of truth for the PongReport shape.
 *
 * The heartbeat/PONG calibration report crosses the native-messaging channel
 * from the bridge (which produces it in components/cast/pongMeter.ts) to the
 * extension (which logs it). The two sides are otherwise separate build units
 * with no shared code, so this shape used to be hand-duplicated in both
 * bridge/src/bridge/messaging.ts and extension/src/messaging.ts with
 * "keep in sync" comments. This declaration file replaces those copies with
 * one definition that both import.
 *
 * Why a `.d.ts` at the repo root (and not a normal `.ts`):
 *   - The bridge compiles with `tsc` and an inferred rootDir of `bridge/`.
 *     A regular `.ts` here would be pulled into the program, emitted, and
 *     shift the common rootDir to the repo root — moving `dist/app/src/main.js`
 *     and breaking the launcher. A declaration file is never emitted and
 *     never counts toward rootDir, so the bridge's output layout is untouched.
 *   - The extension bundles with esbuild via `import type`, which is erased
 *     before resolution, so there is zero runtime cost on that side either.
 *
 * Both sides reference it type-only:
 *   bridge:    import type { PongReport } from "../../../shared/pongReport";
 *   extension: import type { PongReport } from "../../shared/pongReport";
 */
export interface PongReport {
    /** `host:port/destinationId` — identifies the measured connection. */
    label: string;
    /** Number of inter-PONG gap samples in the current window. */
    samples: number;
    /** Latest round-trip time (PING->PONG) in ms, or -1 if unknown. */
    rttMs: number;
    /** Inter-PONG gap percentiles / extremes over the window (ms). */
    gap: {
        p50: number;
        p90: number;
        p95: number;
        p99: number;
        max: number;
        mean: number;
    };
    /**
     * Calibrated watchdog threshold: max(healthyMax + margin,
     * ceil(p99 * 1.5)) rounded up to a whole heartbeat multiple. Compare
     * against the hard-coded HEARTBEAT_STALE_MS and adjust if they diverge.
     */
    suggestedThresholdMs: number;
    /** True when this report was triggered by a brand-new max gap. */
    newMax: boolean;
}
