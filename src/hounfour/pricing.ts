// src/hounfour/pricing.ts — Integer Micro-USD Pricing Table (SDD §3.3, T-A.5)
// All prices in micro-USD per million tokens. 1 USD = 1,000,000 micro-USD.
// No floating-point anywhere in the cost path.

// --- Types ---

export interface MicroPricingEntry {
  provider: string
  model: string
  input_micro_per_million: number   // micro-USD per 1M input tokens
  output_micro_per_million: number  // micro-USD per 1M output tokens
  reasoning_micro_per_million?: number // micro-USD per 1M reasoning tokens
  bytesPerToken?: number            // Average bytes per token for byte-based estimation
}

/** Current pricing table version. Monotonically increasing. */
export const PRICE_TABLE_VERSION = 1

// --- Cost Calculation (Integer-Only) ---

/**
 * Calculate cost in micro-USD using integer arithmetic only.
 *
 * Formula: cost_micro = floor((tokens * price_micro_per_million) / 1_000_000)
 *
 * Safe because max realistic product is ~10^12 (well within Number.MAX_SAFE_INTEGER = 2^53).
 * Guardrail: throws BUDGET_OVERFLOW if product exceeds MAX_SAFE_INTEGER.
 *
 * Returns { cost_micro, remainder_micro } for remainder carry.
 */
export function calculateCostMicro(
  tokens: number,
  priceMicroPerMillion: number,
): { cost_micro: number; remainder_micro: number } {
  const product = tokens * priceMicroPerMillion
  if (product > Number.MAX_SAFE_INTEGER) {
    throw new Error(`BUDGET_OVERFLOW: tokens(${tokens}) * price(${priceMicroPerMillion}) = ${product} exceeds MAX_SAFE_INTEGER`)
  }

  const cost_micro = Math.floor(product / 1_000_000)
  const remainder_micro = product % 1_000_000

  return { cost_micro, remainder_micro }
}

/**
 * Calculate total cost for a completion in micro-USD.
 * Handles input, output, and optional reasoning tokens.
 */
export interface UsageMicro {
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
}

export interface CostBreakdownMicro {
  input_cost_micro: number
  output_cost_micro: number
  reasoning_cost_micro: number
  total_cost_micro: number
  remainder_input_micro: number
  remainder_output_micro: number
  remainder_reasoning_micro: number
}

export function calculateTotalCostMicro(
  usage: UsageMicro,
  pricing: MicroPricingEntry,
): CostBreakdownMicro {
  const input = calculateCostMicro(usage.prompt_tokens, pricing.input_micro_per_million)
  const output = calculateCostMicro(usage.completion_tokens, pricing.output_micro_per_million)
  const reasoning = pricing.reasoning_micro_per_million
    ? calculateCostMicro(usage.reasoning_tokens, pricing.reasoning_micro_per_million)
    : { cost_micro: 0, remainder_micro: 0 }

  return {
    input_cost_micro: input.cost_micro,
    output_cost_micro: output.cost_micro,
    reasoning_cost_micro: reasoning.cost_micro,
    total_cost_micro: input.cost_micro + output.cost_micro + reasoning.cost_micro,
    remainder_input_micro: input.remainder_micro,
    remainder_output_micro: output.remainder_micro,
    remainder_reasoning_micro: reasoning.remainder_micro,
  }
}

// --- Remainder Accumulator ---

/**
 * Accumulates remainder from integer division across requests.
 * When remainder >= 1_000_000, carries 1 micro-USD to cost.
 */
export class RemainderAccumulator {
  private remainders = new Map<string, number>()

  /**
   * Apply remainder carry for a scope.
   * Returns the extra micro-USD to add to cost (0 or 1+).
   */
  carry(scopeKey: string, remainderMicro: number): number {
    const current = this.remainders.get(scopeKey) ?? 0
    const total = current + remainderMicro
    const extra = Math.floor(total / 1_000_000)
    this.remainders.set(scopeKey, total % 1_000_000)
    return extra
  }

  /** Get current accumulated remainder for a scope */
  get(scopeKey: string): number {
    return this.remainders.get(scopeKey) ?? 0
  }

  /** Reset all accumulators */
  clear(): void {
    this.remainders.clear()
  }
}

// --- Default Pricing Table ---

export const DEFAULT_PRICING: MicroPricingEntry[] = [
  // Qwen local (self-hosted — cost is infrastructure, set to near-zero for tracking)
  {
    provider: "qwen-local",
    model: "Qwen/Qwen2.5-7B-Instruct",
    input_micro_per_million: 10_000,      // $0.01/1M tokens
    output_micro_per_million: 10_000,
    bytesPerToken: 4,
  },
  {
    provider: "qwen-local",
    model: "Qwen/Qwen2.5-Coder-7B-Instruct",
    input_micro_per_million: 10_000,
    output_micro_per_million: 10_000,
    bytesPerToken: 4,
  },
  // OpenAI
  {
    provider: "openai",
    model: "gpt-4o",
    input_micro_per_million: 2_500_000,   // $2.50/1M input
    output_micro_per_million: 10_000_000, // $10.00/1M output
    bytesPerToken: 4,
  },
  {
    provider: "openai",
    model: "o3",
    input_micro_per_million: 10_000_000,  // $10.00/1M input
    output_micro_per_million: 40_000_000, // $40.00/1M output
    reasoning_micro_per_million: 40_000_000,
    bytesPerToken: 4,
  },
  // Anthropic
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    input_micro_per_million: 15_000_000,  // $15.00/1M input
    output_micro_per_million: 75_000_000, // $75.00/1M output
    reasoning_micro_per_million: 75_000_000,
    bytesPerToken: 3.5,                   // Claude tokenizer slightly more efficient
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    input_micro_per_million: 3_000_000,   // $3.00/1M input
    output_micro_per_million: 15_000_000, // $15.00/1M output
    reasoning_micro_per_million: 15_000_000,
    bytesPerToken: 3.5,
  },
]

/** Look up pricing by provider + model. Returns undefined if not found. */
export function findPricing(provider: string, model: string): MicroPricingEntry | undefined {
  return DEFAULT_PRICING.find(p => p.provider === provider && p.model === model)
}
