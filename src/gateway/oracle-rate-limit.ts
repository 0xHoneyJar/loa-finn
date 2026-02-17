// src/gateway/oracle-rate-limit.ts — Redis-backed Oracle rate limiter (SDD §3.2)
// Three tiers: per-identity, global cap, cost circuit breaker.
// Atomic Lua scripts for check-and-increment and cost reservation.

import { randomUUID } from "node:crypto"
import type { Context, Next } from "hono"
import type { RedisCommandClient } from "../hounfour/redis/client.js"

export interface OracleRateLimitConfig {
  dailyCap: number                  // Global daily cap (default: 200)
  publicDailyLimit: number          // Per-IP limit (default: 5)
  authenticatedDailyLimit: number   // Per-key limit (default: 50)
  costCeilingCents: number          // Daily cost circuit breaker (default: 2000 = $20)
}

export type OracleIdentity =
  | { type: "ip"; ip: string }
  | { type: "api_key"; keyHash: string; ip: string }

export interface RateLimitResult {
  allowed: boolean
  reason: "GLOBAL_CAP_EXCEEDED" | "COST_CEILING_EXCEEDED" | "IDENTITY_LIMIT_EXCEEDED" | null
  retryAfterSeconds?: number
  limit?: number
  remaining?: number
}

export class OracleRateLimiter {
  // In-memory fallback state for rate limiting when Redis is unavailable
  private fallbackLastRequest = new Map<string, number>()
  private static readonly FALLBACK_MIN_INTERVAL_MS = 60_000 // 1 req/min

  constructor(
    private redis: RedisCommandClient,
    private config: OracleRateLimitConfig,
  ) {}

  /**
   * Check all rate limit tiers ATOMICALLY via Redis Lua script.
   *
   * Check order inside Lua (atomic, no partial state):
   *   1. Cost circuit breaker → COST_CEILING_EXCEEDED
   *   2. Per-identity limit → IDENTITY_LIMIT_EXCEEDED
   *   3. Global daily cap → GLOBAL_CAP_EXCEEDED
   *   4. All pass → increment identity + global, return allowed
   *
   * On Redis error: fail-open with conservative in-memory limit (1 req/min)
   * per Flatline IMP-001.
   */
  private static readonly RATE_LIMIT_LUA = `
    local costKey = KEYS[1]
    local identityKey = KEYS[2]
    local globalKey = KEYS[3]
    local costCeiling = tonumber(ARGV[1])
    local identityLimit = tonumber(ARGV[2])
    local globalCap = tonumber(ARGV[3])
    local ttl = 86400

    -- 1. Cost circuit breaker (read-only check)
    local costCents = tonumber(redis.call('GET', costKey) or '0')
    if costCents >= costCeiling then
      return {'COST_CEILING_EXCEEDED', 0, 0}
    end

    -- 2. Per-identity limit (read-only check)
    local identityCount = tonumber(redis.call('GET', identityKey) or '0')
    if identityCount >= identityLimit then
      return {'IDENTITY_LIMIT_EXCEEDED', identityLimit, 0}
    end

    -- 3. Global daily cap (read-only check)
    local globalCount = tonumber(redis.call('GET', globalKey) or '0')
    if globalCount >= globalCap then
      return {'GLOBAL_CAP_EXCEEDED', 0, 0}
    end

    -- All checks passed — atomically increment both counters
    local newIdentity = redis.call('INCR', identityKey)
    if newIdentity == 1 then redis.call('EXPIRE', identityKey, ttl) end
    local newGlobal = redis.call('INCR', globalKey)
    if newGlobal == 1 then redis.call('EXPIRE', globalKey, ttl) end

    return {'ALLOWED', identityLimit, identityLimit - newIdentity}
  `

  async check(identity: OracleIdentity): Promise<RateLimitResult> {
    const dateKey = utcDateKey()
    const costKey = `oracle:cost:${dateKey}`
    const globalKey = `oracle:global:${dateKey}`
    const { key: identityKey, limit } = identity.type === "api_key"
      ? { key: `oracle:ratelimit:key:${identity.keyHash}:${dateKey}`, limit: this.config.authenticatedDailyLimit }
      : { key: `oracle:ratelimit:ip:${identity.ip}:${dateKey}`, limit: this.config.publicDailyLimit }

    let result: unknown
    try {
      result = await this.redis.eval(
        OracleRateLimiter.RATE_LIMIT_LUA,
        3, costKey, identityKey, globalKey,
        this.config.costCeilingCents, limit, this.config.dailyCap,
      )
    } catch {
      // Redis unreachable — fail-open with conservative in-memory limit (Flatline IMP-001)
      const fallbackKey = identity.type === "api_key" ? identity.keyHash : identity.ip
      return this.fallbackCheck(fallbackKey, limit)
    }

    const [reason, _luaLimit, remaining] = result as [string, number, number]

    if (reason === "ALLOWED") {
      return { allowed: true, reason: null, limit, remaining }
    }

    return {
      allowed: false,
      reason: reason as RateLimitResult["reason"],
      retryAfterSeconds: secondsUntilMidnightUTC(),
      limit: reason === "IDENTITY_LIMIT_EXCEEDED" ? limit : undefined,
      remaining: 0,
    }
  }

