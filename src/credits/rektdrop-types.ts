// src/credits/rektdrop-types.ts — Rektdrop Credit System Types (SDD §21, Sprint 21 Task 21.1)
//
// CreditAccount, CreditState, CreditTransaction types.
// Double-entry: every state transition is a debit+credit pair.
// Conservation invariant: sum(all states) = initial_allocation.

// ---------------------------------------------------------------------------
// Credit State
// ---------------------------------------------------------------------------

export const CreditState = {
  ALLOCATED: "ALLOCATED",
  UNLOCKED: "UNLOCKED",
  RESERVED: "RESERVED",
  CONSUMED: "CONSUMED",
  EXPIRED: "EXPIRED",
} as const

export type CreditState = (typeof CreditState)[keyof typeof CreditState]

// ---------------------------------------------------------------------------
// Valid State Transitions (adjacency list)
// ---------------------------------------------------------------------------

export const VALID_CREDIT_TRANSITIONS: Record<CreditState, readonly CreditState[]> = {
  ALLOCATED: [CreditState.UNLOCKED, CreditState.EXPIRED],
  UNLOCKED: [CreditState.RESERVED, CreditState.EXPIRED],
  RESERVED: [CreditState.CONSUMED, CreditState.UNLOCKED],
  CONSUMED: [], // terminal
  EXPIRED: [], // terminal
}

// ---------------------------------------------------------------------------
// Credit Account ID — branded string
// ---------------------------------------------------------------------------

declare const _creditAccountIdBrand: unique symbol
export type CreditAccountId = string & { readonly [_creditAccountIdBrand]: true }

const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

export function parseCreditAccountId(raw: string): CreditAccountId {
  if (typeof raw !== "string" || !ETH_ADDRESS_PATTERN.test(raw)) {
    throw new CreditStateError(
      "ALLOCATED" as CreditState,
      "parse_credit_account_id",
      `Invalid CreditAccountId: "${raw}" — must be a valid Ethereum address`,
    )
  }
  return raw.toLowerCase() as CreditAccountId
}

// ---------------------------------------------------------------------------
// Credit Transaction ID — branded string
// ---------------------------------------------------------------------------

declare const _creditTxIdBrand: unique symbol
export type CreditTransactionId = string & { readonly [_creditTxIdBrand]: true }

let _txCounter = 0

export function generateCreditTransactionId(): CreditTransactionId {
  _txCounter++
  const ts = Date.now().toString(36)
  const counter = _txCounter.toString(36).padStart(6, "0")
  const rand = Math.random().toString(36).slice(2, 8)
  return `ctx_${ts}_${counter}_${rand}` as CreditTransactionId
}

/** Reset counter — only for testing */
export function _resetTxCounter(): void {
  _txCounter = 0
}

// ---------------------------------------------------------------------------
// Credit Account
// ---------------------------------------------------------------------------

export interface CreditAccount {
  account_id: CreditAccountId
  /** Total credits initially allocated (immutable after creation) */
  initial_allocation: bigint
  /** Balances per state — conservation: sum(balances) = initial_allocation */
  balances: Record<CreditState, bigint>
  /** Allocation tier */
  tier: AllocationTier
  /** TTL: credits expire after this timestamp (Unix ms) */
  expires_at: number
  /** When the account was created */
  created_at: number
  /** Last modification timestamp */
  updated_at: number
}

// ---------------------------------------------------------------------------
// Credit Transaction (journal entry for state transitions)
// ---------------------------------------------------------------------------

export interface CreditTransaction {
  tx_id: CreditTransactionId
  account_id: CreditAccountId
  /** Event that triggered this transaction */
  event_type: CreditEventType
  /** Debit side: state losing credits */
  debit_state: CreditState
  /** Credit side: state receiving credits */
  credit_state: CreditState
  /** Amount transferred */
  amount: bigint
  /** Correlation ID for linking related transactions */
  correlation_id: string
  /** Idempotency key to prevent duplicate processing */
  idempotency_key: string
  /** Extra metadata */
  metadata?: Record<string, string>
  /** When the transaction occurred */
  timestamp: number
}

// ---------------------------------------------------------------------------
// Credit Event Types
// ---------------------------------------------------------------------------

export const CREDIT_EVENT_TYPES = [
  "rektdrop_allocate",
  "usdc_unlock",
  "credit_reserve",
  "credit_consume",
  "credit_release",
  "credit_expire",
] as const

export type CreditEventType = (typeof CREDIT_EVENT_TYPES)[number]

// ---------------------------------------------------------------------------
// Allocation Tiers
// ---------------------------------------------------------------------------

export const AllocationTier = {
  OG: "OG",
  CONTRIBUTOR: "CONTRIBUTOR",
  COMMUNITY: "COMMUNITY",
  PARTNER: "PARTNER",
} as const

export type AllocationTier = (typeof AllocationTier)[keyof typeof AllocationTier]

export const TIER_AMOUNTS: Record<AllocationTier, bigint> = {
  OG: 10_000n,
  CONTRIBUTOR: 5_000n,
  COMMUNITY: 1_000n,
  PARTNER: 25_000n,
}

// ---------------------------------------------------------------------------
// Default TTL (90 days in milliseconds)
// ---------------------------------------------------------------------------

export const DEFAULT_CREDIT_TTL_MS = 90 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Unlock Request (USDC-backed unlock)
// ---------------------------------------------------------------------------

export interface UnlockRequest {
  /** Wallet address receiving unlock */
  wallet: string
  /** Amount to unlock */
  amount: bigint
  /** EIP-3009 authorization fields */
  authorization: EIP3009UnlockAuth
  /** Idempotency key */
  idempotency_key: string
}

export interface EIP3009UnlockAuth {
  from: string
  to: string
  value: string
  valid_after: number
  valid_before: number
  nonce: string
  v: number
  r: string
  s: string
}

export interface UnlockResult {
  tx_id: string
  account_id: string
  unlocked_amount: bigint
  remaining_allocated: bigint
  remaining_unlocked: bigint
  status: "unlocked"
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class CreditStateError extends Error {
  constructor(
    public readonly currentState: CreditState,
    public readonly attemptedTransition: string,
    message?: string,
  ) {
    super(
      message ??
        `Invalid credit state transition: cannot ${attemptedTransition} from ${currentState}`,
    )
    this.name = "CreditStateError"
  }
}

export class CreditLedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CreditLedgerError"
  }
}

export class RektdropError extends Error {
  public readonly httpStatus: number

  constructor(
    public readonly code: RektdropErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "RektdropError"
    this.httpStatus = REKTDROP_CODE_TO_STATUS[code] ?? 500
  }
}

export type RektdropErrorCode =
  | "ALREADY_ALLOCATED"
  | "INVALID_WALLET"
  | "INVALID_TIER"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_ALLOCATED"
  | "ALREADY_UNLOCKED"
  | "UNLOCK_VERIFICATION_FAILED"
  | "NONCE_REPLAY"
  | "AUTHORIZATION_EXPIRED"
  | "CONSERVATION_VIOLATION"

const REKTDROP_CODE_TO_STATUS: Record<RektdropErrorCode, number> = {
  ALREADY_ALLOCATED: 409,
  INVALID_WALLET: 400,
  INVALID_TIER: 400,
  INVALID_AMOUNT: 400,
  INSUFFICIENT_ALLOCATED: 409,
  ALREADY_UNLOCKED: 409,
  UNLOCK_VERIFICATION_FAILED: 402,
  NONCE_REPLAY: 409,
  AUTHORIZATION_EXPIRED: 400,
  CONSERVATION_VIOLATION: 500,
}
