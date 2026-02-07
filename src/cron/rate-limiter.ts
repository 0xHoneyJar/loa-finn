// src/cron/rate-limiter.ts — Token bucket rate limiter with GitHub secondary limit handling (SDD §4.10)
// Provides global + per-job rate limiting with exponential backoff and jitter.

import { EventEmitter } from "node:events"

// ── Types ────────────────────────────────────────────────────

export interface RateLimiterConfig {
  globalCapacity?: number      // default 500
  globalRefillPerHour?: number // default 500
  jobCapacity?: number         // default 100
  jobRefillPerHour?: number    // default 100
}

export type RateLimitClassification = "primary" | "secondary" | "none"

export interface RateLimitEvent {
  type: "ratelimit:primary" | "ratelimit:secondary"
  remaining: number
  resetAt?: string
  retryAfterMs?: number
}

// ── TokenBucket ──────────────────────────────────────────────
// SDD §4.10 — Fixed-capacity bucket with time-based refill.
// Tokens refill linearly based on elapsed time since last refill,
// capped at capacity. tryConsume() atomically checks and deducts.

export class TokenBucket {
  public readonly capacity: number
  public readonly refillPerHour: number

  private tokens: number
  private lastRefillTime: number
  private readonly clock: () => number

  constructor(
    capacity: number,
    refillPerHour: number,
    clock: () => number = Date.now,
  ) {
    this.capacity = capacity
    this.refillPerHour = refillPerHour
    this.tokens = capacity // Start full
    this.lastRefillTime = clock()
    this.clock = clock
  }

  // Attempt to consume one token. Returns true if consumed, false if exhausted.
  tryConsume(): boolean {
    this.refill()
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }

  // Current token count (after refill).
  remaining(): number {
    this.refill()
    return Math.floor(this.tokens)
  }

  // Refill tokens based on elapsed time. Capped at capacity.
  private refill(): void {
    const now = this.clock()
    const elapsedMs = now - this.lastRefillTime
    if (elapsedMs <= 0) return

    const elapsedHours = elapsedMs / 3_600_000
    const tokensToAdd = elapsedHours * this.refillPerHour
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd)
    this.lastRefillTime = now
  }
}

// ── Rate Limit Classification ────────────────────────────────
// SDD §4.10 — Distinguish GitHub primary (429) vs secondary (403 + Retry-After) limits.

export function classifyRateLimit(
  status: number,
  headers: Record<string, string>,
): RateLimitClassification {
  // Primary rate limit: HTTP 429 Too Many Requests
  if (status === 429) return "primary"

  // Secondary/abuse rate limit: HTTP 403 with Retry-After header
  // GitHub sends 403 with Retry-After for secondary/abuse limits
  if (status === 403) {
    const retryAfter = headers["retry-after"] ?? headers["Retry-After"]
    if (retryAfter !== undefined) return "secondary"
  }

  return "none"
}

// ── Backoff Calculation ──────────────────────────────────────
// SDD §4.10 — Exponential backoff with jitter for rate limit retries.
// Base 1s, max 60s, jitter +/-25%.

export function getBackoffMs(
  attempt: number,
  classification: RateLimitClassification,
): number {
  const baseMs = 1000
  const maxMs = 60_000

  // Secondary limits are more aggressive; use higher base multiplier
  const multiplier = classification === "secondary" ? 2 : 1

  // Exponential: base * multiplier * 2^attempt, capped at max
  const rawMs = Math.min(maxMs, baseMs * multiplier * Math.pow(2, attempt))

  // Jitter: +/-25% — uniform random in [0.75, 1.25]
  const jitter = 0.75 + Math.random() * 0.5

  return Math.floor(rawMs * jitter)
}

// ── RateLimiter ──────────────────────────────────────────────
// SDD §4.10 — Combines global + per-job token buckets with event emission.
// Lazily initializes per-job buckets on first access.

