// src/hounfour/redis/atomic-budget.ts — Redis Atomic Budget Commit (SDD §4.3, Task 2.2b)
//
// Atomic cost recording via Redis Lua script with idempotency keying.
// Write-ahead protocol: JSONL ledger append FIRST, then Redis Lua.
// On crash between JSONL write and Redis update, reconciliation recomputes.

import type { RedisStateBackend } from "./client.js"
import type { LedgerV2 } from "../ledger-v2.js"
import type { LedgerEntryV2 } from "../types.js"

// --- Lua Script ---

/**
 * Atomic budget recording with idempotency.
 *
 * KEYS[1] = budget spent key (e.g., finn:hounfour:budget:{tenant}:spent_micro)
 * KEYS[2] = idempotency key (e.g., finn:hounfour:idem:{idempotencyKey})
 * KEYS[3] = reconciliation headroom key (e.g., finn:hounfour:budget:{tenant}:headroom_micro)
 *
 * ARGV[1] = cost_micro (string integer)
 * ARGV[2] = idempotency value (cost_micro to cache, or '' to skip idempotency)
 * ARGV[3] = reconciliation status ('SYNCED' | 'FAIL_OPEN' | 'FAIL_CLOSED')
 *
 * Returns: [is_duplicate (0|1), budget_total_or_cached_cost]
 *
 * Idempotency check happens FIRST (before INCRBY) to ensure no double-charge.
 * All operations within Lua are atomic (Redis single-threaded execution).
 */
const ATOMIC_RECORD_COST_LUA = `
-- Check idempotency FIRST (before any side effects)
if ARGV[2] ~= '' then
  local existing = redis.call('GET', KEYS[2])
  if existing then
    -- Already recorded — return cached cost, no charge
    return {1, existing}
  end
end

-- New request — record cost via INCRBY (integer micro-USD)
local cost = tonumber(ARGV[1])
local budget = redis.call('INCRBY', KEYS[1], cost)

-- Store idempotency marker with 24h TTL
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[2], ARGV[1], 'EX', 86400)
end

-- FAIL_OPEN: monotonic headroom decrement
if ARGV[3] == 'FAIL_OPEN' then
  redis.call('DECRBY', KEYS[3], cost)
end

return {0, tostring(budget)}
`

// --- Types ---

/** Result of an atomic budget recording. */
export interface AtomicRecordResult {
  /** Whether this was a duplicate (idempotency hit). */
  isDuplicate: boolean
  /** Budget total after recording (or current total if duplicate). */
  budgetTotalMicro: number
  /** Cost that was recorded (or cached cost if duplicate). */
  costMicro: number
  /** Whether write-ahead to JSONL succeeded. */
  journalWritten: boolean
  /** Whether Redis commit succeeded. */
  redisCommitted: boolean
}

/** Reconciliation status for FAIL_OPEN headroom decrement. */
export type ReconStatus = "SYNCED" | "FAIL_OPEN" | "FAIL_CLOSED"

/** Options for the AtomicBudgetRecorder. */
export interface AtomicBudgetRecorderConfig {
  /** Redis state backend for Lua script execution. */
  redis: RedisStateBackend
  /** JSONL ledger v2 for write-ahead journal. */
  ledger: LedgerV2
}

/** Recovery statistics from JSONL journal reconciliation. */
export interface JournalRecoveryStats {
  /** Number of entries scanned in JSONL. */
  entriesScanned: number
  /** Number of unique entries (by trace_id). */
  uniqueEntries: number
  /** Number of duplicates removed. */
  duplicatesFound: number
  /** Total cost recomputed from JSONL (micro-USD). */
  recomputedTotalMicro: bigint
  /** Whether Redis was successfully updated. */
  redisUpdated: boolean
}

// --- AtomicBudgetRecorder ---

/**
 * Atomic budget recorder with write-ahead JSONL + Redis Lua idempotency.
 *
 * Write-ahead protocol:
 *   1. Derive idempotency key (from tenant + reqHash + provider + model)
 *   2. Append entry to JSONL ledger (crash-safe journal)
 *   3. Execute Redis Lua script (atomic INCRBY + idempotency check)
 *   4. If Redis fails → JSONL entry exists for reconciliation recompute
 *
 * Crash matrix:
 *   (a) Crash after JSONL, before Redis → recompute corrects on startup
 *   (b) Crash after Redis, before JSONL flush → idempotency key prevents
 *       double-charge on retry
 *   (c) N retries with same idempotency key → exactly one committed charge
 *   (d) Retry with different body → different idempotency key → new charge
 */
export class AtomicBudgetRecorder {
  private redis: RedisStateBackend
  private ledger: LedgerV2

  constructor(config: AtomicBudgetRecorderConfig) {
    this.redis = config.redis
    this.ledger = config.ledger
  }

