// tests/finn/budget-micro.test.ts — BigInt micro-USD budget data model (Task 2.1)

import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  computeCostMicro,
  computeTotalCostMicro,
  validateRequestCost,
  microToString,
  stringToMicro,
  MAX_REQUEST_COST_MICRO,
} from "../../src/hounfour/budget.js"
import {
  calculateCostMicro,
  calculateTotalCostMicro,
  RemainderAccumulator,
  PRICE_TABLE_VERSION,
  findPricing,
  DEFAULT_PRICING,
} from "../../src/hounfour/pricing.js"
import type { LedgerEntryV2, BudgetSnapshotMicro } from "../../src/hounfour/types.js"

// --- Golden vector loader ---

const VECTORS_DIR = resolve("packages/loa-hounfour/vectors/budget")

// BB-PR63-F009: Guard against missing vector files. If the loa-hounfour
// subpackage is not installed or vectors are missing, golden vector tests
// will fail with a clear message instead of a cryptic ENOENT.
beforeAll(() => {
  if (!existsSync(VECTORS_DIR)) {
    throw new Error(
      `Golden vector directory not found: ${VECTORS_DIR}\n` +
      `Ensure loa-hounfour is installed: npm install or git submodule update --init`,
    )
  }
})

function loadVectors(filename: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(VECTORS_DIR, filename), "utf8"))
}

// ── BigInt computeCostMicro ─────────────────────────────────────────────

describe("computeCostMicro (BigInt)", () => {
  it("basic calculation matches formula", () => {
    const result = computeCostMicro(1000n, 2_500_000n)
    expect(result.cost_micro).toBe(2500n)
    expect(result.remainder_micro).toBe(0n)
  })

  it("handles remainder correctly", () => {
    const result = computeCostMicro(7n, 2_500_000n)
    expect(result.cost_micro).toBe(17n)
    expect(result.remainder_micro).toBe(500_000n)
  })

  it("zero tokens yields zero cost", () => {
    const result = computeCostMicro(0n, 75_000_000n)
    expect(result.cost_micro).toBe(0n)
    expect(result.remainder_micro).toBe(0n)
  })

  it("zero price yields zero cost", () => {
    const result = computeCostMicro(1000n, 0n)
    expect(result.cost_micro).toBe(0n)
    expect(result.remainder_micro).toBe(0n)
  })

  it("rejects negative tokens", () => {
    expect(() => computeCostMicro(-1n, 1_000_000n)).toThrow("BUDGET_INVALID")
  })

  it("rejects negative price", () => {
    expect(() => computeCostMicro(1n, -1_000_000n)).toThrow("BUDGET_INVALID")
  })

  it("handles values beyond Number.MAX_SAFE_INTEGER", () => {
    // 2^53 tokens at $0.000001/1M — pure arithmetic, no business limit
    const bigTokens = 9_007_199_254_740_992n // 2^53
    const result = computeCostMicro(bigTokens, 1n)
    expect(result.cost_micro).toBe(9_007_199_254n)
    expect(result.remainder_micro).toBe(740_992n)
  })

  it("allows cost exactly at $1000 (no enforcement in raw compute)", () => {
    // 1M tokens at $1000/1M (= 1_000_000_000 micro/1M) = exactly $1000 = 1_000_000_000 micro-USD
    const result = computeCostMicro(1_000_000n, 1_000_000_000n)
    expect(result.cost_micro).toBe(1_000_000_000n)
    expect(result.remainder_micro).toBe(0n)
  })

  it("computes costs above $1000 (enforcement is separate)", () => {
    // 1B tokens at $1000/1M = $1,000,000 — pure arithmetic succeeds
    const result = computeCostMicro(1_000_000_000n, 1_000_000_000n)
    expect(result.cost_micro).toBe(1_000_000_000_000n)
    expect(result.remainder_micro).toBe(0n)
  })
})

// ── BigInt computeTotalCostMicro ────────────────────────────────────────

