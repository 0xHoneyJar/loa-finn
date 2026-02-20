// src/nft/eval/scorecard.ts — Aggregate Scorecard (Sprint 13 Task 13.2)
//
// Builds per-personality scorecards from evaluation results and computes
// aggregate summary statistics. Determines pass/fail based on thresholds.

import type { DistinctivenessResult } from "./distinctiveness.js"
import type { FidelityResult } from "./fidelity.js"
import type { ANBatchResult } from "./anti-narration-eval.js"
import type { TemporalResult } from "./temporal-eval.js"
import type { DAMPEvalResult } from "./damp-eval.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalScorecard {
  personality_id: string

  /** Distinctiveness: mean cosine similarity (target: < 0.3) */
  distinctiveness_score: number

  /** Signal fidelity: blind archetype identification accuracy (target: >= 0.8) */
  signal_fidelity_score: number

  /** Anti-narration: violation count (target: 0) */
  anti_narration_violations: number

  /** Temporal consistency: compliance rate (target: >= 0.75) */
  temporal_consistency_score: number

  /** dAMP behavioral impact: max significant dimensions across pairs (target: >= 5) */
  damp_behavioral_score: number

  /** Overall pass/fail based on all targets */
  overall_pass: boolean

  /** Metadata */
  evaluated_at: number
  eval_model: string
}

