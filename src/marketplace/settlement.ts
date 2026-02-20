// src/marketplace/settlement.ts — Escrow settlement engine (Sprint 24, Task 24.1)
//
// Handles the full settlement lifecycle:
// 1. Lock seller credits into escrow when an ask is placed
// 2. On match: transfer USDC from buyer, credits from escrow to buyer, deduct fee
// 3. On failure: release credits from escrow back to seller
// 4. Conservation invariant: total credits + escrowed credits = constant
//
// All operations are idempotent — settling the same match twice is a no-op.

import { randomUUID } from "node:crypto"
import type {
  Order,
  Match,
  EscrowRecord,
  SettlementResult,
  WalletBalance,
} from "./types.js"
import { DEFAULT_LOT_SIZE, FEE_RATE } from "./types.js"
import type { MarketplaceStorage } from "./storage.js"

// ── Settlement Error ─────────────────────────────────────────

export class SettlementError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INSUFFICIENT_CREDITS"
      | "INSUFFICIENT_USDC"
      | "ESCROW_NOT_FOUND"
      | "ESCROW_INSUFFICIENT"
      | "ALREADY_SETTLED"
      | "INVARIANT_VIOLATION",
  ) {
    super(message)
    this.name = "SettlementError"
  }
}

// ── Settlement Engine ────────────────────────────────────────

export class SettlementEngine {
  private readonly storage: MarketplaceStorage
  private readonly clock: () => number

  /** Track settled match IDs for idempotency */
  private readonly settledMatches: Map<string, SettlementResult> = new Map()

  constructor(storage: MarketplaceStorage, clock: () => number = Date.now) {
    this.storage = storage
    this.clock = clock
  }

  // ── Escrow Locking ─────────────────────────────────────────

  /**
   * Lock seller credits into escrow when placing an ask order.
   * Deducts credits from the seller's available balance and creates
   * an EscrowRecord.
   *
   * @returns The created EscrowRecord
   * @throws SettlementError if insufficient credits
   */
  lockCredits(order: Order): EscrowRecord {
    if (order.side !== "ask") {
      throw new SettlementError(
        "Only ask orders require escrow",
        "INVARIANT_VIOLATION",
      )
    }

    const creditsRequired = order.lots * DEFAULT_LOT_SIZE
    const balance = this.storage.getBalance(order.wallet)

    if (balance.credits < creditsRequired) {
      throw new SettlementError(
        `Insufficient credits: need ${creditsRequired}, have ${balance.credits}`,
        "INSUFFICIENT_CREDITS",
      )
    }

    // Deduct credits from available balance
    balance.credits -= creditsRequired
    this.storage.setBalance(order.wallet, balance)

    // Create escrow record
    const now = this.clock()
    const escrow: EscrowRecord = {
      id: randomUUID(),
      orderId: order.id,
      wallet: order.wallet,
      creditsLocked: creditsRequired,
      creditsRemaining: creditsRequired,
      status: "locked",
      createdAt: now,
      updatedAt: now,
    }

    this.storage.putEscrow(escrow)
    return escrow
  }

  // ── Settlement ─────────────────────────────────────────────

  /**
   * Settle a match: transfer credits from escrow to buyer,
   * USDC from buyer to seller (minus fee).
   *
   * Idempotent: returns the cached result if the match was already settled.
   *
   * @throws SettlementError on failure (escrow not found, insufficient USDC, etc.)
   */
  settle(match: Match): SettlementResult {
    // Idempotency check
    const existing = this.settledMatches.get(match.id)
    if (existing) return existing

    const { settlement } = match
    const now = this.clock()

    // 1. Find and validate escrow
    const escrow = this.storage.getEscrow(settlement.escrowId)
      ?? this.storage.getEscrowByOrderId(match.askOrderId)

    if (!escrow) {
      throw new SettlementError(
        `Escrow not found for match ${match.id}`,
        "ESCROW_NOT_FOUND",
      )
    }

    if (escrow.creditsRemaining < settlement.creditsToTransfer) {
      throw new SettlementError(
        `Escrow insufficient: need ${settlement.creditsToTransfer}, have ${escrow.creditsRemaining}`,
        "ESCROW_INSUFFICIENT",
      )
    }

    // 2. Validate buyer has sufficient USDC
    const buyerBalance = this.storage.getBalance(match.buyerWallet)
    if (buyerBalance.usdcMicro < match.totalMicro) {
      throw new SettlementError(
        `Buyer insufficient USDC: need ${match.totalMicro}, have ${buyerBalance.usdcMicro}`,
        "INSUFFICIENT_USDC",
      )
    }

    // 3. Execute transfers atomically (single-threaded JS = atomic)

    // Deduct USDC from buyer
    buyerBalance.usdcMicro -= match.totalMicro
    // Credit credits to buyer
    buyerBalance.credits += settlement.creditsToTransfer
    this.storage.setBalance(match.buyerWallet, buyerBalance)

    // Credit USDC to seller (minus fee)
    const sellerBalance = this.storage.getBalance(match.sellerWallet)
    sellerBalance.usdcMicro += settlement.usdcToSeller
    this.storage.setBalance(match.sellerWallet, sellerBalance)

    // 4. Update escrow
    escrow.creditsRemaining -= settlement.creditsToTransfer
    escrow.updatedAt = now
    if (escrow.creditsRemaining === 0) {
      escrow.status = "settled"
    }
    this.storage.updateEscrow(escrow)

    // 5. Record result
    const result: SettlementResult = {
      matchId: match.id,
      status: "success",
      creditsTransferred: settlement.creditsToTransfer,
      usdcTransferred: settlement.usdcToSeller,
      feeCollected: settlement.usdcFee,
      settledAt: now,
    }

    this.settledMatches.set(match.id, result)
    return result
  }

