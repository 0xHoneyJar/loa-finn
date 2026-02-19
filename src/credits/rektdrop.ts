// src/credits/rektdrop.ts — Rektdrop Batch Allocation Engine (SDD §21, Sprint 21 Task 21.2)
//
// Batch allocate credits to a wallet list with tiered amounts.
// Idempotent: re-running for the same wallet is a no-op.
// Creates allocated (locked) credit entries in the credit sub-ledger.

import { CreditSubLedger } from "./rektdrop-ledger.js"
import {
  type CreditAccount,
  type CreditAccountId,
  type AllocationTier,
  AllocationTier as AT,
  TIER_AMOUNTS,
  DEFAULT_CREDIT_TTL_MS,
  RektdropError,
  parseCreditAccountId,
} from "./rektdrop-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RektdropEntry {
  /** Ethereum wallet address */
  wallet: string
  /** Allocation tier */
  tier: AllocationTier
  /** Optional override amount (defaults to tier amount) */
  amount?: bigint
}

export interface RektdropBatchResult {
  /** Total wallets processed in this batch */
  total_processed: number
  /** Newly allocated wallets */
  newly_allocated: number
  /** Wallets that were already allocated (idempotent skip) */
  already_allocated: number
  /** Wallets that failed allocation */
  failed: number
  /** Per-wallet results */
  results: RektdropWalletResult[]
  /** Total credits allocated in this batch */
  total_credits_allocated: bigint
}

export interface RektdropWalletResult {
  wallet: string
  status: "allocated" | "already_exists" | "failed"
  account?: CreditAccount
  error?: string
}

export interface RektdropConfig {
  /** Override default TTL for all allocations in this batch */
  ttlMs?: number
  /** Batch correlation ID */
  batchId?: string
  /** Optional callback on each allocation */
  onAllocated?: (wallet: string, account: CreditAccount) => void
}

// ---------------------------------------------------------------------------
// Rektdrop Allocation Engine
// ---------------------------------------------------------------------------

export class RektdropEngine {
  private readonly ledger: CreditSubLedger

  constructor(ledger: CreditSubLedger) {
    this.ledger = ledger
  }

  /**
   * Allocate credits to a single wallet.
   * Idempotent: if the wallet already has an account, returns the existing one.
   */
  allocate(
    wallet: string,
    tier: AllocationTier,
    amount?: bigint,
    config?: RektdropConfig,
  ): RektdropWalletResult {
    // Validate wallet
    try {
      parseCreditAccountId(wallet)
    } catch {
      return {
        wallet,
        status: "failed",
        error: `Invalid wallet address: ${wallet}`,
      }
    }

    // Validate tier
    if (!Object.values(AT).includes(tier)) {
      return {
        wallet,
        status: "failed",
        error: `Invalid tier: ${tier}`,
      }
    }

    // Validate amount if provided
    const allocationAmount = amount ?? TIER_AMOUNTS[tier]
    if (allocationAmount <= 0n) {
      return {
        wallet,
        status: "failed",
        error: `Invalid amount: ${allocationAmount}`,
      }
    }

    // Check if already allocated (idempotent)
    const existing = this.ledger.getAccount(wallet)
    if (existing) {
      return {
        wallet,
        status: "already_exists",
        account: existing,
      }
    }

    // Create account with allocation
    const batchId = config?.batchId ?? `batch_${Date.now()}`
    const idempotencyKey = `rektdrop_${wallet.toLowerCase()}_${batchId}`

    try {
      const account = this.ledger.createAccount(
        wallet,
        tier,
        allocationAmount,
        config?.ttlMs ?? DEFAULT_CREDIT_TTL_MS,
        idempotencyKey,
      )

      config?.onAllocated?.(wallet, account)

      return {
        wallet,
        status: "allocated",
        account,
      }
    } catch (err) {
      return {
        wallet,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Batch allocate credits to multiple wallets.
   * Idempotent: wallets that already have accounts are skipped.
   * Non-atomic: failures on individual wallets do not roll back others.
   */
  batchAllocate(
    entries: RektdropEntry[],
    config?: RektdropConfig,
  ): RektdropBatchResult {
    const results: RektdropWalletResult[] = []
    let newlyAllocated = 0
    let alreadyAllocated = 0
    let failed = 0
    let totalCreditsAllocated = 0n

    const batchConfig: RektdropConfig = {
      ...config,
      batchId: config?.batchId ?? `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    }

    for (const entry of entries) {
      const result = this.allocate(entry.wallet, entry.tier, entry.amount, batchConfig)
      results.push(result)

      switch (result.status) {
        case "allocated":
          newlyAllocated++
          totalCreditsAllocated += result.account!.initial_allocation
          break
        case "already_exists":
          alreadyAllocated++
          break
        case "failed":
          failed++
          break
      }
    }

    return {
      total_processed: entries.length,
      newly_allocated: newlyAllocated,
      already_allocated: alreadyAllocated,
      failed,
      results,
      total_credits_allocated: totalCreditsAllocated,
    }
  }

  /**
   * Batch allocate by tier: given a list of wallets and a tier,
   * allocate the tier's default amount to each.
   */
  batchAllocateByTier(
    wallets: string[],
    tier: AllocationTier,
    config?: RektdropConfig,
  ): RektdropBatchResult {
    const entries: RektdropEntry[] = wallets.map(wallet => ({ wallet, tier }))
    return this.batchAllocate(entries, config)
  }

  /**
   * Get allocation summary across all accounts.
   */
  getSummary(): RektdropSummary {
    const accounts = this.ledger.getAllAccounts()
    const byTier: Record<AllocationTier, number> = {
      OG: 0,
      CONTRIBUTOR: 0,
      COMMUNITY: 0,
      PARTNER: 0,
    }
    let totalAllocated = 0n
    let totalUnlocked = 0n
    let totalConsumed = 0n
    let totalExpired = 0n

    for (const account of accounts) {
      byTier[account.tier]++
      totalAllocated += account.balances.ALLOCATED
      totalUnlocked += account.balances.UNLOCKED
      totalConsumed += account.balances.CONSUMED
      totalExpired += account.balances.EXPIRED
    }

    return {
      total_accounts: accounts.length,
      by_tier: byTier,
      total_allocated: totalAllocated,
      total_unlocked: totalUnlocked,
      total_consumed: totalConsumed,
      total_expired: totalExpired,
      conservation_valid: this.ledger.verifyAllConservation().valid,
    }
  }

  /**
   * Access the underlying ledger (for composition with unlock flow).
   */
  getLedger(): CreditSubLedger {
    return this.ledger
  }
}

// ---------------------------------------------------------------------------
// Summary Type
// ---------------------------------------------------------------------------

export interface RektdropSummary {
  total_accounts: number
  by_tier: Record<AllocationTier, number>
  total_allocated: bigint
  total_unlocked: bigint
  total_consumed: bigint
  total_expired: bigint
  conservation_valid: boolean
}
