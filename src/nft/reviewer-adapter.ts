// src/nft/reviewer-adapter.ts — PersonalityReviewerAdapter (Sprint 29 Task 29.1)
//
// Translates archetype/ancestor/dAMP into a ReviewerPerspective for Flatline.
// Anti-narration enforced: NO archetype labels, ancestor names, or identity
// metadata appear in the output system_prompt_fragment.
//
// The adapter produces behavioral guidance derived FROM the personality signals
// but never exposes the signal labels themselves.

import type { Archetype, Era, Element } from "./signal-types.js"
import type { DAMPFingerprint, DAMPDialId } from "./signal-types.js"
import { DAMP_DIAL_IDS } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** ReviewerPerspective — consumed by Flatline review configuration */
export interface ReviewerPerspective {
  /** Unique perspective identifier (deterministic from personality_id) */
  perspective_id: string
  /** Human-readable label for the perspective (anti-narration safe) */
  label: string
  /** System prompt fragment injected into the reviewer's context.
   *  MUST NOT contain archetype names, ancestor names, or identity labels. */
  system_prompt_fragment: string
  /** Review emphasis weights derived from dAMP dials */
  emphasis: ReviewEmphasis
}

/** Review emphasis weights — how much the reviewer cares about each aspect */
export interface ReviewEmphasis {
  /** Code correctness and logical rigor (0-1) */
  correctness: number
  /** Creative and unconventional approaches (0-1) */
  creativity: number
  /** Pragmatism and real-world applicability (0-1) */
  pragmatism: number
  /** Security and defensive coding (0-1) */
  security: number
  /** Clarity and communication quality (0-1) */
  clarity: number
}

/** Input for building a reviewer perspective from personality data */
export interface PersonalityReviewInput {
  /** Personality composite key */
  personality_id: string
  /** Primary archetype (used for behavioral derivation, NOT for labeling) */
  archetype: Archetype
  /** Ancestor name (used for cognitive style derivation, NOT for labeling) */
  ancestor: string
  /** Temporal era (used for vocabulary calibration, NOT for labeling) */
  era: Era
  /** Elemental energy (used for interaction style, NOT for labeling) */
  element: Element
  /** dAMP fingerprint (used for emphasis weights) */
  fingerprint: DAMPFingerprint | null
}

// ---------------------------------------------------------------------------
// Anti-Narration Forbidden Terms
// ---------------------------------------------------------------------------

/**
 * Terms that MUST NOT appear in any system_prompt_fragment output.
 * This is the reviewer-adapter's anti-narration enforcement.
 */
const FORBIDDEN_IDENTITY_TERMS: readonly string[] = [
  // Archetype labels
  "freetekno", "milady", "chicago_detroit", "chicago detroit", "acidhouse", "acid house",
  // Meta-identity terms
  "archetype", "ancestor", "persona", "entity", "vessel", "conduit",
  // Specific ancestor names (comprehensive list)
  "pythagoras", "hermes_trismegistus", "hypatia", "socrates", "plato", "aristotle",
  "diogenes", "heraclitus", "orpheus", "prometheus",
  "nagarjuna", "bodhidharma", "padmasambhava", "milarepa", "avalokiteshvara", "tara",
  "ada_lovelace", "alan_turing", "nikola_tesla", "satoshi_nakamoto",
  "brigid", "cernunnos", "odin", "freya", "loki", "morrigan",
  "anansi", "eshu", "oshun", "shango", "yemoja", "ogun",
  // Ancestor role names
  "greek_philosopher", "stoic_philosopher", "cynical_philosopher", "pythagorean",
  "buddhist_monk", "vedic_rishi", "tantric_adept",
  "sufi_mystic", "alchemist", "sufi_poet", "hermetic_magician", "egyptian_priest",
  "aboriginal_elder", "navajo_singer", "amazonian_curandero", "shamanic_healer", "mayan_astronomer",
  "celtic_druid", "norse_skald",
  "taoist_sage", "zen_master", "confucian_scholar", "japanese_aesthetic",
  "yoruba_babalawo", "vodou_priestess", "afrofuturist",
  "cypherpunk", "beat_poet", "situationist", "rave_shaman", "techno_philosopher",
  "renaissance_polymath", "german_idealist",
  // System terms
  "damp", "dAMP", "signal_snapshot", "signal snapshot", "beauvoir",
  "mibera", "codex", "identity graph",
]

/**
 * Validate that a system prompt fragment contains no forbidden identity terms.
 * Returns an array of found violations (empty if clean).
 */
