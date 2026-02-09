// src/hounfour/redis/budget.ts — Redis-backed budget enforcement (SDD §4.6.3, T-2.9)
//
// Dual-write: Redis INCRBYFLOAT (atomic gate) + JSONL append (audit log).
// Fail-closed: rejects model requests when Redis is unavailable.

import type { RedisStateBackend } from "./client.js"

// --- Types ---

export interface BudgetSnapshot {
  scopeKey: string
  spentMicro: number
  limitMicro: number
  remainingMicro: number
  exceeded: boolean
  warning: boolean
  /** @deprecated Use spentMicro. Kept for 1 rotation cycle compat. */
  spentUsd: number
  /** @deprecated Use limitMicro. Kept for 1 rotation cycle compat. */
  limitUsd: number
  /** @deprecated Use remainingMicro. Kept for 1 rotation cycle compat. */
  remainingUsd: number
}

export interface BudgetConfig {
  limitMicro: number              // Budget limit per scope in micro-USD
  warningThresholdPercent: number // Warning at this % of limit (default: 80)
  /** @deprecated Use limitMicro. */
  limitUsd?: number
}

export interface ReconciliationResult {
  timestamp: string
  scopes: Array<{
    key: string
    redisUsd: number
    mirrorUsd: number
    driftPercent: number
    alert: boolean
  }>
}

/** Port interface for budget enforcement */
export interface BudgetEnforcerPort {
  recordCost(scopeKey: string, costMicro: number): Promise<void>
  isExceeded(scopeKey: string): Promise<boolean>
  isWarning(scopeKey: string): boolean
  getBudgetSnapshot(scopeKey: string): BudgetSnapshot
}

// --- RedisBudgetEnforcer ---

/**
 * Redis-backed budget enforcement with fail-closed semantics.
 * Phase 5: integer micro-USD via INCRBY (replacing INCRBYFLOAT).
 *
 * Dual-write pattern:
 *   1. INCRBY on Redis (atomic, online gate) — integer micro-USD
 *   2. Update in-memory mirror
 *
 * Fail-closed behavior:
 *   - recordCost(): throws on Redis failure (request rejected)
 *   - isExceeded(): returns true on Redis failure (treat as exceeded)
 *   - isWarning()/getBudgetSnapshot(): read in-memory mirror (advisory)
 */
export class RedisBudgetEnforcer implements BudgetEnforcerPort {
  private mirror = new Map<string, number>() // micro-USD values

  constructor(
    private redis: RedisStateBackend | null,
    private config: BudgetConfig,
  ) {}

  /**
   * Record cost in micro-USD — dual-write to Redis + in-memory mirror.
   * Uses INCRBY (integer) instead of INCRBYFLOAT (float).
   * Throws if Redis is unavailable (fail-closed).
   */
  async recordCost(scopeKey: string, costMicro: number): Promise<void> {
    if (!this.redis?.isConnected()) {
      throw new Error("BUDGET_UNAVAILABLE: Redis not connected, cannot record cost (fail-closed)")
    }

    if (!Number.isInteger(costMicro) || costMicro < 0) {
      throw new Error(`BUDGET_INVALID: costMicro must be a non-negative integer (got ${costMicro})`)
    }

    const redisKey = this.redisSpentKey(scopeKey)
    try {
      const newTotal = await this.redis.getClient().incrby(redisKey, costMicro)
      this.mirror.set(scopeKey, newTotal)
    } catch (err) {
      throw new Error(`BUDGET_UNAVAILABLE: Redis INCRBY failed: ${err}`)
    }
  }

  /**
   * Budget check — async, reads Redis directly.
   * On Redis failure: returns true (fail-closed, reject request).
   */
  async isExceeded(scopeKey: string): Promise<boolean> {
    if (!this.redis?.isConnected()) {
      return true // Fail-closed
    }

    try {
      const redisKey = this.redisSpentKey(scopeKey)
      const value = await this.redis.getClient().get(redisKey)
      const parsed = value ? parseInt(value, 10) : 0
      if (Number.isNaN(parsed)) return true // Fail-closed: corrupted data → treat as exceeded
      this.mirror.set(scopeKey, parsed) // Sync mirror
      return parsed >= this.config.limitMicro
    } catch {
      return true // Fail-closed
    }
  }

  /**
   * Warning check — sync, reads in-memory mirror (advisory only).
   */
  isWarning(scopeKey: string): boolean {
    const spentMicro = this.mirror.get(scopeKey) ?? 0
    const threshold = Math.floor(this.config.limitMicro * (this.config.warningThresholdPercent / 100))
    return spentMicro >= threshold
  }

  /**
   * Budget snapshot — sync, reads in-memory mirror (advisory only).
   */
  getBudgetSnapshot(scopeKey: string): BudgetSnapshot {
    const spentMicro = this.mirror.get(scopeKey) ?? 0
    const limitMicro = this.config.limitMicro
    const remainingMicro = Math.max(0, limitMicro - spentMicro)
    return {
      scopeKey,
      spentMicro,
      limitMicro,
      remainingMicro,
      exceeded: spentMicro >= limitMicro,
      warning: this.isWarning(scopeKey),
      // Deprecated compat fields (1 rotation cycle)
      spentUsd: spentMicro / 1_000_000,
      limitUsd: limitMicro / 1_000_000,
      remainingUsd: remainingMicro / 1_000_000,
    }
  }

  /**
   * Initialize mirror from Redis (startup sync).
   */
  async syncFromRedis(scopeKeys: string[]): Promise<void> {
    if (!this.redis?.isConnected()) return

    for (const scopeKey of scopeKeys) {
      try {
        const redisKey = this.redisSpentKey(scopeKey)
        const value = await this.redis.getClient().get(redisKey)
        if (value !== null) {
          const parsed = parseInt(value, 10)
          if (!Number.isNaN(parsed)) {
            this.mirror.set(scopeKey, parsed)
          }
          // NaN → skip (mirror stays at 0, non-fatal for sync)
        }
      } catch {
        // Non-fatal — mirror stays at 0
      }
    }
  }

  /**
   * Reconciliation — compare Redis vs mirror, report drift.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const scopes: ReconciliationResult["scopes"] = []

    for (const [scopeKey, mirrorMicro] of this.mirror) {
      let redisMicro = mirrorMicro // Default to mirror if Redis unavailable

      if (this.redis?.isConnected()) {
        try {
          const redisKey = this.redisSpentKey(scopeKey)
          const value = await this.redis.getClient().get(redisKey)
          const parsed = value ? parseInt(value, 10) : 0
          redisMicro = Number.isNaN(parsed) ? mirrorMicro : parsed
        } catch {
          // Use mirror value
        }
      }

      const driftPercent = mirrorMicro > 0
        ? Math.abs((redisMicro - mirrorMicro) / mirrorMicro) * 100
        : 0

      scopes.push({
        key: scopeKey,
        redisUsd: redisMicro / 1_000_000,
        mirrorUsd: mirrorMicro / 1_000_000,
        driftPercent,
        alert: driftPercent > 1,
      })
    }

    return { timestamp: new Date().toISOString(), scopes }
  }

  /** Redis key for spent_micro counter */
  private redisSpentKey(scopeKey: string): string {
    return this.redis!.key("budget", `${scopeKey}:spent_micro`)
  }
}
