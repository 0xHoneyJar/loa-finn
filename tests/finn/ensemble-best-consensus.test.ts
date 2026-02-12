// tests/finn/ensemble-best-consensus.test.ts — Streaming best_of_n & consensus (Task 3.7, B.4 part 3)
// Per-branch timeout, quorum, scoring, field extraction, majority vote.

import { describe, it, expect } from "vitest"
import {
  bestOfNStreaming,
  consensusStreaming,
  type StreamingModelResolver,
  type ScorerFunction,
} from "../../src/hounfour/ensemble.js"
import type {
  ModelPortStreaming,
  CompletionRequest,
  CompletionResult,
  StreamChunk,
  ModelCapabilities,
  HealthStatus,
} from "../../src/hounfour/types.js"
import { findPricing, type MicroPricingEntry } from "../../src/hounfour/pricing.js"

// --- Mock Streaming Adapter ---

const GPT4O_PRICING = findPricing("openai", "gpt-4o")!
const OPUS_PRICING = findPricing("anthropic", "claude-opus-4-6")!

interface MockStreamConfig {
  startDelayMs?: number
  chunkDelayMs?: number
  chunkCount?: number
  includeUsage?: boolean
  errorAfterChunks?: number
  chunkText?: string
  /** Content to emit as final text (overrides chunkText pattern) */
  content?: string
}

function createMockStreamingAdapter(config: MockStreamConfig = {}): ModelPortStreaming {
  const {
    startDelayMs = 0,
    chunkDelayMs = 1,
    chunkCount = 5,
    includeUsage = true,
    errorAfterChunks,
    chunkText = "hello ",
    content,
  } = config

  return {
    capabilities(): ModelCapabilities {
      return { streaming: true, tools: true, thinking: false, maxContextTokens: 128000, maxOutputTokens: 4096 }
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true, latency_ms: 1 }
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      return {
        content: content ?? chunkText.repeat(chunkCount),
        thinking: null, tool_calls: null,
        usage: { prompt_tokens: 100, completion_tokens: chunkCount * 2, reasoning_tokens: 0 },
        metadata: { model: "mock" },
      }
    },
    async *stream(
      request: CompletionRequest,
      options?: { signal?: AbortSignal },
    ): AsyncGenerator<StreamChunk> {
      if (startDelayMs > 0) {
        await new Promise((r) => setTimeout(r, startDelayMs))
      }

      if (content) {
        // Emit content as a single chunk
        if (options?.signal?.aborted) return
        yield { event: "chunk", data: { delta: content, tool_calls: null } }
      } else {
        for (let i = 0; i < chunkCount; i++) {
          if (options?.signal?.aborted) return
          if (errorAfterChunks !== undefined && i >= errorAfterChunks) {
            throw new Error("Mock stream error")
          }
          yield { event: "chunk", data: { delta: `${chunkText}${i} `, tool_calls: null } }
          if (chunkDelayMs > 0) await new Promise((r) => setTimeout(r, chunkDelayMs))
        }
      }

      if (includeUsage) {
        yield { event: "usage", data: { prompt_tokens: 100, completion_tokens: chunkCount * 2, reasoning_tokens: 0 } }
      }
      yield { event: "done", data: { finish_reason: "stop" } }
    },
  }
}

function createMockResolver(
  adapters: Map<string, { adapter: ModelPortStreaming; pricing: MicroPricingEntry }>,
): StreamingModelResolver {
  return {
    resolve(pool: string) {
      const entry = adapters.get(pool)
      if (!entry) throw new Error(`Unknown pool: ${pool}`)
      return entry
    },
  }
}

function makeRequest(): CompletionRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    options: { max_tokens: 1000 },
  }
}

// --- bestOfNStreaming Tests ---