describe("computeTotalCostMicro (BigInt)", () => {
  it("computes full breakdown", () => {
    const result = computeTotalCostMicro(
      { prompt_tokens: 1000n, completion_tokens: 500n, reasoning_tokens: 200n },
      {
        input_micro_per_million: 10_000_000n,
        output_micro_per_million: 40_000_000n,
        reasoning_micro_per_million: 40_000_000n,
      },
    )
    expect(result.input_cost_micro).toBe(10_000n)
    expect(result.output_cost_micro).toBe(20_000n)
    expect(result.reasoning_cost_micro).toBe(8_000n)
    expect(result.total_cost_micro).toBe(38_000n)
  })

  it("handles missing reasoning pricing", () => {
    const result = computeTotalCostMicro(
      { prompt_tokens: 100n, completion_tokens: 50n, reasoning_tokens: 0n },
      {
        input_micro_per_million: 2_500_000n,
        output_micro_per_million: 10_000_000n,
      },
    )
    expect(result.input_cost_micro).toBe(250n)
    expect(result.output_cost_micro).toBe(500n)
    expect(result.reasoning_cost_micro).toBe(0n)
    expect(result.total_cost_micro).toBe(750n)
  })

  it("computes totals above $1000 (enforcement is separate)", () => {
    const result = computeTotalCostMicro(
      { prompt_tokens: 10_000_000n, completion_tokens: 10_000_000n, reasoning_tokens: 10_000_000n },
      {
        input_micro_per_million: 75_000_000n,
        output_micro_per_million: 75_000_000n,
        reasoning_micro_per_million: 75_000_000n,
      },
    )
    // 10M tokens * 75M micro/1M = 750_000_000 per component × 3 = 2_250_000_000
    expect(result.total_cost_micro).toBe(2_250_000_000n)
    // Over $1000, so enforcement would catch it
    expect(() => validateRequestCost(result.total_cost_micro)).toThrow("BUDGET_OVERFLOW")
  })
})

// ── validateRequestCost ─────────────────────────────────────────────────

describe("validateRequestCost", () => {
  it("passes for cost under $1000", () => {
    expect(() => validateRequestCost(999_999_999n)).not.toThrow()
  })

  it("passes for cost exactly at $1000", () => {
    expect(() => validateRequestCost(1_000_000_000n)).not.toThrow()
  })

  it("throws BUDGET_OVERFLOW for cost over $1000", () => {
    expect(() => validateRequestCost(1_000_000_001n)).toThrow("BUDGET_OVERFLOW")
  })

  it("throws for extreme values", () => {
    expect(() => validateRequestCost(999_999_999_999n)).toThrow("BUDGET_OVERFLOW")
  })

  it("passes for zero", () => {
    expect(() => validateRequestCost(0n)).not.toThrow()
  })
})

// ── Wire serialization ──────────────────────────────────────────────────

describe("micro-USD string serialization", () => {
  it("microToString serializes BigInt", () => {
    expect(microToString(0n)).toBe("0")
    expect(microToString(2500n)).toBe("2500")
    expect(microToString(1_000_000_000n)).toBe("1000000000")
    expect(microToString(9_007_199_254_740_991n)).toBe("9007199254740991")
  })

  it("stringToMicro parses valid strings", () => {
    expect(stringToMicro("0")).toBe(0n)
    expect(stringToMicro("2500")).toBe(2500n)
    expect(stringToMicro("1000000000")).toBe(1_000_000_000n)
    expect(stringToMicro("9007199254740991")).toBe(9_007_199_254_740_991n)
  })

  it("stringToMicro rejects invalid strings", () => {
    expect(() => stringToMicro("")).toThrow("BUDGET_PARSE")
    expect(() => stringToMicro("-1")).toThrow("BUDGET_PARSE")
    expect(() => stringToMicro("1.5")).toThrow("BUDGET_PARSE")
    expect(() => stringToMicro("abc")).toThrow("BUDGET_PARSE")
    expect(() => stringToMicro("12 34")).toThrow("BUDGET_PARSE")
  })

  it("roundtrip preserves value", () => {
    const values = [0n, 1n, 2500n, 999_999n, 1_000_000n, 9_007_199_254_740_991n]
    for (const v of values) {
      expect(stringToMicro(microToString(v))).toBe(v)
    }
  })
})

