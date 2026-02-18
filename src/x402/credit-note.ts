// src/x402/credit-note.ts — Off-Chain Credit Notes (Sprint 9 Task 9.2)
//
// Credit notes for x402 overpayment delta.
// Stored in Redis with 7-day TTL.
// Reduces required payment on future x402 requests.
// Double-entry: system:revenue -delta, system:credit_notes +delta

import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDIT_NOTE_PREFIX = "x402:credit:"
const CREDIT_NOTE_TTL = 7 * 24 * 3600 // 7 days

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreditNote {
  id: string
  wallet_address: string
  amount: string // MicroUSDC
  quote_id: string
  quoted_amount: string
  actual_amount: string
  created_at: number
  expires_at: number
}

export interface CreditNoteBalance {
  wallet_address: string
  balance: string // Total available credit in MicroUSDC
  notes: CreditNote[]
}

export interface CreditNoteDeps {
  redis: RedisCommandClient
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
  generateId?: () => string
}

// ---------------------------------------------------------------------------
// Credit Note Service
// ---------------------------------------------------------------------------

export class CreditNoteService {
  private readonly redis: RedisCommandClient
  private readonly walAppend: CreditNoteDeps["walAppend"]
  private readonly generateId: () => string

  constructor(deps: CreditNoteDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend
    this.generateId = deps.generateId ?? (() => `cn_${Date.now().toString(36)}`)
  }

  /**
   * Issue a credit note for overpayment.
   * Only issues if actual_cost < quoted_max_cost.
   */
  async issueCreditNote(
    walletAddress: string,
    quoteId: string,
    quotedAmount: string,
    actualAmount: string,
  ): Promise<CreditNote | null> {
    const quoted = BigInt(quotedAmount)
    const actual = BigInt(actualAmount)

    if (actual >= quoted) {
      return null // No overpayment
    }

    const delta = quoted - actual
    const now = Date.now()
    const expiresAt = now + CREDIT_NOTE_TTL * 1000

    const note: CreditNote = {
      id: this.generateId(),
      wallet_address: walletAddress.toLowerCase(),
      amount: delta.toString(),
      quote_id: quoteId,
      quoted_amount: quotedAmount,
      actual_amount: actualAmount,
      created_at: now,
      expires_at: expiresAt,
    }

    // Store note
    const noteKey = `${CREDIT_NOTE_PREFIX}${walletAddress.toLowerCase()}:${note.id}`
    await this.redis.set(noteKey, JSON.stringify(note))
    await this.redis.expire(noteKey, CREDIT_NOTE_TTL)

    // Update balance
    const balanceKey = `${CREDIT_NOTE_PREFIX}${walletAddress.toLowerCase()}:balance`
    const currentBalance = BigInt(await this.redis.get(balanceKey) ?? "0")
    const newBalance = currentBalance + delta
    await this.redis.set(balanceKey, newBalance.toString())
    await this.redis.expire(balanceKey, CREDIT_NOTE_TTL)

    // WAL audit — double-entry
    this.writeAudit("x402_credit_note", {
      credit_note_id: note.id,
      wallet: walletAddress.toLowerCase(),
      delta: delta.toString(),
      quote_id: quoteId,
      postings: [
        { account: "system:revenue", delta: `-${delta}` },
        { account: "system:credit_notes", delta: `+${delta}` },
      ],
    })

    return note
  }

  /**
   * Get available credit balance for a wallet.
   */
  async getBalance(walletAddress: string): Promise<string> {
    const key = `${CREDIT_NOTE_PREFIX}${walletAddress.toLowerCase()}:balance`
    return (await this.redis.get(key)) ?? "0"
  }

  /**
   * Apply credit notes to reduce required payment amount.
   * Returns the reduced amount and remaining credit balance.
   */
  async applyCreditNotes(
    walletAddress: string,
    requiredAmount: string,
  ): Promise<{ reducedAmount: string; creditUsed: string; remainingCredit: string }> {
    const required = BigInt(requiredAmount)
    const balance = BigInt(await this.getBalance(walletAddress))

    if (balance === 0n) {
      return {
        reducedAmount: requiredAmount,
        creditUsed: "0",
        remainingCredit: "0",
      }
    }

    const creditUsed = balance > required ? required : balance
    const reducedAmount = required - creditUsed
    const remainingCredit = balance - creditUsed

    // Update balance
    const balanceKey = `${CREDIT_NOTE_PREFIX}${walletAddress.toLowerCase()}:balance`
    await this.redis.set(balanceKey, remainingCredit.toString())
    if (remainingCredit > 0n) {
      await this.redis.expire(balanceKey, CREDIT_NOTE_TTL)
    }

    return {
      reducedAmount: reducedAmount.toString(),
      creditUsed: creditUsed.toString(),
      remainingCredit: remainingCredit.toString(),
    }
  }

  private writeAudit(operation: string, payload: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("x402", operation, "x402", { ...payload, timestamp: Date.now() })
    } catch {
      // Best-effort
    }
  }
}