  /**
   * Record a cost atomically with write-ahead + idempotency.
   *
   * @param tenantId - Tenant identifier
   * @param entry - Complete ledger v2 entry to journal
   * @param idempotencyKey - Canonical key from deriveIdempotencyKey()
   * @param reconStatus - Reconciliation state for headroom decrement
   * @returns Atomic record result with dedup and commit status
   */
  async recordCost(
    tenantId: string,
    entry: LedgerEntryV2,
    idempotencyKey: string,
    reconStatus: ReconStatus = "SYNCED",
  ): Promise<AtomicRecordResult> {
    if (!/^[0-9]+$/.test(entry.total_cost_micro)) {
      throw new Error(
        `BUDGET_INVALID: total_cost_micro must be a non-negative integer string (got "${entry.total_cost_micro}")`
      )
    }
    const costMicro = parseInt(entry.total_cost_micro, 10)

    // --- Step 1: Write-ahead to JSONL ledger ---
    let journalWritten = false
    try {
      await this.ledger.append(tenantId, entry)
      journalWritten = true
    } catch (err) {
      // JSONL write failed — do NOT proceed to Redis (no journal = no recovery path)
      throw new Error(
        `BUDGET_JOURNAL_FAILED: JSONL append failed for tenant ${tenantId}: ${err}`
      )
    }

    // --- Step 2: Execute Redis Lua script ---
    if (!this.redis.isConnected()) {
      // Redis unavailable — JSONL entry exists for reconciliation recompute
      return {
        isDuplicate: false,
        budgetTotalMicro: costMicro,
        costMicro,
        journalWritten: true,
        redisCommitted: false,
      }
    }

    try {
      const budgetKey = this.redis.key("budget", `${tenantId}:spent_micro`)
      const idemKey = this.redis.key("idem", idempotencyKey)
      const headroomKey = this.redis.key("budget", `${tenantId}:headroom_micro`)

      const result = await this.redis.getClient().eval(
        ATOMIC_RECORD_COST_LUA,
        3, // numkeys
        budgetKey,
        idemKey,
        headroomKey,
        String(costMicro),
        String(costMicro), // idem_value = cost for cache
        reconStatus,
      ) as [number, string]

      const isDuplicate = result[0] === 1
      const returnedValue = parseInt(result[1], 10)

      return {
        isDuplicate,
        budgetTotalMicro: isDuplicate ? 0 : returnedValue,
        costMicro: isDuplicate ? parseInt(result[1], 10) : costMicro,
        journalWritten: true,
        redisCommitted: true,
      }
    } catch (err) {
      // Redis failed after JSONL write — journal entry exists for recovery
      return {
        isDuplicate: false,
        budgetTotalMicro: costMicro,
        costMicro,
        journalWritten: true,
        redisCommitted: false,
      }
    }
  }

  /**
   * Recover Redis budget state from JSONL journal.
   *
   * Scans all entries in the tenant's JSONL ledger, deduplicates by trace_id,
   * and sets the Redis budget counter to the recomputed total.
   *
   * Called at startup after a crash to reconcile JSONL → Redis.
   */
  async recoverFromJournal(tenantId: string): Promise<JournalRecoveryStats> {
    // First, recover the JSONL file itself (handle partial writes)
    await this.ledger.recover(tenantId)

    // Recompute totals from JSONL
    const recomputed = await this.ledger.recompute(tenantId)

    const stats: JournalRecoveryStats = {
      entriesScanned: recomputed.totalEntries + recomputed.duplicatesRemoved,
      uniqueEntries: recomputed.totalEntries,
      duplicatesFound: recomputed.duplicatesRemoved,
      recomputedTotalMicro: recomputed.totalCostMicro,
      redisUpdated: false,
    }

    // Update Redis with recomputed total
    if (this.redis.isConnected()) {
      try {
        const budgetKey = this.redis.key("budget", `${tenantId}:spent_micro`)
        // SET (not INCRBY) — we're replacing the value with the authoritative JSONL total
        await this.redis.getClient().set(
          budgetKey,
          recomputed.totalCostMicro.toString(),
        )
        stats.redisUpdated = true
      } catch {
        // Redis update failed — will be retried on next recovery or reconciliation
      }
    }

    return stats
  }

  /**
   * Check if an idempotency key has already been recorded.
   * Returns the cached cost if duplicate, null if new.
   */
  async checkIdempotency(idempotencyKey: string): Promise<number | null> {
    if (!this.redis.isConnected()) return null

    try {
      const idemKey = this.redis.key("idem", idempotencyKey)
      const value = await this.redis.getClient().get(idemKey)
      if (value !== null) {
        const parsed = parseInt(value, 10)
        return Number.isNaN(parsed) ? null : parsed
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Get the current budget total from Redis for a tenant.
   * Returns null if Redis unavailable.
   */
  async getBudgetTotal(tenantId: string): Promise<number | null> {
    if (!this.redis.isConnected()) return null

    try {
      const budgetKey = this.redis.key("budget", `${tenantId}:spent_micro`)
      const value = await this.redis.getClient().get(budgetKey)
      if (value === null) return 0
      const parsed = parseInt(value, 10)
      return Number.isNaN(parsed) ? null : parsed
    } catch {
      return null
    }
  }
}