// ── LedgerEntryV2 type conformance ──────────────────────────────────────

describe("LedgerEntryV2 wire format", () => {
  it("all *_micro fields are strings", () => {
    const entry: LedgerEntryV2 = {
      schema_version: 2,
      timestamp: new Date().toISOString(),
      trace_id: "test-trace",
      agent: "test-agent",
      provider: "openai",
      model: "gpt-4o",
      project_id: "test",
      phase_id: "phase-1",
      sprint_id: "sprint-1",
      tenant_id: "tenant-1",
      prompt_tokens: 1000,
      completion_tokens: 500,
      reasoning_tokens: 0,
      input_cost_micro: microToString(2500n),
      output_cost_micro: microToString(5000n),
      reasoning_cost_micro: microToString(0n),
      total_cost_micro: microToString(7500n),
      price_table_version: PRICE_TABLE_VERSION,
      billing_method: "provider_reported",
      latency_ms: 1200,
    }

    const json = JSON.stringify(entry)
    const parsed = JSON.parse(json)

    // All micro fields must be strings in JSON
    expect(typeof parsed.input_cost_micro).toBe("string")
    expect(typeof parsed.output_cost_micro).toBe("string")
    expect(typeof parsed.reasoning_cost_micro).toBe("string")
    expect(typeof parsed.total_cost_micro).toBe("string")

    // Parse back to BigInt
    expect(stringToMicro(parsed.total_cost_micro)).toBe(7500n)
  })

  it("schema_version is 2", () => {
    const entry: LedgerEntryV2 = {
      schema_version: 2,
      timestamp: new Date().toISOString(),
      trace_id: "v2-test",
      agent: "test",
      provider: "openai",
      model: "gpt-4o",
      project_id: "p",
      phase_id: "ph",
      sprint_id: "sp",
      tenant_id: "t",
      prompt_tokens: 0,
      completion_tokens: 0,
      reasoning_tokens: 0,
      input_cost_micro: "0",
      output_cost_micro: "0",
      reasoning_cost_micro: "0",
      total_cost_micro: "0",
      price_table_version: 1,
      billing_method: "provider_reported",
      latency_ms: 0,
    }
    expect(entry.schema_version).toBe(2)
  })
})

// ── BudgetSnapshotMicro type conformance ────────────────────────────────

describe("BudgetSnapshotMicro wire format", () => {
  it("uses string micro-USD fields", () => {
    const snapshot: BudgetSnapshotMicro = {
      scope: "tenant:test",
      spent_micro: microToString(7500n),
      limit_micro: microToString(100_000_000n), // $100
      percent_used: 0.0075,
      warning: false,
      exceeded: false,
    }

    const json = JSON.stringify(snapshot)
    const parsed = JSON.parse(json)
    expect(typeof parsed.spent_micro).toBe("string")
    expect(typeof parsed.limit_micro).toBe("string")
    expect(stringToMicro(parsed.spent_micro)).toBe(7500n)
  })
})

// ── Pricing table ───────────────────────────────────────────────────────

describe("pricing table", () => {
  it("PRICE_TABLE_VERSION is defined", () => {
    expect(PRICE_TABLE_VERSION).toBe(1)
  })

  it("all entries have bytesPerToken", () => {
    for (const entry of DEFAULT_PRICING) {
      expect(entry.bytesPerToken).toBeDefined()
      expect(entry.bytesPerToken).toBeGreaterThan(0)
    }
  })

  it("findPricing returns known models", () => {
    const gpt4o = findPricing("openai", "gpt-4o")
    expect(gpt4o).toBeDefined()
    expect(gpt4o!.input_micro_per_million).toBe(2_500_000)
    expect(gpt4o!.bytesPerToken).toBe(4)

    const opus = findPricing("anthropic", "claude-opus-4-6")
    expect(opus).toBeDefined()
    expect(opus!.bytesPerToken).toBe(3.5)
  })

  it("findPricing returns undefined for unknown", () => {
    expect(findPricing("unknown", "unknown")).toBeUndefined()
  })
})

