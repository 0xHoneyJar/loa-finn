// tests/finn/ensemble-scorer.test.ts — Ensemble Async Scorer tests (F9, T-31.3)

import { describe, it, expect, vi } from "vitest"
import { EnsembleOrchestrator } from "../../src/hounfour/ensemble.js"
import type { EnsembleConfig, ModelResolver, ScorerFunction } from "../../src/hounfour/ensemble.js"
import type {
  CompletionRequest,
  CompletionResult,
  ExecutionContext,
  ModelPortBase,
  PricingEntry,
} from "../../src/hounfour/types.js"

// --- Helpers ---

function makeRequest(): CompletionRequest {
  return {
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    options: {},
    metadata: { agent: "test", tenant_id: "local", nft_id: "", trace_id: "trace-001" },
  }
}

function makeContext(): ExecutionContext {
  return {
    resolved: { provider: "test", modelId: "test-model" },
    scopeMeta: { project_id: "proj-1", phase_id: "phase-1", sprint_id: "sprint-1" },
    binding: { agent: "test", model: "test:test-model", requires: {} },
    pricing: { provider: "test", model: "test-model", input_per_1m: 3, output_per_1m: 15 },
  } as ExecutionContext
}

function makeResult(content: string, overrides?: Partial<CompletionResult>): CompletionResult {
  return {
    content,
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 0 },
    metadata: { model: "test-model", latency_ms: 100, trace_id: "trace-001" },
    ...overrides,
  }
}

function makePricing(): PricingEntry {
  return { provider: "test", model: "test-model", input_per_1m: 3, output_per_1m: 15 }
}

function mockAdapter(result: CompletionResult): ModelPortBase {
  return {
    complete: vi.fn().mockResolvedValue(result),
    capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
    healthCheck: async () => ({ healthy: true, latency_ms: 10 }),
  }
}

function mockResolver(adapters: Map<string, { adapter: ModelPortBase; pricing: PricingEntry }>): ModelResolver {
  return {
    resolve: (pool: string) => {
      const entry = adapters.get(pool)
      if (!entry) throw new Error(`Unknown pool: ${pool}`)
      return entry
    },
  }
}

function makeConfig(overrides?: Partial<EnsembleConfig>): EnsembleConfig {
  return {
    models: ["pool-a", "pool-b", "pool-c"],
    strategy: "best_of_n",
    budget_per_model_micro: 1_000_000,
    budget_total_micro: 5_000_000,
    timeout_ms: 10_000,
    ...overrides,
  }
}

// --- Tests ---

describe("Ensemble Async Scorer (F9)", () => {
  it("async scorer is called for each result", async () => {
    const resultA = makeResult("Result A")
    const resultB = makeResult("Result B")
    const resultC = makeResult("Result C")

    const adapters = new Map([
      ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
      ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
      ["pool-c", { adapter: mockAdapter(resultC), pricing: makePricing() }],
    ])

    const scorerCalls: string[] = []
    const asyncScorer: ScorerFunction = async (r) => {
      scorerCalls.push(r.content)
      return r.content === "Result B" ? 0.9 : 0.5
    }

    const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
    const result = await orchestrator.run(
      makeRequest(),
      makeConfig({ scorer: asyncScorer }),
      makeContext(),
    )

    expect(scorerCalls).toHaveLength(3)
    expect(scorerCalls).toContain("Result A")
    expect(scorerCalls).toContain("Result B")
    expect(scorerCalls).toContain("Result C")
  })

  it("3 results scored [0.5, 0.9, 0.7] → result 2 returned", async () => {
    const resultA = makeResult("A-low")
    const resultB = makeResult("B-high")
    const resultC = makeResult("C-mid")

    const adapters = new Map([
      ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
      ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
      ["pool-c", { adapter: mockAdapter(resultC), pricing: makePricing() }],
    ])

    const scores: Record<string, number> = {
      "A-low": 0.5,
      "B-high": 0.9,
      "C-mid": 0.7,
    }

    const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
    const result = await orchestrator.run(
      makeRequest(),
      makeConfig({ scorer: async (r) => scores[r.content] ?? 0 }),
      makeContext(),
    )

    expect(result.selected.content).toBe("B-high")
  })

  it("ties broken by first result (deterministic)", async () => {
    const resultA = makeResult("First")
    const resultB = makeResult("Second")

    const adapters = new Map([
      ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
      ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
    ])

    const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
    const result = await orchestrator.run(
      makeRequest(),
      makeConfig({
        models: ["pool-a", "pool-b"],
        scorer: async () => 0.5, // Same score for all
      }),
      makeContext(),
    )

    // First result wins on tie
    expect(result.selected.content).toBe("First")
  })

  it("sync scorer still works (backward compatible)", async () => {
    const resultA = makeResult("Short", {
      usage: { prompt_tokens: 10, completion_tokens: 100, reasoning_tokens: 0 },
    })
    const resultB = makeResult("x", {
      usage: { prompt_tokens: 10, completion_tokens: 1, reasoning_tokens: 0 },
    })

    const adapters = new Map([
      ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
      ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
    ])

    // Sync scorer (returns number, not Promise)
    const syncScorer = (r: CompletionResult) => -r.usage.completion_tokens

    const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
    const result = await orchestrator.run(
      makeRequest(),
      makeConfig({
        models: ["pool-a", "pool-b"],
        scorer: syncScorer as any, // Sync fn where async expected — should work via resolveScorer wrapper
      }),
      makeContext(),
    )

    expect(result.selected.content).toBe("x") // Fewest tokens
  })

  it("existing consensus behavior unchanged", async () => {
    const resultA = makeResult('{"color":"blue","size":"large"}')
    const resultB = makeResult('{"color":"blue","size":"small"}')
    const resultC = makeResult('{"color":"blue","size":"large"}')

    const adapters = new Map([
      ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
      ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
      ["pool-c", { adapter: mockAdapter(resultC), pricing: makePricing() }],
    ])

    const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
    const result = await orchestrator.run(
      makeRequest(),
      makeConfig({ strategy: "consensus" }),
      makeContext(),
    )

    expect(result.strategy_used).toBe("consensus")
    const parsed = JSON.parse(result.selected.content)
    expect(parsed.color).toBe("blue")
    expect(parsed.size).toBe("large")
  })
})