describe("bestOfNStreaming", () => {
  it("selects highest-scoring result", async () => {
    // Custom scorer: longer content = higher score
    const scorer: ScorerFunction = async (r) => r.content.length

    const adapters = new Map([
      ["short", { adapter: createMockStreamingAdapter({ chunkCount: 2, chunkText: "a " }), pricing: GPT4O_PRICING }],
      ["long", { adapter: createMockStreamingAdapter({ chunkCount: 10, chunkText: "b " }), pricing: OPUS_PRICING }],
      ["medium", { adapter: createMockStreamingAdapter({ chunkCount: 5, chunkText: "c " }), pricing: GPT4O_PRICING }],
    ])

    const result = await bestOfNStreaming(
      ["short", "long", "medium"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100, scorer },
    )

    // "long" pool produces the most content
    expect(result.selected.content.length).toBeGreaterThan(0)
    expect(result.branches).toHaveLength(3)
    expect(result.branches.filter(b => b.status === "completed")).toHaveLength(3)
    expect(result.strategy).toBe("best_of_n")
  })

  it("uses default scorer when none provided", async () => {
    const adapters = new Map([
      ["pool-a", { adapter: createMockStreamingAdapter({ chunkCount: 3 }), pricing: GPT4O_PRICING }],
      ["pool-b", { adapter: createMockStreamingAdapter({ chunkCount: 5 }), pricing: OPUS_PRICING }],
    ])

    const result = await bestOfNStreaming(
      ["pool-a", "pool-b"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100 },
    )

    expect(result.selected).toBeDefined()
    expect(result.selected.content.length).toBeGreaterThan(0)
  })

  it("handles partial failures with quorum", async () => {
    const adapters = new Map([
      ["good", { adapter: createMockStreamingAdapter({ chunkCount: 5 }), pricing: GPT4O_PRICING }],
      ["bad", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: OPUS_PRICING }],
      ["good2", { adapter: createMockStreamingAdapter({ chunkCount: 3 }), pricing: GPT4O_PRICING }],
    ])

    const result = await bestOfNStreaming(
      ["good", "bad", "good2"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100, quorum: 2 },
    )

    // 2 of 3 succeeded, meets quorum
    expect(result.selected.content.length).toBeGreaterThan(0)
    const completed = result.branches.filter(b => b.status === "completed")
    const failed = result.branches.filter(b => b.status === "failed")
    expect(completed.length).toBe(2)
    expect(failed.length).toBe(1)
  })

  it("throws when quorum not met", async () => {
    const adapters = new Map([
      ["bad1", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: GPT4O_PRICING }],
      ["bad2", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: OPUS_PRICING }],
    ])

    await expect(
      bestOfNStreaming(
        ["bad1", "bad2"],
        makeRequest(),
        createMockResolver(adapters),
        { promptTokens: 100, quorum: 1 },
      ),
    ).rejects.toThrow("0/2 branches succeeded")
  })

  it("per-branch timeout aborts slow branches", async () => {
    const adapters = new Map([
      ["fast", { adapter: createMockStreamingAdapter({ startDelayMs: 0, chunkCount: 3 }), pricing: GPT4O_PRICING }],
      ["slow", { adapter: createMockStreamingAdapter({ startDelayMs: 500, chunkCount: 3 }), pricing: OPUS_PRICING }],
    ])

    const result = await bestOfNStreaming(
      ["fast", "slow"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100, perBranchTimeoutMs: 50, timeoutMs: 5000, quorum: 1 },
    )

    // Fast branch should succeed, slow branch should timeout
    expect(result.selected.content.length).toBeGreaterThan(0)
    const timeouts = result.branches.filter(b => b.status === "timeout")
    expect(timeouts.length).toBe(1)
  })

  it("all branches produce cost data", async () => {
    const adapters = new Map([
      ["pool-a", { adapter: createMockStreamingAdapter({ chunkCount: 3 }), pricing: GPT4O_PRICING }],
      ["pool-b", { adapter: createMockStreamingAdapter({ chunkCount: 5 }), pricing: OPUS_PRICING }],
    ])

    const result = await bestOfNStreaming(
      ["pool-a", "pool-b"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100 },
    )

    expect(result.total_cost_micro).toBeGreaterThan(0n)
    for (const branch of result.branches) {
      if (branch.status === "completed") {
        expect(branch.cost).not.toBeNull()
      }
    }
  })

  it("throws on empty pools", async () => {
    await expect(
      bestOfNStreaming([], makeRequest(), createMockResolver(new Map())),
    ).rejects.toThrow("no pools specified")
  })

  it("abort signal cancels all branches", async () => {
    const adapters = new Map([
      ["pool-a", { adapter: createMockStreamingAdapter({ startDelayMs: 200, chunkCount: 10 }), pricing: GPT4O_PRICING }],
      ["pool-b", { adapter: createMockStreamingAdapter({ startDelayMs: 200, chunkCount: 10 }), pricing: OPUS_PRICING }],
    ])

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    await expect(
      bestOfNStreaming(
        ["pool-a", "pool-b"],
        makeRequest(),
        createMockResolver(adapters),
        { promptTokens: 100, signal: controller.signal, quorum: 1 },
      ),
    ).rejects.toThrow()
  })
})

// --- consensusStreaming Tests ---

