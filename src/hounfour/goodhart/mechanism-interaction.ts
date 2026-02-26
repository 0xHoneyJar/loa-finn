// src/hounfour/goodhart/mechanism-interaction.ts — Mechanism Interaction (SDD §4.1.4, cycle-034)
//
// Precedence chain: Kill switch → Exploration → Reputation → Deterministic fallback.
// Exploration feedback weighted at 0.5x to prevent gaming.

import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"
import { mapUnknownTaskTypeToRoutingKey, type NFTRoutingKey } from "../nft-routing-config.js"
import { resolvePool } from "../tier-bridge.js"
import type { TemporalDecayEngine, EMAKey } from "./temporal-decay.js"
import type { ExplorationEngine } from "./exploration.js"
import type { CalibrationEngine } from "./calibration.js"
import type { KillSwitch } from "./kill-switch.js"

// --- Types ---

export interface MechanismConfig {
  decay: TemporalDecayEngine
  exploration: ExplorationEngine
  calibration: CalibrationEngine
  killSwitch: KillSwitch
  /** Weight applied to exploration feedback EMA updates (default: 0.5) */
  explorationFeedbackWeight: number
}

export interface ReputationScoringResult {
  pool: PoolId
  score: number | null
  path: "kill_switch" | "exploration" | "reputation" | "deterministic" | "exploration_skipped"
  metadata: {
    decayApplied?: boolean
    calibrationApplied?: boolean
    explorationCandidateSetSize?: number
    randomValue?: number
  }
}

// --- Resolver ---

/**
 * Resolve pool with full Goodhart protection stack.
 *
 * Precedence (SDD §4.1.4):
 * 1. Kill switch → deterministic routing, zero reputation queries
 * 2. Exploration coin flip → random candidate from filtered set
 * 3. Reputation scoring → decay + calibration blending per pool
 * 4. Deterministic fallback → resolvePool() when all scores null
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
  abortSignal?: AbortSignal,
): Promise<ReputationScoringResult> {
  const routingKey: NFTRoutingKey = taskType
    ? mapUnknownTaskTypeToRoutingKey(taskType)
    : "default"

  // 1. Kill switch — deterministic routing, zero reputation queries
  if (config.killSwitch.isDisabled()) {
    return {
      pool: resolvePool(tier, taskType, nftPreferences),
      score: null,
      path: "kill_switch",
      metadata: {},
    }
  }

  // 2. Exploration coin flip — independent of calibration/decay
  const explorationDecision = config.exploration.decide(
    tier,
    accessiblePools,
    circuitBreakerStates,
    poolCosts,
    defaultPoolCost,
    routingKey,
    poolCapabilities,
  )

  if (explorationDecision.explore && explorationDecision.selectedPool) {
    // Record exploration for observability (best-effort)
    void config.exploration.recordExploration(tier)

    return {
      pool: explorationDecision.selectedPool,
      score: null,
      path: "exploration",
      metadata: {
        explorationCandidateSetSize: explorationDecision.candidateSetSize,
        randomValue: explorationDecision.randomValue,
      },
    }
  }

  // Exploration triggered but no eligible candidates — fall through to reputation
  // (NOT deterministic fallback — important for loop closure)
  if (explorationDecision.explore && !explorationDecision.selectedPool) {
    console.warn(JSON.stringify({
      component: "mechanism-interaction",
      event: "exploration_skipped",
      reason: explorationDecision.reason ?? "no_eligible_candidates",
      tier,
      routingKey,
      timestamp: new Date().toISOString(),
    }))
    // Fall through to reputation scoring below
  }

  // 3. Reputation scoring — decay + calibration blending for each pool
  let bestPool: PoolId | null = null
  let bestScore = -1
  let anyDecayApplied = false
  let anyCalibrationApplied = false

  for (const poolId of accessiblePools) {
    // Check abort signal
    if (abortSignal?.aborted) break

    const emaKey: EMAKey = { nftId, poolId, routingKey }

    // Get decayed score
    const decayResult = await config.decay.getDecayedScore(emaKey)
    if (!decayResult) continue

    anyDecayApplied = true
    let finalScore = decayResult.score

    // Get calibration entries and blend
    const calibrationEntries = config.calibration.getCalibration(nftId, poolId, routingKey)
    if (calibrationEntries.length > 0) {
      const rawState = await config.decay.getRawState(emaKey)
      const sampleCount = rawState?.sampleCount ?? 0
      finalScore = config.calibration.blendWithDecay(decayResult.score, sampleCount, calibrationEntries)
      anyCalibrationApplied = true
    }

    // Clamp to [0, 1]
    finalScore = Math.max(0, Math.min(1, finalScore))

    if (finalScore > bestScore) {
      bestScore = finalScore
      bestPool = poolId
    }
  }

  // If reputation scoring produced a winner
  if (bestPool !== null) {
    return {
      pool: bestPool,
      score: bestScore,
      path: "reputation",
      metadata: {
        decayApplied: anyDecayApplied,
        calibrationApplied: anyCalibrationApplied,
      },
    }
  }

  // 4. Deterministic fallback — all reputation queries returned null
  return {
    pool: resolvePool(tier, taskType, nftPreferences),
    score: null,
    path: explorationDecision.explore ? "exploration_skipped" : "deterministic",
    metadata: {},
  }
}

/**
 * Feed back an exploration observation at reduced weight (SDD §4.1.4 FR1.4 §5).
 * Called after an exploration-path request completes with a quality signal.
 */
export async function feedbackExploration(
  config: MechanismConfig,
  key: EMAKey,
  score: number,
  timestamp: number,
  eventHash: string,
): Promise<void> {
  const weightedScore = score * config.explorationFeedbackWeight
  await config.decay.updateEMA(key, weightedScore, timestamp, eventHash)
}
