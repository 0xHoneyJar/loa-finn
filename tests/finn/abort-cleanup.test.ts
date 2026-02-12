// tests/finn/abort-cleanup.test.ts — Abort Cleanup E2E (Task 2.10, A.8)
// 100 disconnects → 0 orphans. Validates StreamCostTracker abort handling,
// billing method selection, and cost attribution after stream termination.

import { describe, it, expect } from "vitest"
import {
  StreamCostTracker,
  streamWithCostTracking,
  type StreamCostOptions,
  type StreamCostResult,
  type BillingMethod,
} from "../../src/hounfour/stream-cost.js"
import { findPricing } from "../../src/hounfour/pricing.js"
import type { StreamChunk } from "../../src/hounfour/types.js"

// --- Helpers ---

const GPT4O_PRICING = findPricing("openai", "gpt-4o")!
const OPUS_PRICING = findPricing("anthropic", "claude-opus-4-6")!

function makeOptions(overrides: Partial<StreamCostOptions> = {}): StreamCostOptions {
  return {
    pricing: GPT4O_PRICING,
    promptTokens: 1000,
    ...overrides,
  }
}

/** Create a stream that yields N text chunks then a usage event, then done. */
async function* normalStream(
  chunkCount: number,
  usage?: { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number },
): AsyncGenerator<StreamChunk> {
  for (let i = 0; i < chunkCount; i++) {
    yield {
      event: "chunk",
      data: { delta: `chunk-${i} hello world `, tool_calls: null },
    }
  }

  if (usage) {
    yield { event: "usage", data: usage }
  }

  yield {
    event: "done",
    data: { finish_reason: "stop" },
  }
}

/** Create a stream that yields chunks and then aborts when signal fires. */
async function* abortableStream(
  chunkCount: number,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  for (let i = 0; i < chunkCount; i++) {
    if (signal.aborted) {
      return
    }
    yield {
      event: "chunk",
      data: { delta: `chunk-${i} data data `, tool_calls: null },
    }
    // Small delay to allow abort to fire between chunks
    await new Promise((r) => setTimeout(r, 1))
  }

  yield { event: "done", data: { finish_reason: "stop" } }
}

/** Create a stream that throws after N chunks (simulating network error). */
async function* errorStream(
  chunkCount: number,
): AsyncGenerator<StreamChunk> {
  for (let i = 0; i < chunkCount; i++) {
    yield {
      event: "chunk",
      data: { delta: `chunk-${i} `, tool_calls: null },
    }
  }
  throw new Error("Connection reset by peer")
}

/** Create a stream that yields nothing (empty response). */
async function* emptyStream(): AsyncGenerator<StreamChunk> {
  yield { event: "done", data: { finish_reason: "stop" } }
}

/** Consume a tracked stream completely, ignoring errors. */
async function consumeStream(
  gen: AsyncGenerator<StreamChunk>,
): Promise<{ chunks: number; errored: boolean }> {
  let chunks = 0
  let errored = false
  try {
    for await (const chunk of gen) {
      if (chunk.event === "chunk") chunks++
    }
  } catch {
    errored = true
  }
  return { chunks, errored }
}

// --- Tests ---

describe("normal stream completion", () => {
  it("provider_reported billing when usage event present", async () => {
    const tracker = new StreamCostTracker(makeOptions())
    const stream = normalStream(10, {
      prompt_tokens: 1000,
      completion_tokens: 500,
      reasoning_tokens: 0,
    })

    await consumeStream(tracker.track(stream))
    const result = tracker.getResult()

    expect(result.billing_method).toBe("provider_reported")
    expect(result.prompt_tokens).toBe(1000)
    expect(result.completion_tokens).toBe(500)
    expect(result.was_aborted).toBe(false)
    expect(result.total_cost_micro).toBeGreaterThan(0n)
  })

  it("byte_estimated billing when no usage event", async () => {
    const tracker = new StreamCostTracker(makeOptions())
    const stream = normalStream(10) // no usage event

    await consumeStream(tracker.track(stream))
    const result = tracker.getResult()

    expect(result.billing_method).toBe("byte_estimated")
    expect(result.prompt_tokens).toBe(1000) // from options
    expect(result.completion_tokens).toBeGreaterThan(0)
    expect(result.observed_bytes).toBeGreaterThan(0)
    expect(result.was_aborted).toBe(false)
  })

  it("prompt_only billing when no output", async () => {
    const tracker = new StreamCostTracker(makeOptions())
    const stream = emptyStream()

    await consumeStream(tracker.track(stream))
    const result = tracker.getResult()

    expect(result.billing_method).toBe("prompt_only")
    expect(result.completion_tokens).toBe(0)
    expect(result.observed_bytes).toBe(0)
    expect(result.was_aborted).toBe(false)
    expect(result.total_cost_micro).toBeGreaterThanOrEqual(0n)
  })
})

