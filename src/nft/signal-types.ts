// src/nft/signal-types.ts — Signal & Identity Types (SDD §3.1, Sprint 1 Task 1.2)
//
// Complete type system for the identity architecture:
// - Archetypes, Eras, Elements, Zodiac, SwagRank
// - TarotCard, SignalSnapshot, SignalCore8
// - DAMPDialId (96-member union), DAMPFingerprint
// - PersonalityVersion, DerivedVoiceProfile

// ---------------------------------------------------------------------------
// Compatibility Mode
// ---------------------------------------------------------------------------

export type CompatibilityMode = "legacy_v1" | "signal_v2"

// ---------------------------------------------------------------------------
// Archetypes (Tier 1 — PRD section 4.1)
// ---------------------------------------------------------------------------

export type Archetype = "freetekno" | "milady" | "chicago_detroit" | "acidhouse"

export const ARCHETYPES = ["freetekno", "milady", "chicago_detroit", "acidhouse"] as const

// ---------------------------------------------------------------------------
// Eras (Tier 1 — PRD section 4.3.1)
// ---------------------------------------------------------------------------

export type Era = "ancient" | "medieval" | "early_modern" | "modern" | "contemporary"

export const ERA_BOUNDARIES: Record<Era, { start: number; end: number }> = {
  ancient:      { start: -13000, end: 500 },
  medieval:     { start: 500,    end: 1500 },
  early_modern: { start: 1500,   end: 1800 },
  modern:       { start: 1800,   end: 1950 },
  contemporary: { start: 1950,   end: 9999 },
}

// ---------------------------------------------------------------------------
// Swag (Tier 3 — PRD section 4.1)
// ---------------------------------------------------------------------------

export type SwagRank = "SSS" | "SS" | "S" | "A" | "B" | "C" | "D" | "F"

export const SWAG_RANK_VALUES: Record<SwagRank, number> = {
  SSS: 1.0, SS: 0.875, S: 0.75, A: 0.625,
  B: 0.50, C: 0.375, D: 0.25, F: 0.125,
}

// ---------------------------------------------------------------------------
// Zodiac (Tier 3 — PRD section 4.1)
// ---------------------------------------------------------------------------

export type ZodiacSign =
  | "aries" | "taurus" | "gemini" | "cancer"
  | "leo" | "virgo" | "libra" | "scorpio"
  | "sagittarius" | "capricorn" | "aquarius" | "pisces"

export const ZODIAC_SIGNS = [
  "aries", "taurus", "gemini", "cancer",
  "leo", "virgo", "libra", "scorpio",
  "sagittarius", "capricorn", "aquarius", "pisces",
] as const

// ---------------------------------------------------------------------------
// Elements (Tier 2 — PRD section 4.1)
// ---------------------------------------------------------------------------

export type Element = "fire" | "water" | "air" | "earth"

// ---------------------------------------------------------------------------
// Tarot (Tier 2 — PRD section 4.1, bijective from molecule)
// ---------------------------------------------------------------------------

export interface TarotCard {
  name: string        // e.g., "Death", "The Fool"
  number: number      // 0-77
  suit: "wands" | "cups" | "swords" | "pentacles" | "major"
  element: Element    // Derived: wands=fire, cups=water, swords=air, pentacles=earth
}

// ---------------------------------------------------------------------------
// Mode (PRD section 4.2, FR-3.3)
// ---------------------------------------------------------------------------

export type AgentMode = "default" | "brainstorm" | "critique" | "execute"

// ---------------------------------------------------------------------------
// SignalSnapshot (PRD section 4.1)
// ---------------------------------------------------------------------------

export interface SignalSnapshot {
  // Tier 1: Load-bearing (define worldview)
  archetype: Archetype
  ancestor: string          // 33 options from mibera-codex
  birthday: string          // ISO date string (e.g., "1352-06-15")
  era: Era                  // Derived from birthday

  // Tier 2: Textural (color expression)
  molecule: string          // Drug name, 78 options from mibera-codex
  tarot: TarotCard          // Derived (bijective from molecule)
  element: Element          // Derived from tarot suit

  // Tier 3: Modifier (adjust expression)
  swag_rank: SwagRank
  swag_score: number        // 0-100 continuous
  sun_sign: ZodiacSign
  moon_sign: ZodiacSign
  ascending_sign: ZodiacSign
}

// ---------------------------------------------------------------------------
// SignalCore8 — Projected from SignalSnapshot (PRD section 4.1.2)
// ---------------------------------------------------------------------------

export interface SignalCore8 {
  value_system: Archetype                      // dim 1: from archetype
  cultural_frame: string                       // dim 2: from ancestor
  temporal_constraint: Era                     // dim 3: from era
  consciousness_orientation: number            // dim 4: from molecule+tarot (0-1)
  energy_style: Element                        // dim 5: from element
  presence_modifier: number                    // dim 6: from swag_rank+score (0-1)
  emotional_coloring: number                   // dim 7: from sun+moon+rising blend (0-1)
  task_override: AgentMode                     // dim 8: from current mode
}

