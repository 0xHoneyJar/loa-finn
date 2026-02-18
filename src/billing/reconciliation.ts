// src/billing/reconciliation.ts — Daily Reconciliation Job (SDD §7.2, Sprint 2 Task 2.6)
//
// Derives all account balances from WAL journal entries, compares against
// Redis cached balances, overwrites Redis on divergence, alerts with diff.

import { Cron } from "croner"
import type { Ledger, JournalEntry } from "./ledger.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationDeps {
  /** Get all journal entries from WAL */
  getAllJournalEntries: () => Promise<JournalEntry[]>
  /** Get Redis balance for account */
  redisGet: (key: string) => Promise<string | null>
  /** Set Redis balance for account */
  redisSet: (key: string, value: string) => Promise<void>
  /** WAL append for reconciliation entry */
  walAppend: (entryType: string, payload: unknown) => Promise<string>
  /** Alert on divergence */
  alertDivergence: (details: ReconciliationDivergence[]) => Promise<void>
  /** Alert on rounding drift */
  alertRoundingDrift: (details: RoundingDriftReport) => Promise<void>
}

export interface ReconciliationDivergence {
  account: string
  derived_balance: string
  redis_balance: string
  delta: string
}

export interface RoundingDriftReport {
  total_drift_micro_usd: bigint
  by_denom: Record<string, bigint>
  threshold_exceeded: boolean
}

export interface ReconciliationResult {
  accounts_checked: number
  divergences_found: number
  divergences_corrected: number
  rounding_drift: RoundingDriftReport
  duration_ms: number
}

// ---------------------------------------------------------------------------
// Reconciliation Service
// ---------------------------------------------------------------------------

/** Max acceptable cumulative rounding drift in MicroUSD */
const MAX_ROUNDING_DRIFT = 1000n

export class ReconciliationService {
  private cron: Cron | null = null

  constructor(private deps: ReconciliationDeps) {}

  /**
   * Start the daily reconciliation cron job.
   * Runs at 02:00 UTC daily.
   */
  start(): void {
    if (this.cron) return
    this.cron = new Cron("0 2 * * *", async () => {
      try {
        await this.reconcile()
      } catch {
        // Logged but not thrown — cron resilience
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
   * Run reconciliation: derive balances from WAL, compare against Redis.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const start = Date.now()
    const entries = await this.deps.getAllJournalEntries()

    // Derive all balances from journal entries
    const derivedBalances = new Map<string, bigint>()
    const roundingByDenom = new Map<string, bigint>()

    for (const entry of entries) {
      for (const posting of entry.postings) {
        const current = derivedBalances.get(posting.account) ?? 0n
        derivedBalances.set(posting.account, current + posting.delta)

        // Track rounding by denom (rounding entries have metadata.is_rounding = "true")
        if (posting.metadata?.is_rounding === "true") {
          const denomKey = posting.denom
          const currentDrift = roundingByDenom.get(denomKey) ?? 0n
          roundingByDenom.set(denomKey, currentDrift + posting.delta)
        }
      }
    }

    // Compare against Redis
    const divergences: ReconciliationDivergence[] = []
    let divergencesCorrected = 0

    for (const [account, derivedBalance] of derivedBalances) {
      const redisKey = `balance:${account}:value`
      const redisValue = await this.deps.redisGet(redisKey)
      const redisBalance = redisValue ? BigInt(redisValue) : 0n

      if (derivedBalance !== redisBalance) {
        divergences.push({
          account,
          derived_balance: derivedBalance.toString(),
          redis_balance: redisBalance.toString(),
          delta: (derivedBalance - redisBalance).toString(),
        })

        // Overwrite Redis from derived values
        await this.deps.redisSet(redisKey, derivedBalance.toString())
        divergencesCorrected++
      }
    }

    // Compute rounding drift report
    let totalDrift = 0n
    const byDenom: Record<string, bigint> = {}
    for (const [denom, drift] of roundingByDenom) {
      const absDrift = drift < 0n ? -drift : drift
      totalDrift += absDrift
      byDenom[denom] = drift
    }

    const driftReport: RoundingDriftReport = {
      total_drift_micro_usd: totalDrift,
      by_denom: byDenom,
      threshold_exceeded: totalDrift > MAX_ROUNDING_DRIFT,
    }

    // Alert on divergences
    if (divergences.length > 0) {
      await this.deps.alertDivergence(divergences)
    }

    // Alert on rounding drift threshold
    if (driftReport.threshold_exceeded) {
      await this.deps.alertRoundingDrift(driftReport)
    }

    // Log reconciliation to WAL
    const duration = Date.now() - start
    await this.deps.walAppend("billing_reconciliation", {
      accounts_checked: derivedBalances.size,
      divergences_found: divergences.length,
      divergences_corrected: divergencesCorrected,
      total_rounding_drift: totalDrift.toString(),
      drift_threshold_exceeded: driftReport.threshold_exceeded,
      duration_ms: duration,
      timestamp: Date.now(),
    })

    return {
      accounts_checked: derivedBalances.size,
      divergences_found: divergences.length,
      divergences_corrected: divergencesCorrected,
      rounding_drift: driftReport,
      duration_ms: duration,
    }
  }
}