// ── Golden vector validation against src/ implementation ────────────────

describe("golden vectors: basic-pricing", () => {
  const data = loadVectors("basic-pricing.json") as {
    single_cost_vectors: Array<{
      id: string; tokens: number; price_micro_per_million: number;
      expected_cost_micro: number; expected_remainder_micro: number; note: string;
    }>;
    total_cost_vectors: Array<{
      id: string; note: string;
      input: {
        prompt_tokens: number; completion_tokens: number; reasoning_tokens: number;
        pricing: { input_micro_per_million: number; output_micro_per_million: number; reasoning_micro_per_million?: number };
      };
      expected: {
        input_cost_micro: number; output_cost_micro: number;
        reasoning_cost_micro: number; total_cost_micro: number;
      };
    }>;
    remainder_accumulator_sequences: Array<{
      id: string; note: string; scope_key: string;
      steps: Array<{
        tokens: number; price_micro_per_million: number;
        expected_carry: number; expected_accumulated: number;
      }>;
    }>;
  }

  describe("single cost (Number path)", () => {
    for (const v of data.single_cost_vectors) {
      it(`${v.id}: ${v.note}`, () => {
        const result = calculateCostMicro(v.tokens, v.price_micro_per_million)
        expect(result.cost_micro).toBe(v.expected_cost_micro)
        expect(result.remainder_micro).toBe(v.expected_remainder_micro)
      })
    }
  })

  describe("single cost (BigInt path)", () => {
    for (const v of data.single_cost_vectors) {
      it(`${v.id}: BigInt — ${v.note}`, () => {
        const result = computeCostMicro(BigInt(v.tokens), BigInt(v.price_micro_per_million))
        expect(result.cost_micro).toBe(BigInt(v.expected_cost_micro))
        expect(result.remainder_micro).toBe(BigInt(v.expected_remainder_micro))
      })
    }
  })

  describe("total cost (Number path)", () => {
    for (const v of data.total_cost_vectors) {
      it(`${v.id}: ${v.note}`, () => {
        const result = calculateTotalCostMicro(
          { prompt_tokens: v.input.prompt_tokens, completion_tokens: v.input.completion_tokens, reasoning_tokens: v.input.reasoning_tokens },
          { provider: "test", model: "test", input_micro_per_million: v.input.pricing.input_micro_per_million, output_micro_per_million: v.input.pricing.output_micro_per_million, reasoning_micro_per_million: v.input.pricing.reasoning_micro_per_million },
        )
        expect(result.input_cost_micro).toBe(v.expected.input_cost_micro)
        expect(result.output_cost_micro).toBe(v.expected.output_cost_micro)
        expect(result.reasoning_cost_micro).toBe(v.expected.reasoning_cost_micro)
        expect(result.total_cost_micro).toBe(v.expected.total_cost_micro)
      })
    }
  })

  describe("total cost (BigInt path)", () => {
    for (const v of data.total_cost_vectors) {
      it(`${v.id}: BigInt — ${v.note}`, () => {
        const result = computeTotalCostMicro(
          { prompt_tokens: BigInt(v.input.prompt_tokens), completion_tokens: BigInt(v.input.completion_tokens), reasoning_tokens: BigInt(v.input.reasoning_tokens) },
          {
            input_micro_per_million: BigInt(v.input.pricing.input_micro_per_million),
            output_micro_per_million: BigInt(v.input.pricing.output_micro_per_million),
            reasoning_micro_per_million: v.input.pricing.reasoning_micro_per_million ? BigInt(v.input.pricing.reasoning_micro_per_million) : undefined,
          },
        )
        expect(result.input_cost_micro).toBe(BigInt(v.expected.input_cost_micro))
        expect(result.output_cost_micro).toBe(BigInt(v.expected.output_cost_micro))
        expect(result.reasoning_cost_micro).toBe(BigInt(v.expected.reasoning_cost_micro))
        expect(result.total_cost_micro).toBe(BigInt(v.expected.total_cost_micro))
      })
    }
  })

  describe("remainder accumulator", () => {
    for (const seq of data.remainder_accumulator_sequences) {
      it(`${seq.id}: ${seq.note}`, () => {
        const acc = new RemainderAccumulator()
        for (const step of seq.steps) {
          const { remainder_micro } = calculateCostMicro(step.tokens, step.price_micro_per_million)
          const carry = acc.carry(seq.scope_key, remainder_micro)
          expect(carry).toBe(step.expected_carry)
          expect(acc.get(seq.scope_key)).toBe(step.expected_accumulated)
        }
      })
    }
  })
})

