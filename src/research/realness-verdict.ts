// src/research/realness-verdict.ts — the realness verdict computer (GADGET #001,
// graduated from grimoires/loa/lab/gadgets/ — sprint:corpus-a T3).
//
//   WHAT  given an on-chain economy's daily activity series + concentration,
//         compute the realness verdict deterministically — HELD[real],
//         FALSIFIED→theater, INSUFFICIENT, or INDETERMINATE.
//   WHY   the SETTLE step's verdict was ad-hoc inline math each run (SETTLE-001/2/3);
//         a pure function makes the verdict reproducible, not a judgment call.
//   DEPS  none. Pure. No network, no LLM — settles are deterministic (epistemology §4).
//
// Reproduces SETTLE-003's HELD[real] on the Kintara $KINS series and a THEATER
// verdict on an x402-shaped series (the discrimination test — realness-verdict.test.ts).
// This is the verdict computer for src/corpus/settle.ts (DD-7); it never decides
// what to measure, only how to read a measured series against pinned bars.

export interface DailyPoint {
  /** ISO date (label only — math uses index order). */
  date: string
  /** distinct traders / participants that day. */
  traders: number
  /** USD volume that day (optional; corroborating, not a bar). */
  volume?: number
}

/** The pinned falsification bars. Defaults = SETTLE-003's frozen bars. Freeze a
 *  copy per experiment BEFORE the data (anti-p-hacking; the lab-cycle seam). */
export interface RealnessBars {
  /** HELD needs last-7d mean ÷ peak-7d mean ≥ this. */
  held_last7_over_peak7_min: number
  /** HELD needs distinct-traders OLS slope ≥ this. */
  held_traders_slope_min: number
  /** HELD needs top-1 participant share ≤ this. */
  held_top1_share_max: number
  /** FALSIFY (→theater) if last-7d ÷ peak-7d < this (pump decay). */
  falsify_last7_over_peak7_max: number
  /** FALSIFY (→theater) if top-1 share > this (wash / single actor). */
  falsify_top1_share_min: number
  /** INSUFFICIENT if fewer than this many days of data. */
  insufficient_min_days: number
}

export const SETTLE_003_BARS: RealnessBars = {
  held_last7_over_peak7_min: 0.5,
  held_traders_slope_min: 0,
  held_top1_share_max: 0.25,
  falsify_last7_over_peak7_max: 0.25,
  falsify_top1_share_min: 0.5,
  insufficient_min_days: 7,
}

export interface RealnessInput {
  series: DailyPoint[]
  /** Top-1 participant's share of total volume, 0..1. */
  top1_share: number
  /** Optional totals (reported, not gated). */
  total_traders?: number
  total_volume?: number
  bars?: RealnessBars
}

export type RealnessVerdict =
  | "HELD[real]"
  | "FALSIFIED→theater"
  | "INSUFFICIENT"
  | "INDETERMINATE"

export interface RealnessMetrics {
  n_days: number
  traders_ols_slope: number
  last7_mean: number
  peak7_mean: number
  last7_over_peak7: number
  last3_over_first3: number
  peak_traders: number
  top1_share: number
}

export interface RealnessResult {
  verdict: RealnessVerdict
  reason: string
  metrics: RealnessMetrics
  /** Per-leg bar outcomes (transparency — show your work). */
  legs: {
    held_last7_over_peak7: boolean
    held_slope: boolean
    held_top1: boolean
    falsify_decay: boolean
    falsify_concentration: boolean
  }
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

/** Ordinary least squares slope of y over its own index (0..n-1). */
function olsSlope(y: number[]): number {
  const n = y.length
  if (n < 2) return 0
  const x = [...y.keys()]
  const mx = mean(x)
  const my = mean(y)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my)
    den += (x[i] - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

/** Max rolling-7 window mean (the peak-7d). Falls back to the whole-series mean
 *  when fewer than 7 days exist. */
function peak7(series: number[]): number {
  if (series.length < 7) return mean(series)
  let m = 0
  for (let i = 0; i + 7 <= series.length; i++) {
    const w = mean(series.slice(i, i + 7))
    if (w > m) m = w
  }
  return m
}

/** Compute the realness verdict. Deterministic and pure. Verdict precedence:
 *  INSUFFICIENT (not enough data to judge) → FALSIFIED (a kill takes precedence) →
 *  HELD (all legs clear) → INDETERMINATE (the honest gap; abstain over force). */
export function realnessVerdict(input: RealnessInput): RealnessResult {
  const bars = input.bars ?? SETTLE_003_BARS
  const traders = input.series.map((p) => p.traders)
  const n = traders.length

  const slope = olsSlope(traders)
  const last7 = mean(traders.slice(-7))
  const pk7 = peak7(traders)
  const last7_over_peak7 = pk7 === 0 ? 0 : last7 / pk7
  const first3 = mean(traders.slice(0, 3))
  const last3 = mean(traders.slice(-3))
  const last3_over_first3 = first3 === 0 ? 0 : last3 / first3

  const metrics: RealnessMetrics = {
    n_days: n,
    traders_ols_slope: slope,
    last7_mean: last7,
    peak7_mean: pk7,
    last7_over_peak7,
    last3_over_first3,
    peak_traders: traders.length ? Math.max(...traders) : 0,
    top1_share: input.top1_share,
  }

  const legs = {
    held_last7_over_peak7: last7_over_peak7 >= bars.held_last7_over_peak7_min,
    held_slope: slope >= bars.held_traders_slope_min,
    held_top1: input.top1_share <= bars.held_top1_share_max,
    falsify_decay: last7_over_peak7 < bars.falsify_last7_over_peak7_max,
    falsify_concentration: input.top1_share > bars.falsify_top1_share_min,
  }

  if (n < bars.insufficient_min_days) {
    return {
      verdict: "INSUFFICIENT",
      reason: `only ${n} days of data (need ≥ ${bars.insufficient_min_days}) — abstain over fabricate`,
      metrics,
      legs,
    }
  }
  if (legs.falsify_decay || legs.falsify_concentration) {
    const why = [
      legs.falsify_decay ? `decay (last7/peak7 ${last7_over_peak7.toFixed(2)} < ${bars.falsify_last7_over_peak7_max})` : null,
      legs.falsify_concentration ? `concentration (top1 ${(input.top1_share * 100).toFixed(1)}% > ${bars.falsify_top1_share_min * 100}%)` : null,
    ].filter(Boolean).join(" + ")
    return { verdict: "FALSIFIED→theater", reason: `pump/theater pattern: ${why}`, metrics, legs }
  }
  if (legs.held_last7_over_peak7 && legs.held_slope && legs.held_top1) {
    return {
      verdict: "HELD[real]",
      reason: `broad (top1 ${(input.top1_share * 100).toFixed(2)}%), sustained (last7/peak7 ${last7_over_peak7.toFixed(2)}), ${slope >= 0 ? "growing" : "flat"} (slope ${slope.toFixed(1)}/day)`,
      metrics,
      legs,
    }
  }
  return {
    verdict: "INDETERMINATE",
    reason: "neither the real bars nor the theater bars cleared — the honest gap; needs a sharper instrument or more data",
    metrics,
    legs,
  }
}
