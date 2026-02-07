// src/bridgebuilder/adapters/r2-context.ts

import type { IContextStore, ContextData } from "../ports/index.js"
import type { R2CheckpointStorage } from "../../persistence/r2-storage.js"

const CONTEXT_KEY = "bridgebuilder/context.json"
const IDEM_PREFIX = "bridgebuilder/reviewed/"

/** In-progress claims expire after this many minutes (allows retry on failure). */
const CLAIM_TTL_MINUTES = 10

const EMPTY_CONTEXT: ContextData = {
  reviews: [],
  stats: { totalRuns: 0, totalReviews: 0 },
}

interface ClaimRecord {
  status: "in-progress" | "posted"
  claimedAt: string
  expiresAt?: string  // only set for in-progress
  postedAt?: string   // only set for posted
}

/**
 * R2-backed context store with two-phase idempotency claims.
 *
 * R2 does not support true CAS (conditional writes). The claimReview
 * check-then-write has a small race window. This is acceptable because:
 * 1. The GitHub marker is the primary idempotency gate — checked first
 *    AND re-checked before posting in ReviewPipeline.reviewItem.
 * 2. The R2-backed lease with read-after-write verification prevents
 *    most concurrent runs.
 * 3. The R2 claim is defense-in-depth, not the sole authority.
 * 4. Claims use a two-phase lifecycle: claimReview writes "in-progress"
 *    with TTL, finalizeReview upgrades to permanent "posted".
 * 5. Permanent "posted" claims are never overwritten.
 */
export class R2ContextAdapter implements IContextStore {
  constructor(private readonly r2: R2CheckpointStorage) {}

  async load(): Promise<ContextData> {
    const buf = await this.r2.readFile(CONTEXT_KEY)
    if (!buf) return { ...EMPTY_CONTEXT, reviews: [], stats: { ...EMPTY_CONTEXT.stats } }
    try {
      return JSON.parse(buf.toString("utf-8")) as ContextData
    } catch {
      return { ...EMPTY_CONTEXT, reviews: [], stats: { ...EMPTY_CONTEXT.stats } }
    }
  }

  async save(data: ContextData): Promise<void> {
    const buf = Buffer.from(JSON.stringify(data), "utf-8")
    await this.r2.writeFile(CONTEXT_KEY, buf)
  }

  /**
   * Two-phase claim: writes "in-progress" with TTL.
   * Returns false if a valid claim exists (posted, or in-progress and not expired).
   * Expired in-progress claims are overwritten (allows retry after failure).
   */
  async claimReview(repo: string, prNumber: number, headSha: string): Promise<boolean> {
    const key = `${IDEM_PREFIX}${repo}/${prNumber}/${headSha}`

    // Check existing claim
    const existing = await this.r2.readFile(key)
    if (existing) {
      try {
        const record = JSON.parse(existing.toString("utf-8")) as ClaimRecord
        // Permanent "posted" claims are never overwritten
        if (record.status === "posted") return false
        // In-progress claims expire after TTL — allow retry
        if (record.expiresAt && new Date(record.expiresAt) > new Date()) {
          return false // Still in progress, not expired
        }
        // Expired in-progress — fall through to overwrite
      } catch {
        // Corrupt claim — overwrite
      }
    }

    // Write in-progress claim with TTL
    const now = new Date()
    const claim: ClaimRecord = {
      status: "in-progress",
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CLAIM_TTL_MINUTES * 60_000).toISOString(),
    }
    return this.r2.writeFile(key, Buffer.from(JSON.stringify(claim), "utf-8"))
  }

  /**
   * Finalize claim after successful post. Upgrades to permanent "posted" record.
   */
  async finalizeReview(repo: string, prNumber: number, headSha: string): Promise<void> {
    const key = `${IDEM_PREFIX}${repo}/${prNumber}/${headSha}`
    const record: ClaimRecord = {
      status: "posted",
      claimedAt: new Date().toISOString(),
      postedAt: new Date().toISOString(),
    }
    await this.r2.writeFile(key, Buffer.from(JSON.stringify(record), "utf-8"))
  }
}
