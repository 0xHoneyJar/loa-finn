// src/nft/experience-rebase.ts — Rebase Transform for Experience Offsets (Sprint 25 Task 25.3)
//
// When a personality's birth dials change (e.g., codex re-derive), experience
// offsets must be rebased to preserve the direction and magnitude of behavioral
// drift while respecting cumulative clamp bounds under the new birth values.
//
// Rebase rule:
//   rebased_offset = clamp(old_offset, -CUMULATIVE_CLAMP, +CUMULATIVE_CLAMP)
//   effective = clamp(new_birth + rebased_offset, new_birth - 0.05, new_birth + 0.05)
//
// Direction vectors (sign of offset) are preserved. Magnitude is preserved
// up to the cumulative clamp limit.

import type { DAMPDialId, DAMPFingerprint } from "./signal-types.js"
import { DAMP_DIAL_IDS } from "./signal-types.js"
import type { ExperienceOffset, ExperienceDirectionVector } from "./experience-types.js"
import { CUMULATIVE_CLAMP } from "./experience-types.js"
import { computeEffectiveDial } from "./experience-engine.js"

// ---------------------------------------------------------------------------
// Direction Vector Extraction
// ---------------------------------------------------------------------------

/**
 * Extract experience direction vectors from an offset record.
 * Direction vectors capture the sign and magnitude of each dial's drift.
 *
 * @param offsets - Current experience offsets
 * @returns Array of direction vectors for all dials with non-zero offset
 */
export function extractDirectionVectors(
  offsets: ExperienceOffset,
): ExperienceDirectionVector[] {
  const vectors: ExperienceDirectionVector[] = []

  for (const dialId of DAMP_DIAL_IDS) {
    const offset = offsets.dial_offsets[dialId]
    if (offset !== undefined && offset !== 0) {
      vectors.push({
        dial_id: dialId,
        offset,
        direction: offset > 0 ? 1 : -1,
      })
    }
  }

  return vectors
}

// ---------------------------------------------------------------------------
// Single-Dial Rebase
// ---------------------------------------------------------------------------

/**
 * Rebase a single dial's experience offset from old birth to new birth.
 *
 * The offset is preserved (direction + magnitude) up to the cumulative clamp.
 * The effective value under the new birth is:
 *   effective = clamp(new_birth + rebased_offset, new_birth - 0.05, new_birth + 0.05)
 *
 * Examples:
 *   rebase(old_birth=0.6, new_birth=0.7, old_offset=+0.03) => rebased=+0.03, effective=0.73
 *   rebase(old_birth=0.6, new_birth=0.7, old_offset=+0.06) => rebased=+0.05, effective=0.75
 *
 * @param oldBirth - Previous birth dial value
 * @param newBirth - New birth dial value after re-derive
 * @param oldOffset - Previous experience offset (signed)
 * @returns Object with rebased offset and effective dial value
 */
export function rebaseDial(
  _oldBirth: number,
  newBirth: number,
  oldOffset: number,
): { rebasedOffset: number; effectiveValue: number } {
  // Clamp offset to cumulative bounds (preserves direction)
  const rebasedOffset = Math.max(-CUMULATIVE_CLAMP, Math.min(CUMULATIVE_CLAMP, oldOffset))

  // Compute effective value under new birth
  const effectiveValue = computeEffectiveDial(newBirth, rebasedOffset)

  return { rebasedOffset, effectiveValue }
}

// ---------------------------------------------------------------------------
// Full Rebase Transform
// ---------------------------------------------------------------------------

/**
 * Rebase result for a full offset record.
 */
export interface RebaseResult {
  /** Rebased offsets (direction preserved, magnitude clamped) */
  rebasedOffsets: ExperienceOffset
  /** Per-dial effective values under the new birth fingerprint */
  effectiveValues: Partial<Record<DAMPDialId, number>>
  /** Direction vectors that were preserved */
  preservedDirections: ExperienceDirectionVector[]
  /** Number of dials that were rebased */
  rebasedDialCount: number
}

