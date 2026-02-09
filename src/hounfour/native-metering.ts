// src/hounfour/native-metering.ts — Claude Code token tracking (SDD §4.10, T-3.5)

import type { BudgetEnforcer } from "./budget.js"
import type { ScopeMeta, PricingEntry, UsageInfo } from "./types.js"

// --- Sentinel Values ---

/** Sentinel value for unmetered sessions (-1 indicates extraction unavailable) */
export const SENTINEL_TOKENS = -1

// --- Native Runtime Meter ---

export class NativeRuntimeMeter {
  constructor(
    private budget: BudgetEnforcer,
    private pricing: PricingEntry,
    private scopeMeta: ScopeMeta,
  ) {}

  /**
   * Record a Claude Code session turn.
   * Called after each turn completes (hooked into session lifecycle).
   */
  async recordTurn(usage: UsageInfo, extraFields?: { trace_id?: string; latency_ms?: number }): Promise<void> {
    // Skip recording if any sentinel/invalid values (unmetered or malformed)
    if (
      !Number.isFinite(usage.prompt_tokens) ||
      !Number.isFinite(usage.completion_tokens) ||
      !Number.isFinite(usage.reasoning_tokens) ||
      usage.prompt_tokens < 0 ||
      usage.completion_tokens < 0 ||
      usage.reasoning_tokens < 0
    ) return

    await this.budget.recordCost(
      this.scopeMeta,
      usage,
      this.pricing,
      {
        trace_id: extraFields?.trace_id ?? `native-${Date.now()}`,
        agent: "native-runtime",
        provider: "claude-code",
        model: "session",
        tenant_id: "local",
        latency_ms: extraFields?.latency_ms ?? 0,
      },
    )
  }

  /**
   * Attempt to extract usage from Claude Code session data.
   * Returns sentinel values if extraction fails.
   *
   * Session data format varies by Claude Code version.
   * We look for the common fields in the session transcript.
   */
  static extractUsage(sessionData: unknown): UsageInfo {
    if (!sessionData || typeof sessionData !== "object") {
      return { prompt_tokens: SENTINEL_TOKENS, completion_tokens: SENTINEL_TOKENS, reasoning_tokens: 0 }
    }

    const data = sessionData as Record<string, unknown>

    // Try standard usage fields
    const usage = data.usage as Record<string, unknown> | undefined
    if (usage) {
      const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : SENTINEL_TOKENS
      const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : SENTINEL_TOKENS
      const reasoningTokens = typeof usage.reasoning_tokens === "number" ? usage.reasoning_tokens : 0

      return { prompt_tokens: promptTokens, completion_tokens: completionTokens, reasoning_tokens: reasoningTokens }
    }

    // Try input/output token format
    const inputTokens = typeof data.input_tokens === "number" ? data.input_tokens : SENTINEL_TOKENS
    const outputTokens = typeof data.output_tokens === "number" ? data.output_tokens : SENTINEL_TOKENS

    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      reasoning_tokens: 0,
    }
  }
}

// --- Default Anthropic Pricing ---

/** Current Anthropic pricing (per 1M tokens) for common models */
export const ANTHROPIC_PRICING: Record<string, PricingEntry> = {
  "claude-opus-4-6": {
    provider: "anthropic",
    model: "claude-opus-4-6",
    input_per_1m: 15.00,
    output_per_1m: 75.00,
    reasoning_per_1m: 75.00,
  },
  "claude-sonnet-4-5": {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    input_per_1m: 3.00,
    output_per_1m: 15.00,
    reasoning_per_1m: 15.00,
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    input_per_1m: 0.80,
    output_per_1m: 4.00,
  },
}

/**
 * Get pricing for a model name, falling back to sonnet pricing.
 */
export function getAnthropicPricing(model: string): PricingEntry {
  // Try exact match first
  if (ANTHROPIC_PRICING[model]) return ANTHROPIC_PRICING[model]

  // Try partial match (e.g., "claude-opus-4-6" matches "opus")
  for (const [key, pricing] of Object.entries(ANTHROPIC_PRICING)) {
    if (model.includes(key.split("-")[1])) return pricing
  }

  // Default to sonnet pricing
  return ANTHROPIC_PRICING["claude-sonnet-4-5"]
}