export interface AggregateScorecard {
  personalities: EvalScorecard[]
  summary: {
    total_evaluated: number
    total_passing: number
    pass_rate: number
    mean_distinctiveness: number
    mean_fidelity: number
    total_an_violations: number
    mean_temporal_consistency: number
    mean_damp_dimensions: number
  }
  evaluated_at: number
  eval_model: string
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const DISTINCTIVENESS_THRESHOLD = 0.3 // mean similarity must be BELOW this
const FIDELITY_THRESHOLD = 0.8 // accuracy must be AT OR ABOVE this
const AN_VIOLATION_THRESHOLD = 0 // must be exactly 0
const TEMPORAL_THRESHOLD = 0.75 // compliance must be AT OR ABOVE this
const DAMP_DIMENSION_THRESHOLD = 5 // significant dimensions must be AT OR ABOVE this

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build per-personality scorecards from evaluation results.
 *
 * @param personalityIds - IDs of personalities to evaluate
 * @param distinctiveness - Distinctiveness result from scoreDistinctiveness()
 * @param fidelity - Fidelity result from scoreFidelity()
 * @param antiNarration - Anti-narration batch result from checkAntiNarrationBatch()
 * @param temporal - Temporal result from scoreTemporalConsistency()
 * @param damp - dAMP eval result from scoreDAMPDistinctiveness()
 * @param evalModel - Model identifier used for evaluation
 * @returns AggregateScorecard with per-personality and summary results
 */
export function buildScorecards(
  personalityIds: string[],
  distinctiveness: DistinctivenessResult,
  fidelity: FidelityResult,
  antiNarration: ANBatchResult,
  temporal: TemporalResult,
  damp: DAMPEvalResult,
  evalModel: string,
): AggregateScorecard {
  const now = Date.now()

  // --- Extract per-personality distinctiveness ---
  // Distinctiveness is a pairwise metric. For each personality, compute its mean
  // similarity to all others from per_pair data.
  const personalityDistinctiveness = new Map<string, number[]>()
  for (const pair of distinctiveness.per_pair) {
    const a = pair.personality_a
    const b = pair.personality_b
    const sim = pair.similarity

    if (!personalityDistinctiveness.has(a)) personalityDistinctiveness.set(a, [])
    if (!personalityDistinctiveness.has(b)) personalityDistinctiveness.set(b, [])
    personalityDistinctiveness.get(a)!.push(sim)
    personalityDistinctiveness.get(b)!.push(sim)
  }

  // --- Extract per-personality fidelity ---
  // Use per_archetype if available; map personality to archetype accuracy
  // For simplicity, use overall accuracy as the per-personality fidelity score
  // since fidelity is evaluated per-personality in the per_archetype map.
  const personalityFidelity = new Map<string, number>()
  // Build inverse map from personality to archetype accuracy
  for (const [archetype, stats] of Object.entries(fidelity.per_archetype)) {
    personalityFidelity.set(archetype, stats.accuracy)
  }

  // --- Extract per-personality AN violations ---
  const personalityANViolations = new Map<string, number>()
  for (const v of antiNarration.violations) {
    const current = personalityANViolations.get(v.personality_id) ?? 0
    personalityANViolations.set(v.personality_id, current + 1)
  }

  // --- Extract per-personality dAMP scores ---
  // For each personality, find max significant_count across all pairs it participates in
  const personalityDAMP = new Map<string, number>()
  for (const pair of damp.per_pair) {
    const currentA = personalityDAMP.get(pair.personality_a) ?? 0
    const currentB = personalityDAMP.get(pair.personality_b) ?? 0
    personalityDAMP.set(pair.personality_a, Math.max(currentA, pair.significant_count))
    personalityDAMP.set(pair.personality_b, Math.max(currentB, pair.significant_count))
  }

  // --- Build scorecards ---
  const scorecards: EvalScorecard[] = personalityIds.map(pid => {
    // Distinctiveness: mean similarity for this personality's pairs
    const distSims = personalityDistinctiveness.get(pid) ?? []
    const distinctivenessScore =
      distSims.length > 0
        ? distSims.reduce((a, b) => a + b, 0) / distSims.length
        : distinctiveness.mean_similarity

    // Fidelity: per-personality or overall
    const fidelityScore = personalityFidelity.get(pid) ?? fidelity.overall_accuracy

    // AN violations
    const anViolations = personalityANViolations.get(pid) ?? 0

    // Temporal: use overall compliance rate (it's an aggregate metric)
    const temporalScore = temporal.compliance_rate

    // dAMP: max significant dimensions for this personality
    const dampScore = personalityDAMP.get(pid) ?? 0

    // Pass/fail
    const overallPass =
      distinctivenessScore < DISTINCTIVENESS_THRESHOLD &&
      fidelityScore >= FIDELITY_THRESHOLD &&
      anViolations === AN_VIOLATION_THRESHOLD &&
      temporalScore >= TEMPORAL_THRESHOLD &&
      dampScore >= DAMP_DIMENSION_THRESHOLD

    return {
      personality_id: pid,
      distinctiveness_score: distinctivenessScore,
      signal_fidelity_score: fidelityScore,
      anti_narration_violations: anViolations,
      temporal_consistency_score: temporalScore,
      damp_behavioral_score: dampScore,
      overall_pass: overallPass,
      evaluated_at: now,
      eval_model: evalModel,
    }
  })

  // --- Build summary ---
  const totalPassing = scorecards.filter(s => s.overall_pass).length
  const totalEvaluated = scorecards.length

  const meanDistinctiveness =
    totalEvaluated > 0
      ? scorecards.reduce((sum, s) => sum + s.distinctiveness_score, 0) / totalEvaluated
      : 0
  const meanFidelity =
    totalEvaluated > 0
      ? scorecards.reduce((sum, s) => sum + s.signal_fidelity_score, 0) / totalEvaluated
      : 0
  const totalANViolations = scorecards.reduce((sum, s) => sum + s.anti_narration_violations, 0)
  const meanTemporal =
    totalEvaluated > 0
      ? scorecards.reduce((sum, s) => sum + s.temporal_consistency_score, 0) / totalEvaluated
      : 0
  const meanDAMP =
    totalEvaluated > 0
      ? scorecards.reduce((sum, s) => sum + s.damp_behavioral_score, 0) / totalEvaluated
      : 0

  return {
    personalities: scorecards,
    summary: {
      total_evaluated: totalEvaluated,
      total_passing: totalPassing,
      pass_rate: totalEvaluated > 0 ? totalPassing / totalEvaluated : 0,
      mean_distinctiveness: meanDistinctiveness,
      mean_fidelity: meanFidelity,
      total_an_violations: totalANViolations,
      mean_temporal_consistency: meanTemporal,
      mean_damp_dimensions: meanDAMP,
    },
    evaluated_at: now,
    eval_model: evalModel,
  }
}
