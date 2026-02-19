// src/nft/eval/temporal-eval.ts — Temporal Consistency Scorer (Sprint 12 Task 12.5)
//
// Measures temporal consistency: compliance rate of response texts
// with era-appropriate vocabulary constraints via checkTemporalVoice().
// A response is "compliant" if it produces zero temporal voice violations.

import { checkTemporalVoice } from "../temporal-voice.js"
import type { Era } from "../signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemporalResult {
  /** Overall compliance rate across all evaluated texts (0-1) */
  compliance_rate: number
  /** Total texts evaluated */
  total_evaluated: number
  /** Total compliant texts (zero violations) */
  total_compliant: number
  /** Per-era breakdown */
  per_era: Record<Era, { compliant: number; total: number; compliance_rate: number }>
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Score temporal consistency of text responses against era constraints.
 * A text is "compliant" if checkTemporalVoice() returns zero violations for its era.
 *
 * @param entries - Array of objects with text content and era
 * @returns TemporalResult with per-era and aggregate compliance rates
 */
export function scoreTemporalConsistency(
  entries: Array<{
    personality_id: string
    text: string
    era: Era
  }>,
): TemporalResult {
  const eraStats: Record<string, { compliant: number; total: number }> = {}

  for (const entry of entries) {
    if (!eraStats[entry.era]) {
      eraStats[entry.era] = { compliant: 0, total: 0 }
    }
    const stats = eraStats[entry.era]
    stats.total++

    const violations = checkTemporalVoice(entry.text, entry.era)
    if (violations.length === 0) {
      stats.compliant++
    }
  }

  // Build per-era result
  const per_era = {} as TemporalResult["per_era"]
  const allEras: Era[] = ["ancient", "medieval", "early_modern", "modern", "contemporary"]
  for (const era of allEras) {
    const stats = eraStats[era] ?? { compliant: 0, total: 0 }
    per_era[era] = {
      compliant: stats.compliant,
      total: stats.total,
      compliance_rate: stats.total > 0 ? stats.compliant / stats.total : 1,
    }
  }

  let totalCompliant = 0
  let totalEvaluated = 0
  for (const stats of Object.values(eraStats)) {
    totalCompliant += stats.compliant
    totalEvaluated += stats.total
  }

  return {
    compliance_rate: totalEvaluated > 0 ? totalCompliant / totalEvaluated : 1,
    total_evaluated: totalEvaluated,
    total_compliant: totalCompliant,
    per_era,
  }
}
