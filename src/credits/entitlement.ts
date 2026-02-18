// src/credits/entitlement.ts — BYOK Entitlement State Machine (SDD §3.3, Sprint 3 Task 3.2)
//
// 4-state subscription machine: ACTIVE → PAST_DUE → GRACE_EXPIRED, CANCELLED.
// Redis persistence with WAL audit entries on every state transition.
// Daily rate limiting: BYOK_DAILY_RATE_LIMIT env var (default 1000 req/day).

import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntitlementState = "ACTIVE" | "PAST_DUE" | "GRACE_EXPIRED" | "CANCELLED"

export interface EntitlementRecord {
  state: EntitlementState
  expires_at: number   // Unix ms
  grace_until: number  // Unix ms (expires_at + GRACE_PERIOD_MS)
  monthly_fee_micro: string // serialized MicroUSD
  created_at: number
}

export interface EntitlementCheckResult {
  allowed: boolean
  state: EntitlementState
  reason?: string
}

export interface DailyLimitResult {
  allowed: boolean
  count: number
  limit: number
  resetAt: number // Unix ms (next midnight UTC)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BYOK_DAILY_RATE_LIMIT = 1000
export const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000 // 72 hours
export const DEFAULT_SUBSCRIPTION_DURATION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class EntitlementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 403,
  ) {
    super(message)
    this.name = "EntitlementError"
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface EntitlementDeps {
  redis: RedisCommandClient
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EntitlementService {
  private readonly redis: RedisCommandClient
  private readonly walAppend: EntitlementDeps["walAppend"]

  constructor(deps: EntitlementDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend
  }

  /**
   * Check if a BYOK account is entitled to inference.
   * Automatically transitions ACTIVE → PAST_DUE → GRACE_EXPIRED based on time.
   */
  async checkEntitlement(accountId: string): Promise<EntitlementCheckResult> {
    const record = await this.getRecord(accountId)

    if (!record) {
      return { allowed: false, state: "CANCELLED", reason: "No BYOK entitlement found" }
    }

    const now = Date.now()

    // Auto-transition: ACTIVE → PAST_DUE when subscription expires
    if (record.state === "ACTIVE" && now > record.expires_at) {
      await this.transitionState(accountId, record, "PAST_DUE")
    }

    // Auto-transition: PAST_DUE → GRACE_EXPIRED when grace period ends
    if (record.state === "PAST_DUE" && now > record.grace_until) {
      await this.transitionState(accountId, record, "GRACE_EXPIRED")
    }

    switch (record.state) {
      case "ACTIVE":
      case "PAST_DUE":
        return { allowed: true, state: record.state }
      case "GRACE_EXPIRED":
        return {
          allowed: false,
          state: record.state,
          reason: "BYOK subscription inactive. Please renew to continue.",
        }
      case "CANCELLED":
        return {
          allowed: false,
          state: record.state,
          reason: "BYOK subscription cancelled.",
        }
    }
  }

  /**
   * Check if the daily request limit has been reached.
   */
  async checkDailyLimit(accountId: string): Promise<DailyLimitResult> {
    const key = `rate:${accountId}:daily`
    const limit = Number(process.env.BYOK_DAILY_RATE_LIMIT ?? BYOK_DAILY_RATE_LIMIT)
    const countStr = await this.redis.get(key) ?? "0"
    const count = Number(countStr)
    const resetAt = nextMidnightUTC()

    return { allowed: count < limit, count, limit, resetAt }
  }

  /**
   * Increment the daily request counter. Returns new count.
   * Sets TTL to next midnight UTC on first increment.
   */
  async incrementDailyCount(accountId: string): Promise<number> {
    const key = `rate:${accountId}:daily`
    const count = await this.redis.incrby(key, 1)

    // Set TTL on first increment (count === 1)
    if (count === 1) {
      const ttlSeconds = Math.ceil((nextMidnightUTC() - Date.now()) / 1000)
      await this.redis.expire(key, ttlSeconds)
    }

    return count
  }

  /**
   * Create a new BYOK entitlement for an account.
   */
  async createEntitlement(
    accountId: string,
    monthlyFeeMicro: string,
    durationMs: number = DEFAULT_SUBSCRIPTION_DURATION_MS,
  ): Promise<EntitlementRecord> {
    const now = Date.now()
    const record: EntitlementRecord = {
      state: "ACTIVE",
      expires_at: now + durationMs,
      grace_until: now + durationMs + GRACE_PERIOD_MS,
      monthly_fee_micro: monthlyFeeMicro,
      created_at: now,
    }

    await this.saveRecord(accountId, record)
    this.writeAudit(accountId, null, "ACTIVE", {
      expires_at: record.expires_at,
      monthly_fee_micro: monthlyFeeMicro,
    })

    return record
  }

  /**
   * Renew an existing entitlement (reactivate from any state except CANCELLED).
   */
  async renewEntitlement(
    accountId: string,
    monthlyFeeMicro: string,
    durationMs: number = DEFAULT_SUBSCRIPTION_DURATION_MS,
  ): Promise<EntitlementRecord> {
    const existing = await this.getRecord(accountId)
    const previousState = existing?.state ?? null

    const now = Date.now()
    const record: EntitlementRecord = {
      state: "ACTIVE",
      expires_at: now + durationMs,
      grace_until: now + durationMs + GRACE_PERIOD_MS,
      monthly_fee_micro: monthlyFeeMicro,
      created_at: existing?.created_at ?? now,
    }

    await this.saveRecord(accountId, record)
    this.writeAudit(accountId, previousState, "ACTIVE", {
      expires_at: record.expires_at,
      monthly_fee_micro: monthlyFeeMicro,
    })

    return record
  }

  /**
   * Cancel a BYOK entitlement. Non-recoverable — requires new subscription.
   */
  async cancelEntitlement(accountId: string): Promise<void> {
    const record = await this.getRecord(accountId)
    if (!record) return

    const previousState = record.state
    record.state = "CANCELLED"
    await this.saveRecord(accountId, record)
    this.writeAudit(accountId, previousState, "CANCELLED")
  }

  /**
   * Compute prorated fee for mid-month activation.
   * Formula: (remaining_days / 30) × monthly_fee
   */
  computeProration(monthlyFeeMicro: bigint, remainingDays: number): bigint {
    return (monthlyFeeMicro * BigInt(remainingDays)) / 30n
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getRecord(accountId: string): Promise<EntitlementRecord | null> {
    const key = `entitlement:${accountId}`
    const data = await this.redis.get(key)
    if (!data) return null
    try {
      return JSON.parse(data) as EntitlementRecord
    } catch {
      return null
    }
  }

  private async saveRecord(accountId: string, record: EntitlementRecord): Promise<void> {
    const key = `entitlement:${accountId}`
    await this.redis.set(key, JSON.stringify(record))
  }

  private async transitionState(
    accountId: string,
    record: EntitlementRecord,
    newState: EntitlementState,
  ): Promise<void> {
    const previousState = record.state
    record.state = newState
    await this.saveRecord(accountId, record)
    this.writeAudit(accountId, previousState, newState)
  }

  private writeAudit(
    accountId: string,
    fromState: EntitlementState | null,
    toState: EntitlementState,
    extra?: Record<string, unknown>,
  ): void {
    if (!this.walAppend) return
    try {
      this.walAppend("entitlement", "transition", `entitlement:${accountId}`, {
        account_id: accountId,
        from_state: fromState,
        to_state: toState,
        timestamp: Date.now(),
        ...extra,
      })
    } catch {
      // Best-effort — never throw from audit
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextMidnightUTC(): number {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  tomorrow.setUTCHours(0, 0, 0, 0)
  return tomorrow.getTime()
}