export class RateLimiter extends EventEmitter {
  private readonly globalBucket: TokenBucket
  private readonly jobBuckets: Map<string, TokenBucket> = new Map()
  private readonly config: Required<RateLimiterConfig>
  private readonly clock: () => number

  constructor(config: RateLimiterConfig = {}, clock: () => number = Date.now) {
    super()
    this.clock = clock
    this.config = {
      globalCapacity: config.globalCapacity ?? 500,
      globalRefillPerHour: config.globalRefillPerHour ?? 500,
      jobCapacity: config.jobCapacity ?? 100,
      jobRefillPerHour: config.jobRefillPerHour ?? 100,
    }
    this.globalBucket = new TokenBucket(
      this.config.globalCapacity,
      this.config.globalRefillPerHour,
      this.clock,
    )
  }

  // Try to consume one token for a tool invocation.
  // Checks global bucket first, then per-job bucket (if jobId provided).
  // Returns true if allowed, false if rate-limited.
  tryConsume(toolName: string, jobId?: string): boolean {
    // Check global bucket first — deny early if global is exhausted
    if (!this.globalBucket.tryConsume()) {
      return false
    }

    // If a jobId is specified, also check/consume from the per-job bucket
    if (jobId !== undefined) {
      const jobBucket = this.getOrCreateJobBucket(jobId)
      if (!jobBucket.tryConsume()) {
        return false
      }
    }

    return true
  }

  // Get remaining tokens for the global bucket, and optionally a specific job.
  getRemainingTokens(jobId?: string): { global: number; job?: number } {
    const result: { global: number; job?: number } = {
      global: this.globalBucket.remaining(),
    }

    if (jobId !== undefined) {
      const jobBucket = this.jobBuckets.get(jobId)
      result.job = jobBucket?.remaining() ?? this.config.jobCapacity
    }

    return result
  }

  // Handle a rate-limited HTTP response. Classifies the response,
  // emits the appropriate event, and returns the backoff delay.
  handleRateLimitResponse(
    status: number,
    headers: Record<string, string>,
    attempt: number,
  ): { classification: RateLimitClassification; backoffMs: number } {
    const classification = classifyRateLimit(status, headers)

    if (classification === "none") {
      return { classification, backoffMs: 0 }
    }

    // Parse Retry-After header (seconds) if present — override computed backoff
    const retryAfterRaw = headers["retry-after"] ?? headers["Retry-After"]
    let retryAfterMs: number | undefined
    if (retryAfterRaw !== undefined) {
      const seconds = parseInt(retryAfterRaw, 10)
      if (!isNaN(seconds) && seconds > 0) {
        retryAfterMs = seconds * 1000
      }
    }

    const computedBackoff = getBackoffMs(attempt, classification)
    // Respect server Retry-After if provided, otherwise use computed backoff
    const backoffMs = retryAfterMs ?? computedBackoff

    // Parse x-ratelimit-reset for the event metadata
    const resetHeader = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"]
    const resetAt = resetHeader
      ? new Date(parseInt(resetHeader, 10) * 1000).toISOString()
      : undefined

    const remainingHeader = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"]
    const remaining = remainingHeader !== undefined ? parseInt(remainingHeader, 10) : 0

    const event: RateLimitEvent = {
      type: classification === "primary" ? "ratelimit:primary" : "ratelimit:secondary",
      remaining: isNaN(remaining) ? 0 : remaining,
      resetAt,
      retryAfterMs: backoffMs,
    }

    this.emit(event.type, event)

    return { classification, backoffMs }
  }

  // Lazily create a per-job bucket using the configured job limits.
  private getOrCreateJobBucket(jobId: string): TokenBucket {
    let bucket = this.jobBuckets.get(jobId)
    if (!bucket) {
      bucket = new TokenBucket(
        this.config.jobCapacity,
        this.config.jobRefillPerHour,
        this.clock,
      )
      this.jobBuckets.set(jobId, bucket)
    }
    return bucket
  }
}