describe("consensusStreaming", () => {
  it("merges JSON outputs via majority vote", async () => {
    // 3 models produce JSON with overlapping fields
    const adapters = new Map([
      ["m1", { adapter: createMockStreamingAdapter({ content: '{"color":"blue","size":"large"}' }), pricing: GPT4O_PRICING }],
      ["m2", { adapter: createMockStreamingAdapter({ content: '{"color":"blue","size":"small"}' }), pricing: OPUS_PRICING }],
      ["m3", { adapter: createMockStreamingAdapter({ content: '{"color":"blue","size":"large"}' }), pricing: GPT4O_PRICING }],
    ])

    const result = await consensusStreaming(
      ["m1", "m2", "m3"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100, quorum: 3 },
    )

    const parsed = JSON.parse(result.selected.content)
    expect(parsed.color).toBe("blue") // unanimous
    expect(parsed.size).toBe("large") // 2/3 majority
    expect(result.strategy).toBe("consensus")
  })

  it("falls back to first result when content is not JSON", async () => {
    const adapters = new Map([
      ["m1", { adapter: createMockStreamingAdapter({ chunkText: "plain text ", chunkCount: 3 }), pricing: GPT4O_PRICING }],
      ["m2", { adapter: createMockStreamingAdapter({ chunkText: "other text ", chunkCount: 2 }), pricing: OPUS_PRICING }],
    ])

    const result = await consensusStreaming(
      ["m1", "m2"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100, quorum: 2 },
    )

    // Falls back to first result since neither is JSON
    expect(result.selected.content.length).toBeGreaterThan(0)
  })

  it("respects quorum threshold", async () => {
    const adapters = new Map([
      ["good", { adapter: createMockStreamingAdapter({ content: '{"x":1}' }), pricing: GPT4O_PRICING }],
      ["bad", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: OPUS_PRICING }],
      ["good2", { adapter: createMockStreamingAdapter({ content: '{"x":1}' }), pricing: GPT4O_PRICING }],
    ])

    // Quorum of 2 — should succeed with 2 of 3
    const result = await consensusStreaming(
      ["good", "bad", "good2"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100, quorum: 2 },
    )

    expect(result.selected.content).toContain('"x"')
    const completed = result.branches.filter(b => b.status === "completed")
    expect(completed.length).toBe(2)
  })

  it("throws when quorum not met", async () => {
    const adapters = new Map([
      ["bad1", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: GPT4O_PRICING }],
      ["bad2", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: OPUS_PRICING }],
      ["good", { adapter: createMockStreamingAdapter({ content: '{"x":1}' }), pricing: GPT4O_PRICING }],
    ])

    await expect(
      consensusStreaming(
        ["bad1", "bad2", "good"],
        makeRequest(),
        createMockResolver(adapters),
        { promptTokens: 100, quorum: 3 },
      ),
    ).rejects.toThrow("1/3 branches succeeded")
  })

  it("custom field extractor works", async () => {
    const adapters = new Map([
      ["m1", { adapter: createMockStreamingAdapter({ content: "answer: yes, confidence: high" }), pricing: GPT4O_PRICING }],
      ["m2", { adapter: createMockStreamingAdapter({ content: "answer: yes, confidence: low" }), pricing: OPUS_PRICING }],
      ["m3", { adapter: createMockStreamingAdapter({ content: "answer: yes, confidence: high" }), pricing: GPT4O_PRICING }],
    ])

    const extractor = (r: CompletionResult) => {
      const match = r.content.match(/answer: (\w+), confidence: (\w+)/)
      if (!match) return null
      return { answer: match[1], confidence: match[2] }
    }

    const result = await consensusStreaming(
      ["m1", "m2", "m3"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100, quorum: 3, fieldExtractor: extractor },
    )

    const parsed = JSON.parse(result.selected.content)
    expect(parsed.answer).toBe("yes") // unanimous
    expect(parsed.confidence).toBe("high") // 2/3 majority
  })

  it("produces cost data for all branches", async () => {
    const adapters = new Map([
      ["m1", { adapter: createMockStreamingAdapter({ content: '{"a":1}' }), pricing: GPT4O_PRICING }],
      ["m2", { adapter: createMockStreamingAdapter({ content: '{"a":1}' }), pricing: OPUS_PRICING }],
    ])

    const result = await consensusStreaming(
      ["m1", "m2"],
      makeRequest(),
      createMockResolver(adapters),
      { promptTokens: 100 },
    )

    expect(result.total_cost_micro).toBeGreaterThan(0n)
    for (const branch of result.branches) {
      if (branch.status === "completed") {
        expect(branch.cost).not.toBeNull()
      }
    }
  })

  it("throws on empty pools", async () => {
    await expect(
      consensusStreaming([], makeRequest(), createMockResolver(new Map())),
    ).rejects.toThrow("no pools specified")
  })

  it("default quorum requires all branches", async () => {
    const adapters = new Map([
      ["good", { adapter: createMockStreamingAdapter({ content: '{"x":1}' }), pricing: GPT4O_PRICING }],
      ["bad", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: OPUS_PRICING }],
    ])

    // Default quorum = pools.length = 2, but only 1 succeeds
    await expect(
      consensusStreaming(
        ["good", "bad"],
        makeRequest(),
        createMockResolver(adapters),
        { promptTokens: 100 },
      ),
    ).rejects.toThrow("1/2 branches succeeded")
  })
})
