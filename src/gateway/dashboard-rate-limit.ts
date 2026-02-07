// src/gateway/dashboard-rate-limit.ts — Per-IP rate limiting for dashboard API endpoints (TASK-6.7)

export interface RateLimitConfig {
  maxRequests: number   // default: 60
  windowMs: number      // default: 60_000 (1 minute)
}

export interface RateLimitRequest {
  remoteAddr: string    // Client IP for keying
}

export interface RateLimitResult {
  allowed: boolean
  headers: Record<string, string>  // Always includes X-RateLimit-* headers
  retryAfterSeconds?: number       // Only when not allowed
}

interface WindowEntry {
  count: number
  windowStart: number
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60_000,
}

export class DashboardRateLimiter {
  private config: RateLimitConfig
  private windows = new Map<string, WindowEntry>()

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Check rate limit for a request and return result with standard headers. */
  check(req: RateLimitRequest): RateLimitResult {
    const now = Date.now()
    const { maxRequests, windowMs } = this.config
    let entry = this.windows.get(req.remoteAddr)

    // Reset window if expired or first request
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now }
      this.windows.set(req.remoteAddr, entry)
    }

    entry.count++

    const remaining = Math.max(0, maxRequests - entry.count)
    const resetUnix = Math.ceil((entry.windowStart + windowMs) / 1000)

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(maxRequests),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset": String(resetUnix),
    }

    if (entry.count > maxRequests) {
      const retryAfterSeconds = Math.ceil((entry.windowStart + windowMs - now) / 1000)
      headers["Retry-After"] = String(retryAfterSeconds)
      return { allowed: false, headers, retryAfterSeconds }
    }

    return { allowed: true, headers }
  }

  /** Remove stale entries older than 2x the window. */
  cleanup(): void {
    const staleThreshold = Date.now() - this.config.windowMs * 2
    for (const [ip, entry] of this.windows) {
      if (entry.windowStart < staleThreshold) {
        this.windows.delete(ip)
      }
    }
  }
}
