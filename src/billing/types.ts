// src/billing/types.ts — Billing State Machine Core Types (SDD §6.3, Sprint 1 Task 1.1)
//
// WAL-authoritative commit model: finn WAL is the authoritative commit record;
// arrakis finalize is async side-effect via DLQ.

import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"

// ---------------------------------------------------------------------------
// Billing State
// ---------------------------------------------------------------------------

export const BillingState = {
  IDLE: "IDLE",
  RESERVE_HELD: "RESERVE_HELD",
  COMMITTED: "COMMITTED",
  FINALIZE_PENDING: "FINALIZE_PENDING",
  FINALIZE_ACKED: "FINALIZE_ACKED",
  FINALIZE_FAILED: "FINALIZE_FAILED",
  RELEASED: "RELEASED",
  VOIDED: "VOIDED",
} as const

export type BillingState = (typeof BillingState)[keyof typeof BillingState]

// ---------------------------------------------------------------------------
// Billing Entry ID — branded ULID
// ---------------------------------------------------------------------------

declare const _billingEntryIdBrand: unique symbol
export type BillingEntryId = string & { readonly [_billingEntryIdBrand]: true }

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function parseBillingEntryId(raw: string): BillingEntryId {
  if (typeof raw !== "string" || !ULID_PATTERN.test(raw)) {
    throw new BillingStateError(
      "IDLE" as BillingState,
      "parse_billing_entry_id",
      `Invalid BillingEntryId: "${raw}" — must be a valid ULID`,
    )
  }
  return raw as BillingEntryId
}

// ---------------------------------------------------------------------------
// WAL Envelope (Flatline IMP-002: schema versioning)
// ---------------------------------------------------------------------------

/** Current billing WAL schema version. Increment on breaking changes. */
export const BILLING_WAL_SCHEMA_VERSION = 1

/** Known billing event types for strict parsing. */
export const BILLING_EVENT_TYPES = [
  "billing_reserve",
  "billing_commit",
  "billing_release",
  "billing_void",
  "billing_finalize_ack",
  "billing_finalize_fail",
  "billing_reserve_expired",
  "billing_reconciliation",
  "credit_mint",
  "credit_deduct",
  "x402_credit_note",
  "request_start",
  "request_complete",
] as const

export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number]

/**
 * WAL envelope wrapping every billing record (Flatline IMP-002).
 * Replay engine uses strict parsing for known versions,
 * lenient skip for unknown event types (forward compat).
 */
export interface BillingWALEnvelope<T = unknown> {
  schema_version: number
  event_type: BillingEventType | string // string for forward compat
  timestamp: number // Unix milliseconds
  billing_entry_id: BillingEntryId
  correlation_id: string
  checksum: string // CRC32 of JSON.stringify(payload)
  payload: T
}

// ---------------------------------------------------------------------------
// Billing Entry — mutable state per billing_entry_id
// ---------------------------------------------------------------------------

export interface BillingEntry {
  billing_entry_id: BillingEntryId
  correlation_id: string
  state: BillingState
  account_id: string
  estimated_cost: MicroUSD
  actual_cost: MicroUSD | null
  exchange_rate_snapshot: ExchangeRateSnapshot | null
  created_at: number // Unix ms
  updated_at: number // Unix ms
  wal_offset: string // ULID of the latest WAL entry for this billing entry
  finalize_attempts: number
}

// ---------------------------------------------------------------------------
// Exchange Rate Snapshot (frozen at RESERVE time)
// ---------------------------------------------------------------------------

export interface ExchangeRateSnapshot {
  credit_units_per_usd: number // e.g. 100 (100 CU = $1)
  usd_usdc_rate: number // e.g. 1.0 (1 USD = 1 USDC)
  frozen_at: number // Unix ms
}

// ---------------------------------------------------------------------------
// State Transition Events (WAL payloads)
// ---------------------------------------------------------------------------

export interface BillingReservePayload {
  account_id: string
  estimated_cost: string // serialized MicroUSD
  exchange_rate_snapshot: ExchangeRateSnapshot
}

export interface BillingCommitPayload {
  actual_cost: string // serialized MicroUSD
}

export interface BillingReleasePayload {
  reason: "pre_stream_failure" | "reserve_expired" | "user_cancel"
}

export interface BillingVoidPayload {
  reason: string
  admin_id?: string
}

export interface BillingFinalizeAckPayload {
  arrakis_response_status: number
}

export interface BillingFinalizeFailPayload {
  attempt: number
  reason: string
}

// ---------------------------------------------------------------------------
// State Transition Error
// ---------------------------------------------------------------------------

export class BillingStateError extends Error {
  constructor(
    public readonly currentState: BillingState,
    public readonly attemptedTransition: string,
    message?: string,
  ) {
    super(
      message ??
        `Invalid billing state transition: cannot ${attemptedTransition} from ${currentState}`,
    )
    this.name = "BillingStateError"
  }
}

// ---------------------------------------------------------------------------
// Valid State Transitions (adjacency list)
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<BillingState, readonly BillingState[]> = {
  IDLE: [BillingState.RESERVE_HELD],
  RESERVE_HELD: [BillingState.COMMITTED, BillingState.RELEASED],
  COMMITTED: [BillingState.FINALIZE_PENDING, BillingState.VOIDED],
  FINALIZE_PENDING: [BillingState.FINALIZE_ACKED, BillingState.FINALIZE_FAILED],
  FINALIZE_ACKED: [], // terminal
  FINALIZE_FAILED: [BillingState.FINALIZE_ACKED, BillingState.VOIDED], // admin replay or void
  RELEASED: [], // terminal
  VOIDED: [], // terminal
}