describe("golden vectors: extreme-tokens", () => {
  const data = loadVectors("extreme-tokens.json") as {
    single_cost_vectors: Array<{
      id: string; tokens: number; price_micro_per_million: number;
      expected_cost_micro: number; expected_remainder_micro: number; note: string;
    }>;
    overflow_vectors: Array<{
      id: string; tokens: number; price_micro_per_million: number;
      expected_error: string; note: string;
    }>;
    bigint_vectors: Array<{
      id: string; tokens: string; price_micro_per_million: string;
      expected_cost_micro: string; expected_remainder_micro: string; note: string;
    }>;
    serialization_vectors: Array<{
      id: string; micro_usd_string: string; note: string;
    }>;
  }

  describe("safe boundary values (Number path)", () => {
    for (const v of data.single_cost_vectors) {
      it(`${v.id}: ${v.note}`, () => {
        const result = calculateCostMicro(v.tokens, v.price_micro_per_million)
        expect(result.cost_micro).toBe(v.expected_cost_micro)
        expect(result.remainder_micro).toBe(v.expected_remainder_micro)
      })
    }
  })

  describe("overflow detection (Number path)", () => {
    for (const v of data.overflow_vectors) {
      it(`${v.id}: ${v.note}`, () => {
        expect(() => calculateCostMicro(v.tokens, v.price_micro_per_million)).toThrow(/BUDGET_OVERFLOW/)
      })
    }
  })

  describe("BigInt calculations", () => {
    for (const v of data.bigint_vectors) {
      it(`${v.id}: ${v.note}`, () => {
        const result = computeCostMicro(BigInt(v.tokens), BigInt(v.price_micro_per_million))
        expect(result.cost_micro).toBe(BigInt(v.expected_cost_micro))
        expect(result.remainder_micro).toBe(BigInt(v.expected_remainder_micro))
      })
    }
  })

  describe("string serialization roundtrip", () => {
    for (const v of data.serialization_vectors) {
      it(`${v.id}: ${v.note}`, () => {
        const parsed = stringToMicro(v.micro_usd_string)
        const serialized = microToString(parsed)
        expect(serialized).toBe(v.micro_usd_string)
      })
    }
  })
})

