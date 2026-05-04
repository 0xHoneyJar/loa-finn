// src/x402/reconciliation.ts — Settlement Reconciliation (SDD §4.4.6, T-3.9)
//
// Periodic scan of non-terminal settlement records via GSI.
// pending > 1h → expired (process crashed before submission)
// submitted > 10min → re-check on-chain receipt

import type { SettlementStore, SettlementStatus } from "./settlement-store.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationConfig {
  /** Check interval in ms (default: 300000 = 5 minutes) */
  intervalMs?: number
  /** Max age for pending records in ms (default: 3600000 = 1 hour) */
  pendingMaxAgeMs?: number
  /** Max age for submitted records before re-check in ms (default: 600000 = 10 minutes) */
  submittedMaxAgeMs?: number
}

export interface ReconciliationResult {
  scanned: number
  confirmed: number
  reverted: number
  expired: number
  errors: number
}

/** Minimal interface for checking on-chain receipt status. */
export interface ReceiptChecker {
  checkReceipt(txHash: string): Promise<"confirmed" | "reverted" | "pending">
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 300_000       // 5 minutes
const DEFAULT_PENDING_MAX_AGE_MS = 3_600_000  // 1 hour
const DEFAULT_SUBMITTED_MAX_AGE_MS = 600_000  // 10 minutes

// ---------------------------------------------------------------------------
// SettlementReconciler
// ---------------------------------------------------------------------------

export class SettlementReconciler {
  private readonly store: SettlementStore
  private readonly receiptChecker: ReceiptChecker
  private readonly intervalMs: number
  private readonly pendingMaxAgeMs: number
  private readonly submittedMaxAgeMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(store: SettlementStore, receiptChecker: ReceiptChecker, config?: ReconciliationConfig) {
    this.store = store
    this.receiptChecker = receiptChecker
    this.intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS
    this.pendingMaxAgeMs = config?.pendingMaxAgeMs ?? DEFAULT_PENDING_MAX_AGE_MS
    this.submittedMaxAgeMs = config?.submittedMaxAgeMs ?? DEFAULT_SUBMITTED_MAX_AGE_MS
  }

  /**
   * Run a single reconciliation pass.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      scanned: 0,
      confirmed: 0,
      reverted: 0,
      expired: 0,
      errors: 0,
    }

    // 1. Expire stale pending records (pending > 1h)
    const pendingCutoff = new Date(Date.now() - this.pendingMaxAgeMs).toISOString()
    const stalePending = await this.store.queryStaleByStatus("pending", pendingCutoff)
    result.scanned += stalePending.length

    for (const record of stalePending) {
      try {
        await this.store.update(record.idempotencyKey, { status: "expired" })
        result.expired++
        console.warn(JSON.stringify({
          metric: "reconciliation.expired",
          key: record.idempotencyKey,
          age_ms: Date.now() - new Date(record.updatedAt).getTime(),
          timestamp: Date.now(),
        }))
      } catch (err) {
        result.errors++
        console.error(JSON.stringify({
          metric: "reconciliation.error",
          key: record.idempotencyKey,
          phase: "pending_expire",
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }))
      }
    }

    // 2. Re-check stale submitted records (submitted > 10min)
    const submittedCutoff = new Date(Date.now() - this.submittedMaxAgeMs).toISOString()
    const staleSubmitted = await this.store.queryStaleByStatus("submitted", submittedCutoff)
    result.scanned += staleSubmitted.length

    for (const record of staleSubmitted) {
      try {
        if (!record.txHash) {
          // Submitted without txHash = broken state → expire
          await this.store.update(record.idempotencyKey, { status: "expired" })
          result.expired++
          continue
        }

        const receiptStatus = await this.receiptChecker.checkReceipt(record.txHash)

        if (receiptStatus === "confirmed") {
          await this.store.update(record.idempotencyKey, { status: "confirmed" })
          result.confirmed++
        } else if (receiptStatus === "reverted") {
          await this.store.update(record.idempotencyKey, { status: "reverted" })
          result.reverted++
        } else {
          // Still pending — check if too old (> 1h since submission = tx dropped)
          const age = Date.now() - new Date(record.updatedAt).getTime()
          if (age > this.pendingMaxAgeMs) {
            await this.store.update(record.idempotencyKey, { status: "expired" })
            result.expired++
          }
          // Otherwise leave as submitted — will be re-checked next cycle
        }
      } catch (err) {
        result.errors++
        console.error(JSON.stringify({
          metric: "reconciliation.error",
          key: record.idempotencyKey,
          phase: "submitted_recheck",
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }))
      }
    }

    if (result.scanned > 0) {
      console.log(JSON.stringify({
        metric: "reconciliation.complete",
        ...result,
        timestamp: Date.now(),
      }))
    }

    return result
  }

  /**
   * Start periodic reconciliation.
   */
  startPeriodicReconciliation(): void {
    if (this.timer) return

    this.timer = setInterval(async () => {
      try {
        await this.reconcile()
      } catch (err) {
        console.error(JSON.stringify({
          metric: "reconciliation.fatal",
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }))
      }
    }, this.intervalMs)

    if (this.timer.unref) {
      this.timer.unref()
    }
  }

  /**
   * Stop periodic reconciliation.
   */
  stopPeriodicReconciliation(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
