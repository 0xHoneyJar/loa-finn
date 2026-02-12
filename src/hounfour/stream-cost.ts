// src/hounfour/stream-cost.ts — Streaming Cost Attribution (SDD §4.3, Task A.3 part 4)
// Tracks usage incrementally during streaming, falls back to byte-based estimation
// when provider does not report terminal usage.

import type { StreamChunk, StreamUsageData } from "./types.js"
import type { MicroPricingEntry } from "./pricing.js"
import { computeCostMicro } from "./budget.js"

// --- Types ---

/** Billing method for cost attribution. */
export type BillingMethod =
  | "provider_reported"        // Provider sent terminal usage event
  | "byte_estimated"           // Estimated from observed bytes / bytesPerToken
  | "observed_chunks_overcount" // Observed chunks + 10% margin (ensemble losers)
  | "prompt_only"              // Abort before any output (prompt tokens only)

/** Cost tracking result emitted after stream completes. */
export interface StreamCostResult {
  billing_method: BillingMethod
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
  total_cost_micro: bigint
  observed_bytes: number
  was_aborted: boolean
}

/** Options for the streaming cost tracker. */
export interface StreamCostOptions {
  /** Pricing entry for the model being streamed. */
  pricing: MicroPricingEntry
  /** Known prompt token count (from request, if available). */
  promptTokens?: number
  /** Whether the adapter reports usage on abort. */
  usageOnAbort?: boolean
  /** Default bytes per token for byte-based fallback. Default: 4. */
  defaultBytesPerToken?: number
}

// --- Streaming Cost Tracker ---

/**
 * Wraps a streaming response with cost tracking.
 *
 * Passes through all stream chunks unchanged. Tracks:
 * - Text chunk bytes (for byte-based token estimation)
 * - Usage events (takes the last one as terminal usage)
 * - Abort signal (detects premature termination)
 *
 * After the stream ends, call `getResult()` to get the cost attribution.
 *
 * Billing method selection:
 * 1. Provider-reported usage (preferred) → "provider_reported"
 * 2. Byte-based estimation (fallback) → "byte_estimated"
 * 3. Prompt-only (abort before output) → "prompt_only"
 */
export class StreamCostTracker {
  private lastUsage: StreamUsageData | null = null
  private observedBytes = 0
  private observedChunks = 0
  private wasAborted = false
  private streamComplete = false
  private pricing: MicroPricingEntry
  private promptTokens: number
  private usageOnAbort: boolean
  private bytesPerToken: number

  constructor(options: StreamCostOptions) {
    this.pricing = options.pricing
    this.promptTokens = options.promptTokens ?? 0
    this.usageOnAbort = options.usageOnAbort ?? false
    this.bytesPerToken = options.pricing.bytesPerToken ?? options.defaultBytesPerToken ?? 4
  }

  /**
   * Wrap a stream, tracking usage and bytes. Yields all chunks unchanged.
   */
  async *track(
    stream: AsyncIterable<StreamChunk>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    try {
      for await (const chunk of stream) {
        // Track abort signal
        if (signal?.aborted) {
          this.wasAborted = true
        }

        // Track usage events (take the latest)
        if (chunk.event === "usage") {
          this.lastUsage = chunk.data
        }

        // Track text chunk bytes for fallback estimation
        if (chunk.event === "chunk") {
          this.observedBytes += Buffer.byteLength(chunk.data.delta, "utf8")
          this.observedChunks++
        }

        yield chunk
      }
    } catch (err) {
      // AbortError or other stream termination
      this.wasAborted = true
      throw err
    } finally {
      this.streamComplete = true
      if (signal?.aborted) {
        this.wasAborted = true
      }
    }
  }

