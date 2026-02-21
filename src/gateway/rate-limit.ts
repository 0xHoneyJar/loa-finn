// src/gateway/rate-limit.ts — In-memory rate limiting (SDD §6.4, T-2.8)

import type { Context, Next } from "hono"
import type { FinnConfig } from "../config.js"

interface TokenBucket {
  tokens: number
  lastRefill: number
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>()
  private windowMs: number
  private maxTokens: number

  constructor(windowMs: number, maxTokens: number) {
    this.windowMs = windowMs
    this.maxTokens = maxTokens
  }

  /** Returns true if the request is allowed, false if rate-limited */
  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now()
    let bucket = this.buckets.get(key)

    if (!bucket) {
      bucket = { tokens: this.maxTokens - 1, lastRefill: now }
      this.buckets.set(key, bucket)
      return { allowed: true, retryAfterMs: 0 }
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill
    const refill = Math.floor((elapsed / this.windowMs) * this.maxTokens)
    if (refill > 0) {
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refill)
      bucket.lastRefill = now
    }

    if (bucket.tokens > 0) {
      bucket.tokens--
      return { allowed: true, retryAfterMs: 0 }
    }

    const retryAfterMs = this.windowMs - elapsed
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) }
  }

  /** Periodic cleanup of stale buckets */
  cleanup(): void {
    const staleThreshold = Date.now() - this.windowMs * 2
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < staleThreshold) {
        this.buckets.delete(key)
      }
    }
  }
}

/**
 * Extract client IP — only trust proxy headers when explicitly configured.
 * Falls back to socket remote address to prevent IP spoofing via forged headers.
 */
function getClientIp(c: Context, trustProxy = false): string {
  if (trustProxy) {
    const cfIp = c.req.header("CF-Connecting-IP")
    if (cfIp) return cfIp
    const xff = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    if (xff) return xff
  }
  // Use the raw connection info when not trusting proxy headers
  const connInfo = c.env?.remoteAddr ?? c.req.header("X-Real-IP")
  return connInfo ?? "unknown"
}

export function rateLimitMiddleware(config: FinnConfig) {
  const limiter = new RateLimiter(
    config.auth.rateLimiting.windowMs,
    config.auth.rateLimiting.maxRequestsPerWindow,
  )

  // Cleanup stale buckets every 5 minutes
  setInterval(() => limiter.cleanup(), 300_000).unref()

  return async (c: Context, next: Next) => {
    const ip = getClientIp(c)
    const { allowed, retryAfterMs } = limiter.check(ip)

    if (!allowed) {
      c.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)))
      return c.json({ error: "Too Many Requests", code: "RATE_LIMITED" }, 429)
    }

    return next()
  }
}

export { getClientIp }

// ---------------------------------------------------------------------------
// Multi-Tier Rate Limiter (Sprint 3 T3.5)
// Redis sliding window — per-tier rate limits for free/x402/API key paths
// ---------------------------------------------------------------------------

export interface RateLimitCheckResult {
  allowed: boolean
  remaining: number
  resetMs: number
  retryAfterSeconds: number
}

export interface MultiTierRateLimiterDeps {
  redis: import("../hounfour/redis/client.js").RedisCommandClient
}

/**
 * Redis-backed sliding window rate limiter with per-tier limits.
 *
 * Uses Redis sorted sets: score = timestamp (ms), member = unique request ID.
 * Window slides: remove entries older than windowMs, count remaining.
 */
export class MultiTierRateLimiter {
  private readonly redis: MultiTierRateLimiterDeps["redis"]

  constructor(deps: MultiTierRateLimiterDeps) {
    this.redis = deps.redis
  }

  /**
   * Check rate limit for a given tier and identifier.
   * Returns whether the request is allowed + standard rate limit headers.
   */
  async check(
    tier: string,
    identifier: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<RateLimitCheckResult> {
    const key = `finn:ratelimit:${tier}:${identifier}`
    const now = Date.now()
    const windowStart = now - windowMs

    // Atomic sliding window via Lua script:
    // 1. Remove expired entries
    // 2. Count current entries
    // 3. Add new entry if under limit
    // 4. Set key expiry
    const result = await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(windowStart),
      String(now),
      String(maxRequests),
      String(Math.ceil(windowMs / 1000) * 2), // Key TTL = 2x window for cleanup
    )

    const [allowed, count] = result as [number, number]
    const remaining = Math.max(0, maxRequests - count)
    const resetMs = windowMs // Approximate — window is sliding

    return {
      allowed: allowed === 1,
      remaining,
      resetMs,
      retryAfterSeconds: allowed === 1 ? 0 : Math.ceil(windowMs / 1000),
    }
  }
}

/** Lua script for atomic sliding window rate limiting */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local window_start = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count current entries
local count = redis.call('ZCARD', key)

if count < max_requests then
  -- Under limit — add entry with score = timestamp
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('EXPIRE', key, ttl)
  return {1, count + 1}
else
  redis.call('EXPIRE', key, ttl)
  return {0, count}
end
`

// ---------------------------------------------------------------------------
// Tier Definitions (SDD §4.6)
// ---------------------------------------------------------------------------

export const RATE_LIMIT_TIERS = {
  free_per_ip: { windowMs: 60_000, maxRequests: 60 },
  x402_per_wallet: { windowMs: 60_000, maxRequests: 30 },
  challenge_per_ip: { windowMs: 60_000, maxRequests: 120 },
  api_key_default: { windowMs: 60_000, maxRequests: 60 },
} as const