  // ── Escrow Release ─────────────────────────────────────────

  /**
   * Release credits from escrow back to the seller.
   * Used when an ask order is cancelled or expires.
   *
   * @returns The number of credits released
   */
  releaseEscrow(orderId: string): number {
    const escrow = this.storage.getEscrowByOrderId(orderId)
    if (!escrow || escrow.status !== "locked") return 0

    const creditsToRelease = escrow.creditsRemaining
    if (creditsToRelease === 0) return 0

    // Return credits to seller
    const balance = this.storage.getBalance(escrow.wallet)
    balance.credits += creditsToRelease
    this.storage.setBalance(escrow.wallet, balance)

    // Update escrow
    escrow.creditsRemaining = 0
    escrow.status = "released"
    escrow.updatedAt = this.clock()
    this.storage.updateEscrow(escrow)

    return creditsToRelease
  }

  // ── Rollback ───────────────────────────────────────────────

  /**
   * Roll back a failed settlement. Restores escrow credits and
   * buyer/seller balances to pre-settlement state.
   *
   * Only applicable if the match has not been successfully settled.
   */
  rollback(match: Match): SettlementResult {
    const existing = this.settledMatches.get(match.id)
    if (existing && existing.status === "success") {
      // Reverse the settlement
      const { settlement } = match

      // Restore buyer USDC
      const buyerBalance = this.storage.getBalance(match.buyerWallet)
      buyerBalance.usdcMicro += match.totalMicro
      buyerBalance.credits -= settlement.creditsToTransfer
      this.storage.setBalance(match.buyerWallet, buyerBalance)

      // Restore seller USDC deduction
      const sellerBalance = this.storage.getBalance(match.sellerWallet)
      sellerBalance.usdcMicro -= settlement.usdcToSeller
      this.storage.setBalance(match.sellerWallet, sellerBalance)

      // Restore escrow
      const escrow = this.storage.getEscrow(settlement.escrowId)
        ?? this.storage.getEscrowByOrderId(match.askOrderId)
      if (escrow) {
        escrow.creditsRemaining += settlement.creditsToTransfer
        escrow.status = "locked"
        escrow.updatedAt = this.clock()
        this.storage.updateEscrow(escrow)
      }

      const result: SettlementResult = {
        matchId: match.id,
        status: "rolled_back",
        creditsTransferred: 0,
        usdcTransferred: 0,
        feeCollected: 0,
        settledAt: this.clock(),
      }

      this.settledMatches.set(match.id, result)
      return result
    }

    // Nothing to roll back
    return {
      matchId: match.id,
      status: "rolled_back",
      creditsTransferred: 0,
      usdcTransferred: 0,
      feeCollected: 0,
      settledAt: this.clock(),
    }
  }

  // ── Conservation Check ─────────────────────────────────────

  /**
   * Verify the conservation invariant across all wallets.
   * The total of (available credits + escrowed credits) should equal
   * the expected total supply.
   */
  verifyConservation(expectedTotalCredits: number): {
    valid: boolean
    totalAvailable: number
    totalEscrowed: number
    actual: number
    expected: number
  } {
    let totalAvailable = 0
    let totalEscrowed = 0

    // Sum all wallet available credits
    // We need to iterate all known wallets — use a set approach
    const wallets = new Set<string>()
    // Gather wallet addresses from escrow records
    for (let i = 0; i < this.storage.escrowCount; i++) {
      // We'll use getBalance which tracks all wallets we've touched
    }

    // Since MarketplaceStorage doesn't expose wallet iteration directly,
    // we track through escrow and order data
    // For a proper implementation, we'd iterate the balance map.
    // Use the internal balance map via a conservation-check method.

    // Sum available credits from all balances we can observe
    // This is a simplified check — in production you'd have proper wallet enumeration
    return this.computeConservation(expectedTotalCredits)
  }

  /** Internal conservation computation. */
  private computeConservation(expectedTotalCredits: number): {
    valid: boolean
    totalAvailable: number
    totalEscrowed: number
    actual: number
    expected: number
  } {
    // Access internal maps for conservation check
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const balances = (this.storage as any).balances as Map<string, WalletBalance>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const escrows = (this.storage as any).escrows as Map<string, EscrowRecord>

    let totalAvailable = 0
    for (const bal of balances.values()) {
      totalAvailable += bal.credits
    }

    let totalEscrowed = 0
    for (const esc of escrows.values()) {
      if (esc.status === "locked") {
        totalEscrowed += esc.creditsRemaining
      }
    }

    const actual = totalAvailable + totalEscrowed
    return {
      valid: actual === expectedTotalCredits,
      totalAvailable,
      totalEscrowed,
      actual,
      expected: expectedTotalCredits,
    }
  }

  /** Check if a match has been settled. */
  isSettled(matchId: string): boolean {
    const result = this.settledMatches.get(matchId)
    return result?.status === "success"
  }

  /** Get settlement result for a match. */
  getSettlementResult(matchId: string): SettlementResult | undefined {
    return this.settledMatches.get(matchId)
  }
}
