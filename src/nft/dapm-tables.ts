// src/nft/dapm-tables.ts — Legacy VoiceType → dAPM Dial Mapping (SDD §3.1, Sprint 4 Task 4.1)
//
// Maps the 4 legacy VoiceType archetypes to fixed dAPM dial offsets.
// Only conversational_style (cs_*) and emotional_tone (et_*) dials are offset;
// all other 80 dials are set to 0.5 (neutral baseline) in legacy mode.

import type { VoiceType } from "./types.js"
import type { DAPMDialId } from "./signal-types.js"
import { DAPM_DIAL_IDS } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Neutral Baseline
// ---------------------------------------------------------------------------

const NEUTRAL = 0.5

/** Clamp a value to the valid dial range [0.0, 1.0] */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

// ---------------------------------------------------------------------------
// Legacy Voice Offsets
// ---------------------------------------------------------------------------

/**
 * Per-voice offsets for legacy VoiceType → dAPM mapping.
 *
 * Only dials in the conversational_style (cs_*, dials 9-16) and
 * emotional_tone (et_*, dials 65-72) categories carry offsets.
 * All offsets are relative to the 0.5 neutral baseline.
 *
 * Dial name mapping from spec intent to actual DAPMDialId values:
 *   spec "cs_humor_frequency"    → cs_turn_taking (quick-fire exchanges)
 *   spec "cs_storytelling_tendency" → cs_narrative_tendency
 *   spec "cs_technical_depth"    → cs_reference_density (depth of references)
 *   spec "cs_question_tendency"  → cs_question_ratio
 *   spec "et_warmth"             → et_empathic_resonance
 *   spec "et_enthusiasm"         → et_passion_expression
 *   spec "et_patience"           → et_mood_stability
 *   spec "et_empathy"            → et_empathic_resonance
 *   spec "et_assertiveness"      → et_intensity_range
 *   spec "et_playfulness"        → et_positivity_bias
 *   spec "et_gravitas"           → et_composure_under_stress
 *   spec "et_vulnerability"      → et_emotional_granularity
 */
export const LEGACY_VOICE_OFFSETS: Record<VoiceType, Partial<Record<DAPMDialId, number>>> = {
  analytical: {
    cs_formality: +0.3,
    cs_directness: +0.2,
    cs_reference_density: +0.3,     // technical depth
    et_composure_under_stress: +0.2, // gravitas
  },
  creative: {
    cs_metaphor_density: +0.3,
    cs_narrative_tendency: +0.3,     // storytelling tendency
    et_positivity_bias: +0.2,        // playfulness
    et_passion_expression: +0.2,     // enthusiasm
  },
  witty: {
    cs_turn_taking: +0.4,           // humor frequency (quick exchanges)
    cs_directness: +0.2,
    et_positivity_bias: +0.3,        // playfulness
    et_intensity_range: +0.2,        // assertiveness
  },
  sage: {
    cs_verbosity: +0.1,
    cs_question_ratio: +0.2,         // question tendency
    et_mood_stability: +0.3,         // patience
    et_empathic_resonance: +0.2,     // warmth
    et_composure_under_stress: +0.2, // gravitas
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the full 96-dial dAPM fingerprint for a legacy VoiceType.
 *
 * Returns all 96 dials: non-specified dials at 0.5 (neutral), specified
 * dials at 0.5 + offset, clamped to [0.0, 1.0].
 *
 * @param voice - One of the 4 legacy VoiceType archetypes
 * @returns Record mapping all 96 DAPMDialId keys to their values
 */
export function getLegacyDAPMOffsets(voice: VoiceType): Record<DAPMDialId, number> {
  const offsets = LEGACY_VOICE_OFFSETS[voice]
  const result = {} as Record<DAPMDialId, number>

  for (const dialId of DAPM_DIAL_IDS) {
    const offset = offsets[dialId]
    result[dialId] = offset !== undefined ? clamp(NEUTRAL + offset) : NEUTRAL
  }

  return result
}
