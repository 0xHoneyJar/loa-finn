// tests/finn/budget-vectors.test.ts — Integer Micro-USD Budget Tests (T-A.5)

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  calculateCostMicro,
  calculateTotalCostMicro,
  RemainderAccumulator,
} from "../../src/hounfour/pricing.js"

// --- Load Test Vectors ---

interface TestVector {
  id: string
  tokens: number
  price_micro_per_million: number
  expected_cost_micro: number
  expected_remainder_micro: number
  note: string
}

const vectorsPath = resolve("tests/fixtures/budget-test-vectors.json")
const vectorsFile = JSON.parse(readFileSync(vectorsPath, "utf8"))
const vectors: TestVector[] = vectorsFile.vectors

describe("Budget Test Vectors (T-A.5)", () => {
  describe("calculateCostMicro — 50 deterministic vectors", () => {
    for (const v of vectors) {
      it(`${v.id}: ${v.note}`, () => {
        const result = calculateCostMicro(v.tokens, v.price_micro_per_million)
        expect(result.cost_micro).toBe(v.expected_cost_micro)
        expect(result.remainder_micro).toBe(v.expected_remainder_micro)
      })
    }
  })

  describe("BigInt oracle verification", () => {
    it("all 50 vectors match BigInt reference implementation", () => {
      for (const v of vectors) {
        // BigInt reference oracle
        const product = BigInt(v.tokens) * BigInt(v.price_micro_per_million)
        const expectedCost = Number(product / 1_000_000n)
        const expectedRemainder = Number(product % 1_000_000n)

        // Number implementation
        const result = calculateCostMicro(v.tokens, v.price_micro_per_million)

        expect(result.cost_micro).toBe(expectedCost)
        expect(result.remainder_micro).toBe(expectedRemainder)
      }
    })
  })

  describe("overflow guardrail", () => {
    it("throws BUDGET_OVERFLOW for product > MAX_SAFE_INTEGER", () => {
      // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991
      // tokens=10^9 * price=10^10 = 10^19 > MAX_SAFE_INTEGER
      expect(() => calculateCostMicro(1_000_000_000, 10_000_000_000)).toThrow("BUDGET_OVERFLOW")
    })

    it("does not throw for large but safe products", () => {
      // tokens=1M * price=75M = 75 * 10^12, well within 2^53
      const result = calculateCostMicro(1_000_000, 75_000_000)
      expect(result.cost_micro).toBe(75_000_000)
      expect(result.remainder_micro).toBe(0)
    })
  })

  describe("calculateTotalCostMicro", () => {
    it("computes total from input + output + reasoning", () => {
      const result = calculateTotalCostMicro(
        { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 200 },
        {
          provider: "openai",
          model: "o3",
          input_micro_per_million: 10_000_000,
          output_micro_per_million: 40_000_000,
          reasoning_micro_per_million: 40_000_000,
        },
      )

      expect(result.input_cost_micro).toBe(10_000)   // 1000 * 10M / 1M
      expect(result.output_cost_micro).toBe(20_000)   // 500 * 40M / 1M
      expect(result.reasoning_cost_micro).toBe(8_000)  // 200 * 40M / 1M
      expect(result.total_cost_micro).toBe(38_000)
    })

    it("handles missing reasoning pricing", () => {
      const result = calculateTotalCostMicro(
        { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
        {
          provider: "openai",
          model: "gpt-4o",
          input_micro_per_million: 2_500_000,
          output_micro_per_million: 10_000_000,
        },
      )

      expect(result.input_cost_micro).toBe(250)
      expect(result.output_cost_micro).toBe(500)
      expect(result.reasoning_cost_micro).toBe(0)
      expect(result.total_cost_micro).toBe(750)
    })
  })

  describe("RemainderAccumulator", () => {
    it("carries when remainder >= 1M", () => {
      const acc = new RemainderAccumulator()

      // Add 500_000 remainder (no carry)
      let carry = acc.carry("scope1", 500_000)
      expect(carry).toBe(0)
      expect(acc.get("scope1")).toBe(500_000)

      // Add 600_000 → total = 1_100_000 → carry 1, remainder 100_000
      carry = acc.carry("scope1", 600_000)
      expect(carry).toBe(1)
      expect(acc.get("scope1")).toBe(100_000)
    })

    it("carries multiple micro-USD at once", () => {
      const acc = new RemainderAccumulator()
      // Add 2_500_000 at once → carry 2, remainder 500_000
      const carry = acc.carry("scope1", 2_500_000)
      expect(carry).toBe(2)
      expect(acc.get("scope1")).toBe(500_000)
    })

    it("isolates by scope", () => {
      const acc = new RemainderAccumulator()
      acc.carry("a", 500_000)
      acc.carry("b", 700_000)
      expect(acc.get("a")).toBe(500_000)
      expect(acc.get("b")).toBe(700_000)
    })

    it("handles zero remainder", () => {
      const acc = new RemainderAccumulator()
      const carry = acc.carry("scope1", 0)
      expect(carry).toBe(0)
      expect(acc.get("scope1")).toBe(0)
    })

    it("clear resets all scopes", () => {
      const acc = new RemainderAccumulator()
      acc.carry("a", 500_000)
      acc.carry("b", 700_000)
      acc.clear()
      expect(acc.get("a")).toBe(0)
      expect(acc.get("b")).toBe(0)
    })
  })

  describe("no floating-point in cost path", () => {
    it("all vector results are integers", () => {
      for (const v of vectors) {
        const result = calculateCostMicro(v.tokens, v.price_micro_per_million)
        expect(Number.isInteger(result.cost_micro)).toBe(true)
        expect(Number.isInteger(result.remainder_micro)).toBe(true)
      }
    })
  })
})
