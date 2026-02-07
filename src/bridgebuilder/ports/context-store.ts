// src/bridgebuilder/ports/context-store.ts

export interface ReviewRecord {
  repo: string
  prNumber: number
  headSha: string
  reviewedAt: string
  dimensions: string[]
}

export interface ContextData {
  reviews: ReviewRecord[]
  stats: {
    totalRuns: number
    totalReviews: number
    lastRunAt?: string
  }
}

export interface IContextStore {
  /** Load context. Returns empty context if none exists. */
  load(): Promise<ContextData>

  /** Save context to persistent storage. */
  save(data: ContextData): Promise<void>

  /**
   * Attempt to claim an idempotency key (two-phase).
   * Writes an "in-progress" record with TTL. Returns true if claimed (proceed),
   * false if a valid (non-expired) claim already exists (skip).
   * Expired in-progress claims are treated as available and overwritten.
   */
  claimReview(repo: string, prNumber: number, headSha: string): Promise<boolean>

  /**
   * Finalize a claim after successful post. Upgrades the in-progress record
   * to a permanent "posted" record (no TTL). Must be called after posting
   * to prevent the claim from expiring and allowing duplicate reviews.
   */
  finalizeReview(repo: string, prNumber: number, headSha: string): Promise<void>
}