// ---------------------------------------------------------------------------
// DAMPDialId — 96-member union type (12 categories × 8 dials)
// ---------------------------------------------------------------------------

export type DAMPDialId =
  // Category 1: Social Warmth (dials 1-8)
  | "sw_approachability" | "sw_emotional_attunement" | "sw_generosity"
  | "sw_trust_default" | "sw_physical_metaphor_warmth" | "sw_humor_use"
  | "sw_vulnerability_tolerance" | "sw_group_inclusion"
  // Category 2: Conversational Style (dials 9-16)
  | "cs_formality" | "cs_verbosity" | "cs_turn_taking" | "cs_question_ratio"
  | "cs_metaphor_density" | "cs_narrative_tendency" | "cs_directness"
  | "cs_reference_density"
  // Category 3: Assertiveness (dials 17-24)
  | "as_opinion_strength" | "as_disagreement_willingness" | "as_initiative"
  | "as_boundary_setting" | "as_persuasion_effort" | "as_authority_comfort"
  | "as_correction_readiness" | "as_confidence_projection"
  // Category 4: Cognitive Style (dials 25-32)
  | "cg_analytical_intuitive" | "cg_abstract_concrete" | "cg_systematic_holistic"
  | "cg_detail_orientation" | "cg_temporal_focus" | "cg_causal_reasoning"
  | "cg_pattern_recognition" | "cg_metacognition"
  // Category 5: Epistemic Behavior (dials 33-40)
  | "ep_evidence_threshold" | "ep_uncertainty_expression" | "ep_source_attribution"
  | "ep_revision_willingness" | "ep_speculation_comfort" | "ep_contrarian_tendency"
  | "ep_epistemic_humility" | "ep_first_principles"
  // Category 6: Creativity (dials 41-48)
  | "cr_divergent_thinking" | "cr_originality_drive" | "cr_combination_skill"
  | "cr_constraint_affinity" | "cr_aesthetic_sensitivity" | "cr_playfulness"
  | "cr_abstraction_comfort" | "cr_experimentation_bias"
  // Category 7: Convergence (dials 49-56)
  | "cv_closure_drive" | "cv_simplification_tendency" | "cv_feasibility_weight"
  | "cv_prioritization_strictness" | "cv_decision_speed" | "cv_completeness_need"
  | "cv_pragmatism" | "cv_scope_discipline"
  // Category 8: Motivation (dials 57-64)
  | "mo_autonomy_drive" | "mo_mastery_orientation" | "mo_purpose_seeking"
  | "mo_curiosity_breadth" | "mo_achievement_focus" | "mo_service_orientation"
  | "mo_legacy_concern" | "mo_collaboration_preference"
  // Category 9: Emotional Tone (dials 65-72)
  | "et_intensity_range" | "et_positivity_bias" | "et_emotional_granularity"
  | "et_affect_labeling" | "et_mood_stability" | "et_empathic_resonance"
  | "et_passion_expression" | "et_composure_under_stress"
  // Category 10: Social Cognition (dials 73-80)
  | "sc_perspective_taking" | "sc_norm_awareness" | "sc_coalition_instinct"
  | "sc_hierarchy_sensitivity" | "sc_reciprocity_tracking" | "sc_cultural_code_switching"
  | "sc_conflict_approach" | "sc_collective_identity"
  // Category 11: Agency (dials 81-88)
  | "ag_initiative_level" | "ag_risk_tolerance" | "ag_self_efficacy"
  | "ag_planning_horizon" | "ag_adaptability" | "ag_resource_mobilization"
  | "ag_persistence" | "ag_opportunity_seeking"
  // Category 12: Identity (dials 89-96)
  | "id_persona_stability" | "id_role_adherence" | "id_style_consistency"
  | "id_value_anchoring" | "id_narrative_coherence" | "id_cultural_grounding"
  | "id_temporal_fidelity" | "id_contradiction_tolerance"

