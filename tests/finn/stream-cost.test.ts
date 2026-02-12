// tests/finn/stream-cost.test.ts — Streaming cost attribution tests (Task 2.4)
import { describe, it, expect } from "vitest"
import {
  StreamCostTracker,
  streamWithCostTracking,
  type StreamCostOptions,
} from "../../src/hounfour/stream-cost.js"
import type { StreamChunk, StreamUsageData } from "../../src/hounfour/types.js"
import type { MicroPricingEntry } from "../../src/hounfour/pricing.js"

// --- Test Helpers ---

const GPT4O_PRICING: MicroPricingEntry = {
  provider: "openai",
  model: "gpt-4o",
  input_micro_per_million: 2_500_000,   // $2.50/1M
  output_micro_per_million: 10_000_000, // $10.00/1M
  bytesPerToken: 4,
}

const O3_PRICING: MicroPricingEntry = {
  provider: "openai",
  model: "o3",
  input_micro_per_million: 10_000_000,  // $10.00/1M
  output_micro_per_million: 40_000_000, // $40.00/1M
  reasoning_micro_per_million: 40_000_000,
  bytesPerToken: 4,
}

function defaultOptions(overrides: Partial<StreamCostOptions> = {}): StreamCostOptions {
  return {
    pricing: GPT4O_PRICING,
    promptTokens: 100,
    ...overrides,
  }
}

/** Create a mock stream from an array of chunks. */
async function* mockStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk
  }
}

/** Create text chunk events. */
function textChunks(texts: string[]): StreamChunk[] {
  return texts.map(t => ({ event: "chunk" as const, data: { delta: t, tool_calls: null } }))
}

/** Create a usage event. */
function usageEvent(prompt: number, completion: number, reasoning = 0): StreamChunk {
  return { event: "usage", data: { prompt_tokens: prompt, completion_tokens: completion, reasoning_tokens: reasoning } }
}

/** Create a done event. */
function doneEvent(): StreamChunk {
  return { event: "done", data: { finish_reason: "stop" } }
}

/** Consume a generator fully, collecting yielded values. */
async function consume(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of gen) {
    result.push(chunk)
  }
  return result
}

// --- StreamCostTracker ---

