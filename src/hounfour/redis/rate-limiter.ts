// src/hounfour/redis/rate-limiter.ts — Redis-backed rate limiter (SDD §4.6.4, T-2.10)
//
// RPM: Sliding window sorted set. TPM: Two-window weighted hash counters.
// Fallback: fail-open — if Redis unavailable, allow requests through.

import { randomUUID } from "node:crypto"
import type { RedisStateBackend } from "./client.js"

// --- Types ---

export interface RateLimitConfig {
  rpm: number                    // Requests per minute
  tpm: number                    // Tokens per minute
}

export interface RateLimiterResult {
  allowed: boolean
  remaining: number
}

// --- Lua Scripts ---

const RPM_LIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member_id = ARGV[4]
local window_start = now - window

redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member_id)
  redis.call('EXPIRE', key, math.ceil(window / 1000) + 1)
  return 1
end
return 0
`

const TPM_LIMIT_LUA = `
local curr_key = KEYS[1]
local prev_key = KEYS[2]
local bucket = ARGV[1]
local tokens = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local elapsed = tonumber(ARGV[5])

local curr_all = redis.call('HGETALL', curr_key)
local curr_total = 0
for i = 2, #curr_all, 2 do
  curr_total = curr_total + tonumber(curr_all[i])
end

local prev_total = 0
if redis.call('EXISTS', prev_key) == 1 then
  local prev_all = redis.call('HGETALL', prev_key)
  for i = 2, #prev_all, 2 do
    prev_total = prev_total + tonumber(prev_all[i])
  end
end

local effective = prev_total * (1 - elapsed) + curr_total

if (effective + tokens) <= limit then
  redis.call('HINCRBY', curr_key, bucket, tokens)
  redis.call('EXPIRE', curr_key, ttl)
  return 1
end
return 0
`

// --- RedisRateLimiter ---

/**
 * Redis-backed rate limiter with separate RPM and TPM enforcement.
 *
 * Fail-open: if Redis unavailable, allow requests (provider 429s are backstop).
 */
export class RedisRateLimiter {
  constructor(
    private redis: RedisStateBackend | null,
    private limits: Map<string, RateLimitConfig>,
  ) {}

  /** Compose a rate limit key from provider + model */
  private rateKey(provider: string, model: string): string {
    return `${provider}:${model}`
  }

  /**
   * Pre-flight RPM check: call before sending a request.
   * Returns true if request is allowed, false if rate limited.
   */
  async acquireRequest(provider: string, model: string): Promise<boolean> {
    const config = this.limits.get(this.rateKey(provider, model))
    if (!config) return true // No limit configured

    if (!this.redis?.isConnected()) return true // Fail-open

    try {
      const key = this.redis.key("rate", provider, model, "rpm")
      const now = Date.now()
      const memberId = randomUUID()

      const result = await this.redis.getClient().eval(
        RPM_LIMIT_LUA,
        1,       // numkeys
        key,     // KEYS[1]
        now,     // ARGV[1] = current timestamp
        60000,   // ARGV[2] = window size (60s)
        config.rpm, // ARGV[3] = max requests
        memberId,   // ARGV[4] = unique member ID
      )

      return result === 1
    } catch {
      return true // Fail-open
    }
  }

  /**
   * Post-flight TPM recording: call after receiving usage info.
   * Records token count and returns true if within limit.
   */
  async recordTokens(provider: string, model: string, tokens: number): Promise<boolean> {
    const config = this.limits.get(this.rateKey(provider, model))
    if (!config) return true

    if (!this.redis?.isConnected()) return true // Fail-open

    try {
      const now = new Date()
      const currentMinute = Math.floor(now.getTime() / 60000)
      const prevMinute = currentMinute - 1
      const currentSecond = now.getSeconds()
      const elapsedFraction = (currentSecond / 60).toFixed(4)

      const currKey = this.redis.key("rate", provider, model, "tpm", String(currentMinute))
      const prevKey = this.redis.key("rate", provider, model, "tpm", String(prevMinute))

      const result = await this.redis.getClient().eval(
        TPM_LIMIT_LUA,
        2,                  // numkeys
        currKey,            // KEYS[1]
        prevKey,            // KEYS[2]
        String(currentSecond), // ARGV[1] = bucket
        tokens,             // ARGV[2] = token count
        config.tpm,         // ARGV[3] = TPM limit
        120,                // ARGV[4] = hash TTL (2 windows)
        elapsedFraction,    // ARGV[5] = elapsed fraction
      )

      return result === 1
    } catch {
      return true // Fail-open
    }
  }

  /**
   * Query remaining capacity for RPM.
   */
  async getRpmRemaining(provider: string, model: string): Promise<number> {
    const config = this.limits.get(this.rateKey(provider, model))
    if (!config) return Infinity

    if (!this.redis?.isConnected()) return config.rpm

    try {
      const key = this.redis.key("rate", provider, model, "rpm")
      const now = Date.now()
      await this.redis.getClient().zremrangebyscore(key, "-inf", now - 60000)
      const count = await this.redis.getClient().zcard(key)
      return Math.max(0, config.rpm - count)
    } catch {
      return config.rpm // Fail-open
    }
  }
}
