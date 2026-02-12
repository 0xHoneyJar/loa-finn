// tests/finn/ensemble-cost-attribution.test.ts — Ensemble Cost Attribution (Task 3.8)
// Cancelled branch billing, per-model ledger entries, ensemble_id linking.

import { describe, it, expect } from "vitest"
import {
  buildStreamingEnsembleLedgerEntries,
  validateEnsembleBilling,
  computeEnsembleTotalCost,
  type EnsembleLedgerContext,
} from "../../src/hounfour/ensemble-cost-attribution.js"
import type { EnsembleStreamingFinalResult, EnsembleStreamingBranchResult } from "../../src/hounfour/ensemble.js"
import type { StreamCostResult, BillingMethod } from "../../src/hounfour/stream-cost.js"
import { findPricing, type MicroPricingEntry } from "../../src/hounfour/pricing.js"

// --- Helpers ---

const GPT4O_PRICING = findPricing("openai", "gpt-4o")!
const OPUS_PRICING = findPricing("anthropic", "claude-opus-4-6")!

function makeContext(): EnsembleLedgerContext {
  return {
    tenantId: "tenant-abc",
    projectId: "proj-1",
    phaseId: "phase-1",
    sprintId: "sprint-3",
    agent: "test-agent",
    priceTableVersion: 1,
  }
}

function makeCostResult(overrides: Partial<StreamCostResult> = {}): StreamCostResult {
  return {
    billing_method: "provider_reported" as BillingMethod,
    prompt_tokens: 100,
    completion_tokens: 50,
    reasoning_tokens: 0,
    total_cost_micro: 1500n,
    observed_bytes: 200,
    was_aborted: false,
    ...overrides,
  }
}

function makeBranch(pool: string, overrides: Partial<EnsembleStreamingBranchResult> = {}): EnsembleStreamingBranchResult {
  return {
    pool,
    status: "completed",
    cost: makeCostResult(),
    latency_ms: 200,
    error: null,
    ...overrides,
  }
}

function makeResult(branches: EnsembleStreamingBranchResult[]): EnsembleStreamingFinalResult {
  return {
    ensemble_id: "ens-test-001",
    selected: {
      content: "test result",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
      metadata: { model: "test" },
    },
    branches,
    total_cost_micro: branches.reduce((sum, b) => sum + (b.cost?.total_cost_micro ?? 0n), 0n),
    strategy: "first_complete",
  }
}

// --- Tests ---

