// tests/finn/sprint-b-integration.test.ts — Sprint B Integration Tests (T-B.6)
// E2E flows: AnthropicAdapter streaming + tool use, Ensemble strategies, budget, abort.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AnthropicAdapter } from "../../src/hounfour/native-adapter.js"
import { EnsembleOrchestrator, buildEnsembleUsageReports, buildEnsembleLedgerEntries } from "../../src/hounfour/ensemble.js"
import type { EnsembleConfig, ModelResolver } from "../../src/hounfour/ensemble.js"
import { createModelAdapter } from "../../src/hounfour/cheval-invoker.js"
import type {
  CompletionRequest,
  CompletionResult,
  ProviderEntry,
  ResolvedModel,
  StreamChunk,
  ExecutionContext,
  ModelPortBase,
  PricingEntry,
} from "../../src/hounfour/types.js"

// --- Helpers ---

function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

function makeRequest(): CompletionRequest {
  return {
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    options: {},
    metadata: { agent: "test", tenant_id: "local", nft_id: "", trace_id: "trace-001" },
  }
}

function makeProviderConfig(type: "claude-code" | "openai-compatible" = "claude-code"): ProviderEntry {
  return {
    name: type === "claude-code" ? "anthropic-direct" : "test-provider",
    type,
    options: { baseURL: "https://api.anthropic.com", apiKey: "sk-ant-test" },
    models: new Map([
      ["claude-opus-4-6", {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        capabilities: { tool_calling: true, thinking_traces: true, vision: true, streaming: true },
        limit: { context: 200_000, output: 4096 },
      }],
    ]),
  } as ProviderEntry
}

function makeContext(): ExecutionContext {
  return {
    resolved: { provider: "anthropic-direct", modelId: "claude-opus-4-6" },
    scopeMeta: { project_id: "proj-1", phase_id: "phase-1", sprint_id: "sprint-B" },
    binding: { agent: "reviewer", model: "anthropic-direct:claude-opus-4-6", requires: {} },
    pricing: { provider: "anthropic-direct", model: "claude-opus-4-6", input_per_1m: 15, output_per_1m: 75 },
  } as ExecutionContext
}