/**
 * Rebase all experience offsets from old birth fingerprint to new birth fingerprint.
 *
 * Preserves experience direction vectors while respecting cumulative clamp
 * bounds under the new birth values. This is the primary transform for
 * maintaining behavioral trajectory through codex re-derivation.
 *
 * @param oldBirthFingerprint - Previous birth dAMP fingerprint
 * @param newBirthFingerprint - New birth dAMP fingerprint after re-derive
 * @param currentOffsets - Current experience offsets to rebase
 * @returns RebaseResult with rebased offsets and effective values
 */
export function rebaseExperience(
  oldBirthFingerprint: DAMPFingerprint,
  newBirthFingerprint: DAMPFingerprint,
  currentOffsets: ExperienceOffset,
): RebaseResult {
  // Extract direction vectors before rebase (for preservation tracking)
  const directionVectors = extractDirectionVectors(currentOffsets)

  const rebasedDialOffsets: Partial<Record<DAMPDialId, number>> = {}
  const effectiveValues: Partial<Record<DAMPDialId, number>> = {}
  let rebasedDialCount = 0

  for (const dialId of DAMP_DIAL_IDS) {
    const oldOffset = currentOffsets.dial_offsets[dialId]
    if (oldOffset === undefined || oldOffset === 0) {
      continue
    }

    const oldBirth = oldBirthFingerprint.dials[dialId]
    const newBirth = newBirthFingerprint.dials[dialId]

    const { rebasedOffset, effectiveValue } = rebaseDial(oldBirth, newBirth, oldOffset)

    rebasedDialOffsets[dialId] = rebasedOffset
    effectiveValues[dialId] = effectiveValue
    rebasedDialCount++
  }

  const rebasedOffsets: ExperienceOffset = {
    dial_offsets: rebasedDialOffsets,
    epoch_count: currentOffsets.epoch_count,
    interaction_count: currentOffsets.interaction_count,
    updated_at: Date.now(),
  }

  // Track which direction vectors were preserved
  const preservedDirections: ExperienceDirectionVector[] = []
  for (const vec of directionVectors) {
    const rebasedOffset = rebasedDialOffsets[vec.dial_id]
    if (rebasedOffset !== undefined && rebasedOffset !== 0) {
      const newDirection: 1 | -1 | 0 = rebasedOffset > 0 ? 1 : rebasedOffset < 0 ? -1 : 0
      if (newDirection === vec.direction) {
        preservedDirections.push({
          dial_id: vec.dial_id,
          offset: rebasedOffset,
          direction: newDirection,
        })
      }
    }
  }

  return {
    rebasedOffsets,
    effectiveValues,
    preservedDirections,
    rebasedDialCount,
  }
}

// ---------------------------------------------------------------------------
// Convenience: Apply rebased offsets to a new birth fingerprint
// ---------------------------------------------------------------------------

/**
 * Produce a full effective fingerprint by applying rebased offsets to new birth dials.
 *
 * @param newBirthFingerprint - New birth dAMP fingerprint
 * @param rebasedOffsets - Rebased experience offsets
 * @returns New DAMPFingerprint with experience applied
 */
export function applyRebasedOffsets(
  newBirthFingerprint: DAMPFingerprint,
  rebasedOffsets: ExperienceOffset,
): DAMPFingerprint {
  const newDials = { ...newBirthFingerprint.dials }

  for (const dialId of DAMP_DIAL_IDS) {
    const offset = rebasedOffsets.dial_offsets[dialId]
    if (offset !== undefined && offset !== 0) {
      newDials[dialId] = computeEffectiveDial(newBirthFingerprint.dials[dialId], offset)
    }
  }

  return {
    ...newBirthFingerprint,
    dials: newDials,
    derived_at: Date.now(),
  }
}
