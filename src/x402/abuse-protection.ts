// src/x402/abuse-protection.ts — x402 Abuse Protection (SDD §7.1.1, T-3.7)
//
// Three-layer protection:
//   1. Quote rate limit: 60 quotes/min/IP (Redis INCR + TTL)
//   2. Dust rejection: < 100 MicroUSDC rejected BEFORE sig verify
//   3. CPU DoS: max 10 concurrent signature verifications (semaphore)

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { X402Error } from "./types.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AbuseProtectionConfig {
  /** Max quotes per IP per minute (default: 60) */
  quoteRateLimitPerMinute?: number
  /** Minimum payment in MicroUSDC (default: 100 = $0.0001) */
  minPaymentMicroUSDC?: bigint
  /** Max concurrent signature verifications (default: 10) */
  maxConcurrentVerifications?: number
}

const DEFAULT_QUOTE_RATE_LIMIT = 60
const DEFAULT_MIN_PAYMENT = 100n
const DEFAULT_MAX_CONCURRENT_VERIFICATIONS = 10

// ---------------------------------------------------------------------------
// Quote Rate Limiter
// ---------------------------------------------------------------------------

export class QuoteRateLimiter {
  private readonly redis: RedisCommandClient
  private readonly limitPerMinute: number

  constructor(redis: RedisCommandClient, limitPerMinute: number = DEFAULT_QUOTE_RATE_LIMIT) {
    this.redis = redis
    this.limitPerMinute = limitPerMinute
  }

  /**
   * Check and increment quote count for an IP.
   * Throws X402Error with 429 if rate exceeded.
   */
  async checkQuoteRate(ip: string): Promise<void> {
    const key = `x402:quote-rate:${ip}`
    const count = await this.redis.incr(key)

    // Set TTL on first increment (60s window)
    if (count === 1) {
      await this.redis.expire(key, 60)
    }

    if (count > this.limitPerMinute) {
      throw new X402Error(
        `Quote rate limit exceeded: ${count}/${this.limitPerMinute} per minute`,
        "RATE_LIMITED",
        429,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Dust Rejection
// ---------------------------------------------------------------------------

/**
 * Reject payments below minimum threshold BEFORE signature verification.
 * Prevents CPU exhaustion via trivial invalid payments.
 */
export function rejectDustPayment(
  valueMicroUSDC: bigint,
  minPayment: bigint = DEFAULT_MIN_PAYMENT,
): void {
  if (valueMicroUSDC < minPayment) {
    throw new X402Error(
      `Payment ${valueMicroUSDC} below minimum threshold ${minPayment}`,
      "PAYMENT_TOO_SMALL",
      402,
    )
  }
}

// ---------------------------------------------------------------------------
// Signature Verification Semaphore
// ---------------------------------------------------------------------------

export class VerificationSemaphore {
  private active = 0
  private readonly maxConcurrent: number
  private readonly waitQueue: Array<() => void> = []

  constructor(maxConcurrent: number = DEFAULT_MAX_CONCURRENT_VERIFICATIONS) {
    this.maxConcurrent = maxConcurrent
  }

  /**
   * Execute a signature verification under semaphore control.
   * Returns 503 if queue is full (no waiting — fail fast).
   */
  async verify<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      throw new X402Error(
        `Signature verification queue full (${this.active}/${this.maxConcurrent})`,
        "VERIFICATION_QUEUE_FULL",
        503,
      )
    }

    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      // Wake next waiter if any
      const next = this.waitQueue.shift()
      if (next) next()
    }
  }

  /** Current active verification count (for health checks). */
  get activeCount(): number {
    return this.active
  }
}

// ---------------------------------------------------------------------------
// Composed Abuse Protection
// ---------------------------------------------------------------------------

export class AbuseProtection {
  readonly rateLimiter: QuoteRateLimiter
  readonly semaphore: VerificationSemaphore
  private readonly minPayment: bigint

  constructor(redis: RedisCommandClient, config?: AbuseProtectionConfig) {
    this.rateLimiter = new QuoteRateLimiter(redis, config?.quoteRateLimitPerMinute)
    this.semaphore = new VerificationSemaphore(config?.maxConcurrentVerifications)
    this.minPayment = config?.minPaymentMicroUSDC ?? DEFAULT_MIN_PAYMENT
  }

  /** Check quote rate for an IP address. */
  async checkQuoteRate(ip: string): Promise<void> {
    return this.rateLimiter.checkQuoteRate(ip)
  }

  /** Reject dust payment before signature verification. */
  checkDustPayment(valueMicroUSDC: bigint): void {
    rejectDustPayment(valueMicroUSDC, this.minPayment)
  }

  /** Run signature verification under semaphore. */
  async verifySignature<T>(fn: () => Promise<T>): Promise<T> {
    return this.semaphore.verify(fn)
  }
}
