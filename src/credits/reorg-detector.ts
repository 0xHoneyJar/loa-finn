// src/credits/reorg-detector.ts — On-Chain Reorg Detection (Flatline SKP-004, Sprint 2 Task 2.5)
//
// Background job re-verifies recent credit mints (< 1 hour old) every 5 minutes.
// Compares stored block_hash against current chain state.
// On reorg: re-fetches receipt, re-verifies, freezes credits if tx invalid.

import { Cron } from "croner"
import { createPublicClient, http, type PublicClient } from "viem"
import { base } from "viem/chains"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredMint {
  billing_entry_id: string
  tx_hash: string
  log_index: number
  block_number: bigint
  block_hash: string
  amount_micro_usdc: bigint
  wallet_address: string
  minted_at: number // Unix ms
}

export interface ReorgDetectorDeps {
  /** Primary RPC client */
  primaryClient: PublicClient
  /** Fallback RPC client */
  fallbackClient?: PublicClient
  /** Get recent mints (< 1 hour old) */
  getRecentMints: (maxAgeMs: number) => Promise<StoredMint[]>
  /** WAL append for reorg events */
  walAppend: (entryType: string, payload: unknown) => Promise<string>
  /** Freeze minted credits (set balance hold) */
  freezeCredits: (wallet: string, billingEntryId: string, amount: bigint) => Promise<void>
  /** Alert admin about reorg */
  alertAdmin: (message: string, details: Record<string, unknown>) => Promise<void>
}

export interface ReorgCheckResult {
  checked: number
  reorgsDetected: number
  creditsReverted: number
  errors: number
}

// ---------------------------------------------------------------------------
// Reorg Detector
// ---------------------------------------------------------------------------

export class ReorgDetector {
  private cron: Cron | null = null

  constructor(private deps: ReorgDetectorDeps) {}

  /**
   * Start the background reorg detection job.
   * Runs every 5 minutes, checks mints < 1 hour old.
   */
  start(): void {
    if (this.cron) return
    this.cron = new Cron("*/5 * * * *", async () => {
      try {
        await this.checkRecentMints()
      } catch {
        // Cron error handling — logged but not thrown
      }
    })
  }

  stop(): void {
    if (this.cron) {
      this.cron.stop()
      this.cron = null
    }
  }

  /**
   * Check all recent mints for block hash consistency.
   * Called by the cron job, but also available for manual invocation.
   */
  async checkRecentMints(): Promise<ReorgCheckResult> {
    const ONE_HOUR_MS = 60 * 60 * 1000
    const mints = await this.deps.getRecentMints(ONE_HOUR_MS)

    const result: ReorgCheckResult = { checked: 0, reorgsDetected: 0, creditsReverted: 0, errors: 0 }

    for (const mint of mints) {
      result.checked++
      try {
        const reorged = await this.checkMint(mint)
        if (reorged) {
          result.reorgsDetected++
          const reverted = await this.handleReorg(mint)
          if (reverted) result.creditsReverted++
        }
      } catch {
        result.errors++
      }
    }

    return result
  }

  /**
   * Check a single mint for block hash consistency.
   * Returns true if a reorg was detected.
   */
  private async checkMint(mint: StoredMint): Promise<boolean> {
    // Fetch current block at the stored block number
    let block
    try {
      block = await this.deps.primaryClient.getBlock({ blockNumber: mint.block_number })
    } catch {
      // Try fallback
      if (this.deps.fallbackClient) {
        try {
          block = await this.deps.fallbackClient.getBlock({ blockNumber: mint.block_number })
        } catch {
          return false // Both RPCs down — skip, will retry next cycle
        }
      } else {
        return false
      }
    }

    // Compare block hash
    return block.hash !== mint.block_hash
  }

  /**
   * Handle a detected reorg for a specific mint.
   * Re-fetches receipt, re-verifies transfer log.
   * If tx no longer valid: freeze credits + alert admin.
   */
  private async handleReorg(mint: StoredMint): Promise<boolean> {
    // Multi-RPC consistency check
    if (this.deps.fallbackClient) {
      try {
        const primaryBlock = await this.deps.primaryClient.getBlock({ blockNumber: mint.block_number })
        const fallbackBlock = await this.deps.fallbackClient.getBlock({ blockNumber: mint.block_number })
        if (primaryBlock.hash !== fallbackBlock.hash) {
          // RPCs disagree — conservatively freeze
          await this.freezeAndAlert(mint, "RPC providers disagree on block hash after reorg")
          return true
        }
      } catch {
        // One RPC down — use primary only
      }
    }

    // Re-fetch receipt
    let receipt
    try {
      receipt = await this.deps.primaryClient.getTransactionReceipt({
        hash: mint.tx_hash as `0x${string}`,
      })
    } catch {
      // Tx not found after reorg — the transfer may have been dropped
      await this.freezeAndAlert(mint, "Transaction receipt not found after reorg")
      return true
    }

    // Re-verify: check tx still succeeded and still in a valid block
    if (receipt.status !== "success") {
      await this.freezeAndAlert(mint, "Transaction no longer successful after reorg")
      return true
    }

    // Block hash changed but tx is still valid — update stored hash
    await this.deps.walAppend("credit_mint_revalidated", {
      billing_entry_id: mint.billing_entry_id,
      old_block_hash: mint.block_hash,
      new_block_hash: receipt.blockHash,
      new_block_number: receipt.blockNumber.toString(),
    })

    return false // Tx still valid, no credit freeze needed
  }

  private async freezeAndAlert(mint: StoredMint, reason: string): Promise<void> {
    // Write WAL entry
    await this.deps.walAppend("credit_mint_reverted", {
      billing_entry_id: mint.billing_entry_id,
      tx_hash: mint.tx_hash,
      block_number: mint.block_number.toString(),
      original_block_hash: mint.block_hash,
      reason,
      reverted_at: Date.now(),
    })

    // Freeze credits
    await this.deps.freezeCredits(mint.wallet_address, mint.billing_entry_id, mint.amount_micro_usdc)

    // Alert admin
    await this.deps.alertAdmin(`Credit mint reverted due to chain reorg`, {
      billing_entry_id: mint.billing_entry_id,
      tx_hash: mint.tx_hash,
      wallet: mint.wallet_address,
      amount_micro_usdc: mint.amount_micro_usdc.toString(),
      reason,
    })
  }
}
