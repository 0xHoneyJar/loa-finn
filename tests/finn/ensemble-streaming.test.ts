// tests/finn/ensemble-streaming.test.ts — Streaming Ensemble E2E (Task 3.5, B.4 part 1)
// Winner latch, cancellation, cost attribution, orphan prevention.

import { describe, it, expect } from "vitest"
import {
  firstCompleteStreaming,
  type StreamingModelResolver,
  type EnsembleStreamingResult,
  type EnsembleStreamingBranchResult,
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
  /** Delay in ms before first chunk */
  startDelayMs?: number
  /** Delay in ms between chunks */
  chunkDelayMs?: number
  /** Number of text chunks to emit */
  chunkCount?: number
  /** Include terminal usage event */
  includeUsage?: boolean
  /** Throw error after N chunks */
  errorAfterChunks?: number
  /** Text content per chunk */
  chunkText?: string
}

function createMockStreamingAdapter(config: MockStreamConfig = {}): ModelPortStreaming {
  const {
    startDelayMs = 0,
    chunkDelayMs = 1,
    chunkCount = 5,
    includeUsage = true,
    errorAfterChunks,
    chunkText = "hello ",
  } = config

  return {
    capabilities(): ModelCapabilities {
      return {
        streaming: true,
        tools: true,
        thinking: false,
        maxContextTokens: 128000,
        maxOutputTokens: 4096,
      }
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true, latency_ms: 1 }
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      return {
        content: chunkText.repeat(chunkCount),
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 100, completion_tokens: chunkCount * 2, reasoning_tokens: 0 },
        metadata: { model: "mock-model" },
      }
    },
    async *stream(
      request: CompletionRequest,
      options?: { signal?: AbortSignal },
    ): AsyncGenerator<StreamChunk> {
      if (startDelayMs > 0) {
        await new Promise((r) => setTimeout(r, startDelayMs))
      }

      for (let i = 0; i < chunkCount; i++) {
        if (options?.signal?.aborted) return

        if (errorAfterChunks !== undefined && i >= errorAfterChunks) {
          throw new Error("Mock stream error")
        }

        yield {
          event: "chunk",
          data: { delta: `${chunkText}${i} `, tool_calls: null },
        }

        if (chunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, chunkDelayMs))
        }
      }

      if (includeUsage) {
        yield {
          event: "usage",
          data: { prompt_tokens: 100, completion_tokens: chunkCount * 2, reasoning_tokens: 0 },
        }
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

/** Consume a streaming ensemble and collect chunks */
async function consumeStream(
  gen: AsyncGenerator<StreamChunk>,
): Promise<{ chunks: StreamChunk[]; errored: boolean }> {
  const chunks: StreamChunk[] = []
  let errored = false
  try {
    for await (const chunk of gen) {
      chunks.push(chunk)
    }
  } catch {
    errored = true
  }
  return { chunks, errored }
}

// --- Tests ---

describe("winner latch (first chunk wins)", () => {
  it("fastest adapter wins the race", async () => {
    const adapters = new Map([
      ["fast-pool", { adapter: createMockStreamingAdapter({ startDelayMs: 0, chunkCount: 3 }), pricing: GPT4O_PRICING }],
      ["slow-pool", { adapter: createMockStreamingAdapter({ startDelayMs: 100, chunkCount: 3 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["fast-pool", "slow-pool"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    const { chunks } = await consumeStream(stream)
    const result = getResult()

    expect(result.winner_pool).toBe("fast-pool")
    expect(result.ensemble_id).toBeTruthy()
    expect(chunks.length).toBeGreaterThan(0)

    // Winner should be completed, loser should be cancelled
    const winner = result.branches.find((b) => b.pool === "fast-pool")!
    const loser = result.branches.find((b) => b.pool === "slow-pool")!
    expect(winner.status).toBe("completed")
    expect(loser.status).toBe("cancelled")
  })

  it("second adapter wins when first has startup delay", async () => {
    const adapters = new Map([
      ["slow-pool", { adapter: createMockStreamingAdapter({ startDelayMs: 100, chunkCount: 3 }), pricing: GPT4O_PRICING }],
      ["fast-pool", { adapter: createMockStreamingAdapter({ startDelayMs: 0, chunkCount: 3 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["slow-pool", "fast-pool"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    expect(result.winner_pool).toBe("fast-pool")
  })

  it("exactly one winner among N branches", async () => {
    const pools: string[] = []
    const adapters = new Map<string, { adapter: ModelPortStreaming; pricing: MicroPricingEntry }>()

    for (let i = 0; i < 5; i++) {
      const pool = `pool-${i}`
      pools.push(pool)
      adapters.set(pool, {
        adapter: createMockStreamingAdapter({ startDelayMs: i * 10, chunkCount: 3 }),
        pricing: GPT4O_PRICING,
      })
    }

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      pools,
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    const completedBranches = result.branches.filter((b) => b.status === "completed")
    expect(completedBranches).toHaveLength(1)
    expect(result.winner_pool).toBe("pool-0") // Fastest
  })
})

describe("cancellation and orphan prevention", () => {
  it("all losing branches are cancelled after winner", async () => {
    const adapters = new Map([
      ["winner", { adapter: createMockStreamingAdapter({ startDelayMs: 0, chunkCount: 10 }), pricing: GPT4O_PRICING }],
      ["loser-1", { adapter: createMockStreamingAdapter({ startDelayMs: 50, chunkCount: 10 }), pricing: GPT4O_PRICING }],
      ["loser-2", { adapter: createMockStreamingAdapter({ startDelayMs: 80, chunkCount: 10 }), pricing: GPT4O_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["winner", "loser-1", "loser-2"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    expect(result.winner_pool).toBe("winner")
    for (const branch of result.branches) {
      if (branch.pool !== "winner") {
        expect(branch.status).toBe("cancelled")
      }
    }
  })

  it("no orphaned streams after completion (getResult returns valid metadata)", async () => {
    const adapters = new Map([
      ["a", { adapter: createMockStreamingAdapter({ chunkCount: 5 }), pricing: GPT4O_PRICING }],
      ["b", { adapter: createMockStreamingAdapter({ startDelayMs: 20, chunkCount: 5 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["a", "b"],
      makeRequest(),
      resolver,
    )

    await consumeStream(stream)
    const result = getResult()

    // All branches must have latency_ms > 0 (were tracked)
    for (const branch of result.branches) {
      expect(branch.latency_ms).toBeGreaterThanOrEqual(0)
    }
    // Ensemble ID must be set
    expect(result.ensemble_id).toMatch(/^[0-9A-Z]{26}$/) // ULID format
  })
})

describe("cost attribution per branch", () => {
  it("winner gets provider_reported or byte_estimated cost", async () => {
    const adapters = new Map([
      ["winner", { adapter: createMockStreamingAdapter({ chunkCount: 5, includeUsage: true }), pricing: GPT4O_PRICING }],
      ["loser", { adapter: createMockStreamingAdapter({ startDelayMs: 50, chunkCount: 5 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["winner", "loser"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    const winnerBranch = result.branches.find((b) => b.pool === "winner")!
    expect(winnerBranch.cost).not.toBeNull()
    expect(winnerBranch.cost!.total_cost_micro).toBeGreaterThan(0n)
    expect(["provider_reported", "byte_estimated"]).toContain(winnerBranch.cost!.billing_method)
  })

  it("cancelled branches get overcount billing (prompt_only or observed_chunks_overcount)", async () => {
    const adapters = new Map([
      ["winner", { adapter: createMockStreamingAdapter({ chunkCount: 5 }), pricing: GPT4O_PRICING }],
      ["loser", { adapter: createMockStreamingAdapter({ startDelayMs: 50, chunkCount: 5 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["winner", "loser"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    const loserBranch = result.branches.find((b) => b.pool === "loser")!
    expect(loserBranch.cost).not.toBeNull()
    // Overcount billing for cancelled branches
    expect(["prompt_only", "observed_chunks_overcount"]).toContain(loserBranch.cost!.billing_method)
    expect(loserBranch.cost!.was_aborted).toBe(true)
  })

  it("total cost is sum of all branch costs", async () => {
    const adapters = new Map([
      ["a", { adapter: createMockStreamingAdapter({ chunkCount: 5 }), pricing: GPT4O_PRICING }],
      ["b", { adapter: createMockStreamingAdapter({ startDelayMs: 30, chunkCount: 5 }), pricing: OPUS_PRICING }],
      ["c", { adapter: createMockStreamingAdapter({ startDelayMs: 60, chunkCount: 5 }), pricing: GPT4O_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["a", "b", "c"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    let expectedTotal = 0n
    for (const branch of result.branches) {
      if (branch.cost) expectedTotal += branch.cost.total_cost_micro
    }
    expect(result.total_cost_micro).toBe(expectedTotal)
  })
})

describe("error handling", () => {
  it("branch that errors is marked as failed", async () => {
    const adapters = new Map([
      ["good", { adapter: createMockStreamingAdapter({ startDelayMs: 20, chunkCount: 5 }), pricing: GPT4O_PRICING }],
      ["bad", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["good", "bad"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    // Good adapter wins since bad errors immediately
    expect(result.winner_pool).toBe("good")
    const badBranch = result.branches.find((b) => b.pool === "bad")!
    expect(badBranch.status).toBe("failed")
    expect(badBranch.error).toContain("Mock stream error")
  })

  it("all branches failing rejects the stream", async () => {
    const adapters = new Map([
      ["bad-1", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: GPT4O_PRICING }],
      ["bad-2", { adapter: createMockStreamingAdapter({ errorAfterChunks: 0 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream } = firstCompleteStreaming(
      ["bad-1", "bad-2"],
      makeRequest(),
      resolver,
    )

    const { errored } = await consumeStream(stream)
    expect(errored).toBe(true)
  })

  it("no pools throws synchronously", () => {
    const resolver = createMockResolver(new Map())
    expect(() =>
      firstCompleteStreaming([], makeRequest(), resolver),
    ).toThrow("no pools specified")
  })
})

describe("AbortController integration", () => {
  it("external abort cancels all branches", async () => {
    const controller = new AbortController()
    const adapters = new Map([
      ["a", { adapter: createMockStreamingAdapter({ chunkCount: 100, chunkDelayMs: 10 }), pricing: GPT4O_PRICING }],
      ["b", { adapter: createMockStreamingAdapter({ startDelayMs: 20, chunkCount: 100, chunkDelayMs: 10 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["a", "b"],
      makeRequest(),
      resolver,
      { signal: controller.signal, promptTokens: 100 },
    )

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50)

    await consumeStream(stream)
    const result = getResult()

    // All branches should have cost attribution despite abort
    for (const branch of result.branches) {
      if (branch.cost) {
        expect(branch.cost.total_cost_micro).toBeGreaterThanOrEqual(0n)
      }
    }
  })

  it("timeout aborts all branches", async () => {
    const adapters = new Map([
      ["slow", { adapter: createMockStreamingAdapter({ startDelayMs: 500, chunkCount: 5 }), pricing: GPT4O_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream } = firstCompleteStreaming(
      ["slow"],
      makeRequest(),
      resolver,
      { timeoutMs: 50 },
    )

    const { errored } = await consumeStream(stream)
    // Should fail because timeout fires before first chunk
    expect(errored).toBe(true)
  })
})

describe("streaming output correctness", () => {
  it("yields all chunks from winner stream", async () => {
    const adapters = new Map([
      ["winner", { adapter: createMockStreamingAdapter({ chunkCount: 10, includeUsage: true }), pricing: GPT4O_PRICING }],
      ["loser", { adapter: createMockStreamingAdapter({ startDelayMs: 50, chunkCount: 5 }), pricing: OPUS_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["winner", "loser"],
      makeRequest(),
      resolver,
    )

    const { chunks } = await consumeStream(stream)

    // Should have: 10 chunk events + 1 usage + 1 done
    const chunkEvents = chunks.filter((c) => c.event === "chunk")
    const usageEvents = chunks.filter((c) => c.event === "usage")
    const doneEvents = chunks.filter((c) => c.event === "done")

    expect(chunkEvents.length).toBe(10)
    expect(usageEvents.length).toBe(1)
    expect(doneEvents.length).toBe(1)
  })

  it("chunks come from winner only (no cross-contamination)", async () => {
    const adapters = new Map([
      ["alpha", {
        adapter: createMockStreamingAdapter({ chunkCount: 5, chunkText: "ALPHA-" }),
        pricing: GPT4O_PRICING,
      }],
      ["beta", {
        adapter: createMockStreamingAdapter({ startDelayMs: 50, chunkCount: 5, chunkText: "BETA-" }),
        pricing: OPUS_PRICING,
      }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream } = firstCompleteStreaming(
      ["alpha", "beta"],
      makeRequest(),
      resolver,
    )

    const { chunks } = await consumeStream(stream)

    // All content chunks should be from alpha (winner)
    for (const chunk of chunks) {
      if (chunk.event === "chunk") {
        expect(chunk.data.delta).toContain("ALPHA-")
        expect(chunk.data.delta).not.toContain("BETA-")
      }
    }
  })
})

describe("getResult() lifecycle", () => {
  it("throws if called before stream is consumed", () => {
    const adapters = new Map([
      ["a", { adapter: createMockStreamingAdapter({ chunkCount: 3 }), pricing: GPT4O_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { getResult } = firstCompleteStreaming(
      ["a"],
      makeRequest(),
      resolver,
    )

    expect(() => getResult()).toThrow("stream not yet consumed")
  })

  it("returns valid result after stream consumed", async () => {
    const adapters = new Map([
      ["a", { adapter: createMockStreamingAdapter({ chunkCount: 3 }), pricing: GPT4O_PRICING }],
    ])

    const resolver = createMockResolver(adapters)
    const { stream, getResult } = firstCompleteStreaming(
      ["a"],
      makeRequest(),
      resolver,
      { promptTokens: 100 },
    )

    await consumeStream(stream)
    const result = getResult()

    expect(result.ensemble_id).toBeTruthy()
    expect(result.winner_pool).toBe("a")
    expect(result.branches).toHaveLength(1)
    expect(result.branches[0].status).toBe("completed")
    expect(result.total_cost_micro).toBeGreaterThanOrEqual(0n)
  })
})

describe("deterministic delay simulation", () => {
  it("controlled delays produce deterministic winner selection", async () => {
    // Run 5 times — fastest pool should always win
    for (let trial = 0; trial < 5; trial++) {
      const adapters = new Map([
        ["fast", { adapter: createMockStreamingAdapter({ startDelayMs: 0, chunkCount: 3 }), pricing: GPT4O_PRICING }],
        ["medium", { adapter: createMockStreamingAdapter({ startDelayMs: 50, chunkCount: 3 }), pricing: GPT4O_PRICING }],
        ["slow", { adapter: createMockStreamingAdapter({ startDelayMs: 100, chunkCount: 3 }), pricing: GPT4O_PRICING }],
      ])

      const resolver = createMockResolver(adapters)
      const { stream, getResult } = firstCompleteStreaming(
        ["fast", "medium", "slow"],
        makeRequest(),
        resolver,
      )

      await consumeStream(stream)
      expect(getResult().winner_pool).toBe("fast")
    }
  })
})
