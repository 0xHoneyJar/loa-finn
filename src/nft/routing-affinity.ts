/**
 * Routing Affinity — Sprint 2 (GID 122), Tasks T2.1 + T2.2 + T2.3
 *
 * Maps dAMP-96 genotype into model pool selection:
 * - Archetype → pool affinity (static baseline)
 * - Dial-weighted pool scoring (genotype expression)
 * - Combined scoring with configurable blend weights
 *
 * dAMP vocabulary: genotype (96 dials) → phenotypic expression (pool preference).
 * The personality becomes a routing function, not just a prompt prefix.
 *
 * Tier Safety Invariant (GPT-5.2 fix #5):
 * `allowedPoolsForTier()` is the SINGLE source of truth for pool access.
 * Called at BOTH primary selection AND health fallback. If all allowed pools
 * are unhealthy, request fails with explicit error — NEVER escalates.
 */

import type { Archetype, DAMPDialId, DAMPFingerprint } from "./signal-types.js"
// Import through tier-bridge to avoid broken loa-hounfour main index
// (index.js references missing validators/billing.js)
import type { PoolId, Tier } from "../hounfour/tier-bridge.js"
import { TIER_POOL_ACCESS } from "../hounfour/tier-bridge.js"
import type { RoutingQualityStore } from "./routing-quality.js"

// ---------------------------------------------------------------------------
// Tier Safety — authoritative pool allowlist (GPT-5.2 fix #5)
// ---------------------------------------------------------------------------

/**
 * Authoritative function for tier→pool access. Single source of truth.
 * Delegates to loa-hounfour's canonical TIER_POOL_ACCESS mapping.
 *
 * Called at BOTH primary selection AND fallback — prevents escalation.
 */
export function allowedPoolsForTier(tier: Tier): PoolId[] {
  return [...TIER_POOL_ACCESS[tier]]
}

// ---------------------------------------------------------------------------
// Archetype → Pool Affinity Matrix (T2.1)
// ---------------------------------------------------------------------------

/**
 * Static archetype→pool affinity scores [0-1].
 * Reflects each archetype's personality characteristics:
 * - freetekno: creative, experimental → favors architect + reasoning
 * - milady: aesthetic, social → favors cheap (fast chat) + architect
 * - chicago_detroit: assertive, energetic → favors fast-code + reasoning
 * - acidhouse: experimental, divergent → favors architect + reviewer
 */
export const ARCHETYPE_POOL_AFFINITY: Record<Archetype, Record<PoolId, number>> = {
  freetekno: {
    cheap: 0.3 as number,
    "fast-code": 0.4 as number,
    reviewer: 0.5 as number,
    reasoning: 0.7 as number,
    architect: 0.9 as number,
  } as Record<PoolId, number>,
  milady: {
    cheap: 0.7 as number,
    "fast-code": 0.3 as number,
    reviewer: 0.5 as number,
    reasoning: 0.4 as number,
    architect: 0.8 as number,
  } as Record<PoolId, number>,
  chicago_detroit: {
    cheap: 0.4 as number,
    "fast-code": 0.8 as number,
    reviewer: 0.6 as number,
    reasoning: 0.7 as number,
    architect: 0.5 as number,
  } as Record<PoolId, number>,
  acidhouse: {
    cheap: 0.3 as number,
    "fast-code": 0.5 as number,
    reviewer: 0.7 as number,
    reasoning: 0.6 as number,
    architect: 0.8 as number,
  } as Record<PoolId, number>,
}

/**
 * Get archetype affinity for a specific pool.
 * Returns 0.5 (neutral) if archetype or pool not found.
 */
export function getArchetypeAffinity(archetype: Archetype, poolId: PoolId): number {
  const affinities = ARCHETYPE_POOL_AFFINITY[archetype]
  if (!affinities) return 0.5
  return affinities[poolId] ?? 0.5
}

// ---------------------------------------------------------------------------
// Dial → Pool Weights (T2.2)
// ---------------------------------------------------------------------------

/**
 * Maps dial category prefixes to pool affinity boosts.
 * Each category maps to pools that benefit from high values in that dimension.
 *
 * Design: high creativity dials → architect pool. High cognitive dials → reasoning.
 * High conversational dials → cheap (fast, chatty). High assertiveness → fast-code.
 */
