/**
 * Reputation Bootstrap — Sprint 2 (GID 125), Tasks T2.3 + T2.4
 *
 * Collection-level reputation aggregation with anti-manipulation guardrails
 * and Bayesian pseudo-count blending for warm-start routing.
 *
 * The Netflix cold-start parallel: when a new personality has no quality history,
 * use the collection's accumulated quality as a Bayesian prior. The prior fades
 * monotonically as personal data accumulates — earned reputation always dominates
 * inherited reputation.
 *
 * Anti-manipulation (v1 defenses):
 * - Minimum sample threshold: only personalities with sufficient history contribute
 * - Max contributor cap: limits influence of any single collection
 * - Trimmed mean: discards outliers before averaging
 * - Confidence weighting: new personalities have less influence
 */

import type { QualityScore } from "./routing-quality.js"
import type { RoutingQualityStore } from "./routing-quality.js"
import { extractPoolId } from "./routing-quality.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReputationConfig {
  /** Minimum quality events per personality to contribute to collection (default: 5) */
  minSampleCount?: number
  /** Max personalities contributing per pool (default: 20) */
  maxContributors?: number
  /** Bayesian pseudo-count k for collection prior blending (default: 3) */
  pseudoCount?: number
  /** Confidence weighting denominator — full confidence at this many events (default: 50) */
  confidenceDenominator?: number
}

const DEFAULT_MIN_SAMPLE_COUNT = 5
const DEFAULT_MAX_CONTRIBUTORS = 20
const DEFAULT_PSEUDO_COUNT = 3
const DEFAULT_CONFIDENCE_DENOMINATOR = 50

