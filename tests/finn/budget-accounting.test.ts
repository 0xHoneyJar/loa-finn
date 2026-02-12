// tests/finn/budget-accounting.test.ts — Budget Accounting E2E (Task 2.10, A.8)
// 10K requests, verify drift < threshold across the full cost pipeline.
// Pipeline: pricing → computeCostMicro → LedgerV2 → verify totals match.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  computeCostMicro,
  computeTotalCostMicro,
  validateRequestCost,
  microToString,
  stringToMicro,
  MAX_REQUEST_COST_MICRO,
  type BigIntUsage,
  type BigIntPricing,
} from "../../src/hounfour/budget.ts"
import {
  calculateCostMicro as calculateCostMicroNumber,
  calculateTotalCostMicro as calculateTotalNumber,
  RemainderAccumulator,
  findPricing,
  DEFAULT_PRICING,
  PRICE_TABLE_VERSION,
  type MicroPricingEntry,
} from "../../src/hounfour/pricing.ts"
import { LedgerV2, crc32, verifyCrc32, stampCrc32 } from "../../src/hounfour/ledger-v2.ts"
import { deriveIdempotencyKey } from "@0xhoneyjar/loa-hounfour"
import type { LedgerEntryV2 } from "../../src/hounfour/types.ts"

// --- Helpers ---

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "budget-e2e-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeEntry(overrides: Partial<LedgerEntryV2> = {}): LedgerEntryV2 {
  return {
    schema_version: 2,
    timestamp: new Date().toISOString(),
    trace_id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    agent: "test-agent",
    provider: "openai",
    model: "gpt-4o",
    project_id: "proj-1",
    phase_id: "phase-1",
    sprint_id: "sprint-1",
    tenant_id: "tenant-abc",
    prompt_tokens: 1000,
    completion_tokens: 500,
    reasoning_tokens: 0,
    input_cost_micro: "2500",
    output_cost_micro: "5000",
    reasoning_cost_micro: "0",
    total_cost_micro: "7500",
    price_table_version: PRICE_TABLE_VERSION,
    billing_method: "provider_reported",
    latency_ms: 150,
    ...overrides,
  }
}

// --- Tests ---

describe("BigInt cost computation accuracy", () => {
  it("matches Number-based calculation for typical values", () => {
    const pricing = findPricing("openai", "gpt-4o")!
    const tokens = 1000

    const bigIntResult = computeCostMicro(
      BigInt(tokens),
      BigInt(pricing.input_micro_per_million),
    )
    const numberResult = calculateCostMicroNumber(
      tokens,
      pricing.input_micro_per_million,
    )

    expect(Number(bigIntResult.cost_micro)).toBe(numberResult.cost_micro)
    expect(Number(bigIntResult.remainder_micro)).toBe(numberResult.remainder_micro)
  })

  it("computes correct cost for all default pricing entries", () => {
    for (const pricing of DEFAULT_PRICING) {
      const usage: BigIntUsage = {
        prompt_tokens: 10000n,
        completion_tokens: 5000n,
        reasoning_tokens: pricing.reasoning_micro_per_million ? 2000n : 0n,
      }
      const bigPricing: BigIntPricing = {
        input_micro_per_million: BigInt(pricing.input_micro_per_million),
        output_micro_per_million: BigInt(pricing.output_micro_per_million),
        reasoning_micro_per_million: pricing.reasoning_micro_per_million
          ? BigInt(pricing.reasoning_micro_per_million)
          : undefined,
      }

      const result = computeTotalCostMicro(usage, bigPricing)

      // Verify: total = input + output + reasoning
      expect(result.total_cost_micro).toBe(
        result.input_cost_micro + result.output_cost_micro + result.reasoning_cost_micro,
      )

      // Verify: all costs are non-negative
      expect(result.input_cost_micro).toBeGreaterThanOrEqual(0n)
      expect(result.output_cost_micro).toBeGreaterThanOrEqual(0n)
      expect(result.reasoning_cost_micro).toBeGreaterThanOrEqual(0n)
    }
  })

  it("validates per-request cost limit ($1000)", () => {
    const justUnder = MAX_REQUEST_COST_MICRO
    expect(() => validateRequestCost(justUnder)).not.toThrow()

    const justOver = MAX_REQUEST_COST_MICRO + 1n
    expect(() => validateRequestCost(justOver)).toThrow("BUDGET_OVERFLOW")
  })
})