describe("abort via AbortSignal", () => {
  it("detects abort and marks was_aborted=true", async () => {
    const controller = new AbortController()
    const tracker = new StreamCostTracker(makeOptions())

    // Abort after 3 chunks
    setTimeout(() => controller.abort(), 5)
    const stream = abortableStream(100, controller.signal)

    await consumeStream(tracker.track(stream, controller.signal))
    const result = tracker.getResult()

    expect(result.was_aborted).toBe(true)
    // Should still have cost attribution (byte_estimated or prompt_only)
    expect(result.total_cost_micro).toBeGreaterThanOrEqual(0n)
  })

  it("immediate abort yields prompt_only billing", async () => {
    const controller = new AbortController()
    controller.abort() // Abort immediately

    const tracker = new StreamCostTracker(makeOptions())
    const stream = abortableStream(100, controller.signal)

    await consumeStream(tracker.track(stream, controller.signal))
    const result = tracker.getResult()

    expect(result.was_aborted).toBe(true)
    expect(result.billing_method).toBe("prompt_only")
    expect(result.completion_tokens).toBe(0)
  })
})

describe("error during stream (connection reset)", () => {
  it("marks was_aborted=true on stream error", async () => {
    const tracker = new StreamCostTracker(makeOptions())
    const stream = errorStream(5)

    const { errored } = await consumeStream(tracker.track(stream))
    expect(errored).toBe(true)

    const result = tracker.getResult()
    expect(result.was_aborted).toBe(true)
    expect(result.observed_bytes).toBeGreaterThan(0)
    // Cost should still be attributed for observed work
    expect(result.total_cost_micro).toBeGreaterThan(0n)
  })
})

describe("100 disconnects → 0 orphans", () => {
  it("every aborted stream produces a valid cost result", async () => {
    const results: StreamCostResult[] = []
    const N = 100

    for (let i = 0; i < N; i++) {
      const controller = new AbortController()
      const tracker = new StreamCostTracker(makeOptions({
        pricing: i % 2 === 0 ? GPT4O_PRICING : OPUS_PRICING,
        promptTokens: 500 + i,
      }))

      // Abort at varying points
      const abortAfterMs = i % 10 // 0-9ms
      setTimeout(() => controller.abort(), abortAfterMs)

      const stream = abortableStream(50, controller.signal)
      await consumeStream(tracker.track(stream, controller.signal))

      results.push(tracker.getResult())
    }

    // Verify: every result is valid (no orphans)
    expect(results).toHaveLength(N)

    let abortedCount = 0
    for (const result of results) {
      // Every result must have a valid billing method
      expect(["provider_reported", "byte_estimated", "prompt_only"]).toContain(
        result.billing_method,
      )

      // Cost must be non-negative
      expect(result.total_cost_micro).toBeGreaterThanOrEqual(0n)

      // Token counts must be non-negative
      expect(result.prompt_tokens).toBeGreaterThanOrEqual(0)
      expect(result.completion_tokens).toBeGreaterThanOrEqual(0)
      expect(result.reasoning_tokens).toBeGreaterThanOrEqual(0)

      if (result.was_aborted) abortedCount++
    }

    // At least some should have been aborted (timing may vary)
    expect(abortedCount).toBeGreaterThan(0)

    // Zero orphans: all 100 produced valid results
    // (if any threw without a result, we wouldn't reach this point)
  })

  it("every errored stream produces a valid cost result", async () => {
    const results: StreamCostResult[] = []
    const N = 100

    for (let i = 0; i < N; i++) {
      const tracker = new StreamCostTracker(makeOptions({
        pricing: GPT4O_PRICING,
        promptTokens: 100 + i,
      }))

      // Error at varying points (1-10 chunks)
      const stream = errorStream(1 + (i % 10))
      await consumeStream(tracker.track(stream))

      results.push(tracker.getResult())
    }

    expect(results).toHaveLength(N)

    for (const result of results) {
      expect(result.was_aborted).toBe(true)
      expect(result.total_cost_micro).toBeGreaterThanOrEqual(0n)
      expect(["byte_estimated", "prompt_only"]).toContain(result.billing_method)
    }
  })
})

