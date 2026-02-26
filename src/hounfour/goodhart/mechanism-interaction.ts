// src/hounfour/goodhart/mechanism-interaction.ts — Mechanism Interaction (SDD §4.1.4, cycle-034)
//
// Precedence chain: Kill switch → Exploration → Reputation → Deterministic fallback.
// Exploration feedback weighted at 0.5x to prevent gaming.

import pLimit from "p-limit"
import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"
import { mapUnknownTaskTypeToRoutingKey, type NFTRoutingKey } from "../nft-routing-config.js"
import { resolvePool } from "../tier-bridge.js"
import type { TemporalDecayEngine, EMAKey } from "./temporal-decay.js"
import type { ExplorationEngine } from "./exploration.js"
import type { CalibrationEngine } from "./calibration.js"
import type { KillSwitch } from "./kill-switch.js"
import type { ResilientAuditLogger } from "../audit/audit-fallback.js"
import type { GraduationMetrics } from "../graduation-metrics.js"

// --- Types ---

export interface MechanismConfig {
  decay: TemporalDecayEngine
  exploration: ExplorationEngine
  calibration: CalibrationEngine
  killSwitch: KillSwitch
  /** Weight applied to exploration feedback EMA updates (default: 0.5) */
  explorationFeedbackWeight: number
  /** Optional audit logger for tamper-evident scoring path log (T-4.7). */
  auditLogger?: ResilientAuditLogger
  /** Optional graduation metrics for Prometheus export (T-2.6). */
  metrics?: GraduationMetrics
}

export interface ReputationScoringResult {
  pool: PoolId
  score: number | null
  path: "kill_switch" | "exploration" | "reputation" | "deterministic" | "exploration_skipped" | "shadow"
  /** Per-pool scored breakdown for observability (cycle-036 T-4.1) */
  scoredPools: Array<{ poolId: PoolId; score: number }>
  metadata: {
    decayApplied?: boolean
    calibrationApplied?: boolean
    explorationCandidateSetSize?: number
    randomValue?: number
    /** Shadow mode: the pool reputation scoring would have chosen. */
    shadowPool?: PoolId
    /** Shadow mode: whether shadow and deterministic diverged. */
    shadowDiverged?: boolean
    /** Shadow mode: score from reputation scoring (for comparison). */
    shadowScore?: number | null
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

  const switchState = await config.killSwitch.getState()

  // 1. Kill switch — deterministic routing, zero reputation queries
  if (switchState === "disabled") {
    const pool = resolvePool(tier, taskType, nftPreferences)
    // Audit: kill switch path (best-effort, never blocks routing)
    void config.auditLogger?.log("scoring_path", {
      path: "kill_switch", tier, nftId, pool, routingKey,
    })
    return {
      pool,
      score: null,
      path: "kill_switch",
      scoredPools: [],
      metadata: {},
    }
  }

  // 1b. Shadow mode — run full scoring but return deterministic pool (T-6.6, §13.3)
  // Scoring runs for observability; actual routing uses deterministic fallback.
  // No EMA writes in shadow mode.
  if (switchState === "shadow") {
    const deterministicPool = resolvePool(tier, taskType, nftPreferences)
    const shadowResult = await _scorePools(config, tier, nftId, routingKey, accessiblePools, abortSignal)
    const shadowPool = shadowResult.bestPool ?? deterministicPool
    const diverged = shadowPool !== deterministicPool

    // Shadow metrics recorded at router level (T-5.5: removed here to prevent double-count)

    // Emit shadow comparison log (structured JSON for dashboards)
    console.log(JSON.stringify({
      component: "mechanism-interaction",
      event: "shadow_comparison",
      tier,
      nftId,
      routingKey,
      deterministicPool,
      shadowPool,
      shadowScore: shadowResult.bestScore > -1 ? shadowResult.bestScore : null,
      diverged,
      decayApplied: shadowResult.anyDecayApplied,
      calibrationApplied: shadowResult.anyCalibrationApplied,
      timestamp: new Date().toISOString(),
    }))

    // Audit: shadow path
    void config.auditLogger?.log("scoring_path", {
      path: "shadow", tier, nftId, pool: deterministicPool, routingKey,
      shadowPool, shadowScore: shadowResult.bestScore > -1 ? shadowResult.bestScore : null,
      diverged,
    })

    return {
      pool: deterministicPool,
      score: null,
      path: "shadow",
      scoredPools: shadowResult.allScores,
      metadata: {
        decayApplied: shadowResult.anyDecayApplied,
        calibrationApplied: shadowResult.anyCalibrationApplied,
        shadowPool,
        shadowDiverged: diverged,
        shadowScore: shadowResult.bestScore > -1 ? shadowResult.bestScore : null,
      },
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
    // Metrics: exploration event (T-2.6)
    config.metrics?.recordExploration(tier)
    // Audit: exploration path
    void config.auditLogger?.log("scoring_path", {
      path: "exploration", tier, nftId, pool: explorationDecision.selectedPool,
      routingKey, candidateSetSize: explorationDecision.candidateSetSize,
    })

    return {
      pool: explorationDecision.selectedPool,
      score: null,
      path: "exploration",
      scoredPools: [],
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
  const scored = await _scorePools(config, tier, nftId, routingKey, accessiblePools, abortSignal)

  // If reputation scoring produced a winner
  if (scored.bestPool !== null) {
    // Audit: reputation path
    void config.auditLogger?.log("scoring_path", {
      path: "reputation", tier, nftId, pool: scored.bestPool, score: scored.bestScore,
      routingKey, decayApplied: scored.anyDecayApplied, calibrationApplied: scored.anyCalibrationApplied,
    })
    return {
      pool: scored.bestPool,
      score: scored.bestScore,
      path: "reputation",
      scoredPools: scored.allScores,
      metadata: {
        decayApplied: scored.anyDecayApplied,
        calibrationApplied: scored.anyCalibrationApplied,
      },
    }
  }

  // 4. Deterministic fallback — all reputation queries returned null
  const fallbackPool = resolvePool(tier, taskType, nftPreferences)
  const fallbackPath = explorationDecision.explore ? "exploration_skipped" : "deterministic"
  // Audit: fallback path
  void config.auditLogger?.log("scoring_path", {
    path: fallbackPath, tier, nftId, pool: fallbackPool, routingKey,
  })
  return {
    pool: fallbackPool,
    score: null,
    path: fallbackPath,
    scoredPools: scored.allScores,
    metadata: {},
  }
}

// --- Internal helpers ---

interface PoolScoringResult {
  bestPool: PoolId | null
  bestScore: number
  anyDecayApplied: boolean
  anyCalibrationApplied: boolean
  /** Individual per-pool scores for observability (cycle-036 T-4.1) */
  allScores: Array<{ poolId: PoolId; score: number }>
}

const SCORING_CONCURRENCY = 5
const PER_POOL_TIMEOUT_MS = 50

/**
 * Score all accessible pools using decay + calibration blending.
 * Uses p-limit(5) for concurrency control with 50ms per-pool timeout.
 * Individual failures don't block other pools (Promise.allSettled).
 * Extracted for reuse by both shadow mode and normal reputation path.
 */
async function _scorePools(
  config: MechanismConfig,
  tier: Tier,
  nftId: string,
  routingKey: NFTRoutingKey,
  accessiblePools: readonly PoolId[],
  abortSignal?: AbortSignal,
): Promise<PoolScoringResult> {
  const limit = pLimit(SCORING_CONCURRENCY)

  const results = await Promise.allSettled(
    accessiblePools.map((poolId) =>
      limit(async () => {
        if (abortSignal?.aborted) throw new Error("aborted")

        const scored = await Promise.race([
          _scoreOnePool(config, nftId, poolId, routingKey),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`scoring timeout for ${poolId}`)), PER_POOL_TIMEOUT_MS),
          ),
        ])
        return scored
      }),
    ),
  )

