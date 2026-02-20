// src/credits/types.ts — Credit Purchase Types (SDD §5.2, Sprint 2 Task 2.4)

import type { CreditUnit, MicroUSDC } from "../hounfour/wire-boundary.js"
import type { BillingEntryId } from "../billing/types.js"

// ---------------------------------------------------------------------------
// Credit Pack Definitions
// ---------------------------------------------------------------------------

export const CREDIT_PACKS = {
  500: { credit_units: 500, usdc_amount: 5_000_000n }, // $5 = 5 USDC = 5_000_000 MicroUSDC
  1000: { credit_units: 1000, usdc_amount: 10_000_000n }, // $10 = 10 USDC
  2500: { credit_units: 2500, usdc_amount: 25_000_000n }, // $25 = 25 USDC
} as const

export type PackSize = keyof typeof CREDIT_PACKS

export function isValidPackSize(size: number): size is PackSize {
  return size in CREDIT_PACKS
}

// ---------------------------------------------------------------------------
// USDC Contract Constants (Base Mainnet)
// ---------------------------------------------------------------------------

/** USDC contract address on Base mainnet */
export const USDC_CONTRACT_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const

/** Minimum L2 confirmations for credit mint */
export const MIN_CONFIRMATIONS = 12

/** Treasury address — env var override supported */
export function getTreasuryAddress(): string {
  const addr = process.env.FINN_TREASURY_ADDRESS
  if (!addr) throw new CreditPurchaseError("CONFIGURATION_ERROR", "FINN_TREASURY_ADDRESS not set")
  return addr.toLowerCase()
}

// ---------------------------------------------------------------------------
// Request / Response Types
// ---------------------------------------------------------------------------

export interface PaymentProof {
  tx_hash: string
  chain_id: number
  token: string
  sender: string
  amount_micro_usdc: string
}

export interface CreditPurchaseRequest {
  pack_size: number
  payment_proof: PaymentProof
  idempotency_key: string
}

export interface CreditPurchaseResult {
  credit_balance: string
  pack_size: number
  billing_entry_id: string
  status: "minted"
}

// ---------------------------------------------------------------------------
// Verification Binding (stored in WAL for reorg detection)
// ---------------------------------------------------------------------------

export interface VerificationBinding {
  tx_hash: string
  log_index: number
  block_number: bigint
  block_hash: string
  amount_micro_usdc: bigint
  sender: string
  recipient: string
  verified_at: number
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type CreditPurchaseErrorCode =
  | "INVALID_PACK_SIZE"
  | "INVALID_PROOF"
  | "PAYMENT_NOT_CONFIRMED"
  | "PAYMENT_MISMATCH"
  | "ALREADY_MINTED"
  | "VERIFICATION_UNAVAILABLE"
  | "SENDER_MISMATCH"
  | "CONFIGURATION_ERROR"
  | "RATE_LIMITED"

export class CreditPurchaseError extends Error {
  public readonly httpStatus: number

  constructor(
    public readonly code: CreditPurchaseErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "CreditPurchaseError"
    this.httpStatus = CODE_TO_STATUS[code] ?? 500
  }
}

const CODE_TO_STATUS: Record<CreditPurchaseErrorCode, number> = {
  INVALID_PACK_SIZE: 400,
  INVALID_PROOF: 400,
  PAYMENT_NOT_CONFIRMED: 402,
  PAYMENT_MISMATCH: 409,
  ALREADY_MINTED: 409,
  VERIFICATION_UNAVAILABLE: 503,
  SENDER_MISMATCH: 403,
  CONFIGURATION_ERROR: 500,
  RATE_LIMITED: 429,
}
