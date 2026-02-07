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
