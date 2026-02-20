// src/billing/ledger.ts — Double-Entry Ledger (SDD §3.2, Sprint 1 Task 1.2)
//
// Every WAL event contains a postings[] array that sums to zero (balanced double-entry).
// Posting rules per event type as defined in the SDD.

import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"
import { parseMicroUSD } from "../hounfour/wire-boundary.js"
import type { BillingEntryId, BillingEventType } from "./types.js"
import { getTracer } from "../tracing/otlp.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Posting {
  account: string
  delta: bigint // positive = credit, negative = debit
  denom: "MicroUSD" | "CreditUnit" | "MicroUSDC"
  metadata?: Record<string, string>
}

export interface JournalEntry {
  billing_entry_id: BillingEntryId
  event_type: BillingEventType
  correlation_id: string
  postings: Posting[]
  exchange_rate: number | null // frozen rate at RESERVE
  rounding_direction: "ceil" | "floor" | null
  wal_offset: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// Canonical Account Names
// ---------------------------------------------------------------------------

export function userAvailableAccount(userId: string): string {
  return `user:${userId}:available`
}

export function userHeldAccount(userId: string): string {
  return `user:${userId}:held`
}

export const SYSTEM_REVENUE = "system:revenue"
export const SYSTEM_RESERVES = "system:reserves"
export const TREASURY_USDC_RECEIVED = "treasury:usdc_received"
export const SYSTEM_CREDIT_NOTES = "system:credit_notes"

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export class Ledger {
  private readonly entries: JournalEntry[] = []
  private readonly seenIds = new Set<string>()

  /**
   * Append a journal entry. Enforces zero-sum invariant.
   * Idempotent: replayed entries with same billing_entry_id + event_type produce no effect.
   */
  appendEntry(entry: JournalEntry): void {
    // Idempotency: skip replayed entries
    const dedupeKey = `${entry.billing_entry_id}:${entry.event_type}:${entry.wal_offset}`
    if (this.seenIds.has(dedupeKey)) {
      return
    }

    const tracer = getTracer("x402")
    const span = tracer?.startSpan("x402.ledger", {
      attributes: {
        event_type: entry.event_type,
        posting_count: entry.postings.length,
        billing_entry_id: entry.billing_entry_id,
      },
    })

    try {
      // Zero-sum invariant: SUM(all postings) === 0n
      this.validatePostings(entry.postings)

      this.entries.push(entry)
      this.seenIds.add(dedupeKey)
    } finally {
      span?.end()
    }
  }

  /**
   * Validate that postings sum to zero. Hard error on violation.
   */
  validatePostings(postings: Posting[]): void {
    if (postings.length === 0) {
      throw new LedgerError("Journal entry must have at least one posting")
    }

    const sum = postings.reduce((acc, p) => acc + p.delta, 0n)
    if (sum !== 0n) {
      throw new LedgerError(
        `Zero-sum invariant violated: SUM(postings) = ${sum}, expected 0. ` +
          `Postings: ${postings.map(p => `${p.account}:${p.delta}`).join(", ")}`,
      )
    }
  }

  /**
   * Derive balance for a specific account by summing all posting deltas.
   */
  deriveBalance(account: string): bigint {
    let balance = 0n
    for (const entry of this.entries) {
      for (const posting of entry.postings) {
        if (posting.account === account) {
          balance += posting.delta
        }
      }
    }
    return balance
  }

  /**
   * Derive balances for all accounts.
   */
  deriveAllBalances(): Map<string, bigint> {
    const balances = new Map<string, bigint>()
    for (const entry of this.entries) {
      for (const posting of entry.postings) {
        const current = balances.get(posting.account) ?? 0n
        balances.set(posting.account, current + posting.delta)
      }
    }
    return balances
  }

  /**
   * Get all entries for a specific billing_entry_id.
   */
  getEntriesForBillingEntry(billingEntryId: BillingEntryId): JournalEntry[] {
    return this.entries.filter(e => e.billing_entry_id === billingEntryId)
  }

  /**
   * Get total entry count (for metrics/health).
   */
  get entryCount(): number {
    return this.entries.length
  }
}

// ---------------------------------------------------------------------------
// Posting Rule Factories (SDD §3.2 table)
// ---------------------------------------------------------------------------

/**
 * credit_mint: treasury pays USDC, user receives credits.
 * treasury:usdc_received -amount, user:{id}:available +amount
 */
export function creditMintPostings(userId: string, amount: bigint): Posting[] {
  return [
    { account: TREASURY_USDC_RECEIVED, delta: -amount, denom: "MicroUSD" },
    { account: userAvailableAccount(userId), delta: amount, denom: "MicroUSD" },
  ]
}

/**
 * billing_reserve: hold funds from user available → user held.
 * user:{id}:available -amount, user:{id}:held +amount
 */
export function billingReservePostings(userId: string, amount: bigint): Posting[] {
  return [
    { account: userAvailableAccount(userId), delta: -amount, denom: "MicroUSD" },
    { account: userHeldAccount(userId), delta: amount, denom: "MicroUSD" },
  ]
}

/**
 * billing_commit: move committed cost from held to revenue, return overage.
 * user:{id}:held -estimatedCost, system:revenue +actualCost, user:{id}:available +(estimatedCost - actualCost)
 *
 * If actualCost === estimatedCost, the return-to-available posting is zero and omitted.
 */
export function billingCommitPostings(userId: string, estimatedCost: bigint, actualCost: bigint): Posting[] {
  const overage = estimatedCost - actualCost
  const postings: Posting[] = [
    { account: userHeldAccount(userId), delta: -estimatedCost, denom: "MicroUSD" },
    { account: SYSTEM_REVENUE, delta: actualCost, denom: "MicroUSD" },
  ]

  if (overage > 0n) {
    postings.push({ account: userAvailableAccount(userId), delta: overage, denom: "MicroUSD" })
  } else if (overage < 0n) {
    // Actual cost exceeds estimate — debit extra from available
    postings.push({ account: userAvailableAccount(userId), delta: overage, denom: "MicroUSD" })
  }

  return postings
}

/**
 * billing_release: return held funds to user available.
 * user:{id}:held -amount, user:{id}:available +amount
 */
export function billingReleasePostings(userId: string, amount: bigint): Posting[] {
  return [
    { account: userHeldAccount(userId), delta: -amount, denom: "MicroUSD" },
    { account: userAvailableAccount(userId), delta: amount, denom: "MicroUSD" },
  ]
}

/**
 * billing_void: reverse committed funds from revenue back to user available.
 * system:revenue -amount, user:{id}:available +amount
 */
export function billingVoidPostings(userId: string, amount: bigint): Posting[] {
  return [
    { account: SYSTEM_REVENUE, delta: -amount, denom: "MicroUSD" },
    { account: userAvailableAccount(userId), delta: amount, denom: "MicroUSD" },
  ]
}

/**
 * x402_credit_note: issue credit note for x402 payment.
 * system:credit_notes -amount, user:{id}:available +amount
 */
export function x402CreditNotePostings(userId: string, amount: bigint): Posting[] {
  return [
    { account: SYSTEM_CREDIT_NOTES, delta: -amount, denom: "MicroUSD" },
    { account: userAvailableAccount(userId), delta: amount, denom: "MicroUSD" },
  ]
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class LedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LedgerError"
  }
}
