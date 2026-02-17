// src/gateway/oracle-concurrency.ts — In-memory concurrency limiter (SDD §3.4)
// Limits concurrent Oracle requests per ECS task to prevent resource starvation.

import type { Context, Next } from "hono"

/**
 * Global in-memory concurrency limiter for Oracle requests per ECS task.
 *
 * LIMITATION (BB-025-003): This is a global semaphore, not per-identity.
 * A single aggressive client can consume all slots, starving others.
 * Acceptable for Phase 1 with single-replica ECS (desired_count=1).
 * Phase 2: migrate to per-identity concurrency (Map<string, number>)
 * when the JSONL ledger moves to a shared store and autoscaling is enabled.
 */
export class ConcurrencyLimiter {
  private active = 0

  constructor(private maxConcurrent: number) {}

  acquire(): boolean {
    if (this.active >= this.maxConcurrent) return false
    this.active++
    return true
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
  }

  getActive(): number {
    return this.active
  }
}

export function oracleConcurrencyMiddleware(limiter: ConcurrencyLimiter) {
  return async (c: Context, next: Next) => {
    if (!limiter.acquire()) {
      c.header("Retry-After", "5")
      return c.json(
        { error: "Too many concurrent Oracle requests", code: "ORACLE_CONCURRENCY_EXCEEDED" },
        429,
      )
    }
    try {
      return await next()
    } finally {
      limiter.release()
    }
  }
}