describe("ensemble loser overcount billing", () => {
  it("overcount adds 10% margin to byte-estimated tokens", async () => {
    const tracker = new StreamCostTracker(makeOptions({ usageOnAbort: false }))
    const stream = normalStream(20) // 20 chunks, no usage event

    await consumeStream(tracker.track(stream))

    const normalResult = tracker.getResult()
    const overcountResult = tracker.getOvercountResult()

    expect(overcountResult.billing_method).toBe("observed_chunks_overcount")
    expect(overcountResult.was_aborted).toBe(true) // overcount implies cancellation
    expect(overcountResult.completion_tokens).toBeGreaterThan(
      normalResult.completion_tokens,
    )

    // Overcount should be ~10% more
    const ratio =
      Number(overcountResult.completion_tokens) /
      Number(normalResult.completion_tokens)
    expect(ratio).toBeGreaterThanOrEqual(1.09)
    expect(ratio).toBeLessThanOrEqual(1.15) // ceil may add slightly more
  })

  it("overcount uses exact values when adapter reports usage on abort", async () => {
    const tracker = new StreamCostTracker(
      makeOptions({ usageOnAbort: true }),
    )
    const stream = normalStream(10, {
      prompt_tokens: 800,
      completion_tokens: 400,
      reasoning_tokens: 0,
    })

    await consumeStream(tracker.track(stream))

    const overcountResult = tracker.getOvercountResult()
    // When usageOnAbort=true and usage exists, use exact (no overcount)
    expect(overcountResult.billing_method).toBe("provider_reported")
    expect(overcountResult.completion_tokens).toBe(400)
  })

  it("overcount returns prompt_only when no chunks observed", async () => {
    const tracker = new StreamCostTracker(makeOptions({ usageOnAbort: false }))
    const stream = emptyStream()

    await consumeStream(tracker.track(stream))

    const overcountResult = tracker.getOvercountResult()
    expect(overcountResult.billing_method).toBe("prompt_only")
    expect(overcountResult.was_aborted).toBe(true)
    expect(overcountResult.completion_tokens).toBe(0)
  })
})

describe("cost attribution accuracy after abort", () => {
  it("partial stream cost is proportional to observed output", async () => {
    // Full stream: 100 chunks
    const fullTracker = new StreamCostTracker(makeOptions())
    const fullStream = normalStream(100)
    await consumeStream(fullTracker.track(fullStream))
    const fullResult = fullTracker.getResult()

    // Half stream: ~50 chunks via abort
    const controller = new AbortController()
    const halfTracker = new StreamCostTracker(makeOptions())
    let chunksSeen = 0
    const halfStream = (async function* () {
      for await (const chunk of normalStream(100)) {
        if (chunksSeen >= 50) {
          controller.abort()
          return
        }
        if (chunk.event === "chunk") chunksSeen++
        yield chunk
      }
    })()

    await consumeStream(halfTracker.track(halfStream, controller.signal))
    const halfResult = halfTracker.getResult()

    // Both should be byte_estimated (no usage event in partial)
    expect(halfResult.billing_method).toBe("byte_estimated")
    expect(halfResult.observed_bytes).toBeGreaterThan(0)
    expect(halfResult.observed_bytes).toBeLessThan(fullResult.observed_bytes)

    // Cost should be roughly proportional (within 2x)
    if (fullResult.total_cost_micro > 0n) {
      const ratio =
        Number(halfResult.total_cost_micro) / Number(fullResult.total_cost_micro)
      expect(ratio).toBeGreaterThan(0.2)
      expect(ratio).toBeLessThan(0.8)
    }
  })
})

describe("streamWithCostTracking convenience function", () => {
  it("returns tracked generator and getResult accessor", async () => {
    const stream = normalStream(5, {
      prompt_tokens: 200,
      completion_tokens: 100,
      reasoning_tokens: 0,
    })

    const { tracked, getResult } = streamWithCostTracking(stream, makeOptions())

    await consumeStream(tracked)
    const result = getResult()

    expect(result.billing_method).toBe("provider_reported")
    expect(result.prompt_tokens).toBe(200)
    expect(result.completion_tokens).toBe(100)
    expect(result.total_cost_micro).toBeGreaterThan(0n)
  })

  it("works with abort signal", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)

    const stream = abortableStream(100, controller.signal)
    const { tracked, getResult } = streamWithCostTracking(
      stream,
      makeOptions(),
      controller.signal,
    )

    await consumeStream(tracked)
    const result = getResult()

    expect(result.was_aborted).toBe(true)
    expect(result.total_cost_micro).toBeGreaterThanOrEqual(0n)
  })
})

describe("multi-model abort cleanup", () => {
  it("abort cleanup works across all default pricing models", async () => {
    for (const pricing of [GPT4O_PRICING, OPUS_PRICING]) {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 3)

      const tracker = new StreamCostTracker(
        makeOptions({ pricing, promptTokens: 500 }),
      )
      const stream = abortableStream(50, controller.signal)

      await consumeStream(tracker.track(stream, controller.signal))
      const result = tracker.getResult()

      expect(result.total_cost_micro).toBeGreaterThanOrEqual(0n)
      expect(["byte_estimated", "prompt_only"]).toContain(result.billing_method)
    }
  })
})