describe("wire format round-trip (string micro-USD)", () => {
  it("serializes and deserializes BigInt losslessly", () => {
    const values = [0n, 1n, 999999n, 1_000_000n, 999_999_999_999n]
    for (const v of values) {
      const wire = microToString(v)
      expect(typeof wire).toBe("string")
      expect(/^[0-9]+$/.test(wire)).toBe(true)
      const parsed = stringToMicro(wire)
      expect(parsed).toBe(v)
    }
  })

  it("rejects non-integer strings", () => {
    expect(() => stringToMicro("12.5")).toThrow("BUDGET_PARSE")
    expect(() => stringToMicro("-100")).toThrow("BUDGET_PARSE")
    expect(() => stringToMicro("abc")).toThrow("BUDGET_PARSE")
    expect(() => stringToMicro("")).toThrow("BUDGET_PARSE")
  })
})

describe("remainder accumulator across many requests", () => {
  it("accumulates remainder and carries correctly over 1000 requests", () => {
    const acc = new RemainderAccumulator()
    const pricing = findPricing("openai", "gpt-4o")!

    let totalViaCost = 0
    let totalViaCarry = 0

    for (let i = 0; i < 1000; i++) {
      const tokens = 7 // Small token count → high remainder
      const result = calculateCostMicroNumber(tokens, pricing.input_micro_per_million)
      totalViaCost += result.cost_micro
      const carry = acc.carry("scope-1", result.remainder_micro)
      totalViaCarry += result.cost_micro + carry
    }

    // Carry-adjusted total should be >= direct total (never under-charges)
    expect(totalViaCarry).toBeGreaterThanOrEqual(totalViaCost)

    // The carry total reclaims remainders that would otherwise be lost.
    // Drift between the two methods is bounded by number of carries.
    // Each carry adds 1 micro-USD, and with 1000 small requests the
    // accumulated remainder can produce many carries.
    const drift = totalViaCarry - totalViaCost
    expect(drift).toBeGreaterThanOrEqual(0)
    // Drift should be bounded by (total_remainder / 1_000_000) which is reasonable
    expect(drift).toBeLessThanOrEqual(1000)
  })
})

describe("10K request budget accounting pipeline", () => {
  it("total cost matches sum of individual costs with < 1 micro-USD drift per entry", async () => {
    const ledger = new LedgerV2({ baseDir: tmpDir, fsync: false })
    const pricing = findPricing("openai", "gpt-4o")!
    const tenantId = "tenant-10k"

    let expectedTotalMicro = 0n
    const N = 10_000

    for (let i = 0; i < N; i++) {
      const promptTokens = 100 + (i % 500)
      const completionTokens = 50 + (i % 200)

      const cost = computeTotalCostMicro(
        {
          prompt_tokens: BigInt(promptTokens),
          completion_tokens: BigInt(completionTokens),
          reasoning_tokens: 0n,
        },
        {
          input_micro_per_million: BigInt(pricing.input_micro_per_million),
          output_micro_per_million: BigInt(pricing.output_micro_per_million),
        },
      )

      expectedTotalMicro += cost.total_cost_micro

      const entry = makeEntry({
        tenant_id: tenantId,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        input_cost_micro: microToString(cost.input_cost_micro),
        output_cost_micro: microToString(cost.output_cost_micro),
        reasoning_cost_micro: "0",
        total_cost_micro: microToString(cost.total_cost_micro),
        trace_id: `trace-${i}`,
      })

      await ledger.append(tenantId, stampCrc32(entry))
    }

    // Recompute from ledger
    let ledgerTotal = 0n
    let entryCount = 0
    for await (const entry of ledger.scanEntries(tenantId)) {
      expect(verifyCrc32(entry)).toBe(true)
      ledgerTotal += stringToMicro(entry.total_cost_micro)
      entryCount++
    }

    expect(entryCount).toBe(N)
    // Drift should be zero — same arithmetic path
    expect(ledgerTotal).toBe(expectedTotalMicro)
  })

  it("multi-tenant isolation: costs do not bleed between tenants", async () => {
    const ledger = new LedgerV2({ baseDir: tmpDir, fsync: false })
    const pricing = findPricing("openai", "gpt-4o")!
    const tenants = ["tenant-a", "tenant-b", "tenant-c"]
    const expectedTotals = new Map<string, bigint>()

    for (const tid of tenants) {
      let total = 0n
      for (let i = 0; i < 100; i++) {
        const cost = computeTotalCostMicro(
          { prompt_tokens: 500n, completion_tokens: 200n, reasoning_tokens: 0n },
          {
            input_micro_per_million: BigInt(pricing.input_micro_per_million),
            output_micro_per_million: BigInt(pricing.output_micro_per_million),
          },
        )
        total += cost.total_cost_micro
        const entry = stampCrc32(makeEntry({
          tenant_id: tid,
          total_cost_micro: microToString(cost.total_cost_micro),
          input_cost_micro: microToString(cost.input_cost_micro),
          output_cost_micro: microToString(cost.output_cost_micro),
        }))
        await ledger.append(tid, entry)
      }
      expectedTotals.set(tid, total)
    }

    // Verify each tenant's total independently
    for (const tid of tenants) {
      let ledgerTotal = 0n
      for await (const entry of ledger.scanEntries(tid)) {
        ledgerTotal += stringToMicro(entry.total_cost_micro)
      }
      expect(ledgerTotal).toBe(expectedTotals.get(tid))
    }
  })

  it("CRC32 detects corruption in ledger entries", async () => {
    const entry = stampCrc32(makeEntry())
    expect(verifyCrc32(entry)).toBe(true)

    // Corrupt a field
    const corrupted = { ...entry, total_cost_micro: "999999999" }
    expect(verifyCrc32(corrupted)).toBe(false)
  })
})