  /**
   * Get the cost attribution result after the stream completes.
   * Must be called after the stream generator is fully consumed.
   */
  getResult(): StreamCostResult {
    if (this.lastUsage) {
      // Path 1: Provider reported usage — most accurate
      const total = this.computeCost(
        this.lastUsage.prompt_tokens,
        this.lastUsage.completion_tokens,
        this.lastUsage.reasoning_tokens,
      )
      return {
        billing_method: "provider_reported",
        prompt_tokens: this.lastUsage.prompt_tokens,
        completion_tokens: this.lastUsage.completion_tokens,
        reasoning_tokens: this.lastUsage.reasoning_tokens,
        total_cost_micro: total,
        observed_bytes: this.observedBytes,
        was_aborted: this.wasAborted,
      }
    }

    if (this.observedBytes > 0) {
      // Path 2: Byte-based estimation — fallback when no usage event
      const estimatedCompletionTokens = Math.ceil(this.observedBytes / this.bytesPerToken)
      const total = this.computeCost(
        this.promptTokens,
        estimatedCompletionTokens,
        0,
      )
      return {
        billing_method: "byte_estimated",
        prompt_tokens: this.promptTokens,
        completion_tokens: estimatedCompletionTokens,
        reasoning_tokens: 0,
        total_cost_micro: total,
        observed_bytes: this.observedBytes,
        was_aborted: this.wasAborted,
      }
    }

    // Path 3: No output observed — prompt tokens only
    const total = this.computeCost(this.promptTokens, 0, 0)
    return {
      billing_method: "prompt_only",
      prompt_tokens: this.promptTokens,
      completion_tokens: 0,
      reasoning_tokens: 0,
      total_cost_micro: total,
      observed_bytes: 0,
      was_aborted: this.wasAborted,
    }
  }

  // --- For ensemble losers: overcount billing ---

  /**
   * Get cost result with 10% overcount margin for ensemble losers.
   * Used when a branch is cancelled and no terminal usage is available.
   */
  getOvercountResult(): StreamCostResult {
    if (this.lastUsage && this.usageOnAbort) {
      // If adapter reports usage on abort, use exact values
      return this.getResult()
    }

    if (this.observedChunks > 0) {
      // Observed chunks + 10% safety margin
      const estimatedCompletionTokens = Math.ceil(this.observedBytes / this.bytesPerToken)
      const overcountTokens = Math.ceil(estimatedCompletionTokens * 1.1)
      const total = this.computeCost(this.promptTokens, overcountTokens, 0)
      return {
        billing_method: "observed_chunks_overcount",
        prompt_tokens: this.promptTokens,
        completion_tokens: overcountTokens,
        reasoning_tokens: 0,
        total_cost_micro: total,
        observed_bytes: this.observedBytes,
        was_aborted: true,
      }
    }

    // No output — prompt only
    const total = this.computeCost(this.promptTokens, 0, 0)
    return {
      billing_method: "prompt_only",
      prompt_tokens: this.promptTokens,
      completion_tokens: 0,
      reasoning_tokens: 0,
      total_cost_micro: total,
      observed_bytes: 0,
      was_aborted: true,
    }
  }

  // --- Private ---

  private computeCost(
    promptTokens: number,
    completionTokens: number,
    reasoningTokens: number,
  ): bigint {
    const input = computeCostMicro(
      BigInt(promptTokens),
      BigInt(this.pricing.input_micro_per_million),
    )
    const output = computeCostMicro(
      BigInt(completionTokens),
      BigInt(this.pricing.output_micro_per_million),
    )
    const reasoning = this.pricing.reasoning_micro_per_million
      ? computeCostMicro(
          BigInt(reasoningTokens),
          BigInt(this.pricing.reasoning_micro_per_million),
        )
      : { cost_micro: 0n }

    return input.cost_micro + output.cost_micro + reasoning.cost_micro
  }
}

// --- Convenience function ---

/**
 * Stream with cost tracking as a standalone generator function.
 * Returns a generator that yields stream chunks and a promise that resolves to the cost result.
 */
export function streamWithCostTracking(
  stream: AsyncIterable<StreamChunk>,
  options: StreamCostOptions,
  signal?: AbortSignal,
): { tracked: AsyncGenerator<StreamChunk>; getResult: () => StreamCostResult } {
  const tracker = new StreamCostTracker(options)
  return {
    tracked: tracker.track(stream, signal),
    getResult: () => tracker.getResult(),
  }
}
