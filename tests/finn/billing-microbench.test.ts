/**
 * BillingConservationGuard Microbenchmark — Sprint 2 Task 2.9
 *
 * CI performance gate for billing invariant checks (SDD §9.1).
 * Runs 10,000 iterations per invariant and asserts p95 < 1ms.
 *
 * Performance contract:
 *   - Per-invariant check:       p95 < 1ms
 *   - Constraint compilation:    < 500ms
 *   - Total billing pipeline:    < 5ms (all 4 checks sequential)
 */
import { describe, it, expect, beforeAll } from "vitest"
import { BillingConservationGuard } from "../../src/hounfour/billing-conservation-guard.js"
import { performance } from "node:perf_hooks"

// --- Config ---

const ITERATIONS = 10_000
const P95_THRESHOLD_MS = 1.0
const COMPILATION_THRESHOLD_MS = 500
const PIPELINE_THRESHOLD_MS = 5.0

// --- Helpers ---

/** Compute p95 percentile from a sorted array of durations. */
function p95(sorted: number[]): number {
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

/** Run fn for N iterations, return sorted durations in ms. */
function benchmark(fn: () => void, n: number): number[] {
  // Warmup: 100 iterations to stabilize JIT
  for (let i = 0; i < 100; i++) fn()

  const durations: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const start = performance.now()
    fn()
    durations[i] = performance.now() - start
  }
  durations.sort((a, b) => a - b)
  return durations
}

// --- Microbenchmark Suite ---

describe("billing microbenchmark (SDD §9.1)", () => {
  let guard: BillingConservationGuard

  beforeAll(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
    expect(guard.isBillingReady()).toBe(true)
  })

  // --- Constraint Compilation ---

  it("constraint compilation < 500ms", async () => {
    const start = performance.now()
    const freshGuard = new BillingConservationGuard()
    await freshGuard.init()
    const elapsed = performance.now() - start

    console.log(`[microbench] compilation: ${elapsed.toFixed(2)}ms`)
    expect(elapsed).toBeLessThan(COMPILATION_THRESHOLD_MS)
  })

  // --- Per-Invariant Checks ---

  it(`checkBudgetConservation: p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    const durations = benchmark(
      () => guard.checkBudgetConservation(500_000n, 1_000_000n),
      ITERATIONS,
    )

    const p95val = p95(durations)
    const median = durations[Math.floor(durations.length / 2)]
    console.log(`[microbench] checkBudgetConservation: p50=${median.toFixed(4)}ms p95=${p95val.toFixed(4)}ms`)
    expect(p95val).toBeLessThan(P95_THRESHOLD_MS)
  })

  it(`checkCostNonNegative: p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    const durations = benchmark(
      () => guard.checkCostNonNegative(42_000n),
      ITERATIONS,
    )

    const p95val = p95(durations)
    const median = durations[Math.floor(durations.length / 2)]
    console.log(`[microbench] checkCostNonNegative: p50=${median.toFixed(4)}ms p95=${p95val.toFixed(4)}ms`)
    expect(p95val).toBeLessThan(P95_THRESHOLD_MS)
  })

  it(`checkReserveWithinAllocation: p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    const durations = benchmark(
      () => guard.checkReserveWithinAllocation(750_000n, 1_000_000n),
      ITERATIONS,
    )

    const p95val = p95(durations)
    const median = durations[Math.floor(durations.length / 2)]
    console.log(`[microbench] checkReserveWithinAllocation: p50=${median.toFixed(4)}ms p95=${p95val.toFixed(4)}ms`)
    expect(p95val).toBeLessThan(P95_THRESHOLD_MS)
  })

  it(`checkMicroUSDFormat: p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    const durations = benchmark(
      () => guard.checkMicroUSDFormat("9007199254740991"),
      ITERATIONS,
    )

    const p95val = p95(durations)
    const median = durations[Math.floor(durations.length / 2)]
    console.log(`[microbench] checkMicroUSDFormat: p50=${median.toFixed(4)}ms p95=${p95val.toFixed(4)}ms`)
    expect(p95val).toBeLessThan(P95_THRESHOLD_MS)
  })

  // --- Total Pipeline Overhead ---

  it(`total billing pipeline (4 checks sequential): p95 < ${PIPELINE_THRESHOLD_MS}ms`, () => {
    const durations = benchmark(
      () => {
        guard.checkBudgetConservation(500_000n, 1_000_000n)
        guard.checkCostNonNegative(42_000n)
        guard.checkReserveWithinAllocation(750_000n, 1_000_000n)
        guard.checkMicroUSDFormat("9007199254740991")
      },
      ITERATIONS,
    )

    const p95val = p95(durations)
    const median = durations[Math.floor(durations.length / 2)]
    console.log(`[microbench] pipeline (4 checks): p50=${median.toFixed(4)}ms p95=${p95val.toFixed(4)}ms`)
    expect(p95val).toBeLessThan(PIPELINE_THRESHOLD_MS)
  })
})