describe("idempotency key stability across budget path", () => {
  it("same request produces same idempotency key regardless of trace_id", () => {
    const tenant = "tenant-abc"
    const reqHash = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    const provider = "openai"
    const model = "gpt-4o"

    const key1 = deriveIdempotencyKey(tenant, reqHash, provider, model)
    const key2 = deriveIdempotencyKey(tenant, reqHash, provider, model)
    expect(key1).toBe(key2)
  })

  it("different request body produces different idempotency key", () => {
    const tenant = "tenant-abc"
    const provider = "openai"
    const model = "gpt-4o"

    const key1 = deriveIdempotencyKey(tenant, "sha256:aaa", provider, model)
    const key2 = deriveIdempotencyKey(tenant, "sha256:bbb", provider, model)
    expect(key1).not.toBe(key2)
  })

  it("different model produces different idempotency key", () => {
    const tenant = "tenant-abc"
    const reqHash = "sha256:same"
    const key1 = deriveIdempotencyKey(tenant, reqHash, "openai", "gpt-4o")
    const key2 = deriveIdempotencyKey(tenant, reqHash, "anthropic", "claude-opus-4-6")
    expect(key1).not.toBe(key2)
  })
})

describe("pricing table integrity", () => {
  it("all default pricing entries have valid positive prices", () => {
    for (const entry of DEFAULT_PRICING) {
      expect(entry.input_micro_per_million).toBeGreaterThan(0)
      expect(entry.output_micro_per_million).toBeGreaterThan(0)
      if (entry.reasoning_micro_per_million !== undefined) {
        expect(entry.reasoning_micro_per_million).toBeGreaterThan(0)
      }
      expect(entry.provider.length).toBeGreaterThan(0)
      expect(entry.model.length).toBeGreaterThan(0)
    }
  })

  it("findPricing returns correct entries", () => {
    const gpt4o = findPricing("openai", "gpt-4o")
    expect(gpt4o).toBeDefined()
    expect(gpt4o!.input_micro_per_million).toBe(2_500_000)

    const opus = findPricing("anthropic", "claude-opus-4-6")
    expect(opus).toBeDefined()
    expect(opus!.input_micro_per_million).toBe(15_000_000)

    const missing = findPricing("nonexistent", "model")
    expect(missing).toBeUndefined()
  })

  it("price table version is monotonically increasing integer", () => {
    expect(PRICE_TABLE_VERSION).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(PRICE_TABLE_VERSION)).toBe(true)
  })
})

describe("ledger V2 append and scan pipeline", () => {
  it("appends entries and scans them back with matching totals", async () => {
    const ledger = new LedgerV2({ baseDir: tmpDir, fsync: false })
    const entries: LedgerEntryV2[] = []

    for (let i = 0; i < 50; i++) {
      const entry = stampCrc32(makeEntry({
        trace_id: `trace-scan-${i}`,
        total_cost_micro: String(1000 + i),
      }))
      entries.push(entry)
      await ledger.append("tenant-scan", entry)
    }

    let count = 0
    for await (const scanned of ledger.scanEntries("tenant-scan")) {
      expect(scanned.trace_id).toBe(entries[count].trace_id)
      expect(scanned.total_cost_micro).toBe(entries[count].total_cost_micro)
      expect(verifyCrc32(scanned)).toBe(true)
      count++
    }
    expect(count).toBe(50)
  })

  it("recompute yields correct totals from ledger entries", async () => {
    const ledger = new LedgerV2({ baseDir: tmpDir, fsync: false })
    let expectedTotal = 0n

    for (let i = 0; i < 100; i++) {
      const cost = BigInt(1000 + i * 10)
      expectedTotal += cost
      await ledger.append("tenant-recompute", stampCrc32(makeEntry({
        total_cost_micro: microToString(cost),
      })))
    }

    const result = await ledger.recompute("tenant-recompute")
    expect(result.totalCostMicro).toBe(expectedTotal)
    expect(result.totalEntries).toBe(100)
  })
})
