// src/x402/types.ts — x402 Payment Types (Sprint 8 Task 8.1)
//
// EIP-3009 transferWithAuthorization types.
// Quote, PaymentProof, Settlement result types.

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export interface X402Quote {
  /** Maximum cost in MicroUSDC (ceil rounded) */
  max_cost: string
  /** Maximum tokens for this inference */
  max_tokens: number
  /** Model ID */
  model: string
  /** Treasury address to receive payment */
  payment_address: string
  /** Chain ID (8453 = Base) */
  chain_id: number
  /** Quote validity deadline (Unix timestamp) */
  valid_until: number
  /** USDC token contract address on Base */
  token_address: string
  /** Quote ID for correlation */
  quote_id: string
}

// ---------------------------------------------------------------------------
// EIP-3009 Payment Proof
// ---------------------------------------------------------------------------

export interface EIP3009Authorization {
  /** Payer address */
  from: string
  /** Treasury address */
  to: string
  /** USDC amount in base units (6 decimals) */
  value: string
  /** EIP-3009 validAfter */
  valid_after: number
  /** EIP-3009 validBefore */
  valid_before: number
  /** Unique nonce */
  nonce: string
  /** ECDSA v */
  v: number
  /** ECDSA r */
  r: string
  /** ECDSA s */
  s: string
}

export interface PaymentProof {
  /** Quote this payment fulfills */
  quote_id: string
  /** EIP-3009 authorization */
  authorization: EIP3009Authorization
  /** Chain ID */
  chain_id: number
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface SettlementResult {
  /** On-chain transaction hash */
  tx_hash: string
  /** Block number */
  block_number: number
  /** Number of confirmations */
  confirmation_count: number
  /** Settlement method used */
  method: "facilitator" | "direct"
  /** Amount settled in MicroUSDC */
  amount: string
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export interface X402Receipt {
  /** Quote that was fulfilled */
  quote_id: string
  /** Settlement details */
  settlement: SettlementResult
  /** Canonical payment ID (keccak256 binding) */
  payment_id: string
  /** Timestamp */
  timestamp: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class X402Error extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = "X402Error"
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base chain ID */
export const BASE_CHAIN_ID = 8453

/** USDC on Base */
export const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

/** Quote validity TTL (5 minutes) */
export const QUOTE_TTL_SECONDS = 300

/** Quote cache TTL in Redis (60 seconds) */
export const QUOTE_CACHE_TTL_SECONDS = 60

/** Max tokens cap per model */
export const DEFAULT_MAX_TOKENS: Record<string, number> = {
  "claude-opus-4-6": 4096,
  "claude-sonnet-4-6": 4096,
  "claude-haiku-4-5": 8192,
}

/** Rate limit: requests per hour per wallet */
export const X402_RATE_LIMIT_PER_HOUR = 100
