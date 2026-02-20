// src/x402/denomination.ts — MicroUSD ↔ MicroUSDC Conversion (Sprint 9 Task 9.1)
//
// Rate-frozen conversion for x402 payments.
// Rate captured at quote time, persisted in WAL, used for settlement.
// ceil rounding: user never underpays.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrozenRate {
  /** USD/USDC exchange rate (e.g., 1.0 means 1 USD = 1 USDC) */
  rate: number
  /** When the rate was frozen */
  frozen_at: number
  /** Billing entry ID this rate is bound to */
  billing_entry_id: string
}

// ---------------------------------------------------------------------------
// Conversion Functions
// ---------------------------------------------------------------------------

/**
 * Convert MicroUSD to MicroUSDC using frozen rate.
 * ceil rounding: user never underpays.
 */
export function convertMicroUSDtoMicroUSDC(amountMicroUSD: bigint, rate: number): bigint {
  // MicroUSDC = MicroUSD * rate, ceil
  // Use integer math: multiply by rate * 1e6, divide by 1e6, ceil
  const rateBips = BigInt(Math.ceil(rate * 1_000_000))
  const result = (amountMicroUSD * rateBips + 999_999n) / 1_000_000n // ceil division
  return result
}

/**
 * Convert MicroUSDC to MicroUSD using frozen rate.
 * floor rounding: conservative (for refund calculations).
 */
export function convertMicroUSDCtoMicroUSD(amountMicroUSDC: bigint, rate: number): bigint {
  if (rate === 0) return 0n
  const rateBips = BigInt(Math.ceil(rate * 1_000_000))
  // floor division
  return (amountMicroUSDC * 1_000_000n) / rateBips
}

/**
 * Freeze the current exchange rate for a billing entry.
 */
export function freezeExchangeRate(billingEntryId: string): FrozenRate {
  const rateStr = process.env.USD_USDC_EXCHANGE_RATE ?? "1.0"
  const rate = parseFloat(rateStr)

  if (isNaN(rate) || rate <= 0) {
    throw new Error(`Invalid USD_USDC_EXCHANGE_RATE: ${rateStr}`)
  }

  return {
    rate,
    frozen_at: Date.now(),
    billing_entry_id: billingEntryId,
  }
}

/**
 * Verify round-trip conversion drift is within acceptable threshold.
 * Returns drift in MicroUSD (should be <= 1 per conversion).
 */
export function verifyRoundTripDrift(amountMicroUSD: bigint, rate: number): bigint {
  const microUSDC = convertMicroUSDtoMicroUSDC(amountMicroUSD, rate)
  const roundTrip = convertMicroUSDCtoMicroUSD(microUSDC, rate)
  const drift = roundTrip > amountMicroUSD
    ? roundTrip - amountMicroUSD
    : amountMicroUSD - roundTrip
  return drift
}
