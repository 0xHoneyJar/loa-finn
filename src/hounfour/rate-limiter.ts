// src/hounfour/rate-limiter.ts — Per-provider token bucket rate limiter (SDD §4.8, T-16.3)
// RPM and TPM buckets per provider. Requests queue (up to timeout) when over limit.

// --- Token Bucket ---

export class HounfourTokenBucket {
  private tokens: number
  private lastRefillTime: number
  private readonly clock: () => number

  constructor(
    public readonly capacity: number,
    public readonly refillPerMinute: number,
    clock: () => number = Date.now,
  ) {
    if (capacity <= 0 || refillPerMinute <= 0) {
      throw new Error(`Invalid token bucket config: capacity=${capacity}, refillPerMinute=${refillPerMinute}`)
    }
    this.tokens = capacity
    this.lastRefillTime = clock()
    this.clock = clock
  }

  tryConsume(amount: number = 1): boolean {
    this.refill()
    if (this.tokens < amount) return false
    this.tokens -= amount
    return true
  }

  remaining(): number {
    this.refill()
    return Math.floor(this.tokens)
  }

  /** Refund tokens (e.g., when a downstream acquisition fails) */
  addTokens(amount: number = 1): void {
    if (amount <= 0) return
    this.refill()
    this.tokens = Math.min(this.capacity, this.tokens + amount)
  }

  /** Time in ms until `amount` tokens are available */
  timeUntilAvailable(amount: number = 1): number {
    this.refill()
    if (this.tokens >= amount) return 0
    const deficit = amount - this.tokens
    const msPerToken = 60_000 / this.refillPerMinute
    return Math.ceil(deficit * msPerToken)
  }

  private refill(): void {
    const now = this.clock()
    const elapsedMs = now - this.lastRefillTime
    if (elapsedMs <= 0) return

    const elapsedMinutes = elapsedMs / 60_000
    const tokensToAdd = elapsedMinutes * this.refillPerMinute
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd)
    this.lastRefillTime = now
  }
}

// --- Config ---

export interface ProviderRateLimitConfig {
  rpm: number                     // Requests per minute
  tpm: number                     // Tokens per minute (estimated)
  queue_timeout_ms: number        // Max wait time when rate-limited (default: 30000)
}

const DEFAULT_RATE_LIMIT: ProviderRateLimitConfig = {
  rpm: 60,
  tpm: 100_000,
  queue_timeout_ms: 30_000,
}

// --- Provider Rate Limiter ---

export class ProviderRateLimiter {
  private buckets = new Map<string, { rpm: HounfourTokenBucket; tpm: HounfourTokenBucket }>()
  private configs: Record<string, ProviderRateLimitConfig>
  private clock: () => number

  constructor(
    config: Record<string, Partial<ProviderRateLimitConfig>> = {},
    clock: () => number = Date.now,
  ) {
    this.clock = clock
    this.configs = {}
    for (const [provider, cfg] of Object.entries(config)) {
      this.configs[provider] = { ...DEFAULT_RATE_LIMIT, ...cfg }
    }
  }

  /**
   * Acquire rate limit tokens. Queues up to timeout if over limit.
   * Called ONCE per logical request (not per retry).
   * Returns true if acquired, false if timed out.
   */
  async acquire(provider: string, estimatedTokens: number = 1): Promise<boolean> {
    const buckets = this.getOrCreateBuckets(provider)
    const config = this.configs[provider] ?? DEFAULT_RATE_LIMIT
    const deadline = this.clock() + config.queue_timeout_ms

    // Try RPM first
    while (!buckets.rpm.tryConsume(1)) {
      const wait = buckets.rpm.timeUntilAvailable(1)
      if (this.clock() + wait > deadline) return false
      await this.sleep(Math.min(wait, 100))
    }

    // Then TPM
    while (!buckets.tpm.tryConsume(estimatedTokens)) {
      const wait = buckets.tpm.timeUntilAvailable(estimatedTokens)
      if (this.clock() + wait > deadline) {
        // Refund the RPM token since we couldn't get TPM
        buckets.rpm.addTokens(1)
        return false
      }
      await this.sleep(Math.min(wait, 100))
    }

    return true
  }

  /** Release — no-op for token buckets (placeholder for future semaphore) */
  release(_provider: string): void {
    // No-op: token buckets auto-refill
  }

  /** Get current rate limit status for a provider */
  getStatus(provider: string): { rpm_remaining: number; tpm_remaining: number } | undefined {
    const buckets = this.buckets.get(provider)
    if (!buckets) return undefined
    return {
      rpm_remaining: buckets.rpm.remaining(),
      tpm_remaining: buckets.tpm.remaining(),
    }
  }

  private getOrCreateBuckets(provider: string): { rpm: HounfourTokenBucket; tpm: HounfourTokenBucket } {
    let b = this.buckets.get(provider)
    if (!b) {
      const config = this.configs[provider] ?? DEFAULT_RATE_LIMIT
      b = {
        rpm: new HounfourTokenBucket(config.rpm, config.rpm, this.clock),
        tpm: new HounfourTokenBucket(config.tpm, config.tpm, this.clock),
      }
      this.buckets.set(provider, b)
    }
    return b
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