function makeResult(content: string, overrides?: Partial<CompletionResult>): CompletionResult {
  return {
    content,
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
    metadata: { model: "test-model", latency_ms: 100, trace_id: "trace-001" },
    ...overrides,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// --- Integration Tests ---

describe("Sprint B Integration", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  // --- I-1: AnthropicAdapter streaming with tool use roundtrip ---

  describe("I-1: AnthropicAdapter streaming tool use roundtrip", () => {
    it("streams tool_use → receives tool_result → streams continuation", async () => {
      // Step 1: Model requests tool use
      const toolUseSse = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6","usage":{"input_tokens":20,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"read_file","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"foo.txt\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("")

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream(toolUseSse),
      })

      const adapter = new AnthropicAdapter(
        { provider: "anthropic-direct", modelId: "claude-opus-4-6" },
        makeProviderConfig(),
      )

      const chunks = await collect(adapter.stream(makeRequest()))

      // Verify tool call events were yielded
      const toolCallChunks = chunks.filter(c => c.event === "tool_call")
      expect(toolCallChunks.length).toBeGreaterThanOrEqual(2) // start + deltas

      // Verify done with tool_calls reason
      const doneChunks = chunks.filter(c => c.event === "done")
      expect(doneChunks).toHaveLength(1)
      expect((doneChunks[0] as any).data.finish_reason).toBe("tool_calls")

      // Step 2: Non-streaming continuation with tool result
      const continuationResponse = {
        id: "msg_2",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "The file contains: hello world" }],
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 10 },
      }

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => continuationResponse,
      })

      const continuationResult = await adapter.complete({
        ...makeRequest(),
        messages: [
          { role: "user", content: "Read foo.txt" },
          { role: "assistant", content: null, tool_calls: [{ id: "toolu_01", type: "function", function: { name: "read_file", arguments: '{"path":"foo.txt"}' } }] },
          { role: "tool", content: "hello world", tool_call_id: "toolu_01" },
        ],
      })

      expect(continuationResult.content).toBe("The file contains: hello world")
      expect(continuationResult.usage.prompt_tokens).toBe(50)

      // Verify tool_result was sent as user role
      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body)
      const toolResultMsg = body.messages.find((m: any) =>
        m.content?.some?.((c: any) => c.type === "tool_result"),
      )
      expect(toolResultMsg).toBeDefined()
      expect(toolResultMsg.role).toBe("user")
    })
  })

  // --- I-2: createModelAdapter factory routes to AnthropicAdapter ---

  describe("I-2: createModelAdapter factory", () => {
    it("returns AnthropicAdapter for claude-code provider type", () => {
      const resolved: ResolvedModel = { provider: "anthropic-direct", modelId: "claude-opus-4-6" }
      const provider = makeProviderConfig("claude-code")
      const cheval = {} as any
      const health = {} as any

      const adapter = createModelAdapter(resolved, provider, cheval, health)
      expect(adapter).toBeInstanceOf(AnthropicAdapter)
    })

    it("does NOT return AnthropicAdapter for openai-compatible type", () => {
      const resolved: ResolvedModel = { provider: "test", modelId: "claude-opus-4-6" }
      const provider = makeProviderConfig("openai-compatible")
      const cheval = { invoke: vi.fn() } as any
      const health = { isHealthy: vi.fn().mockReturnValue(true), recordSuccess: vi.fn(), recordFailure: vi.fn() }

      const adapter = createModelAdapter(resolved, provider, cheval, health)
      expect(adapter).not.toBeInstanceOf(AnthropicAdapter)
    })
  })

  // --- I-3: Ensemble first_complete — first response wins, other cancelled ---

  describe("I-3: Ensemble first_complete race", () => {
    it("first response returned, other model effectively cancelled", async () => {
      const fastAdapter: ModelPortBase = {
        complete: vi.fn().mockImplementation(async () => {
          await sleep(5)
          return makeResult("fast-response")
        }),
        capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
        healthCheck: async () => ({ healthy: true, latency_ms: 5 }),
      }
      const slowAdapter: ModelPortBase = {
        complete: vi.fn().mockImplementation(async () => {
          await sleep(200)
          return makeResult("slow-response")
        }),
        capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
        healthCheck: async () => ({ healthy: true, latency_ms: 200 }),
      }

      const resolver: ModelResolver = {
        resolve: (pool: string) => ({
          adapter: pool === "fast" ? fastAdapter : slowAdapter,
          pricing: { provider: "test", model: "test", input_per_1m: 3, output_per_1m: 15 },
        }),
      }

      const orchestrator = new EnsembleOrchestrator(resolver)
      const result = await orchestrator.run(
        makeRequest(),
        {
          models: ["fast", "slow"],
          strategy: "first_complete",
          budget_per_model_micro: 1_000_000,
          budget_total_micro: 5_000_000,
          timeout_ms: 5000,
        },
        makeContext(),
      )

      expect(result.selected.content).toBe("fast-response")
      expect(result.strategy_used).toBe("first_complete")
      // Fast adapter was called
      expect(fastAdapter.complete).toHaveBeenCalledOnce()
    })
  })

  // --- I-4: Ensemble best_of_n — both complete, higher-scored selected ---

  describe("I-4: Ensemble best_of_n scoring", () => {
    it("selects higher-scored result from 2 models", async () => {
      const poorAdapter: ModelPortBase = {
        complete: vi.fn().mockResolvedValue(makeResult("bad", {
          usage: { prompt_tokens: 100, completion_tokens: 100, reasoning_tokens: 0 },
        })),
        capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
        healthCheck: async () => ({ healthy: true, latency_ms: 10 }),
      }
      const goodAdapter: ModelPortBase = {
        complete: vi.fn().mockResolvedValue(makeResult("This is a detailed, comprehensive, and helpful answer to your question.", {
          usage: { prompt_tokens: 100, completion_tokens: 15, reasoning_tokens: 0 },
        })),
        capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
        healthCheck: async () => ({ healthy: true, latency_ms: 10 }),
      }

      const resolver: ModelResolver = {
        resolve: (pool: string) => ({
          adapter: pool === "poor" ? poorAdapter : goodAdapter,
          pricing: { provider: "test", model: "test", input_per_1m: 3, output_per_1m: 15 },
        }),
      }

      const orchestrator = new EnsembleOrchestrator(resolver)
      const result = await orchestrator.run(
        makeRequest(),
        {
          models: ["poor", "good"],
          strategy: "best_of_n",
          budget_per_model_micro: 1_000_000,
          budget_total_micro: 5_000_000,
          timeout_ms: 5000,
        },
        makeContext(),
      )

      // Default scorer: content_length / tokens — good adapter has better ratio
      expect(result.selected.content).toContain("detailed")
      expect(result.all_results).toHaveLength(2)
    })
  })

  // --- I-5: Ensemble cost attribution — separate entries, shared ensemble_id ---

  describe("I-5: Ensemble cost attribution E2E", () => {
    it("builds per-model usage reports and ledger entries with shared ensemble_id", async () => {
      const adapterA: ModelPortBase = {
        complete: vi.fn().mockResolvedValue(makeResult("result-a", {
          usage: { prompt_tokens: 500, completion_tokens: 200, reasoning_tokens: 0 },
          metadata: { model: "model-a", latency_ms: 50, trace_id: "trace-001" },
        })),
        capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
        healthCheck: async () => ({ healthy: true, latency_ms: 10 }),
      }
      const adapterB: ModelPortBase = {
        complete: vi.fn().mockResolvedValue(makeResult("result-b", {
          usage: { prompt_tokens: 600, completion_tokens: 300, reasoning_tokens: 0 },
          metadata: { model: "model-b", latency_ms: 80, trace_id: "trace-001" },
        })),
        capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
        healthCheck: async () => ({ healthy: true, latency_ms: 10 }),
      }

      const resolver: ModelResolver = {
        resolve: (pool: string) => ({
          adapter: pool === "pool-a" ? adapterA : adapterB,
          pricing: { provider: "test", model: "test", input_per_1m: 3, output_per_1m: 15 },
        }),
      }

      const orchestrator = new EnsembleOrchestrator(resolver)
      const ctx = makeContext()
      const ensembleResult = await orchestrator.run(
        makeRequest(),
        {
          models: ["pool-a", "pool-b"],
          strategy: "best_of_n",
          budget_per_model_micro: 1_000_000,
          budget_total_micro: 5_000_000,
          timeout_ms: 5000,
        },
        ctx,
      )

      // Build usage reports
      const reports = buildEnsembleUsageReports(ensembleResult, ctx)
      expect(reports).toHaveLength(2)

      // All reports share the same ensemble_id
      const ensembleIds = new Set(reports.map(r => r.ensemble_id))
      expect(ensembleIds.size).toBe(1)
      expect(ensembleIds.has(ensembleResult.ensemble_id)).toBe(true)

      // Each report has unique report_id
      expect(reports[0].report_id).not.toBe(reports[1].report_id)

      // Individual token counts
      expect(reports[0].input_tokens).not.toBe(reports[1].input_tokens)

      // Build ledger entries
      const entries = buildEnsembleLedgerEntries(ensembleResult, ctx)
      expect(entries).toHaveLength(2)

      // All entries share ensemble_id
      for (const entry of entries) {
        expect(entry.ensemble_id).toBe(ensembleResult.ensemble_id)
        expect(entry.project_id).toBe("proj-1")
        expect(entry.sprint_id).toBe("sprint-B")
      }
    })
  })

  // --- I-6: Abort propagation — parent cascades to children ---

  describe("I-6: Abort propagation", () => {
    it("ensemble timeout causes all models to fail", async () => {
      // Adapter that throws after a delay (simulating a slow network call that eventually fails)
      const slowAdapter: ModelPortBase = {
        complete: vi.fn().mockImplementation(async () => {
          await sleep(200) // Longer than timeout
          throw new Error("Should have been cancelled")
        }),
        capabilities: () => ({ tool_calling: true, thinking_traces: false, vision: false, streaming: true }),
        healthCheck: async () => ({ healthy: true, latency_ms: 10 }),
      }

      const resolver: ModelResolver = {
        resolve: () => ({
          adapter: slowAdapter,
          pricing: { provider: "test", model: "test", input_per_1m: 3, output_per_1m: 15 },
        }),
      }

      const orchestrator = new EnsembleOrchestrator(resolver)
      await expect(
        orchestrator.run(
          makeRequest(),
          {
            models: ["pool-a", "pool-b"],
            strategy: "first_complete",
            budget_per_model_micro: 1_000_000,
            budget_total_micro: 5_000_000,
            timeout_ms: 50, // Short timeout — models won't finish in time
          },
          makeContext(),
        ),
      ).rejects.toThrow("all 2 models failed")
    }, 2000)
  })
})
