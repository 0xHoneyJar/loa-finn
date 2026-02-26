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
// Chain Configuration (cycle-035 T-4.1)
// ---------------------------------------------------------------------------

/** Known chain configurations for x402 settlement */
export interface ChainConfig {
  chainId: number
  name: string
  usdcAddress: string
  /** Whether this is a testnet */
  testnet: boolean
}

/** CHAIN_CONFIGS lookup table — same code runs on Sepolia (84532) and mainnet (8453) */
export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  8453: {
    chainId: 8453,
    name: "Base",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    testnet: false,
  },
  84532: {
    chainId: 84532,
    name: "Base Sepolia",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    testnet: true,
  },
}

/**
 * Resolve active chain config from environment.
 *
 * Resolution order:
 * 1. X402_CHAIN_ID env var → lookup in CHAIN_CONFIGS
 * 2. Default: Base mainnet (8453)
 *
 * X402_USDC_ADDRESS env var overrides USDC address for custom deployments.
 */
export function resolveChainConfig(): ChainConfig {
  const envChainId = process.env.X402_CHAIN_ID
  const chainId = envChainId ? parseInt(envChainId, 10) : 8453

  const config = CHAIN_CONFIGS[chainId]
  if (!config) {
    throw new Error(`Unknown chain ID ${chainId}. Known chains: ${Object.keys(CHAIN_CONFIGS).join(", ")}`)
  }

  // Allow USDC address override for custom deployments
  const usdcOverride = process.env.X402_USDC_ADDRESS
  if (usdcOverride) {
    return { ...config, usdcAddress: usdcOverride }
  }

  return config
}

// ---------------------------------------------------------------------------
// Constants (backward compat — resolved from chain config)
// ---------------------------------------------------------------------------

/** Base chain ID (default, overridable via X402_CHAIN_ID env var) */
export const BASE_CHAIN_ID = 8453

/** USDC on Base (default, overridable via X402_USDC_ADDRESS env var) */
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