/** Parse int from env var with fallback */
function parseIntEnv(key: string, fallback: number): number {
  const val = process.env[key]
  if (!val) return fallback
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// ---------------------------------------------------------------------------
// Reputation Bootstrap
// ---------------------------------------------------------------------------

export class ReputationBootstrap {
  private readonly store: RoutingQualityStore
  private readonly minSampleCount: number
  private readonly maxContributors: number
  private readonly pseudoCount: number
  private readonly confidenceDenominator: number

  constructor(store: RoutingQualityStore, config: ReputationConfig = {}) {
    this.store = store
    this.minSampleCount = config.minSampleCount
      ?? parseIntEnv("FINN_BOOTSTRAP_MIN_SAMPLES", DEFAULT_MIN_SAMPLE_COUNT)
    this.maxContributors = config.maxContributors
      ?? parseIntEnv("FINN_BOOTSTRAP_MAX_CONTRIBUTORS", DEFAULT_MAX_CONTRIBUTORS)
    this.pseudoCount = config.pseudoCount
      ?? parseIntEnv("FINN_BOOTSTRAP_PSEUDO_COUNT", DEFAULT_PSEUDO_COUNT)
    this.confidenceDenominator = config.confidenceDenominator ?? DEFAULT_CONFIDENCE_DENOMINATOR
  }

  // -------------------------------------------------------------------------
  // T2.3: Collection-level reputation aggregation
  // -------------------------------------------------------------------------

  /**
   * Compute collection-level quality for a specific pool.
   *
   * Algorithm:
   * 1. Get all cacheKeys for collectionId from secondary index
   * 2. Filter to matching pool
   * 3. Exclude personalities below minSampleCount
   * 4. Cap at maxContributors (by highest sample_count)
   * 5. Apply confidence weighting: min(sample_count / 50, 1.0)
   * 6. Trimmed mean: discard highest and lowest, weighted-average the rest
   *
   * Returns null if fewer than 2 qualifying personalities (can't trim).
   */
  getCollectionQuality(collectionId: string, poolId: string): QualityScore | null {
    const collectionKeys = this.store.index.getCollectionKeys(collectionId)
    if (!collectionKeys) return null

    // Filter by pool and gather qualifying personalities
    const qualifying: Array<{ score: number; sampleCount: number; lastUpdated: number }> = []

    for (const cacheKey of collectionKeys) {
      if (extractPoolId(cacheKey) !== poolId) continue

      const quality = this.store.getIndexedQuality(cacheKey)
      if (!quality) continue

      // Minimum sample threshold (anti-manipulation)
      if (quality.sample_count < this.minSampleCount) continue

      qualifying.push({
        score: quality.score,
        sampleCount: quality.sample_count,
        lastUpdated: quality.last_updated,
      })
    }

    // Need at least 2 personalities for trimmed mean
    if (qualifying.length < 2) return null

    // Cap at maxContributors — take those with highest sample_count
    qualifying.sort((a, b) => b.sampleCount - a.sampleCount)
    const contributors = qualifying.slice(0, this.maxContributors)

    // Sort by score for trimming
    contributors.sort((a, b) => a.score - b.score)

    // Trimmed mean: discard highest and lowest
    const trimmed = contributors.slice(1, -1)

    // If trimming leaves nothing (only 2 contributors), use both
    const toAverage = trimmed.length > 0 ? trimmed : contributors

    // Confidence-weighted average
    let weightedSum = 0
    let totalWeight = 0
    let maxTimestamp = 0
    let totalSamples = 0

    for (const entry of toAverage) {
      const confidence = Math.min(entry.sampleCount / this.confidenceDenominator, 1.0)
      weightedSum += entry.score * confidence
      totalWeight += confidence
      if (entry.lastUpdated > maxTimestamp) maxTimestamp = entry.lastUpdated
      totalSamples += entry.sampleCount
    }

    if (totalWeight === 0) return null

    return {
      score: Math.max(0, Math.min(1, weightedSum / totalWeight)),
      sample_count: totalSamples,
      last_updated: maxTimestamp,
    }
  }

  // -------------------------------------------------------------------------
  // T2.4: Warm-start protocol with Bayesian pseudo-count blending
  // -------------------------------------------------------------------------

  /**
   * Get quality with bootstrap from collection reputation.
   *
   * Lookup cascade:
   * 1. Personal quality exists → blend with collection prior (Bayesian)
   * 2. No personal data, collection exists → pure bootstrap
   * 3. Neither → return none (static affinity)
   *
   * Bayesian blending:
   *   q_effective = (k * q_collection + n * q_personal) / (k + n)
   *
   * At n=0: pure collection prior
   * At n=5: prior weight = k/(k+n) = 3/8 = 37.5% (< 40%)
   * At n=10: prior weight ≈ 23%
   */
  getQualityWithBootstrap(
    personalityId: string,
    poolId: string,
    collectionId?: string,
  ): { score: QualityScore | null; source: "personal" | "bootstrap" | "none" } {
    // Step 1: Try personal quality
    const personal = this.store.getQualityForKey(personalityId, poolId)

    // Step 2: Try collection quality (if collectionId provided)
    const collection = collectionId
      ? this.getCollectionQuality(collectionId, poolId)
      : null

    // Case 1: Personal data exists
    if (personal) {
      if (collection) {
        // Bayesian blending: q_effective = (k * q_collection + n * q_personal) / (k + n)
        const k = this.pseudoCount
        const n = personal.sample_count
        const qEffective = (k * collection.score + n * personal.score) / (k + n)

        return {
          score: {
            score: Math.max(0, Math.min(1, qEffective)),
            sample_count: personal.sample_count,
            last_updated: personal.last_updated,
          },
          source: "personal",
        }
      }

      // Personal only, no collection data
      return { score: personal, source: "personal" }
    }

    // Case 2: No personal data, but collection exists → pure bootstrap
    if (collection) {
      return {
        score: {
          score: collection.score,
          sample_count: 0,
          last_updated: collection.last_updated,
        },
        source: "bootstrap",
      }
    }

    // Case 3: Neither
    return { score: null, source: "none" }
  }
}