  /** Conservative in-memory fallback: 1 request per minute per identity */
  private fallbackCheck(identityKey: string, limit: number): RateLimitResult {
    const now = Date.now()
    const lastRequest = this.fallbackLastRequest.get(identityKey)

    if (lastRequest && now - lastRequest < OracleRateLimiter.FALLBACK_MIN_INTERVAL_MS) {
      return {
        allowed: false,
        reason: "IDENTITY_LIMIT_EXCEEDED",
        retryAfterSeconds: Math.ceil((OracleRateLimiter.FALLBACK_MIN_INTERVAL_MS - (now - lastRequest)) / 1000),
        limit,
        remaining: 0,
      }
    }

    this.fallbackLastRequest.set(identityKey, now)
    // Evict stale entries
    if (this.fallbackLastRequest.size > 10_000) {
      const cutoff = now - OracleRateLimiter.FALLBACK_MIN_INTERVAL_MS * 2
      for (const [key, ts] of this.fallbackLastRequest) {
        if (ts < cutoff) this.fallbackLastRequest.delete(key)
      }
    }

    return { allowed: true, reason: null, limit, remaining: undefined }
  }

  /**
   * Atomic check-and-reserve: reserve estimated cost BEFORE invoking the model.
   * Deny if reservation would exceed the ceiling. Reconcile after.
   *
   * Reserve/release is idempotent via request-scoped reservation ID (Flatline SKP-003b).
   * On Redis error: fail-closed (return denied) per Flatline IMP-001.
   */
  private static readonly RESERVE_COST_LUA = `
    local costKey = KEYS[1]
    local estimatedCost = tonumber(ARGV[1])
    local ceiling = tonumber(ARGV[2])
    local ttl = 86400

    local current = tonumber(redis.call('GET', costKey) or '0')
    if (current + estimatedCost) > ceiling then
      return {0, current}
    end

    local newVal = redis.call('INCRBY', costKey, estimatedCost)
    if newVal == estimatedCost then
      redis.call('EXPIRE', costKey, ttl)
    end
    return {1, newVal}
  `

  async reserveCost(
    estimatedCostCents: number,
  ): Promise<{ allowed: boolean; reservationId: string; release: (actualCostCents: number) => Promise<void> }> {
    const reservationId = randomUUID()
    const costKey = `oracle:cost:${utcDateKey()}`
    let released = false

    let result: unknown
    try {
      result = await this.redis.eval(
        OracleRateLimiter.RESERVE_COST_LUA,
        1, costKey,
        estimatedCostCents, this.config.costCeilingCents,
      )
    } catch {
      // Redis unreachable — fail-closed for cost reservation (Flatline IMP-001)
      return {
        allowed: false,
        reservationId,
        release: async () => {},
      }
    }

    const [allowed] = result as [number, number]

    if (!allowed) {
      return {
        allowed: false,
        reservationId,
        release: async () => {},
      }
    }

    return {
      allowed: true,
      reservationId,
      release: async (actualCostCents: number) => {
        if (released) return // Idempotent: no-op if already released (Flatline SKP-003b)
        released = true

        const delta = actualCostCents - estimatedCostCents
        if (delta !== 0) {
          try {
            if (delta > 0) {
              await this.redis.incrby(costKey, delta)
            } else {
              // Clamp to prevent negative counters: only decrement by at most the estimated amount
              const currentRaw = await this.redis.get(costKey)
              const current = parseInt(currentRaw ?? "0", 10)
              const safeDecrement = Math.min(Math.abs(delta), current)
              if (safeDecrement > 0) {
                await this.redis.incrby(costKey, -safeDecrement)
              }
            }
          } catch {
            // Best-effort reconciliation — Redis may be unavailable
          }
        }
      },
    }
  }

  /** Get current daily usage from Redis (for health endpoint) */
  async getDailyUsage(): Promise<{ globalCount: number; costCents: number } | null> {
    try {
      const dateKey = utcDateKey()
      const [globalRaw, costRaw] = await Promise.all([
        this.redis.get(`oracle:global:${dateKey}`),
        this.redis.get(`oracle:cost:${dateKey}`),
      ])
      return {
        globalCount: parseInt(globalRaw ?? "0", 10),
        costCents: parseInt(costRaw ?? "0", 10),
      }
    } catch {
      return null
    }
  }

  /** Health check: is Redis reachable? */
  async isHealthy(): Promise<boolean> {
    try {
      await this.redis.ping()
      return true
    } catch {
      return false
    }
  }
}

export function oracleRateLimitMiddleware(limiter: OracleRateLimiter) {
  return async (c: Context, next: Next) => {
    const identity = c.get("oracleIdentity") as OracleIdentity | undefined
    if (!identity) {
      return c.json({ error: "Identity not established", code: "INTERNAL_ERROR" }, 500)
    }

    let result: RateLimitResult
    try {
      result = await limiter.check(identity)
    } catch {
      // Unexpected error — fail closed (PRD NFR-2)
      return c.json(
        { error: "Service temporarily unavailable", code: "RATE_LIMITER_UNAVAILABLE" },
        503,
      )
    }

    if (!result.allowed) {
      const status = result.reason === "IDENTITY_LIMIT_EXCEEDED" ? 429 : 503
      if (result.retryAfterSeconds) {
        c.header("Retry-After", String(result.retryAfterSeconds))
      }
      return c.json({ error: "Rate limit exceeded", code: result.reason }, status)
    }

    if (result.remaining !== undefined) {
      c.header("X-RateLimit-Remaining", String(result.remaining))
      c.header("X-RateLimit-Limit", String(result.limit))
    }

    return next()
  }
}

export function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function secondsUntilMidnightUTC(): number {
  const now = new Date()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000)
}
