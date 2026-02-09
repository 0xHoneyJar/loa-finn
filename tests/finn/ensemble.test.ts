// tests/finn/ensemble.test.ts — EnsembleOrchestrator tests (T-B.3, T-B.6)

import { describe, it, expect, vi } from "vitest"
import { EnsembleOrchestrator, buildEnsembleUsageReports, buildEnsembleLedgerEntries } from "../../src/hounfour/ensemble.js"
import type { EnsembleConfig, ModelResolver, EnsembleModelResult, EnsembleResult } from "../../src/hounfour/ensemble.js"
import type {
  CompletionRequest,
  CompletionResult,
  ExecutionContext,
  ModelPortBase,
  ModelCapabilities,
  HealthStatus,
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

function makePricing(overrides?: Partial<PricingEntry>): PricingEntry {
  return {
    provider: "test",
    model: "test-model",
    input_per_1m: 3,     // $3 per 1M input tokens
    output_per_1m: 15,   // $15 per 1M output tokens
    ...overrides,
  }
}

/** Create a mock adapter that returns a result after a delay */
function mockAdapter(result: CompletionResult, delayMs = 0): ModelPortBase {
  return {
    complete: vi.fn().mockImplementation(async () => {
      if (delayMs > 0) await sleep(delayMs)
      return result
    }),
    capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
    healthCheck: async () => ({ healthy: true, latency_ms: 10 }),
  }
}

/** Create a mock adapter that throws */
function failingAdapter(error: string, delayMs = 0): ModelPortBase {
  return {
    complete: vi.fn().mockImplementation(async () => {
      if (delayMs > 0) await sleep(delayMs)
      throw new Error(error)
    }),
    capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
    healthCheck: async () => ({ healthy: false, latency_ms: 0 }),
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
    models: ["pool-a", "pool-b"],
    strategy: "first_complete",
    budget_per_model_micro: 1_000_000, // $1 per model
    budget_total_micro: 5_000_000,      // $5 total
    timeout_ms: 10_000,
    ...overrides,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// --- Tests ---

describe("EnsembleOrchestrator", () => {
  describe("first_complete", () => {
    it("returns the first successful result", async () => {
      const fastResult = makeResult("Fast answer")
      const slowResult = makeResult("Slow answer")

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(fastResult, 10), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(slowResult, 100), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(makeRequest(), makeConfig(), makeContext())

      expect(result.ensemble_id).toBeTruthy()
      expect(result.strategy_used).toBe("first_complete")
      expect(result.selected.content).toBe("Fast answer")
    })

    it("returns second model if first fails", async () => {
      const goodResult = makeResult("Good answer")

      const adapters = new Map([
        ["pool-a", { adapter: failingAdapter("model-a failed", 10), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(goodResult, 50), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(makeRequest(), makeConfig(), makeContext())

      expect(result.selected.content).toBe("Good answer")
    })

    it("throws when all models fail", async () => {
      const adapters = new Map([
        ["pool-a", { adapter: failingAdapter("error-a"), pricing: makePricing() }],
        ["pool-b", { adapter: failingAdapter("error-b"), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      await expect(
        orchestrator.run(makeRequest(), makeConfig(), makeContext()),
      ).rejects.toThrow("all 2 models failed")
    })

    it("generates unique ensemble_id per run", async () => {
      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(makeResult("ok")), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(makeResult("ok")), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const r1 = await orchestrator.run(makeRequest(), makeConfig(), makeContext())
      const r2 = await orchestrator.run(makeRequest(), makeConfig(), makeContext())

      expect(r1.ensemble_id).not.toBe(r2.ensemble_id)
    })

    it("calculates total_cost_micro from pricing", async () => {
      const result = makeResult("ok", {
        usage: { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0 },
      })

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(result, 5), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(result, 50), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const ensembleResult = await orchestrator.run(makeRequest(), makeConfig(), makeContext())

      // cost = (1000 * 3 / 1M) + (500 * 15 / 1M) = 0.003 + 0.0075 = 0.0105 USD
      // micro = 10500
      // At least the winner's cost should be present
      expect(ensembleResult.total_cost_micro).toBeGreaterThan(0)
    })
  })

  describe("best_of_n", () => {
    it("selects the highest-scored result", async () => {
      const shortResult = makeResult("Short", {
        usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
      })
      const longResult = makeResult("This is a much more detailed and comprehensive answer", {
        usage: { prompt_tokens: 10, completion_tokens: 10, reasoning_tokens: 0 },
      })

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(shortResult), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(longResult), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "best_of_n" }),
        makeContext(),
      )

      expect(result.strategy_used).toBe("best_of_n")
      // Default scorer: content_length / tokens — longer content with same tokens wins
      expect(result.selected.content).toBe("This is a much more detailed and comprehensive answer")
    })

    it("uses custom scorer when provided", async () => {
      const resultA = makeResult("abc", {
        usage: { prompt_tokens: 10, completion_tokens: 100, reasoning_tokens: 0 },
      })
      const resultB = makeResult("x", {
        usage: { prompt_tokens: 10, completion_tokens: 1, reasoning_tokens: 0 },
      })

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
      ])

      // Custom scorer: prefer fewer completion tokens (cheapest)
      const scorer = (r: CompletionResult) => -r.usage.completion_tokens

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "best_of_n", scorer }),
        makeContext(),
      )

      expect(result.selected.content).toBe("x")
    })

    it("includes all model results (including failures)", async () => {
      const goodResult = makeResult("good")

      const adapters = new Map([
        ["pool-a", { adapter: failingAdapter("model-a error"), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(goodResult), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "best_of_n" }),
        makeContext(),
      )

      expect(result.all_results).toHaveLength(2)
      expect(result.all_results.filter(r => r.error !== null)).toHaveLength(1)
      expect(result.selected.content).toBe("good")
    })

    it("throws when all models fail", async () => {
      const adapters = new Map([
        ["pool-a", { adapter: failingAdapter("error-a"), pricing: makePricing() }],
        ["pool-b", { adapter: failingAdapter("error-b"), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      await expect(
        orchestrator.run(makeRequest(), makeConfig({ strategy: "best_of_n" }), makeContext()),
      ).rejects.toThrow("all 2 models failed")
    })

    it("reports total cost across all models", async () => {
      const result = makeResult("ok", {
        usage: { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0 },
      })

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(result), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(result), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const ensembleResult = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "best_of_n" }),
        makeContext(),
      )

      // Both models complete, so total cost = 2x single cost
      // (1000 * 3 / 1M) + (500 * 15 / 1M) = 0.0105 per model
      // micro = 10500 per model × 2 = 21000
      expect(ensembleResult.total_cost_micro).toBe(21000)
    })
  })

  describe("consensus", () => {
    it("performs majority vote on JSON fields", async () => {
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
        makeConfig({ models: ["pool-a", "pool-b", "pool-c"], strategy: "consensus" }),
        makeContext(),
      )

      expect(result.strategy_used).toBe("consensus")
      const parsed = JSON.parse(result.selected.content)
      expect(parsed.color).toBe("blue")    // 3/3 agree
      expect(parsed.size).toBe("large")    // 2/3 agree
    })

    it("falls back to first result when content is not JSON", async () => {
      const resultA = makeResult("This is not JSON")
      const resultB = makeResult("Also not JSON")

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "consensus" }),
        makeContext(),
      )

      // Falls back to first successful result
      expect(result.selected.content).toBe("This is not JSON")
    })

    it("uses custom fieldExtractor", async () => {
      const resultA = makeResult("ANSWER: red")
      const resultB = makeResult("ANSWER: blue")
      const resultC = makeResult("ANSWER: red")

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
        ["pool-c", { adapter: mockAdapter(resultC), pricing: makePricing() }],
      ])

      const fieldExtractor = (r: CompletionResult) => {
        const match = r.content.match(/ANSWER: (\w+)/)
        return match ? { answer: match[1] } : null
      }

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({
          models: ["pool-a", "pool-b", "pool-c"],
          strategy: "consensus",
          fieldExtractor,
        }),
        makeContext(),
      )

      const parsed = JSON.parse(result.selected.content)
      expect(parsed.answer).toBe("red") // 2/3 vote
    })

    it("aggregates usage across all models", async () => {
      const resultA = makeResult('{"x":1}', {
        usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
      })
      const resultB = makeResult('{"x":1}', {
        usage: { prompt_tokens: 200, completion_tokens: 100, reasoning_tokens: 0 },
      })

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(resultA), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(resultB), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "consensus" }),
        makeContext(),
      )

      expect(result.selected.usage.prompt_tokens).toBe(300)
      expect(result.selected.usage.completion_tokens).toBe(150)
    })
  })

  describe("error handling", () => {
    it("throws on empty models list", async () => {
      const orchestrator = new EnsembleOrchestrator(mockResolver(new Map()))
      await expect(
        orchestrator.run(makeRequest(), makeConfig({ models: [] }), makeContext()),
      ).rejects.toThrow("no models specified")
    })

    it("handles unknown strategy", async () => {
      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(makeResult("ok")), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      await expect(
        orchestrator.run(
          makeRequest(),
          makeConfig({ models: ["pool-a"], strategy: "unknown" as any }),
          makeContext(),
        ),
      ).rejects.toThrow("Unknown ensemble strategy")
    })

    it("records individual model errors in all_results", async () => {
      const goodResult = makeResult("good")

      const adapters = new Map([
        ["pool-a", { adapter: failingAdapter("timeout"), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(goodResult), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(makeRequest(), makeConfig(), makeContext())

      const failedResult = result.all_results.find(r => r.pool === "pool-a")
      expect(failedResult?.error).toContain("timeout")
      expect(failedResult?.result).toBeNull()
    })
  })

  describe("budget enforcement", () => {
    it("records per-model cost_micro in results", async () => {
      const result = makeResult("ok", {
        usage: { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0 },
      })

      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(result), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(result), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const ensembleResult = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "best_of_n" }),
        makeContext(),
      )

      for (const modelResult of ensembleResult.all_results) {
        if (modelResult.result) {
          // cost = (1000 * 3 / 1M) + (500 * 15 / 1M) = 0.0105 USD = 10500 micro
          expect(modelResult.cost_micro).toBe(10500)
        }
      }
    })

    it("records latency_ms per model", async () => {
      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(makeResult("fast"), 10), pricing: makePricing() }],
        ["pool-b", { adapter: mockAdapter(makeResult("slow"), 50), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({ strategy: "best_of_n" }),
        makeContext(),
      )

      for (const modelResult of result.all_results) {
        expect(modelResult.latency_ms).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe("single model ensemble", () => {
    it("works with a single model (degenerate case)", async () => {
      const adapters = new Map([
        ["pool-a", { adapter: mockAdapter(makeResult("solo")), pricing: makePricing() }],
      ])

      const orchestrator = new EnsembleOrchestrator(mockResolver(adapters))
      const result = await orchestrator.run(
        makeRequest(),
        makeConfig({ models: ["pool-a"] }),
        makeContext(),
      )

      expect(result.selected.content).toBe("solo")
      expect(result.all_results).toHaveLength(1)
    })
  })

  // --- T-B.4: Cost Attribution ---

  describe("cost attribution (T-B.4)", () => {
    function makeEnsembleResult(): EnsembleResult {
      return {
        ensemble_id: "ENS_TEST_001",
        selected: makeResult("selected", {
          usage: { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0 },
          metadata: { model: "model-a", latency_ms: 100, trace_id: "trace-001" },
        }),
        all_results: [
          {
            pool: "pool-a",
            result: makeResult("result-a", {
              usage: { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0 },
              metadata: { model: "model-a", latency_ms: 100, trace_id: "trace-001" },
            }),
            error: null,
            cost_micro: 10500,
            latency_ms: 100,
          },
          {
            pool: "pool-b",
            result: makeResult("result-b", {
              usage: { prompt_tokens: 800, completion_tokens: 300, reasoning_tokens: 0 },
              metadata: { model: "model-b", latency_ms: 200, trace_id: "trace-001" },
            }),
            error: null,
            cost_micro: 6900,
            latency_ms: 200,
          },
          {
            pool: "pool-c",
            result: null,
            error: "model-c failed",
            cost_micro: 0,
            latency_ms: 50,
          },
        ],
        strategy_used: "best_of_n",
        total_cost_micro: 17400,
      }
    }

    describe("buildEnsembleUsageReports", () => {
      it("creates one UsageReport per successful model", () => {
        const reports = buildEnsembleUsageReports(makeEnsembleResult(), makeContext())
        expect(reports).toHaveLength(2) // pool-c failed, excluded
      })

      it("each report has shared ensemble_id", () => {
        const reports = buildEnsembleUsageReports(makeEnsembleResult(), makeContext())
        for (const report of reports) {
          expect(report.ensemble_id).toBe("ENS_TEST_001")
        }
      })

      it("each report has unique report_id", () => {
        const reports = buildEnsembleUsageReports(makeEnsembleResult(), makeContext())
        expect(reports[0].report_id).not.toBe(reports[1].report_id)
      })

      it("each report has individual token counts and cost", () => {
        const reports = buildEnsembleUsageReports(makeEnsembleResult(), makeContext())
        const reportA = reports.find(r => r.pool_id === "pool-a")!
        const reportB = reports.find(r => r.pool_id === "pool-b")!

        expect(reportA.input_tokens).toBe(1000)
        expect(reportA.output_tokens).toBe(500)
        expect(reportA.cost_micro).toBe(10500)

        expect(reportB.input_tokens).toBe(800)
        expect(reportB.output_tokens).toBe(300)
        expect(reportB.cost_micro).toBe(6900)
      })

      it("skips failed models (no usage to report)", () => {
        const reports = buildEnsembleUsageReports(makeEnsembleResult(), makeContext())
        const poolIds = reports.map(r => r.pool_id)
        expect(poolIds).not.toContain("pool-c")
      })
    })

    describe("buildEnsembleLedgerEntries", () => {
      it("creates one LedgerEntry per successful model", () => {
        const entries = buildEnsembleLedgerEntries(makeEnsembleResult(), makeContext())
        expect(entries).toHaveLength(2)
      })

      it("each entry has shared ensemble_id", () => {
        const entries = buildEnsembleLedgerEntries(makeEnsembleResult(), makeContext())
        for (const entry of entries) {
          expect(entry.ensemble_id).toBe("ENS_TEST_001")
        }
      })

      it("each entry has individual costs and tokens", () => {
        const entries = buildEnsembleLedgerEntries(makeEnsembleResult(), makeContext())
        const entryA = entries.find(e => e.provider === "pool-a")!
        const entryB = entries.find(e => e.provider === "pool-b")!

        expect(entryA.prompt_tokens).toBe(1000)
        expect(entryA.completion_tokens).toBe(500)
        expect(entryA.total_cost_usd).toBeCloseTo(0.0105, 4)

        expect(entryB.prompt_tokens).toBe(800)
        expect(entryB.completion_tokens).toBe(300)
        expect(entryB.total_cost_usd).toBeCloseTo(0.0069, 4)
      })

      it("each entry has correct scope metadata", () => {
        const entries = buildEnsembleLedgerEntries(makeEnsembleResult(), makeContext())
        for (const entry of entries) {
          expect(entry.project_id).toBe("proj-1")
          expect(entry.phase_id).toBe("phase-1")
          expect(entry.sprint_id).toBe("sprint-1")
          expect(entry.agent).toBe("test")
        }
      })

      it("each entry has individual latency_ms", () => {
        const entries = buildEnsembleLedgerEntries(makeEnsembleResult(), makeContext())
        const entryA = entries.find(e => e.provider === "pool-a")!
        const entryB = entries.find(e => e.provider === "pool-b")!

        expect(entryA.latency_ms).toBe(100)
        expect(entryB.latency_ms).toBe(200)
      })
    })
  })
})
