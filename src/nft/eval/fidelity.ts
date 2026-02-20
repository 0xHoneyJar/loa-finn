// src/nft/eval/fidelity.ts — Signal Fidelity Scorer (Sprint 12 Task 12.3)
//
// Measures how well personality responses express their intended archetype
// via blind identification. A judge provider reads response transcripts
// (with archetype labels stripped) and attempts to identify the archetype.
// Higher accuracy = stronger signal fidelity.

import type { JudgeProvider } from "./providers.js"
import type { EvalResponse, EvalPersonality } from "./harness.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FidelityResult {
  /** Overall accuracy across all evaluated responses (0-1) */
  overall_accuracy: number
  /** Total correctly identified responses */
  total_correct: number
  /** Total responses evaluated */
  total_evaluated: number
  /** Per-archetype breakdown */
  per_archetype: Record<string, { correct: number; total: number; accuracy: number }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known archetype labels that should be stripped from transcripts for blind evaluation */
const ARCHETYPE_LABELS = [
  "freetekno",
  "milady",
  "chicago_detroit",
  "chicago detroit",
  "acidhouse",
  "acid house",
]

/**
 * Strip archetype labels from transcript text to enable blind identification.
 * Removes all known archetype label occurrences (case-insensitive, word-boundary aware).
 */
export function stripArchetypeLabels(text: string): string {
  let result = text
  for (const label of ARCHETYPE_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`\\b${escaped}\\b`, "gi")
    result = result.replace(re, "[REDACTED]")
  }
  return result
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Score signal fidelity via blind archetype identification.
 *
 * For each personality with an archetype, presents its response transcripts
 * (with archetype labels stripped) to the judge provider, which attempts to
 * identify the archetype from the available options. Accuracy measures how
 * often the judge correctly identifies the intended archetype.
 *
 * @param responses - All eval responses from a run
 * @param personalities - Personality definitions with archetype metadata
 * @param provider - Judge provider for blind identification
 * @returns FidelityResult with per-archetype and aggregate accuracy
 */
export async function scoreFidelity(
  responses: EvalResponse[],
  personalities: EvalPersonality[],
  provider: JudgeProvider,
): Promise<FidelityResult> {
  // Build personality lookup: id -> personality
  const personalityMap = new Map<string, EvalPersonality>()
  for (const p of personalities) {
    personalityMap.set(p.id, p)
  }

  // Collect unique archetypes for the option set
  const archetypeSet = new Set<string>()
  for (const p of personalities) {
    if (p.archetype) archetypeSet.add(p.archetype)
  }
  const options = Array.from(archetypeSet).sort()

  if (options.length === 0) {
    return {
      overall_accuracy: 0,
      total_correct: 0,
      total_evaluated: 0,
      per_archetype: {},
    }
  }

  // Per-archetype tracking
  const perArchetype: Record<string, { correct: number; total: number }> = {}
  for (const arch of options) {
    perArchetype[arch] = { correct: 0, total: 0 }
  }

  let totalCorrect = 0
  let totalEvaluated = 0

  // Group responses by personality
  const byPersonality = new Map<string, EvalResponse[]>()
  for (const r of responses) {
    const existing = byPersonality.get(r.personality_id)
    if (existing) {
      existing.push(r)
    } else {
      byPersonality.set(r.personality_id, [r])
    }
  }

  // For each personality with an archetype, run blind identification
  for (const [personalityId, personalityResponses] of byPersonality) {
    const personality = personalityMap.get(personalityId)
    if (!personality?.archetype) continue

    // Concatenate all responses into a single transcript, stripping archetype labels
    const transcript = stripArchetypeLabels(
      personalityResponses.map(r => r.response_text).join("\n\n"),
    )

    const identified = await provider.identify(transcript, options)
    const correct = identified === personality.archetype

    totalEvaluated++
    if (correct) totalCorrect++

    const archStats = perArchetype[personality.archetype]
    if (archStats) {
      archStats.total++
      if (correct) archStats.correct++
    }
  }

  // Build result with accuracy percentages
  const per_archetype: FidelityResult["per_archetype"] = {}
  for (const [arch, stats] of Object.entries(perArchetype)) {
    per_archetype[arch] = {
      correct: stats.correct,
      total: stats.total,
      accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
    }
  }

  return {
    overall_accuracy: totalEvaluated > 0 ? totalCorrect / totalEvaluated : 0,
    total_correct: totalCorrect,
    total_evaluated: totalEvaluated,
    per_archetype,
  }
}
