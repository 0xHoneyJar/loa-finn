// src/billing/pricing.ts — Pricing Table + Cost Estimation (SDD §3.4, Sprint 2 Task 2.2)
//
// Model pricing in MicroUSD/token. Reserve estimation (ceil), actual cost (floor),
// x402 quote (ceil with markup). Rate freeze at RESERVE time.

import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"
import type { CreditUnit, MicroUSDC } from "../hounfour/wire-boundary.js"
import { convertMicroUSDtoCreditUnit, convertMicroUSDtoMicroUSDC } from "../hounfour/wire-boundary.js"
import type { ExchangeRateSnapshot } from "./types.js"

// ---------------------------------------------------------------------------
// Model Pricing Table (MicroUSD per token)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  input_micro_usd_per_token: number
  output_micro_usd_per_token: number
}

const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4": { input_micro_usd_per_token: 3, output_micro_usd_per_token: 15 },
  "claude-haiku-4": { input_micro_usd_per_token: 1, output_micro_usd_per_token: 5 },
  "gpt-4.1": { input_micro_usd_per_token: 2, output_micro_usd_per_token: 8 },
  "gpt-4.1-mini": { input_micro_usd_per_token: 0.4, output_micro_usd_per_token: 1.6 },
}

let modelPricingOverride: Record<string, ModelPricing> | null = null

/**
 * Load model pricing from FINN_MODEL_PRICING_JSON env var.
 * Falls back to DEFAULT_MODEL_PRICING if not set or invalid.
 */
export function loadModelPricing(): Record<string, ModelPricing> {
  if (modelPricingOverride) return modelPricingOverride
  const envJson = process.env.FINN_MODEL_PRICING_JSON
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson) as Record<string, ModelPricing>
      modelPricingOverride = parsed
      return parsed
    } catch {
      // Fall through to defaults
    }
  }
  return DEFAULT_MODEL_PRICING
}

export function getModelPricing(model: string): ModelPricing {
  const table = loadModelPricing()
  const pricing = table[model]
  if (!pricing) {
    throw new PricingError(`Unknown model: "${model}". Available: ${Object.keys(table).join(", ")}`)
  }
  return pricing
}

/** Reset cached pricing override (for testing). */
export function resetModelPricingCache(): void {
  modelPricingOverride = null
}

// ---------------------------------------------------------------------------
// Default Rate Constants
// ---------------------------------------------------------------------------

/** Default: 100 CreditUnit = $1.00 */
export const DEFAULT_CREDIT_UNITS_PER_USD = 100

/** Default: 1 USD = 1 USDC (stablecoin peg) */
export const DEFAULT_USD_USDC_RATE = 1.0

// ---------------------------------------------------------------------------
// Cost Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate reserve cost in MicroUSD (ceil rounding — user never under-reserved).
 *
 * Formula: (input_tokens × input_rate) + (max_tokens × output_rate)
 */
export function estimateReserveCost(
  model: string,
  inputTokens: number,
  maxTokens: number,
): MicroUSD {
  const pricing = getModelPricing(model)
  const inputCost = Math.ceil(inputTokens * pricing.input_micro_usd_per_token)
  const outputCost = Math.ceil(maxTokens * pricing.output_micro_usd_per_token)
  return BigInt(inputCost + outputCost) as MicroUSD
}

/**
 * Compute actual cost in MicroUSD (floor rounding — user never overpays).
 *
 * Formula: (input_tokens × input_rate) + (actual_output_tokens × output_rate)
 */
export function computeActualCost(
  model: string,
  inputTokens: number,
  actualOutputTokens: number,
): MicroUSD {
  const pricing = getModelPricing(model)
  const inputCost = Math.floor(inputTokens * pricing.input_micro_usd_per_token)
  const outputCost = Math.floor(actualOutputTokens * pricing.output_micro_usd_per_token)
  return BigInt(inputCost + outputCost) as MicroUSD
}

/**
 * Estimate reserve cost in CreditUnit (ceil rounding).
 * Uses frozen rate from ExchangeRateSnapshot.
 */
export function estimateReserveCostCU(
  model: string,
  inputTokens: number,
  maxTokens: number,
  snapshot: ExchangeRateSnapshot,
): CreditUnit {
  const microUsd = estimateReserveCost(model, inputTokens, maxTokens)
  return convertMicroUSDtoCreditUnit(microUsd, snapshot.credit_units_per_usd, "ceil")
}

/**
 * Compute actual cost in CreditUnit (floor rounding).
 * Uses frozen rate from ExchangeRateSnapshot.
 */
export function computeActualCostCU(
  model: string,
  inputTokens: number,
  actualOutputTokens: number,
  snapshot: ExchangeRateSnapshot,
): CreditUnit {
  const microUsd = computeActualCost(model, inputTokens, actualOutputTokens)
  return convertMicroUSDtoCreditUnit(microUsd, snapshot.credit_units_per_usd, "floor")
}

/**
 * Compute x402 quote in MicroUSDC (ceil rounding with markup).
 *
 * Formula: ceil(((max_input × input_rate) + (max_tokens × output_rate)) × usd_usdc_rate × markup)
 */
export function computeX402Quote(
  model: string,
  maxInputTokens: number,
  maxTokens: number,
  markupFactor: number,
  usdUsdcRate: number = DEFAULT_USD_USDC_RATE,
): MicroUSDC {
  const baseCost = estimateReserveCost(model, maxInputTokens, maxTokens)
  const markedUp = BigInt(Math.ceil(Number(baseCost) * markupFactor)) as MicroUSD
  return convertMicroUSDtoMicroUSDC(markedUp, usdUsdcRate, "ceil")
}

// ---------------------------------------------------------------------------
// Rate Freeze
// ---------------------------------------------------------------------------

/**
 * Capture current rates as a frozen snapshot.
 * Called at RESERVE time; COMMIT and RELEASE use the frozen rates.
 */
export function freezeRates(overrides?: {
  creditUnitsPerUsd?: number
  usdUsdcRate?: number
}): ExchangeRateSnapshot {
  return {
    credit_units_per_usd: overrides?.creditUnitsPerUsd ?? DEFAULT_CREDIT_UNITS_PER_USD,
    usd_usdc_rate: overrides?.usdUsdcRate ?? DEFAULT_USD_USDC_RATE,
    frozen_at: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PricingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PricingError"
  }
}
