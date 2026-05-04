// src/x402/pricing.ts — x402 Pricing Configuration (Sprint 2 T2.9, Flatline IMP-010)
//
// Flat-fee pricing model for v1. Model-based pricing deferred to post-MVP.
// Cost returned in micro-USDC units (1 USDC = 1_000_000 micro-USDC).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default request cost: 100000 micro-USDC = $0.10 */
const DEFAULT_REQUEST_COST_MICRO = 100_000

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Load pricing from environment.
 * X402_REQUEST_COST_MICRO: integer, micro-USDC units.
 * Examples: 100000 = $0.10, 500000 = $0.50, 1000000 = $1.00
 */
function loadRequestCostMicro(): number {
  const raw = process.env.X402_REQUEST_COST_MICRO
  if (!raw) return DEFAULT_REQUEST_COST_MICRO

  const value = parseInt(raw, 10)
  if (isNaN(value) || value <= 0) {
    throw new Error(
      `X402_REQUEST_COST_MICRO must be a positive integer (got "${raw}")`,
    )
  }
  return value
}

// Cache the loaded value (read once at first call)
let cachedCost: number | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the cost for a request in micro-USDC.
 *
 * v1: Returns flat fee from X402_REQUEST_COST_MICRO env var.
 * Parameters are accepted but ignored in v1 — they will drive
 * model-based pricing in post-MVP.
 *
 * @param _tokenId - NFT token ID (unused in v1)
 * @param _model - Model identifier (unused in v1)
 * @param _maxTokens - Max tokens requested (unused in v1)
 * @returns Cost in micro-USDC (string for BigInt compatibility)
 */
export function getRequestCost(
  _tokenId: string,
  _model: string,
  _maxTokens: number,
): string {
  if (cachedCost === null) {
    cachedCost = loadRequestCostMicro()
  }
  return cachedCost.toString()
}

/**
 * Reset cached pricing (for testing only).
 */
export function resetPricingCache(): void {
  cachedCost = null
}

// ---------------------------------------------------------------------------
// Gas Surcharge (SDD §4.4.4, T-3.5)
// ---------------------------------------------------------------------------

/** Default gas surcharge rate: 5% of inference cost */
const DEFAULT_GAS_SURCHARGE_RATE = 0.05

/** Maximum gas surcharge: 10000 MicroUSDC = 0.01 USDC */
const MAX_GAS_SURCHARGE_MICRO = 10_000n

/**
 * Compute total quote price including gas surcharge.
 * Formula: total = inferenceCost + min(inferenceCost * rate, cap)
 *
 * @param inferenceCostMicro - Inference cost in MicroUSDC
 * @param gasSurchargeRate - Surcharge rate (default: 0.05 = 5%)
 * @param maxSurchargeMicro - Maximum surcharge cap (default: 10000 = $0.01)
 * @returns Total price in MicroUSDC (string for BigInt compatibility)
 */
export function computeQuoteWithGas(
  inferenceCostMicro: bigint,
  gasSurchargeRate: number = DEFAULT_GAS_SURCHARGE_RATE,
  maxSurchargeMicro: bigint = MAX_GAS_SURCHARGE_MICRO,
): string {
  const surcharge = BigInt(Math.ceil(Number(inferenceCostMicro) * gasSurchargeRate))
  const cappedSurcharge = surcharge > maxSurchargeMicro ? maxSurchargeMicro : surcharge
  return (inferenceCostMicro + cappedSurcharge).toString()
}

/**
 * Get full request cost including gas surcharge (for X-Price header, AC30g).
 */
export function getRequestCostWithGas(
  tokenId: string,
  model: string,
  maxTokens: number,
): string {
  const baseCost = BigInt(getRequestCost(tokenId, model, maxTokens))
  return computeQuoteWithGas(baseCost)
}
