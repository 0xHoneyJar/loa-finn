// src/bridgebuilder/core/context.ts

import type { IContextStore, ContextData, ReviewRecord } from "../ports/index.js"
import type { BridgebuilderConfig } from "./types.js"

const MAX_REVIEW_RECORDS = 1000

/**
 * BridgebuilderContext bridges the IContextStore port with the
 * JobContext interface expected by JobRunner.
 *
 * It tracks which PRs have been reviewed (by headSha) and enforces
 * bounded storage via FIFO eviction.
 */
export class BridgebuilderContext {
  private data: ContextData = {
    reviews: [],
    stats: { totalRuns: 0, totalReviews: 0 },
  }

  constructor(
    private readonly store: IContextStore,
    private readonly config: BridgebuilderConfig,
  ) {}

  async load(): Promise<void> {
    this.data = await this.store.load()
  }

  async save(): Promise<void> {
    await this.store.save(this.data)
  }

  /**
   * Check if a PR needs review. Returns true if:
   * 1. Never reviewed, OR
   * 2. headSha changed (new commits), OR
   * 3. Re-review timer expired (if configured)
   */
  hasChanged(repo: string, prNumber: number, headSha: string): boolean {
    const existing = this.data.reviews.find(
      r => r.repo === repo && r.prNumber === prNumber,
    )
    if (!existing) return true
    if (existing.headSha !== headSha) return true

    // Optional re-review timer
    if (this.config.reReviewHours !== undefined) {
      const reviewedAt = new Date(existing.reviewedAt).getTime()
      const cutoff = reviewedAt + this.config.reReviewHours * 60 * 60 * 1000
      if (Date.now() >= cutoff) return true
    }

    return false
  }

  /**
   * Attempt to claim the idempotency key via CAS (two-phase).
   * Writes an in-progress record with TTL. Delegates to store.
   */
  async claimReview(repo: string, prNumber: number, headSha: string): Promise<boolean> {
    return this.store.claimReview(repo, prNumber, headSha)
  }

  /**
   * Finalize claim after successful post. Upgrades to permanent "posted".
   * Must be called after posting to prevent claim expiry and retry loops.
   */
  async finalizeReview(repo: string, prNumber: number, headSha: string): Promise<void> {
    await this.store.finalizeReview(repo, prNumber, headSha)
  }

  /** Record a successful review. */
  recordReview(record: ReviewRecord): void {
    // Update existing or add new
    const idx = this.data.reviews.findIndex(
      r => r.repo === record.repo && r.prNumber === record.prNumber,
    )
    if (idx >= 0) {
      this.data.reviews[idx] = record
    } else {
      this.data.reviews.push(record)
    }

    this.data.stats.totalReviews++
    this.enforceBounds()
  }

  /** Record a run. */
  recordRun(): void {
    this.data.stats.totalRuns++
    this.data.stats.lastRunAt = new Date().toISOString()
  }

  private enforceBounds(): void {
    if (this.data.reviews.length > MAX_REVIEW_RECORDS) {
      this.data.reviews.sort(
        (a, b) => new Date(a.reviewedAt).getTime() - new Date(b.reviewedAt).getTime(),
      )
      this.data.reviews = this.data.reviews.slice(
        this.data.reviews.length - MAX_REVIEW_RECORDS,
      )
    }
  }
}