describe("StreamCostTracker", () => {
  // --- Provider-reported usage ---

  describe("provider_reported billing", () => {
    it("uses terminal usage event for cost calculation", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      const chunks = [
        ...textChunks(["Hello", " world"]),
        usageEvent(100, 50, 0),
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.billing_method).toBe("provider_reported")
      expect(result.prompt_tokens).toBe(100)
      expect(result.completion_tokens).toBe(50)
      expect(result.reasoning_tokens).toBe(0)
      expect(result.was_aborted).toBe(false)
    })

    it("takes the last usage event when multiple are emitted", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      const chunks = [
        ...textChunks(["Hello"]),
        usageEvent(100, 10, 0), // intermediate
        ...textChunks([" world"]),
        usageEvent(100, 50, 0), // terminal
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.billing_method).toBe("provider_reported")
      expect(result.completion_tokens).toBe(50) // last usage event
    })

    it("computes cost correctly with provider-reported usage", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      const chunks = [
        ...textChunks(["test"]),
        usageEvent(1000, 500, 0),
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      // input: 1000 * 2_500_000 / 1_000_000 = 2500
      // output: 500 * 10_000_000 / 1_000_000 = 5000
      // total: 7500 micro-USD
      expect(result.total_cost_micro).toBe(7500n)
    })

    it("includes reasoning tokens in cost for reasoning models", async () => {
      const tracker = new StreamCostTracker(defaultOptions({ pricing: O3_PRICING }))
      const chunks = [
        ...textChunks(["answer"]),
        usageEvent(1000, 500, 2000),
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      // input: 1000 * 10_000_000 / 1_000_000 = 10000
      // output: 500 * 40_000_000 / 1_000_000 = 20000
      // reasoning: 2000 * 40_000_000 / 1_000_000 = 80000
      // total: 110000 micro-USD
      expect(result.total_cost_micro).toBe(110000n)
      expect(result.reasoning_tokens).toBe(2000)
    })
  })

  // --- Byte-estimated billing ---

  describe("byte_estimated billing", () => {
    it("estimates tokens from bytes when no usage event", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      // "Hello world" = 11 bytes, bytesPerToken = 4 → ceil(11/4) = 3 tokens
      const chunks = [
        ...textChunks(["Hello world"]),
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.billing_method).toBe("byte_estimated")
      expect(result.completion_tokens).toBe(3) // ceil(11/4)
      expect(result.prompt_tokens).toBe(100) // from options
      expect(result.observed_bytes).toBe(11)
    })

    it("uses model-specific bytesPerToken", async () => {
      const customPricing: MicroPricingEntry = {
        ...GPT4O_PRICING,
        bytesPerToken: 3.5,
      }
      const tracker = new StreamCostTracker(defaultOptions({ pricing: customPricing }))
      // 14 bytes / 3.5 bytes per token = 4 tokens
      const chunks = [
        ...textChunks(["Hello world!!"]),  // 13 bytes → ceil(13/3.5) = 4
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.billing_method).toBe("byte_estimated")
      expect(result.completion_tokens).toBe(4) // ceil(13/3.5)
    })

    it("accumulates bytes across multiple chunks", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      // "Hello" = 5 bytes, " " = 1 byte, "world" = 5 bytes → 11 bytes
      const chunks = [
        ...textChunks(["Hello", " ", "world"]),
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.observed_bytes).toBe(11)
      expect(result.completion_tokens).toBe(3) // ceil(11/4)
    })

    it("uses default 4 bytes/token when pricing has no bytesPerToken", async () => {
      const noBptPricing: MicroPricingEntry = {
        provider: "test",
        model: "test",
        input_micro_per_million: 1_000_000,
        output_micro_per_million: 1_000_000,
        // no bytesPerToken
      }
      const tracker = new StreamCostTracker(defaultOptions({ pricing: noBptPricing }))
      // 20 bytes / 4 = 5 tokens
      const chunks = [
        ...textChunks(["12345678901234567890"]),
        doneEvent(),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.completion_tokens).toBe(5)
    })
  })

  // --- Prompt-only billing ---

  describe("prompt_only billing", () => {
    it("bills prompt only when no output observed", async () => {
      const tracker = new StreamCostTracker(defaultOptions({ promptTokens: 500 }))
      const chunks = [
        doneEvent(), // no text chunks, no usage
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.billing_method).toBe("prompt_only")
      expect(result.prompt_tokens).toBe(500)
      expect(result.completion_tokens).toBe(0)
      expect(result.total_cost_micro).toBe(1250n) // 500 * 2_500_000 / 1_000_000
    })

    it("bills prompt only for empty stream", async () => {
      const tracker = new StreamCostTracker(defaultOptions({ promptTokens: 0 }))

      await consume(tracker.track(mockStream([])))
      const result = tracker.getResult()

      expect(result.billing_method).toBe("prompt_only")
      expect(result.total_cost_micro).toBe(0n)
    })
  })

  // --- Abort handling ---

  describe("abort handling", () => {
    it("detects abort via signal", async () => {
      const ac = new AbortController()
      const tracker = new StreamCostTracker(defaultOptions())

      async function* abortingStream(): AsyncGenerator<StreamChunk> {
        yield { event: "chunk", data: { delta: "Hello", tool_calls: null } }
        ac.abort()
        yield { event: "chunk", data: { delta: " world", tool_calls: null } }
      }

      await consume(tracker.track(abortingStream(), ac.signal))
      const result = tracker.getResult()

      expect(result.was_aborted).toBe(true)
    })

    it("falls back to byte estimation on abort without usage", async () => {
      const ac = new AbortController()
      const tracker = new StreamCostTracker(defaultOptions())

      async function* abortingStream(): AsyncGenerator<StreamChunk> {
        yield { event: "chunk", data: { delta: "Hello world", tool_calls: null } }
        ac.abort()
      }

      await consume(tracker.track(abortingStream(), ac.signal))
      const result = tracker.getResult()

      expect(result.was_aborted).toBe(true)
      expect(result.billing_method).toBe("byte_estimated")
      expect(result.observed_bytes).toBe(11)
    })

    it("uses provider usage on abort when available", async () => {
      const ac = new AbortController()
      const tracker = new StreamCostTracker(defaultOptions({ usageOnAbort: true }))

      async function* abortStream(): AsyncGenerator<StreamChunk> {
        yield { event: "chunk", data: { delta: "Hello", tool_calls: null } }
        yield usageEvent(100, 20, 0) // provider reports usage on abort
        ac.abort()
      }

      await consume(tracker.track(abortStream(), ac.signal))
      const result = tracker.getResult()

      expect(result.billing_method).toBe("provider_reported")
      expect(result.completion_tokens).toBe(20)
    })
  })

  // --- Ensemble overcount ---

  describe("ensemble overcount billing", () => {
    it("applies 10% overcount margin to observed chunks", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      // 40 bytes / 4 bytes per token = 10 tokens → 10 * 1.1 = 11 tokens
      const chunks = textChunks(["1234567890123456789012345678901234567890"]) // 40 bytes

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getOvercountResult()

      expect(result.billing_method).toBe("observed_chunks_overcount")
      expect(result.completion_tokens).toBe(11) // ceil(10 * 1.1)
      expect(result.was_aborted).toBe(true)
    })

    it("uses exact provider usage when usageOnAbort is true", async () => {
      const tracker = new StreamCostTracker(defaultOptions({ usageOnAbort: true }))
      const chunks = [
        ...textChunks(["Hello"]),
        usageEvent(100, 30, 0),
      ]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getOvercountResult()

      expect(result.billing_method).toBe("provider_reported")
      expect(result.completion_tokens).toBe(30) // exact, no overcount
    })

    it("falls back to prompt_only when no output observed", async () => {
      const tracker = new StreamCostTracker(defaultOptions({ promptTokens: 200 }))

      await consume(tracker.track(mockStream([])))
      const result = tracker.getOvercountResult()

      expect(result.billing_method).toBe("prompt_only")
      expect(result.prompt_tokens).toBe(200)
      expect(result.completion_tokens).toBe(0)
    })

    it("overcount rounds up correctly", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      // 7 bytes / 4 = ceil(1.75) = 2 tokens → 2 * 1.1 = 2.2 → ceil = 3
      const chunks = textChunks(["1234567"])

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getOvercountResult()

      expect(result.completion_tokens).toBe(3) // ceil(ceil(7/4) * 1.1)
    })
  })

  // --- Passthrough behavior ---

  describe("passthrough", () => {
    it("yields all chunks unchanged", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      const original = [
        { event: "chunk" as const, data: { delta: "Hello", tool_calls: null } },
        { event: "chunk" as const, data: { delta: " world", tool_calls: null } },
        usageEvent(100, 50, 0),
        doneEvent(),
      ]

      const yielded = await consume(tracker.track(mockStream(original)))

      expect(yielded).toHaveLength(4)
      expect(yielded[0]).toEqual(original[0])
      expect(yielded[1]).toEqual(original[1])
      expect(yielded[2]).toEqual(original[2])
      expect(yielded[3]).toEqual(original[3])
    })

    it("passes through tool_call events", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      const toolCallChunk: StreamChunk = {
        event: "tool_call",
        data: { index: 0, id: "tc-1", function: { name: "search", arguments: '{"q":"test"}' } },
      }
      const chunks = [toolCallChunk, usageEvent(100, 20, 0), doneEvent()]

      const yielded = await consume(tracker.track(mockStream(chunks)))

      expect(yielded[0]).toEqual(toolCallChunk)
    })

    it("passes through error events", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      const errorChunk: StreamChunk = {
        event: "error",
        data: { code: "timeout", message: "Request timed out" },
      }

      const yielded = await consume(tracker.track(mockStream([errorChunk])))

      expect(yielded[0]).toEqual(errorChunk)
    })
  })

  // --- Cost computation accuracy ---

  describe("cost computation", () => {
    it("zero tokens = zero cost", async () => {
      const tracker = new StreamCostTracker(defaultOptions({ promptTokens: 0 }))
      const chunks = [usageEvent(0, 0, 0), doneEvent()]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.total_cost_micro).toBe(0n)
    })

    it("large token counts produce correct costs", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      const chunks = [usageEvent(1_000_000, 500_000, 0), doneEvent()]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      // input: 1M * 2.5M / 1M = 2,500,000
      // output: 500K * 10M / 1M = 5,000,000
      // total: 7,500,000 micro-USD = $7.50
      expect(result.total_cost_micro).toBe(7_500_000n)
    })

    it("handles sub-token granularity (rounding down)", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      // 1 token * 2_500_000 / 1_000_000 = 2.5 → floor to 2
      const chunks = [usageEvent(1, 0, 0), doneEvent()]

      await consume(tracker.track(mockStream(chunks)))
      const result = tracker.getResult()

      expect(result.total_cost_micro).toBe(2n) // floor(2.5)
    })
  })

  // --- UTF-8 byte counting ---

  describe("UTF-8 byte counting", () => {
    it("counts ASCII bytes correctly", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      await consume(tracker.track(mockStream(textChunks(["Hello"]))))
      expect(tracker.getResult().observed_bytes).toBe(5)
    })

    it("counts multi-byte UTF-8 correctly", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      // "日本" = 6 bytes in UTF-8 (3 bytes each)
      await consume(tracker.track(mockStream(textChunks(["日本"]))))
      expect(tracker.getResult().observed_bytes).toBe(6)
    })

    it("counts emoji bytes correctly", async () => {
      const tracker = new StreamCostTracker(defaultOptions())
      // "🎉" = 4 bytes in UTF-8
      await consume(tracker.track(mockStream(textChunks(["🎉"]))))
      expect(tracker.getResult().observed_bytes).toBe(4)
    })
  })
})

// --- streamWithCostTracking convenience function ---

describe("streamWithCostTracking", () => {
  it("returns tracked generator and getResult function", async () => {
    const stream = mockStream([
      { event: "chunk", data: { delta: "test", tool_calls: null } },
      { event: "usage", data: { prompt_tokens: 50, completion_tokens: 10, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "stop" } },
    ])

    const { tracked, getResult } = streamWithCostTracking(stream, {
      pricing: GPT4O_PRICING,
      promptTokens: 50,
    })

    // Must consume before getResult
    const chunks: StreamChunk[] = []
    for await (const chunk of tracked) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(3)

    const result = getResult()
    expect(result.billing_method).toBe("provider_reported")
    expect(result.prompt_tokens).toBe(50)
    expect(result.completion_tokens).toBe(10)
  })
})