describe("buildStreamingEnsembleLedgerEntries", () => {
  it("creates per-branch ledger entries with ensemble_id", () => {
    const result = makeResult([
      makeBranch("openai-gpt4o"),
      makeBranch("anthropic-opus"),
    ])

    const pricings = new Map<string, MicroPricingEntry>([
      ["openai-gpt4o", GPT4O_PRICING],
      ["anthropic-opus", OPUS_PRICING],
    ])

    const entries = buildStreamingEnsembleLedgerEntries(result, makeContext(), pricings)

    expect(entries).toHaveLength(2)
    // All entries share ensemble_id
    expect(entries[0].entry.ensemble_id).toBe("ens-test-001")
    expect(entries[1].entry.ensemble_id).toBe("ens-test-001")
    // Each entry has unique trace_id
    expect(entries[0].entry.trace_id).not.toBe(entries[1].entry.trace_id)
  })

  it("winner gets provider_reported billing method", () => {
    const result = makeResult([
      makeBranch("winner-pool", {
        cost: makeCostResult({ billing_method: "provider_reported", total_cost_micro: 2000n }),
      }),
    ])

    const entries = buildStreamingEnsembleLedgerEntries(
      result, makeContext(), new Map([["winner-pool", GPT4O_PRICING]]),
    )

    expect(entries[0].billing_method).toBe("provider_reported")
    expect(entries[0].entry.billing_method).toBe("provider_reported")
  })

  it("cancelled branch gets observed_chunks_overcount", () => {
    const result = makeResult([
      makeBranch("winner"),
      makeBranch("loser", {
        status: "cancelled",
        cost: makeCostResult({
          billing_method: "observed_chunks_overcount",
          total_cost_micro: 800n,
          was_aborted: true,
        }),
      }),
    ])

    const pricings = new Map<string, MicroPricingEntry>([
      ["winner", GPT4O_PRICING],
      ["loser", OPUS_PRICING],
    ])

    const entries = buildStreamingEnsembleLedgerEntries(result, makeContext(), pricings)

    expect(entries[1].billing_method).toBe("observed_chunks_overcount")
    expect(entries[1].entry.billing_method).toBe("observed_chunks_overcount")
  })

  it("cancelled branch with no chunks gets prompt_only", () => {
    const result = makeResult([
      makeBranch("winner"),
      makeBranch("loser", {
        status: "cancelled",
        cost: makeCostResult({
          billing_method: "prompt_only",
          completion_tokens: 0,
          total_cost_micro: 250n,
          was_aborted: true,
        }),
      }),
    ])

    const entries = buildStreamingEnsembleLedgerEntries(
      result, makeContext(), new Map([["winner", GPT4O_PRICING], ["loser", OPUS_PRICING]]),
    )

    expect(entries[1].billing_method).toBe("prompt_only")
    expect(entries[1].entry.completion_tokens).toBe(0)
  })

  it("handles branches with null cost (early failure)", () => {
    const result = makeResult([
      makeBranch("winner"),
      makeBranch("failed", { status: "failed", cost: null, error: "connection refused" }),
    ])

    const entries = buildStreamingEnsembleLedgerEntries(
      result, makeContext(), new Map([["winner", GPT4O_PRICING], ["failed", OPUS_PRICING]]),
    )

    expect(entries).toHaveLength(2)
    expect(entries[1].billing_method).toBe("prompt_only")
    expect(entries[1].entry.total_cost_micro).toBe("0")
  })

  it("populates context fields correctly", () => {
    const ctx = makeContext()
    const result = makeResult([makeBranch("pool-a")])
    const entries = buildStreamingEnsembleLedgerEntries(
      result, ctx, new Map([["pool-a", GPT4O_PRICING]]),
    )

    expect(entries[0].entry.tenant_id).toBe("tenant-abc")
    expect(entries[0].entry.project_id).toBe("proj-1")
    expect(entries[0].entry.phase_id).toBe("phase-1")
    expect(entries[0].entry.sprint_id).toBe("sprint-3")
    expect(entries[0].entry.agent).toBe("test-agent")
    expect(entries[0].entry.schema_version).toBe(2)
  })
})

describe("validateEnsembleBilling", () => {
  it("validates correct billing entries", () => {
    const result = makeResult([
      makeBranch("a", { cost: makeCostResult({ billing_method: "provider_reported" }) }),
      makeBranch("b", { cost: makeCostResult({ billing_method: "observed_chunks_overcount" }) }),
    ])

    const entries = buildStreamingEnsembleLedgerEntries(
      result, makeContext(), new Map([["a", GPT4O_PRICING], ["b", OPUS_PRICING]]),
    )

    const validation = validateEnsembleBilling(entries)
    expect(validation.valid).toBe(true)
    expect(validation.issues).toHaveLength(0)
  })

  it("detects empty entries", () => {
    const validation = validateEnsembleBilling([])
    expect(validation.valid).toBe(false)
    expect(validation.issues).toContain("No branch entries")
  })
})

describe("computeEnsembleTotalCost", () => {
  it("sums all branch costs", () => {
    const result = makeResult([
      makeBranch("a", { cost: makeCostResult({ total_cost_micro: 1000n }) }),
      makeBranch("b", { cost: makeCostResult({ total_cost_micro: 2000n }) }),
      makeBranch("c", { cost: makeCostResult({ total_cost_micro: 500n }) }),
    ])

    const entries = buildStreamingEnsembleLedgerEntries(
      result, makeContext(),
      new Map([["a", GPT4O_PRICING], ["b", OPUS_PRICING], ["c", GPT4O_PRICING]]),
    )

    const total = computeEnsembleTotalCost(entries)
    expect(total).toBe(3500n)
  })

  it("handles zero-cost entries", () => {
    const result = makeResult([
      makeBranch("a", { cost: makeCostResult({ total_cost_micro: 1000n }) }),
      makeBranch("b", { cost: null }),
    ])

    const entries = buildStreamingEnsembleLedgerEntries(
      result, makeContext(),
      new Map([["a", GPT4O_PRICING], ["b", OPUS_PRICING]]),
    )

    const total = computeEnsembleTotalCost(entries)
    expect(total).toBe(1000n)
  })
})