const DIAL_POOL_WEIGHTS: Record<string, Partial<Record<PoolId, number>>> = {
  // Social Warmth → cheap (fast chat, conversational)
  sw_: { cheap: 0.6, "fast-code": 0.1, reviewer: 0.2, reasoning: 0.1, architect: 0.3 } as Partial<Record<PoolId, number>>,
  // Conversational Style → cheap (chatty)
  cs_: { cheap: 0.7, "fast-code": 0.1, reviewer: 0.3, reasoning: 0.2, architect: 0.2 } as Partial<Record<PoolId, number>>,
  // Assertiveness → fast-code (decisive, direct)
  as_: { cheap: 0.2, "fast-code": 0.7, reviewer: 0.4, reasoning: 0.5, architect: 0.3 } as Partial<Record<PoolId, number>>,
  // Cognitive Style → reasoning (analytical, systematic)
  cg_: { cheap: 0.1, "fast-code": 0.4, reviewer: 0.5, reasoning: 0.8, architect: 0.6 } as Partial<Record<PoolId, number>>,
  // Epistemic Behavior → reasoning + reviewer
  ep_: { cheap: 0.1, "fast-code": 0.3, reviewer: 0.7, reasoning: 0.8, architect: 0.5 } as Partial<Record<PoolId, number>>,
  // Creativity → architect (literary depth, divergent)
  cr_: { cheap: 0.2, "fast-code": 0.3, reviewer: 0.4, reasoning: 0.5, architect: 0.9 } as Partial<Record<PoolId, number>>,
  // Convergence → fast-code (pragmatic, decisive)
  cv_: { cheap: 0.3, "fast-code": 0.8, reviewer: 0.5, reasoning: 0.4, architect: 0.2 } as Partial<Record<PoolId, number>>,
  // Motivation → reasoning (purpose-driven, deep)
  mo_: { cheap: 0.2, "fast-code": 0.3, reviewer: 0.4, reasoning: 0.7, architect: 0.6 } as Partial<Record<PoolId, number>>,
  // Emotional Tone → cheap (empathic, fast response)
  et_: { cheap: 0.6, "fast-code": 0.2, reviewer: 0.3, reasoning: 0.3, architect: 0.4 } as Partial<Record<PoolId, number>>,
  // Social Cognition → reviewer (perspective-taking)
  sc_: { cheap: 0.3, "fast-code": 0.2, reviewer: 0.7, reasoning: 0.5, architect: 0.4 } as Partial<Record<PoolId, number>>,
  // Agency → fast-code (initiative, action-oriented)
  ag_: { cheap: 0.2, "fast-code": 0.7, reviewer: 0.3, reasoning: 0.5, architect: 0.5 } as Partial<Record<PoolId, number>>,
  // Identity → architect (stable, coherent, deep)
  id_: { cheap: 0.2, "fast-code": 0.2, reviewer: 0.4, reasoning: 0.5, architect: 0.7 } as Partial<Record<PoolId, number>>,
}

/**
 * Get the category prefix for a DAMP dial ID.
 */
function getDialCategory(dialId: DAMPDialId): string {
  const idx = dialId.indexOf("_", 0)
  if (idx === -1) return dialId
  // Category prefix is everything up to and including the first underscore
  // e.g., "cr_divergent_thinking" → "cr_"
  return dialId.slice(0, idx + 1)
}

/**
 * Score a pool based on genotype (DAMPFingerprint) dial values.
 *
 * Algorithm:
 * 1. Find the top-5 most distinctive dials (largest deviation from 0.5)
 * 2. Weight each dial's pool affinity by its distinctiveness
 * 3. Return composite score [0-1]
 *
 * A flat fingerprint (all 0.5) produces equal scores across pools.
 */