/** All 96 DAMP dial IDs as a const array for iteration */
export const DAMP_DIAL_IDS: readonly DAMPDialId[] = [
  // Category 1: Social Warmth
  "sw_approachability", "sw_emotional_attunement", "sw_generosity",
  "sw_trust_default", "sw_physical_metaphor_warmth", "sw_humor_use",
  "sw_vulnerability_tolerance", "sw_group_inclusion",
  // Category 2: Conversational Style
  "cs_formality", "cs_verbosity", "cs_turn_taking", "cs_question_ratio",
  "cs_metaphor_density", "cs_narrative_tendency", "cs_directness",
  "cs_reference_density",
  // Category 3: Assertiveness
  "as_opinion_strength", "as_disagreement_willingness", "as_initiative",
  "as_boundary_setting", "as_persuasion_effort", "as_authority_comfort",
  "as_correction_readiness", "as_confidence_projection",
  // Category 4: Cognitive Style
  "cg_analytical_intuitive", "cg_abstract_concrete", "cg_systematic_holistic",
  "cg_detail_orientation", "cg_temporal_focus", "cg_causal_reasoning",
  "cg_pattern_recognition", "cg_metacognition",
  // Category 5: Epistemic Behavior
  "ep_evidence_threshold", "ep_uncertainty_expression", "ep_source_attribution",
  "ep_revision_willingness", "ep_speculation_comfort", "ep_contrarian_tendency",
  "ep_epistemic_humility", "ep_first_principles",
  // Category 6: Creativity
  "cr_divergent_thinking", "cr_originality_drive", "cr_combination_skill",
  "cr_constraint_affinity", "cr_aesthetic_sensitivity", "cr_playfulness",
  "cr_abstraction_comfort", "cr_experimentation_bias",
  // Category 7: Convergence
  "cv_closure_drive", "cv_simplification_tendency", "cv_feasibility_weight",
  "cv_prioritization_strictness", "cv_decision_speed", "cv_completeness_need",
  "cv_pragmatism", "cv_scope_discipline",
  // Category 8: Motivation
  "mo_autonomy_drive", "mo_mastery_orientation", "mo_purpose_seeking",
  "mo_curiosity_breadth", "mo_achievement_focus", "mo_service_orientation",
  "mo_legacy_concern", "mo_collaboration_preference",
  // Category 9: Emotional Tone
  "et_intensity_range", "et_positivity_bias", "et_emotional_granularity",
  "et_affect_labeling", "et_mood_stability", "et_empathic_resonance",
  "et_passion_expression", "et_composure_under_stress",
  // Category 10: Social Cognition
  "sc_perspective_taking", "sc_norm_awareness", "sc_coalition_instinct",
  "sc_hierarchy_sensitivity", "sc_reciprocity_tracking", "sc_cultural_code_switching",
  "sc_conflict_approach", "sc_collective_identity",
  // Category 11: Agency
  "ag_initiative_level", "ag_risk_tolerance", "ag_self_efficacy",
  "ag_planning_horizon", "ag_adaptability", "ag_resource_mobilization",
  "ag_persistence", "ag_opportunity_seeking",
  // Category 12: Identity
  "id_persona_stability", "id_role_adherence", "id_style_consistency",
  "id_value_anchoring", "id_narrative_coherence", "id_cultural_grounding",
  "id_temporal_fidelity", "id_contradiction_tolerance",
] as const

// ---------------------------------------------------------------------------
// DAMPFingerprint (PRD section 4.2)
// ---------------------------------------------------------------------------

export interface DAMPFingerprint {
  /** 96 dials, keyed by canonical dial ID, each 0.0-1.0 */
  dials: Record<DAMPDialId, number>
  /** Current mode applied to the fingerprint */
  mode: AgentMode
  /** version_id of the SignalSnapshot used for derivation */
  derived_from: string
  /** Timestamp of derivation (for cache invalidation) */
  derived_at: number
}

// ---------------------------------------------------------------------------
// DerivedVoiceProfile (replaces VoiceType enum for signal_v2 mode)
// ---------------------------------------------------------------------------

export interface DerivedVoiceProfile {
  /** Primary archetype influence on voice */
  archetype_voice: Archetype
  /** Ancestor-derived cultural framing */
  cultural_voice: string
  /** Era-constrained temporal register */
  temporal_register: Era
  /** Element-derived energy signature */
  energy_signature: Element
  /** Swag-modified confidence level (0-1) */
  confidence: number
}

// ---------------------------------------------------------------------------
// PersonalityVersion (PRD section 4.5)
// ---------------------------------------------------------------------------

export interface PersonalityVersion {
  /** Unique version ID (ULID) */
  version_id: string
  /** Link to previous version (null for first) */
  previous_version_id: string | null
  /** NFT composite key: collection:tokenId */
  personality_id: string
  /** Full signal state at this version (null for legacy_v1) */
  signal_snapshot: SignalSnapshot | null
  /** Derived 96-dial values (null for legacy_v1) */
  damp_fingerprint: DAMPFingerprint | null
  /** Generated BEAUVOIR.md at this version */
  beauvoir_md: string
  /** Wallet address that authored the change */
  authored_by: string
  /** Governance model at time of version creation */
  governance_model: "holder" | "community" | "dao"
  /** Git SHA of mibera-codex used for derivation */
  codex_version: string
  /** legacy_v1 or signal_v2 */
  compatibility_mode: CompatibilityMode
  /** Creation timestamp (Unix ms) */
  created_at: number
  /** Human-readable summary of what changed */
  change_summary: string
}