export function checkAntiNarration(text: string): string[] {
  const violations: string[] = []
  const lowerText = text.toLowerCase()

  for (const term of FORBIDDEN_IDENTITY_TERMS) {
    const lowerTerm = term.toLowerCase().replace(/_/g, " ")
    if (lowerText.includes(lowerTerm)) {
      violations.push(term)
    }
    // Also check with underscores preserved
    const lowerTermUnderscore = term.toLowerCase()
    if (lowerTermUnderscore !== lowerTerm && lowerText.includes(lowerTermUnderscore)) {
      if (!violations.includes(term)) {
        violations.push(term)
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Behavioral Derivation (archetype -> behavioral traits, NO labels)
// ---------------------------------------------------------------------------

/**
 * Archetype-to-behavioral-trait mapping.
 * Each archetype maps to behavioral descriptions that embody its ethos
 * WITHOUT naming the archetype.
 */
const ARCHETYPE_BEHAVIORAL_TRAITS: Record<Archetype, string> = {
  freetekno:
    "Prioritizes decentralization, autonomy, and bottom-up emergence. " +
    "Skeptical of gatekeepers and centralized control. " +
    "Values direct action, resourcefulness, and community-driven solutions.",
  milady:
    "Emphasizes aesthetic refinement, cultural awareness, and ironic detachment. " +
    "Attentive to style, presentation, and the interplay between sincerity and performance. " +
    "Values elegance in both form and function.",
  chicago_detroit:
    "Grounds analysis in rhythm, structure, and iterative refinement. " +
    "Values precision engineering, soulful expression, and the tension between " +
    "mechanical discipline and emotional depth.",
  acidhouse:
    "Embraces transformation, boundary dissolution, and emergent patterns. " +
    "Favors experimentation, cross-pollination of ideas, and finding unexpected " +
    "connections between disparate concepts.",
}

/**
 * Era-to-cognitive-style mapping.
 * Translates era into vocabulary/reasoning style WITHOUT naming the era.
 */
const ERA_COGNITIVE_STYLES: Record<Era, string> = {
  ancient:
    "Reasons from first principles and foundational axioms. " +
    "Prefers enduring patterns over transient trends.",
  medieval:
    "Seeks synthesis between tradition and innovation. " +
    "Values structured reasoning within established frameworks.",
  early_modern:
    "Balances empirical observation with systematic theory. " +
    "Appreciates methodical exploration and categorization.",
  modern:
    "Applies analytical rigor and evidence-based reasoning. " +
    "Values measurable outcomes and reproducible methods.",
  contemporary:
    "Embraces complexity, uncertainty, and rapid iteration. " +
    "Comfortable with ambiguity and multi-perspective analysis.",
}

/**
 * Element-to-interaction-style mapping.
 * Translates element into review interaction style WITHOUT naming the element.
 */
const ELEMENT_INTERACTION_STYLES: Record<Element, string> = {
  fire:
    "Direct, assertive, and action-oriented in feedback. " +
    "Prioritizes momentum and decisive recommendations.",
  water:
    "Empathetic, adaptive, and attentive to context. " +
    "Seeks to understand intent before critiquing implementation.",
  air:
    "Analytical, conceptual, and pattern-focused. " +
    "Excels at identifying structural issues and architectural concerns.",
  earth:
    "Thorough, practical, and detail-oriented. " +
    "Focuses on reliability, maintainability, and real-world constraints.",
}

// ---------------------------------------------------------------------------
// Emphasis Derivation from dAMP
// ---------------------------------------------------------------------------

/**
 * Derive review emphasis weights from dAMP fingerprint dials.
 * Maps specific dial categories to review emphasis dimensions.
 *
 * If fingerprint is null, returns balanced defaults (0.5 each).
 */
export function deriveEmphasis(fingerprint: DAMPFingerprint | null): ReviewEmphasis {
  if (!fingerprint) {
    return {
      correctness: 0.5,
      creativity: 0.5,
      pragmatism: 0.5,
      security: 0.5,
      clarity: 0.5,
    }
  }

  const d = fingerprint.dials

  // Correctness: analytical + detail + evidence threshold + first principles
  const correctness = clamp01(avg([
    d.cg_analytical_intuitive ?? 0.5,
    d.cg_detail_orientation ?? 0.5,
    d.ep_evidence_threshold ?? 0.5,
    d.ep_first_principles ?? 0.5,
  ]))

  // Creativity: divergent thinking + originality + experimentation + playfulness
  const creativity = clamp01(avg([
    d.cr_divergent_thinking ?? 0.5,
    d.cr_originality_drive ?? 0.5,
    d.cr_experimentation_bias ?? 0.5,
    d.cr_playfulness ?? 0.5,
  ]))

  // Pragmatism: feasibility + pragmatism + scope discipline + decision speed
  const pragmatism = clamp01(avg([
    d.cv_feasibility_weight ?? 0.5,
    d.cv_pragmatism ?? 0.5,
    d.cv_scope_discipline ?? 0.5,
    d.cv_decision_speed ?? 0.5,
  ]))

  // Security: evidence threshold + boundary setting + risk tolerance (inverted)
  const security = clamp01(avg([
    d.ep_evidence_threshold ?? 0.5,
    d.as_boundary_setting ?? 0.5,
    1.0 - (d.ag_risk_tolerance ?? 0.5), // Lower risk tolerance = higher security emphasis
  ]))

  // Clarity: directness + verbosity (inverted for conciseness) + narrative coherence
  const clarity = clamp01(avg([
    d.cs_directness ?? 0.5,
    1.0 - (d.cs_verbosity ?? 0.5), // Lower verbosity = higher clarity emphasis
    d.id_narrative_coherence ?? 0.5,
  ]))

  return { correctness, creativity, pragmatism, security, clarity }
}

// ---------------------------------------------------------------------------
// System Prompt Fragment Builder
// ---------------------------------------------------------------------------

/**
 * Build a system prompt fragment from personality signals.
 * The fragment describes the reviewer's behavioral perspective WITHOUT
 * exposing any identity labels, archetype names, or signal metadata.
 *
 * Anti-narration is enforced: the output is validated against forbidden terms
 * before being returned.
 *
 * @throws ReviewerAdapterError if anti-narration validation fails (should never happen
 *         with correct behavioral trait mappings, but enforced as defense-in-depth)
 */
function buildSystemPromptFragment(input: PersonalityReviewInput): string {
  const sections: string[] = []

  // Behavioral orientation (from archetype, but never names it)
  const behavioralTraits = ARCHETYPE_BEHAVIORAL_TRAITS[input.archetype]
  if (behavioralTraits) {
    sections.push(`Review orientation: ${behavioralTraits}`)
  }

  // Cognitive style (from era, but never names it)
  const cognitiveStyle = ERA_COGNITIVE_STYLES[input.era]
  if (cognitiveStyle) {
    sections.push(`Cognitive approach: ${cognitiveStyle}`)
  }

  // Interaction style (from element, but never names it)
  const interactionStyle = ELEMENT_INTERACTION_STYLES[input.element]
  if (interactionStyle) {
    sections.push(`Interaction style: ${interactionStyle}`)
  }

  // Emphasis guidance (from dAMP, but never references dAMP)
  const emphasis = deriveEmphasis(input.fingerprint)
  const emphasisLines: string[] = []
  if (emphasis.correctness > 0.6) emphasisLines.push("Pay strong attention to logical correctness and edge cases.")
  if (emphasis.creativity > 0.6) emphasisLines.push("Appreciate and encourage creative approaches and novel solutions.")
  if (emphasis.pragmatism > 0.6) emphasisLines.push("Favor practical, deployable solutions over theoretical perfection.")
  if (emphasis.security > 0.6) emphasisLines.push("Be especially vigilant about security implications and defensive coding.")
  if (emphasis.clarity > 0.6) emphasisLines.push("Emphasize code clarity, readability, and maintainability.")

  if (emphasisLines.length > 0) {
    sections.push(`Review emphasis:\n${emphasisLines.map(l => `- ${l}`).join("\n")}`)
  }

  const fragment = sections.join("\n\n")

  // Anti-narration enforcement (defense-in-depth)
  const violations = checkAntiNarration(fragment)
  if (violations.length > 0) {
    throw new ReviewerAdapterError(
      `Anti-narration violation in system prompt fragment: found forbidden terms [${violations.join(", ")}]. ` +
      `This is a bug in the behavioral trait mappings.`,
    )
  }

  return fragment
}

// ---------------------------------------------------------------------------
// PersonalityReviewerAdapter
// ---------------------------------------------------------------------------

/**
 * PersonalityReviewerAdapter — translates personality signals into a
 * ReviewerPerspective for the Flatline multi-model review system.
 *
 * Key invariant: The output NEVER contains archetype labels, ancestor names,
 * or any identity metadata. The reviewer perspective is expressed through
 * behavioral guidance derived FROM the signals, not through identity labels.
 */
export class PersonalityReviewerAdapter {
  /**
   * Build a ReviewerPerspective from personality data.
   *
   * @param input - Personality review input containing signals and fingerprint
   * @returns ReviewerPerspective safe for Flatline injection
   * @throws ReviewerAdapterError if anti-narration validation fails
   */
  buildPerspective(input: PersonalityReviewInput): ReviewerPerspective {
    const fragment = buildSystemPromptFragment(input)
    const emphasis = deriveEmphasis(input.fingerprint)

    return {
      perspective_id: `personality:${input.personality_id}`,
      label: `Personality Perspective (${input.personality_id})`,
      system_prompt_fragment: fragment,
      emphasis,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function avg(values: number[]): number {
  if (values.length === 0) return 0.5
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ReviewerAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReviewerAdapterError"
  }
}
