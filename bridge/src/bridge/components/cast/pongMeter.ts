/**
 * pongMeter.ts — in-process heartbeat/PONG analyzer.
 *
 * Ports the offline parse-pong.js calibration logic into the bridge so the
 * suggested HEARTBEAT_STALE_MS is derived from live traffic instead of a
 * hand-tuned placeholder. Every cast connection feeds its PING/PONG timing
 * here; the meter maintains a rolling window of inter-PONG gaps and emits a
 * periodic report (gap p50/p90/p95/p99/max + a suggested watchdog
 * threshold) which the owner forwards to the extension background log.
 *
 * Always on (no env gate): reports are rate-limited to roughly one per
 * REPORT_INTERVAL_MS so steady-state logging stays cheap.
 */

import type { PongReport } from "../../../../../shared/pongReport";

// PongReport is defined once in shared/pongReport.d.ts (it crosses the
// native-messaging channel to the extension). Re-exported here so this
// module's local consumers (client.ts, remote.ts) can keep importing the
// type from "./pongMeter" alongside the PongMeter class.
export type { PongReport };

/** Heartbeat interval, mirrors HEARTBEAT_INTERVAL_MS in client.ts. */
const HEARTBEAT_MS = 5000;
/** Extra safety margin added on top of the healthy max gap. */
const MARGIN_MS = 5000;
/** Rolling window of gaps kept for percentile math. */
const WINDOW = 500;
/** Emit at most one report per this interval (plus on every new max gap). */
const REPORT_INTERVAL_MS = 60000;
/**
 * Minimum gap samples before a report is meaningful. A single healthy gap
 * (~one heartbeat) would otherwise suggest a threshold of just
 * heartbeat+margin and fire on the very first PONG of every session — pure
 * noise. Require enough samples (~2.5 min at a 5s heartbeat) for the
 * percentiles to mean something before surfacing anything.
 */
const MIN_SAMPLES = 30;

function percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return NaN;
    const idx = Math.min(
        sortedAsc.length - 1,
        Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
    );
    return sortedAsc[idx];
}

export default class PongMeter {
    private lastPingAt = 0;
    private lastPongAt = 0;
    private gaps: number[] = [];
    private maxGap = 0;
    private lastRtt = -1;
    private lastReportAt = 0;

    constructor(private label: string) {}

    /** Call whenever a PING is sent. */
    onPing() {
        this.lastPingAt = Date.now();
    }

    /**
     * Call whenever a PONG is received. Returns a report when one is due
     * (rate-limited, or immediately on a new max gap), otherwise undefined.
     */
    onPong(): PongReport | undefined {
        const now = Date.now();
        this.lastRtt = this.lastPingAt ? now - this.lastPingAt : -1;

        let newMax = false;
        if (this.lastPongAt) {
            const gap = now - this.lastPongAt;
            this.gaps.push(gap);
            if (this.gaps.length > WINDOW) this.gaps.shift();
            if (gap > this.maxGap) {
                this.maxGap = gap;
                newMax = true;
            }
        }
        this.lastPongAt = now;

        // Not enough data for the percentiles/threshold to be trustworthy.
        // This also suppresses the first-PONG-of-every-session false alarm.
        if (this.gaps.length < MIN_SAMPLES) return undefined;

        const due = now - this.lastReportAt >= REPORT_INTERVAL_MS;
        // Report when due, or immediately on a genuinely new max gap.
        if (!due && !newMax) return undefined;

        this.lastReportAt = now;
        return this.buildReport(newMax);
    }

    private buildReport(newMax: boolean): PongReport {
        const sorted = [...this.gaps].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const p50 = percentile(sorted, 50);
        const p90 = percentile(sorted, 90);
        const p95 = percentile(sorted, 95);
        const p99 = percentile(sorted, 99);
        const max = sorted[sorted.length - 1];
        const mean = Math.round(sum / sorted.length);

        const byMax = max + MARGIN_MS;
        const byP99 = Math.ceil(p99 * 1.5);
        const raw = Math.max(byMax, byP99);
        const suggestedThresholdMs =
            Math.ceil(raw / HEARTBEAT_MS) * HEARTBEAT_MS;

        return {
            label: this.label,
            samples: sorted.length,
            rttMs: this.lastRtt,
            gap: { p50, p90, p95, p99, max, mean },
            suggestedThresholdMs,
            newMax
        };
    }
}
