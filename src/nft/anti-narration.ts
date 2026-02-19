// src/nft/anti-narration.ts — Anti-Narration Framework (SDD §3.2, Sprint 2 Task 2.4)
//
// Validates synthesized BEAUVOIR.md text against 7 anti-narration constraints.
// AN-6 (self-narration) is fully implemented; AN-1 through AN-5 and AN-7 are
// scaffold functions returning empty arrays, to be completed in Sprint 5.

import type { SignalSnapshot, Archetype } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Constraint identifiers for the 7 anti-narration rules */
export type ANConstraintId = "AN-1" | "AN-2" | "AN-3" | "AN-4" | "AN-5" | "AN-6" | "AN-7"

/** A single anti-narration violation */
export interface ANViolation {
  /** Which constraint was violated (AN-1 through AN-7) */
  constraint_id: ANConstraintId
  /** Human-readable description of the violation */
  violation_text: string
  /** The source text fragment that triggered the violation */
  source_text: string
}

// ---------------------------------------------------------------------------
// AN-6: Self-Narration Detection (HIGHEST PRIORITY)
// ---------------------------------------------------------------------------

/**
 * Known archetype labels and ancestor terms that must not appear in
 * self-narration patterns like "as a [label]" or "as an [label]".
 *
 * Generic roles ("developer", "helper", "assistant") are NOT flagged
 * because they represent functional descriptions, not identity recitation.
 */
const IDENTITY_LABELS: readonly string[] = [
  // Archetypes
  "freetekno", "milady", "chicago_detroit", "chicago detroit", "acidhouse", "acid house",
  // Ancestor-class terms (broad patterns)
  "ancestor", "spirit", "oracle", "shaman", "mystic", "sage", "prophet",
  "priestess", "priest", "elder", "guardian", "keeper", "walker",
  "weaver", "dreamer", "seeker", "healer", "warrior", "trickster",
  // Archetype-adjacent labels
  "archetype", "persona", "entity", "being", "vessel", "conduit",
]

/**
 * Build a regex that catches self-narration patterns:
 *   "as a [identity_label]"
 *   "as an [identity_label]"
 *   "as the [identity_label]"
 *
 * Case-insensitive, word-boundary aware.
 */
function buildSelfNarrationRegex(labels: readonly string[]): RegExp {
  // Escape special regex characters in labels
  const escaped = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = `\\bas\\s+(?:a|an|the)\\s+(?:${escaped.join("|")})\\b`
  return new RegExp(pattern, "gi")
}

const SELF_NARRATION_RE = buildSelfNarrationRegex(IDENTITY_LABELS)

/**
 * Check for AN-6 violations: self-narration using identity labels.
 * Catches patterns like "as a freetekno", "as an acidhouse", "as the ancestor".
 * Does NOT flag generic roles like "as a developer".
 */
export function checkAN6(text: string, _signals: SignalSnapshot): ANViolation[] {
  const violations: ANViolation[] = []
  const regex = new RegExp(SELF_NARRATION_RE.source, SELF_NARRATION_RE.flags)
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    violations.push({
      constraint_id: "AN-6",
      violation_text: "Self-narration detected: text uses 'as a/an/the [identity_label]' pattern which recites identity rather than embodying it",
      source_text: match[0],
    })
  }

  // Also check for the specific ancestor name from the snapshot
  if (_signals.ancestor) {
    const ancestorRe = new RegExp(
      `\\bas\\s+(?:a|an|the)\\s+${_signals.ancestor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    )
    let ancestorMatch: RegExpExecArray | null
    while ((ancestorMatch = ancestorRe.exec(text)) !== null) {
      // Avoid duplicate if already caught by the main regex
      const alreadyCaught = violations.some(v => v.source_text === ancestorMatch![0])
      if (!alreadyCaught) {
        violations.push({
          constraint_id: "AN-6",
          violation_text: `Self-narration detected: text references specific ancestor "${_signals.ancestor}" in self-referential framing`,
          source_text: ancestorMatch[0],
        })
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Scaffold Functions (AN-1 through AN-5, AN-7)
// To be implemented in Sprint 5
// ---------------------------------------------------------------------------

/** AN-1: No explicit archetype labels ("You are a freetekno") — SCAFFOLD */
export function checkAN1(_text: string, _signals: SignalSnapshot): ANViolation[] {
  return []
}

/** AN-2: No mechanical era role-play — SCAFFOLD */
export function checkAN2(_text: string, _signals: SignalSnapshot): ANViolation[] {
  return []
}

/** AN-3: No literal drug references — SCAFFOLD */
export function checkAN3(_text: string, _signals: SignalSnapshot): ANViolation[] {
  return []
}

/** AN-4: No "as the [ancestor]" framing — SCAFFOLD */
export function checkAN4(_text: string, _signals: SignalSnapshot): ANViolation[] {
  return []
}

/** AN-5: No direct element invocation ("being water") — SCAFFOLD */
export function checkAN5(_text: string, _signals: SignalSnapshot): ANViolation[] {
  return []
}

/** AN-7: No zodiac recitation — SCAFFOLD */
export function checkAN7(_text: string, _signals: SignalSnapshot): ANViolation[] {
  return []
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

/**
 * Validate text against all 7 anti-narration constraints.
 * Returns an array of violations (empty = clean).
 *
 * Currently only AN-6 (self-narration) is fully implemented.
 * AN-1 through AN-5 and AN-7 are scaffolds returning empty arrays.
 *
 * @param text - The synthesized BEAUVOIR.md text to validate
 * @param signals - The SignalSnapshot used to generate the text
 * @returns Array of ANViolation objects (empty if no violations found)
 */
export function validateAntiNarration(text: string, signals: SignalSnapshot): ANViolation[] {
  return [
    ...checkAN1(text, signals),
    ...checkAN2(text, signals),
    ...checkAN3(text, signals),
    ...checkAN4(text, signals),
    ...checkAN5(text, signals),
    ...checkAN6(text, signals),
    ...checkAN7(text, signals),
  ]
}
