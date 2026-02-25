// src/hounfour/tier-bridge.ts — Tier-to-model bridge (SDD §4.5, Task A.2)
// Maps JWT tier claims to canonical pool IDs from loa-hounfour vocabulary.
// Unknown pool IDs are rejected. Tier authorization checked before routing.

import {
  type PoolId,
  type Tier,
  type TaskType,
  POOL_IDS,
  TIER_POOL_ACCESS,
  TIER_DEFAULT_POOL,
  isValidPoolId,
  tierHasAccess,
} from "@0xhoneyjar/loa-hounfour"
import { HounfourError } from "./errors.js"
import { mapUnknownTaskTypeToRoutingKey, type NFTRoutingKey } from "./nft-routing-config.js"
import type { ReputationQueryFn } from "./types.js"

// --- Validation ---

/**
 * Validate a pool ID against loa-hounfour canonical vocabulary.
 * Throws UNKNOWN_POOL if the ID is not recognized.
 */
export function assertValidPoolId(poolId: string): asserts poolId is PoolId {
  if (!isValidPoolId(poolId)) {
    throw new HounfourError("UNKNOWN_POOL", `Unknown pool ID: "${poolId}"`, {
      poolId,
      validPools: [...POOL_IDS],
    })
  }
}

/**
 * Validate that a tier has access to a pool.
 * Throws TIER_UNAUTHORIZED if access is denied.
 */
export function assertTierAccess(tier: Tier, poolId: PoolId): void {
  if (!tierHasAccess(tier, poolId)) {
    throw new HounfourError("TIER_UNAUTHORIZED",
      `Tier "${tier}" cannot access pool "${poolId}"`, {
        tier,
        poolId,
        allowedPools: [...TIER_POOL_ACCESS[tier]],
      })
  }
}

// --- Resolution ---

/**
 * Resolve the best pool for a tenant request.
 *
 * Resolution order:
 * 1. Map `taskType` through `mapUnknownTaskTypeToRoutingKey()` to get an NFTRoutingKey.
 *    Protocol TaskTypes (code_review, creative_writing, analysis, summarization, general,
 *    unspecified) are mapped to internal routing keys (code, chat, analysis, default).
 *    Unknown strings map to "default" with a redacted console.warn.
 * 2. Look up NFT/personality preferences using the mapped routing key (if valid pool).
 * 3. Fall back to tier default pool (from loa-hounfour TIER_DEFAULT_POOL).
 *
 * Invalid preference pool IDs are silently skipped (fall through to tier default).
 * This prevents NFT misconfigurations from breaking routing entirely.
 */
export function resolvePool(
  tier: Tier,
  taskType?: string,
  nftPreferences?: Record<string, string>,
): PoolId {
  // 1. NFT-specific preferences for this task type
  // Map protocol TaskType to internal routing key for NFT preference lookup
  const routingKey = taskType ? mapUnknownTaskTypeToRoutingKey(taskType) : undefined
  if (nftPreferences && routingKey) {
    const preferred = nftPreferences[routingKey]
    if (preferred && isValidPoolId(preferred)) {
      return preferred
    }
    // Also try "default" key if routing-key-specific preference not found
    const defaultPreferred = nftPreferences["default"]
    if (!preferred && defaultPreferred && isValidPoolId(defaultPreferred)) {
      return defaultPreferred
    }
  }

  // 2. Tier default from loa-hounfour canonical mapping
  return TIER_DEFAULT_POOL[tier]
}

/**
 * Resolve pool with reputation-weighted scoring across candidate pools.
 *
 * When `reputationQuery` is provided AND the tier has access to multiple pools,
 * each accessible pool is scored via `reputationQuery`; the highest-scoring pool wins.
 *
 * Score handling:
 * - `null` = no signal (skip candidate)
 * - `NaN` or out-of-range = treated as `null`
 * - Scores are clamped to [0, 1] before comparison
 *
 * Tie-breaking: equal reputation scores → preserve existing deterministic order
 * (tier default pool wins).
 *
 * Falls back to `resolvePool` when:
 * - `reputationQuery` is not provided
 * - All candidates return `null`/invalid scores
 * - Tier has only one accessible pool
 */
export async function resolvePoolWithReputation(
  tier: Tier,
  taskType?: string,
  nftPreferences?: Record<string, string>,
  reputationQuery?: ReputationQueryFn,
): Promise<PoolId> {
  // Without reputation query, delegate to sync resolvePool (zero behavioral change)
  if (!reputationQuery) {
    return resolvePool(tier, taskType, nftPreferences)
  }

  const accessiblePools = TIER_POOL_ACCESS[tier]

  // Single pool — no scoring needed
  if (accessiblePools.length <= 1) {
    return resolvePool(tier, taskType, nftPreferences)
  }

  const routingKey: NFTRoutingKey = taskType
    ? mapUnknownTaskTypeToRoutingKey(taskType)
    : "default"

  // Score each accessible pool
  let bestPool: PoolId | null = null
  let bestScore = -1

  for (const poolId of accessiblePools) {
    let score: number | null
    try {
      score = await reputationQuery(poolId, routingKey)
    } catch {
      // Query failure = no signal for this pool
      score = null
    }

    // Skip null, NaN, or out-of-range scores
    if (score === null || score === undefined || !Number.isFinite(score)) {
      continue
    }

    // Clamp to [0, 1]
    const clamped = Math.max(0, Math.min(1, score))

    // Strict greater-than preserves deterministic order on ties
    if (clamped > bestScore) {
      bestScore = clamped
      bestPool = poolId
    }
  }

  // If reputation scoring produced a winner, use it
  if (bestPool !== null) {
    return bestPool
  }

  // All candidates returned null/invalid — fall back to existing resolution
  return resolvePool(tier, taskType, nftPreferences)
}

/**
 * Resolve pool with tier authorization check.
 * Combines resolution + validation in a single call.
 *
 * Throws TIER_UNAUTHORIZED if the resolved pool is not accessible to the tier.
 * Throws UNKNOWN_POOL if NFT preferences contain an invalid pool ID that somehow resolves.
 */
export function resolveAndAuthorize(
  tier: Tier,
  taskType?: string,
  nftPreferences?: Record<string, string>,
): PoolId {
  const poolId = resolvePool(tier, taskType, nftPreferences)
  assertTierAccess(tier, poolId)
  return poolId
}

/**
 * Get all pools accessible to a given tier.
 * Returns the canonical list from loa-hounfour vocabulary.
 */
export function getAccessiblePools(tier: Tier): readonly PoolId[] {
  return TIER_POOL_ACCESS[tier]
}

/**
 * Get the default pool for a tier.
 * Returns the canonical default from loa-hounfour vocabulary.
 */
export function getDefaultPool(tier: Tier): PoolId {
  return TIER_DEFAULT_POOL[tier]
}

// Re-export loa-hounfour types for convenience
export {
  type PoolId,
  type Tier,
  type TaskType,
  POOL_IDS,
  TIER_POOL_ACCESS,
  TIER_DEFAULT_POOL,
  isValidPoolId,
  tierHasAccess,
}