describe("golden vectors: streaming-cancel", () => {
  const data = loadVectors("streaming-cancel.json") as {
    total_cost_vectors: Array<{
      id: string; note: string;
      input: {
        prompt_tokens: number; completion_tokens: number; reasoning_tokens: number;
        pricing: { input_micro_per_million: number; output_micro_per_million: number; reasoning_micro_per_million?: number };
        billing_method: string;
      };
      expected: {
        input_cost_micro: number; output_cost_micro: number;
        reasoning_cost_micro: number; total_cost_micro: number;
      };
    }>;
  }

  for (const v of data.total_cost_vectors) {
    it(`${v.id}: ${v.note}`, () => {
      // Number path
      const input = calculateCostMicro(v.input.prompt_tokens, v.input.pricing.input_micro_per_million)
      const output = calculateCostMicro(v.input.completion_tokens, v.input.pricing.output_micro_per_million)
      const reasoning = v.input.pricing.reasoning_micro_per_million
        ? calculateCostMicro(v.input.reasoning_tokens, v.input.pricing.reasoning_micro_per_million)
        : { cost_micro: 0, remainder_micro: 0 }

      expect(input.cost_micro).toBe(v.expected.input_cost_micro)
      expect(output.cost_micro).toBe(v.expected.output_cost_micro)
      expect(reasoning.cost_micro).toBe(v.expected.reasoning_cost_micro)
      expect(input.cost_micro + output.cost_micro + reasoning.cost_micro).toBe(v.expected.total_cost_micro)
    })
  }
})

describe("golden vectors: price-change-boundary", () => {
  const data = loadVectors("price-change-boundary.json") as {
    price_comparison_vectors: Array<{
      id: string; note: string; tokens: number;
      old_price: { version: number; micro_per_million: number };
      new_price: { version: number; micro_per_million: number };
      expected_old_cost_micro: number; expected_new_cost_micro: number;
    }>;
  }

  for (const v of data.price_comparison_vectors) {
    it(`${v.id}: ${v.note}`, () => {
      const oldResult = calculateCostMicro(v.tokens, v.old_price.micro_per_million)
      const newResult = calculateCostMicro(v.tokens, v.new_price.micro_per_million)
      expect(oldResult.cost_micro).toBe(v.expected_old_cost_micro)
      expect(newResult.cost_micro).toBe(v.expected_new_cost_micro)
      expect(v.new_price.version).toBeGreaterThan(v.old_price.version)
    })
  }
})

describe("golden vectors: provider-correction", () => {
  const data = loadVectors("provider-correction.json") as {
    correction_vectors: Array<{
      id: string; note: string;
      estimated: { completion_tokens: number; price_micro_per_million: number; cost_micro: number } | null;
      actual: { completion_tokens: number; price_micro_per_million: number; cost_micro: number } | null;
      expected_correction_micro: number;
    }>;
  }

  for (const v of data.correction_vectors) {
    it(`${v.id}: ${v.note}`, () => {
      if (v.estimated) {
        const estResult = calculateCostMicro(v.estimated.completion_tokens, v.estimated.price_micro_per_million)
        expect(estResult.cost_micro).toBe(v.estimated.cost_micro)
      }
      if (v.actual) {
        const actResult = calculateCostMicro(v.actual.completion_tokens, v.actual.price_micro_per_million)
        expect(actResult.cost_micro).toBe(v.actual.cost_micro)
      }
      const estimatedCost = v.estimated?.cost_micro ?? 0
      const actualCost = v.actual?.cost_micro ?? estimatedCost
      expect(actualCost - estimatedCost).toBe(v.expected_correction_micro)
    })
  }
})

// ── Number ↔ BigInt consistency ─────────────────────────────────────────

describe("Number ↔ BigInt consistency", () => {
  const data = loadVectors("basic-pricing.json") as {
    single_cost_vectors: Array<{
      tokens: number; price_micro_per_million: number;
      expected_cost_micro: number; expected_remainder_micro: number;
    }>;
  }

  it("Number and BigInt paths produce identical results for safe values", () => {
    for (const v of data.single_cost_vectors) {
      const numResult = calculateCostMicro(v.tokens, v.price_micro_per_million)
      const bigResult = computeCostMicro(BigInt(v.tokens), BigInt(v.price_micro_per_million))
      expect(bigResult.cost_micro).toBe(BigInt(numResult.cost_micro))
      expect(bigResult.remainder_micro).toBe(BigInt(numResult.remainder_micro))
    }
  })
})
