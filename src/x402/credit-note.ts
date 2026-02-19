// src/x402/credit-note.ts — Off-Chain Credit Notes (Sprint 9 Task 9.2)
//
// Credit notes for x402 overpayment delta.
// Stored in Redis with 7-day TTL.
// Reduces required payment on future x402 requests.
// Double-entry: system:revenue -delta, system:credit_notes +delta

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDIT_NOTE_PREFIX = "x402:credit:"
const CREDIT_NOTE_TTL = 7 * 24 * 3600 // 7 days

// Hard cap on accumulated credit note balance per wallet (1M USDC in base units).
// Well within JS safe integer range (2^53-1 ≈ 9×10^15) and Redis int64 range.
// Enforced atomically in Lua to prevent unbounded accumulation.
const MAX_CREDIT_BALANCE = 1_000_000_000_000 // 1M USDC (6 decimals)

// Lua script: atomically validate cap, increment balance, set expiry.
// Returns new balance on success, "CAP_EXCEEDED" if cap would be breached.
const CREDIT_BALANCE_INCR_SCRIPT = `
  local key = KEYS[1]
  local delta = tonumber(ARGV[1])
  local cap = tonumber(ARGV[2])
  local ttl = tonumber(ARGV[3])
  local current = tonumber(redis.call('GET', key) or '0')
  if current + delta > cap then
    return "CAP_EXCEEDED"
  end
  local new_balance = redis.call('INCRBY', key, delta)
  redis.call('EXPIRE', key, ttl)
  return tostring(new_balance)
`

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
    this.generateId = deps.generateId ?? (() => `cn_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`)
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

    // Validate cap BEFORE storing note to prevent orphaned records
    const balanceKey = `${CREDIT_NOTE_PREFIX}${walletAddress.toLowerCase()}:balance`
    const safeDelta = Number(delta)
    if (!Number.isSafeInteger(safeDelta) || safeDelta <= 0) {
      throw new Error(`CreditNote delta exceeds safe integer range: ${delta}`)
    }

    const result = await this.redis.eval(
      CREDIT_BALANCE_INCR_SCRIPT,
      1,
      balanceKey,
      String(safeDelta), String(MAX_CREDIT_BALANCE), String(CREDIT_NOTE_TTL),
    ) as string

    if (result === "CAP_EXCEEDED") {
      throw new Error(JSON.stringify({
        error: "credit_note_cap_exceeded",
        wallet: walletAddress.toLowerCase(),
        delta: delta.toString(),
        cap: String(MAX_CREDIT_BALANCE),
      }))
    }

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

    // Store note AFTER cap check passes (no orphans on CAP_EXCEEDED)
    const noteKey = `${CREDIT_NOTE_PREFIX}${walletAddress.toLowerCase()}:${note.id}`
    await this.redis.set(noteKey, JSON.stringify(note), "EX", CREDIT_NOTE_TTL)

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
   * Uses an atomic Lua script to prevent double-spend via concurrent requests.
   * Returns the reduced amount and remaining credit balance.
   */
  async applyCreditNotes(
    walletAddress: string,
    requiredAmount: string,
  ): Promise<{ reducedAmount: string; creditUsed: string; remainingCredit: string }> {
    const balanceKey = `${CREDIT_NOTE_PREFIX}${walletAddress.toLowerCase()}:balance`

    // Atomic Lua script: read balance, compute credit used, write new balance
    // Returns [creditUsed, remainingCredit] as strings
    const APPLY_CREDIT_LUA = `
      local balance_str = redis.call('GET', KEYS[1])
      if not balance_str then
        return {'0', '0'}
      end
      local balance = tonumber(balance_str)
      if balance == 0 then
        return {'0', '0'}
      end
      local required = tonumber(ARGV[1])
      local credit_used = math.min(balance, required)
      local remaining = balance - credit_used
      if remaining > 0 then
        redis.call('SET', KEYS[1], tostring(math.floor(remaining)))
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
      else
        redis.call('DEL', KEYS[1])
      end
      return {tostring(math.floor(credit_used)), tostring(math.floor(remaining))}
    `

    const result = await this.redis.eval(
      APPLY_CREDIT_LUA,
      1,
      balanceKey,
      requiredAmount,
      CREDIT_NOTE_TTL,
    ) as [string, string] | null

    if (!result || (result[0] === "0" && result[1] === "0")) {
      return {
        reducedAmount: requiredAmount,
        creditUsed: "0",
        remainingCredit: "0",
      }
    }

    const creditUsed = BigInt(result[0])
    const remainingCredit = BigInt(result[1])
    const reducedAmount = BigInt(requiredAmount) - creditUsed

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
