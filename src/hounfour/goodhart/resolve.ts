// src/hounfour/goodhart/resolve.ts — resolveWithGoodhart Typed Contract (SDD §3.3.1, cycle-036 T-1.4)
//
// Core integration function connecting router to all Goodhart components.
// Error contract: operational errors caught + logged → null; programmer errors propagate.
// Timeout contract: 200ms hard ceiling via setTimeout + AbortController.abort().

import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../nft-routing-config.js"
import type { MechanismConfig, ReputationScoringResult } from "./mechanism-interaction.js"
import { resolveWithGoodhart as resolveWithGoodhartInternal } from "./mechanism-interaction.js"
import type { GraduationMetrics } from "../graduation-metrics.js"

// --- Types ---

export interface GoodhartOptions {
  /** Current routing mode: "shadow" runs read-only, "enabled" allows writes */
  mode: "shadow" | "enabled"
}

export interface ScoredPool {
  pool: PoolId
  score: number | null
}

export interface GoodhartResult {
  /** Selected pool ID */
  pool: PoolId
  /** Reputation score that drove the selection */
  score: number | null
  /** Whether exploration (epsilon-greedy) overrode the score-based pick */
  explored: boolean
  /** Per-pool scored breakdown for observability */
  scoredPools: ScoredPool[]
  /** Internal routing path taken */
  path: ReputationScoringResult["path"]
}

// --- Constants ---

/** Hard timeout ceiling for the entire Goodhart resolution */
const GOODHART_TIMEOUT_MS = 200

// --- Programmer error detection ---

function isProgrammerError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError ||
    err instanceof RangeError ||
    err instanceof EvalError ||
    err instanceof URIError
  )
}

// --- Resolver ---

/**
 * Invoke the full Goodhart protection stack to select a pool.
 *
 * Error contract:
 *   - On individual pool scoring failure → that pool is excluded (partial degradation)
 *   - On ALL pool scoring failures → returns null (caller falls back to deterministic)
 *   - On timeout (200ms ceiling) → returns null + increments timeout counter
 *   - Programmer errors (TypeError, ReferenceError) → propagate (fail-fast for bugs)
 *   - Operational errors (timeout, Redis failure, etc.) → catches, logs, returns null
 *
 * @returns GoodhartResult on success, null on failure (caller uses deterministic fallback)
 */
export async function resolveWithGoodhart(
  config: MechanismConfig,
  tier: Tier,
  nftId: string,
  taskType: string | undefined,
  nftPreferences: Record<string, string> | undefined,
  accessiblePools: readonly PoolId[],
  circuitBreakerStates: Map<PoolId, "closed" | "half-open" | "open">,
  poolCosts: Map<PoolId, number>,
  defaultPoolCost: number,
  poolCapabilities: Map<PoolId, Set<NFTRoutingKey>>,
  options: GoodhartOptions,
  metrics?: GraduationMetrics,
): Promise<GoodhartResult | null> {
  // 200ms hard timeout ceiling via Promise.race
  // AbortController propagated to pool scoring for early cancellation
  const controller = new AbortController()

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      resolve("TIMEOUT")
    }, GOODHART_TIMEOUT_MS)
  })

  try {
    const internalPromise = resolveWithGoodhartInternal(
      config,
      tier,
      nftId,
      taskType,
      nftPreferences,
      accessiblePools,
      circuitBreakerStates,
      poolCosts,
      defaultPoolCost,
      poolCapabilities,
      controller.signal,
    )

    const raceResult = await Promise.race([internalPromise, timeoutPromise])

    if (raceResult === "TIMEOUT") {
      metrics?.goodhartTimeoutTotal.inc()
      console.warn(JSON.stringify({
        component: "goodhart-resolve",
        event: "timeout",
        tier,
        nftId,
        mode: options.mode,
        timeoutMs: GOODHART_TIMEOUT_MS,
        timestamp: new Date().toISOString(),
      }))
      return null
    }

    const result = raceResult
    return {
      pool: result.pool,
      score: result.score,
      explored: result.path === "exploration",
      scoredPools: result.scoredPools.map(({ poolId, score }) => ({ pool: poolId, score })),
      path: result.path,
    }
  } catch (err: unknown) {
    // Programmer errors propagate (fail-fast for bugs)
    if (isProgrammerError(err)) {
      throw err
    }

    // Operational error: catch, log, return null
    console.warn(JSON.stringify({
      component: "goodhart-resolve",
      event: "operational_error",
      tier,
      nftId,
      mode: options.mode,
      error: err instanceof Error ? err.message : String(err),
      errorType: err instanceof Error ? err.constructor.name : typeof err,
      timestamp: new Date().toISOString(),
    }))

    return null
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}
