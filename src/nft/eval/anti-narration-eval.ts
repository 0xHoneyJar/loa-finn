// src/nft/eval/anti-narration-eval.ts — Anti-Narration Batch Checker (Sprint 12 Task 12.4)
//
// Batch wrapper around validateAntiNarration() for eval harness integration.
// Processes multiple conversations and aggregates violations by constraint.

import { validateAntiNarration } from "../anti-narration.js"
import type { SignalSnapshot } from "../signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ANBatchResult {
  /** Number of conversations processed */
  total_conversations: number
  /** Total violations found across all conversations */
  total_violations: number
  /** Detailed violation list with personality attribution */
  violations: Array<{
    personality_id: string
    constraint_id: string
    violation_text: string
    source_text: string
  }>
  /** Violation count per constraint ID (e.g., { "AN-1": 3, "AN-6": 1 }) */
  per_constraint: Record<string, number>
}

// ---------------------------------------------------------------------------
// Batch Checker
// ---------------------------------------------------------------------------

/**
 * Run anti-narration validation across a batch of conversations.
 *
 * Each conversation has a personality_id, text content, and the SignalSnapshot
 * used to generate that text. Returns aggregate results with per-constraint
 * violation counts and full violation details.
 *
 * @param conversations - Array of conversation objects to validate
 * @returns ANBatchResult with per-constraint and aggregate violation data
 */
export function checkAntiNarrationBatch(
  conversations: Array<{
    personality_id: string
    text: string
    signals: SignalSnapshot
  }>,
): ANBatchResult {
  const violations: ANBatchResult["violations"] = []
  const per_constraint: Record<string, number> = {}

  for (const convo of conversations) {
    const results = validateAntiNarration(convo.text, convo.signals)

    for (const v of results) {
      violations.push({
        personality_id: convo.personality_id,
        constraint_id: v.constraint_id,
        violation_text: v.violation_text,
        source_text: v.source_text,
      })

      per_constraint[v.constraint_id] = (per_constraint[v.constraint_id] ?? 0) + 1
    }
  }

  return {
    total_conversations: conversations.length,
    total_violations: violations.length,
    violations,
    per_constraint,
  }
}
