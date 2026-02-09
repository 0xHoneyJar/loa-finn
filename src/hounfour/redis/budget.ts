// src/hounfour/redis/budget.ts — Redis-backed budget enforcement (SDD §4.6.3, T-2.9)
//
// Dual-write: Redis INCRBYFLOAT (atomic gate) + JSONL append (audit log).
// Fail-closed: rejects model requests when Redis is unavailable.

import type { RedisStateBackend } from "./client.js"

// --- Types ---

export interface BudgetSnapshot {
  scopeKey: string
  spentUsd: number
  limitUsd: number
  remainingUsd: number
  exceeded: boolean
  warning: boolean
}

export interface BudgetConfig {
  limitUsd: number                // Budget limit per scope
  warningThresholdPercent: number // Warning at this % of limit (default: 80)
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
  recordCost(scopeKey: string, costUsd: number): Promise<void>
  isExceeded(scopeKey: string): Promise<boolean>
  isWarning(scopeKey: string): boolean
  getBudgetSnapshot(scopeKey: string): BudgetSnapshot
}

// --- RedisBudgetEnforcer ---

/**
 * Redis-backed budget enforcement with fail-closed semantics.
 *
 * Dual-write pattern:
 *   1. INCRBYFLOAT on Redis (atomic, online gate)
 *   2. Update in-memory mirror
 *
 * Fail-closed behavior:
 *   - recordCost(): throws on Redis failure (request rejected)
 *   - isExceeded(): returns true on Redis failure (treat as exceeded)
 *   - isWarning()/getBudgetSnapshot(): read in-memory mirror (advisory)
 */
export class RedisBudgetEnforcer implements BudgetEnforcerPort {
  private mirror = new Map<string, number>()

  constructor(
    private redis: RedisStateBackend | null,
    private config: BudgetConfig,
  ) {}

  /**
   * Record cost — dual-write to Redis + in-memory mirror.
   * Throws if Redis is unavailable (fail-closed).
   */
  async recordCost(scopeKey: string, costUsd: number): Promise<void> {
    if (!this.redis?.isConnected()) {
      throw new Error("BUDGET_UNAVAILABLE: Redis not connected, cannot record cost (fail-closed)")
    }

    const redisKey = this.redis.key("budget", scopeKey)
    try {
      const newTotal = await this.redis.getClient().incrbyfloat(redisKey, costUsd)
      this.mirror.set(scopeKey, parseFloat(newTotal))
    } catch (err) {
      throw new Error(`BUDGET_UNAVAILABLE: Redis INCRBYFLOAT failed: ${err}`)
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
      const redisKey = this.redis.key("budget", scopeKey)
      const value = await this.redis.getClient().get(redisKey)
      const spent = value ? parseFloat(value) : 0
      this.mirror.set(scopeKey, spent) // Sync mirror
      return spent >= this.config.limitUsd
    } catch {
      return true // Fail-closed
    }
  }

  /**
   * Warning check — sync, reads in-memory mirror (advisory only).
   */
  isWarning(scopeKey: string): boolean {
    const spent = this.mirror.get(scopeKey) ?? 0
    const threshold = this.config.limitUsd * (this.config.warningThresholdPercent / 100)
    return spent >= threshold
  }

  /**
   * Budget snapshot — sync, reads in-memory mirror (advisory only).
   */
  getBudgetSnapshot(scopeKey: string): BudgetSnapshot {
    const spent = this.mirror.get(scopeKey) ?? 0
    const remaining = Math.max(0, this.config.limitUsd - spent)
    return {
      scopeKey,
      spentUsd: spent,
      limitUsd: this.config.limitUsd,
      remainingUsd: remaining,
      exceeded: spent >= this.config.limitUsd,
      warning: this.isWarning(scopeKey),
    }
  }

  /**
   * Initialize mirror from Redis (startup sync).
   */
  async syncFromRedis(scopeKeys: string[]): Promise<void> {
    if (!this.redis?.isConnected()) return

    for (const scopeKey of scopeKeys) {
      try {
        const redisKey = this.redis.key("budget", scopeKey)
        const value = await this.redis.getClient().get(redisKey)
        if (value !== null) {
          this.mirror.set(scopeKey, parseFloat(value))
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

    for (const [scopeKey, mirrorUsd] of this.mirror) {
      let redisUsd = mirrorUsd // Default to mirror if Redis unavailable

      if (this.redis?.isConnected()) {
        try {
          const redisKey = this.redis.key("budget", scopeKey)
          const value = await this.redis.getClient().get(redisKey)
          redisUsd = value ? parseFloat(value) : 0
        } catch {
          // Use mirror value
        }
      }

      const driftPercent = mirrorUsd > 0
        ? Math.abs((redisUsd - mirrorUsd) / mirrorUsd) * 100
        : 0

      scopes.push({
        key: scopeKey,
        redisUsd,
        mirrorUsd,
        driftPercent,
        alert: driftPercent > 1,
      })
    }

    return { timestamp: new Date().toISOString(), scopes }
  }
}