export function scorePoolByGenotype(fingerprint: DAMPFingerprint, poolId: PoolId): number {
  const dials = fingerprint.dials

  // Compute distinctiveness for each dial: |value - 0.5|
  const ranked: Array<{ dialId: DAMPDialId; value: number; distinctiveness: number }> = []
  for (const dialId of Object.keys(dials) as DAMPDialId[]) {
    const value = dials[dialId]
    ranked.push({
      dialId,
      value,
      distinctiveness: Math.abs(value - 0.5),
    })
  }

  // Sort by distinctiveness descending, take top 5
  ranked.sort((a, b) => b.distinctiveness - a.distinctiveness)
  const top5 = ranked.slice(0, 5)

  // If all dials are exactly 0.5, return 0.5 (neutral)
  const totalDistinctiveness = top5.reduce((sum, d) => sum + d.distinctiveness, 0)
  if (totalDistinctiveness === 0) return 0.5

  // Weighted pool score
  let weightedScore = 0
  for (const dial of top5) {
    const category = getDialCategory(dial.dialId)
    const poolWeights = DIAL_POOL_WEIGHTS[category]
    const poolWeight = poolWeights?.[poolId] ?? 0.5

    // High dial value + high pool weight = boost
    // Weight contribution by distinctiveness (more extreme dials matter more)
    weightedScore += poolWeight * dial.value * (dial.distinctiveness / totalDistinctiveness)
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, weightedScore))
}

// ---------------------------------------------------------------------------
// Combined Scoring (T2.3 integration point)
// ---------------------------------------------------------------------------

/** Default blend weights: 60% archetype, 40% genotype */
const DEFAULT_ARCHETYPE_WEIGHT = 0.6
const DEFAULT_GENOTYPE_WEIGHT = 0.4

/** Default quality feedback weight (Sprint 3, T3.3) */
const DEFAULT_QUALITY_WEIGHT = 0.3

/**
 * Compute combined pool affinity from archetype (static) + genotype (dial-based)
 * + quality feedback (epigenetic, Sprint 3).
 *
 * Scoring formula:
 * - Without quality: static_affinity (archetype + genotype blend)
 * - With quality: static_affinity * (1 - qualityWeight) + quality_score * qualityWeight
 *
 * Quality reads from RoutingQualityStore cache ONLY — no I/O at scoring time.
 * When no quality data exists for a (personality, pool) pair, static affinity is used
 * unchanged (no penalty for new pools).
 *
 * @param archetype - The personality's archetype
 * @param fingerprint - The 96-dial dAMP fingerprint (optional)
 * @param archetypeWeight - Weight for static archetype affinity (default 0.6)
 * @param genotypeWeight - Weight for dial-based scoring (default 0.4)
 * @param qualityStore - Optional RoutingQualityStore for feedback scoring (Sprint 3)
 * @param personalityId - Required when qualityStore is provided
 * @param qualityWeight - Weight of quality feedback in final score (default 0.3)
 */
export function computeRoutingAffinity(
  archetype: Archetype,
  fingerprint?: DAMPFingerprint | null,
  archetypeWeight = DEFAULT_ARCHETYPE_WEIGHT,
  genotypeWeight = DEFAULT_GENOTYPE_WEIGHT,
  qualityStore?: RoutingQualityStore | null,
  personalityId?: string | null,
  qualityWeight = DEFAULT_QUALITY_WEIGHT,
): Record<PoolId, number> {
  const pools = Object.keys(ARCHETYPE_POOL_AFFINITY.freetekno) as PoolId[]
  const result = {} as Record<PoolId, number>

  for (const poolId of pools) {
    const archetypeScore = getArchetypeAffinity(archetype, poolId)

    let staticAffinity: number
    if (fingerprint) {
      const genotypeScore = scorePoolByGenotype(fingerprint, poolId)
      staticAffinity = archetypeScore * archetypeWeight + genotypeScore * genotypeWeight
    } else {
      staticAffinity = archetypeScore
    }

    // Blend quality feedback if available (Sprint 3, T3.3)
    if (qualityStore && personalityId) {
      const qualityScore = qualityStore.getPoolQualityCached(personalityId, poolId)
      if (qualityScore) {
        result[poolId] = staticAffinity * (1 - qualityWeight) + qualityScore.score * qualityWeight
      } else {
        // No quality data — use static affinity unchanged
        result[poolId] = staticAffinity
      }
    } else {
      result[poolId] = staticAffinity
    }
  }

  return result
}
