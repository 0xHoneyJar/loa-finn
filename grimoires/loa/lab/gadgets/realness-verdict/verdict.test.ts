// gadgets/realness-verdict/verdict.test.ts — the discrimination acceptance test,
// made executable (COMPOSITION.md Enrichment 3). Standalone tsx runner (node:assert)
// so it does NOT depend on vitest config roots. Run: npx tsx <thisfile>
//
// The keystone assertion: the same instrument returns DIFFERENT verdicts on
// different realities. Kintara → REAL, x402-shape → THEATER. An instrument that
// can't tell them apart is broken, however green.

import assert from "node:assert/strict"
import { realnessVerdict, type DailyPoint } from "./verdict.js"

let pass = 0
let fail = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`)
  }
}

const d = (date: string, traders: number, volume?: number): DailyPoint => ({ date, traders, volume })

// SETTLE-003 ground truth — the real Kintara $KINS daily distinct-trader series.
const KINTARA: DailyPoint[] = [
  790, 799, 538, 971, 1221, 3441, 3006, 2643, 2543, 1684, 1527, 1400,
  1967, 1752, 3399, 1826, 2266, 2689, 2510, 3844, 6486, 3640, 5715, 3818,
].map((t, i) => d(`2026-05-${22 + i}`, t))

console.log("realness-verdict · discrimination acceptance test")

check("Kintara $KINS reads REAL (reproduces SETTLE-003 HELD[real])", () => {
  const r = realnessVerdict({ series: KINTARA, top1_share: 0.0578, total_traders: 29009, total_volume: 25288116 })
  assert.equal(r.verdict, "HELD[real]", `got ${r.verdict}: ${r.reason}`)
  assert.ok(r.metrics.traders_ols_slope > 100, `slope should be strongly positive, got ${r.metrics.traders_ols_slope}`)
  assert.equal(r.metrics.last7_over_peak7, 1, "last 7d should be the peak window")
})

check("x402-shape reads THEATER via concentration (reproduces SETTLE-001)", () => {
  // x402x: self-dealing, top pairs ~99.3% of volume. Series shape irrelevant —
  // concentration alone kills the real claim.
  const flat = Array.from({ length: 10 }, (_, i) => d(`2026-04-${10 + i}`, 300))
  const r = realnessVerdict({ series: flat, top1_share: 0.993 })
  assert.equal(r.verdict, "FALSIFIED→theater", `got ${r.verdict}: ${r.reason}`)
  assert.ok(r.legs.falsify_concentration, "concentration leg should fire")
})

check("pump.fun corpse reads THEATER via decay", () => {
  const corpse = [4000, 1200, 400, 150, 60, 30, 20, 12, 8].map((t, i) => d(`2026-03-${1 + i}`, t))
  const r = realnessVerdict({ series: corpse, top1_share: 0.2 })
  assert.equal(r.verdict, "FALSIFIED→theater", `got ${r.verdict}: ${r.reason}`)
  assert.ok(r.legs.falsify_decay, "decay leg should fire")
})

check("too-short series reads INSUFFICIENT (abstain over fabricate)", () => {
  const short = [500, 600, 400].map((t, i) => d(`2026-06-${1 + i}`, t))
  const r = realnessVerdict({ series: short, top1_share: 0.1 })
  assert.equal(r.verdict, "INSUFFICIENT", `got ${r.verdict}: ${r.reason}`)
})

check("gentle decline + mild concentration reads INDETERMINATE (the honest gap)", () => {
  const gap = [2000, 1900, 1800, 1700, 1600, 1500, 1400, 1000, 950, 900, 850, 800, 750, 700]
    .map((t, i) => d(`2026-02-${1 + i}`, t))
  const r = realnessVerdict({ series: gap, top1_share: 0.3 })
  assert.equal(r.verdict, "INDETERMINATE", `got ${r.verdict}: ${r.reason}`)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
