// src/nft/rate-limiter.ts — Redis-Based Rate Limiter (Sprint 16 Task 16.1)
//
// Sliding window rate limiter for LLM-calling endpoints (synthesize, rederive).
// Uses an atomic Lua script for Redis-based sliding window counting.
// Returns 429 RATE_LIMITED on excess.

import type { Context, Next } from "hono"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { NFTPersonalityError } from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rate limiter configuration */
export interface RateLimiterConfig {
  /** Maximum requests allowed within the window (default: 10) */
  maxRequests: number
  /** Window duration in milliseconds (default: 3600000 = 1 hour) */
  windowMs: number
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 10,
  windowMs: 3_600_000, // 1 hour
}

// ---------------------------------------------------------------------------
// Lua Script — Atomic Sliding Window
// ---------------------------------------------------------------------------

/**
 * Atomic Lua script for sliding window rate limiting.
 *
 * KEYS[1] = sorted set key for this wallet
 * ARGV[1] = current timestamp (ms)
 * ARGV[2] = window start timestamp (ms)
 * ARGV[3] = max requests allowed
 * ARGV[4] = window TTL in seconds (for key expiry)
 *
 * Returns: [allowed (0|1), current_count]
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

-- Remove expired entries outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count current entries in the window
local count = redis.call('ZCARD', key)

if count >= max_requests then
  return {0, count}
end

-- Add the current request
redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))

-- Set TTL on the key to auto-cleanup
redis.call('EXPIRE', key, ttl_seconds)

return {1, count + 1}
`

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a rate limiter middleware for Hono routes.
 *
 * Uses Redis sorted sets with a sliding window algorithm.
 * The wallet address is extracted from the Hono context (set by ownership middleware).
 *
 * @param redis - Redis command client
 * @param config - Optional rate limiter configuration
 * @returns Hono middleware function
 */
export function createRateLimiter(
  redis: RedisCommandClient,
  config?: Partial<RateLimiterConfig>,
): (c: Context, next: Next) => Promise<Response | void> {
  const cfg: RateLimiterConfig = { ...DEFAULT_CONFIG, ...config }

  return async (c: Context, next: Next): Promise<Response | void> => {
    // Extract wallet address from context (set by requireNFTOwnership middleware)
    const walletAddress: string = c.get("wallet_address") ?? "unknown"

    // Build rate limit key scoped to wallet
    const key = `ratelimit:llm:${walletAddress}`

    const now = Date.now()
    const windowStart = now - cfg.windowMs
    const ttlSeconds = Math.ceil(cfg.windowMs / 1000)

    try {
      const result = await redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now,
        windowStart,
        cfg.maxRequests,
        ttlSeconds,
      ) as [number, number]

      const [allowed, count] = result

      // Set rate limit headers
      c.header("X-RateLimit-Limit", String(cfg.maxRequests))
      c.header("X-RateLimit-Remaining", String(Math.max(0, cfg.maxRequests - count)))
      c.header("X-RateLimit-Window", String(cfg.windowMs))

      if (!allowed) {
        throw new NFTPersonalityError(
          "RATE_LIMITED",
          `Rate limit exceeded: ${cfg.maxRequests} requests per ${cfg.windowMs / 1000}s window`,
        )
      }

      await next()
    } catch (e) {
      if (e instanceof NFTPersonalityError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 429)
      }

      // Redis failure is non-fatal — allow the request through
      // Log the error but don't block the user
      await next()
    }
  }
}
