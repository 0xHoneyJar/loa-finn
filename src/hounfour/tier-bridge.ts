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
 * 1. NFT/personality preferences for the given task type (if valid pool)
 * 2. Tier default pool (from loa-hounfour TIER_DEFAULT_POOL)
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
  if (nftPreferences && taskType) {
    const preferred = nftPreferences[taskType]
    if (preferred && isValidPoolId(preferred)) {
      return preferred
    }
    // Also try "default" key if task-specific preference not found
    const defaultPreferred = nftPreferences["default"]
    if (!preferred && defaultPreferred && isValidPoolId(defaultPreferred)) {
      return defaultPreferred
    }
  }

  // 2. Tier default from loa-hounfour canonical mapping
  return TIER_DEFAULT_POOL[tier]
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
