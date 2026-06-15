// src/research/realness-verdict.test.ts — the discrimination acceptance test
// (sprint:corpus-a T3 / SDD COMPOSITION Enrichment 3). The keystone assertion:
// the SAME instrument returns DIFFERENT verdicts on different realities. An
// instrument that can't tell Kintara from x402 is broken, however green.

import { describe, it, expect } from "vitest"
import { realnessVerdict, type DailyPoint } from "./realness-verdict.js"

const d = (date: string, traders: number, volume?: number): DailyPoint => ({ date, traders, volume })

// SETTLE-003 ground truth — the real Kintara $KINS daily distinct-trader series
// (grimoires/loa/lab/SETTLES.md SETTLE-003 / probes/kintara-realness.json).
const KINTARA: DailyPoint[] = [
  790, 799, 538, 971, 1221, 3441, 3006, 2643, 2543, 1684, 1527, 1400,
  1967, 1752, 3399, 1826, 2266, 2689, 2510, 3844, 6486, 3640, 5715, 3818,
].map((t, i) => d(`2026-05-${22 + i}`, t))

describe("realness-verdict discrimination", () => {
  it("reads Kintara $KINS as REAL (reproduces SETTLE-003 HELD[real])", () => {
    const r = realnessVerdict({ series: KINTARA, top1_share: 0.0578, total_traders: 29009, total_volume: 25288116 })
    expect(r.verdict).toBe("HELD[real]")
    expect(r.metrics.traders_ols_slope).toBeGreaterThan(100)
    expect(r.metrics.last7_over_peak7).toBe(1) // last 7d is the peak window
  })

  it("reads x402-shape as THEATER via concentration (reproduces SETTLE-001)", () => {
    // x402x: ~99.3% self-dealing in the top pairs. Concentration alone kills the real claim.
    const flat = Array.from({ length: 10 }, (_, i) => d(`2026-04-${10 + i}`, 300))
    const r = realnessVerdict({ series: flat, top1_share: 0.993 })
    expect(r.verdict).toBe("FALSIFIED→theater")
    expect(r.legs.falsify_concentration).toBe(true)
  })

  it("reads a pump.fun corpse as THEATER via decay", () => {
    const corpse = [4000, 1200, 400, 150, 60, 30, 20, 12, 8].map((t, i) => d(`2026-03-${1 + i}`, t))
    const r = realnessVerdict({ series: corpse, top1_share: 0.2 })
    expect(r.verdict).toBe("FALSIFIED→theater")
    expect(r.legs.falsify_decay).toBe(true)
  })

  it("reads a too-short series as INSUFFICIENT (abstain over fabricate)", () => {
    const short = [500, 600, 400].map((t, i) => d(`2026-06-${1 + i}`, t))
    const r = realnessVerdict({ series: short, top1_share: 0.1 })
    expect(r.verdict).toBe("INSUFFICIENT")
  })

  it("reads a gentle decline + mild concentration as INDETERMINATE (the honest gap)", () => {
    const gap = [2000, 1900, 1800, 1700, 1600, 1500, 1400, 1000, 950, 900, 850, 800, 750, 700]
      .map((t, i) => d(`2026-02-${1 + i}`, t))
    const r = realnessVerdict({ series: gap, top1_share: 0.3 })
    expect(r.verdict).toBe("INDETERMINATE")
  })
})