  let bestPool: PoolId | null = null
  let bestScore = -1
  let anyDecayApplied = false
  let anyCalibrationApplied = false
  const allScores: Array<{ poolId: PoolId; score: number }> = []

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue
    const { poolId, score, decayApplied, calibrationApplied } = result.value
    allScores.push({ poolId, score })
    if (decayApplied) anyDecayApplied = true
    if (calibrationApplied) anyCalibrationApplied = true
    if (score > bestScore) {
      bestScore = score
      bestPool = poolId
    }
  }

  if (bestPool === null && accessiblePools.length > 0) {
    config.metrics?.reputationScoringFailedTotal.inc()
    console.warn(`[finn] reputation: all ${accessiblePools.length} pool scorings failed, falling back to deterministic`)
  }

  return { bestPool, bestScore, anyDecayApplied, anyCalibrationApplied, allScores }
}

interface SinglePoolScore {
  poolId: PoolId
  score: number
  decayApplied: boolean
  calibrationApplied: boolean
}

/** Score a single pool — decay + calibration blending. Returns null if no EMA data. */
async function _scoreOnePool(
  config: MechanismConfig,
  nftId: string,
  poolId: PoolId,
  routingKey: NFTRoutingKey,
): Promise<SinglePoolScore | null> {
  const emaKey: EMAKey = { nftId, poolId, routingKey }
  const decayResult = await config.decay.getDecayedScore(emaKey)
  if (!decayResult) return null

  let finalScore = decayResult.score
  let calibrationApplied = false

  const calibrationEntries = config.calibration.getCalibration(nftId, poolId, routingKey)
  if (calibrationEntries.length > 0) {
    const rawState = await config.decay.getRawState(emaKey)
    const sampleCount = rawState?.sampleCount ?? 0
    finalScore = config.calibration.blendWithDecay(decayResult.score, sampleCount, calibrationEntries)
    calibrationApplied = true
  }

  finalScore = Math.max(0, Math.min(1, finalScore))

  return { poolId, score: finalScore, decayApplied: true, calibrationApplied }
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
