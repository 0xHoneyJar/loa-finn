// tests/finn/cost-arithmetic.test.ts — Integer Cost Arithmetic Tests (Sprint 2 T1/T7)
// Pure function unit tests for usdToMicroBigInt() and computeCostMicro().

import { describe, it, expect } from "vitest"
import { usdToMicroBigInt, computeCostMicro } from "../../src/hounfour/router.js"

describe("usdToMicroBigInt", () => {
  it("converts integer price correctly", () => {
    expect(usdToMicroBigInt(3.0)).toBe(3_000_000n)
  })

  it("converts non-terminating binary decimal 0.1 correctly", () => {
    // 0.1 is 0.1000000000000000055... in IEEE-754
    expect(usdToMicroBigInt(0.1)).toBe(100_000n)
  })

  it("converts rounding boundary 0.29 correctly", () => {
    // 0.29 is 0.28999999999... in IEEE-754
    expect(usdToMicroBigInt(0.29)).toBe(290_000n)
  })

  it("converts very small pricing at precision floor", () => {
    expect(usdToMicroBigInt(0.000001)).toBe(1n)
  })

  it("converts below precision floor to 0n", () => {
    // 0.0000001 rounds to 0.000000 at 6 decimal places
    expect(usdToMicroBigInt(0.0000001)).toBe(0n)
  })

  it("converts zero correctly", () => {
    expect(usdToMicroBigInt(0)).toBe(0n)
  })

  it("converts 0.58 (another problematic binary float)", () => {
    expect(usdToMicroBigInt(0.58)).toBe(580_000n)
  })

  it("handles negative values correctly", () => {
    expect(usdToMicroBigInt(-3.0)).toBe(-3_000_000n)
    expect(usdToMicroBigInt(-0.1)).toBe(-100_000n)
  })

  it("throws on NaN", () => {
    expect(() => usdToMicroBigInt(NaN)).toThrow("invalid USD value")
  })

  it("throws on Infinity", () => {
    expect(() => usdToMicroBigInt(Infinity)).toThrow("invalid USD value")
    expect(() => usdToMicroBigInt(-Infinity)).toThrow("invalid USD value")
  })
})

describe("computeCostMicro", () => {
  it("computes 1M tokens at $3.00/1M = exactly 3_000_000n micro-USD", () => {
    const cost = computeCostMicro(1_000_000, 0, 3.0, 0)
    expect(cost).toBe(3_000_000n)
  })

  it("computes 0 tokens = 0n micro-USD", () => {
    const cost = computeCostMicro(0, 0, 3.0, 15.0)
    expect(cost).toBe(0n)
  })

  it("computes mixed prompt + completion tokens", () => {
    // 5000 prompt at $3/1M + 1000 completion at $15/1M
    // = 5000 * 3_000_000 / 1_000_000 + 1000 * 15_000_000 / 1_000_000
    // = 15_000 + 15_000 = 30_000 micro-USD
    const cost = computeCostMicro(5_000, 1_000, 3.0, 15.0)
    expect(cost).toBe(30_000n)
  })

  it("handles non-terminating binary decimal pricing (0.1)", () => {
    // 1M tokens at $0.10/1M = 100_000 micro-USD
    const cost = computeCostMicro(1_000_000, 0, 0.1, 0)
    expect(cost).toBe(100_000n)
  })

  it("handles large token count (1B tokens) without overflow", () => {
    // 1_000_000_000 prompt tokens at $3/1M = $3000 = 3_000_000_000 micro-USD
    const cost = computeCostMicro(1_000_000_000, 0, 3.0, 0)
    expect(cost).toBe(3_000_000_000n)
  })

  it("handles very small pricing correctly", () => {
    // 1M tokens at $0.000001/1M = 1 micro-USD
    const cost = computeCostMicro(1_000_000, 0, 0.000001, 0)
    expect(cost).toBe(1n)
  })

  it("throws on negative prompt tokens", () => {
    expect(() => computeCostMicro(-1, 0, 3.0, 15.0)).toThrow("invalid token count")
  })

  it("throws on negative completion tokens", () => {
    expect(() => computeCostMicro(0, -1, 3.0, 15.0)).toThrow("invalid token count")
  })
})
