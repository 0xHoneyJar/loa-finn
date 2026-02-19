// src/nft/flatline-bridge.ts — Flatline Personality Bridge (Sprint 29 Task 29.2)
//
// Extends the Flatline review configuration to accept personality_perspective.
// When a personality perspective is available, it is injected into the Flatline
// reviewer's context alongside the standard multi-model review configuration.
//
// This bridge does NOT modify the Flatline protocol itself — it produces
// an extended config object that Flatline consumers can optionally use.

import type { ReviewerPerspective } from "./reviewer-adapter.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Standard Flatline review config (minimal shape — not importing Flatline types
 * directly to maintain loose coupling).
 */
export interface FlatlineReviewConfig {
  /** Models to use for multi-model review */
  models: string[]
  /** Consensus threshold (0-1) for auto-integration */
  consensus_threshold: number
  /** Maximum review iterations */
  max_iterations: number
  /** Optional system prompt additions */
  system_prompt_additions?: string[]
}

/**
 * Extended Flatline config with personality perspective support.
 * Backwards-compatible: personality_perspective is optional.
 */
export interface PersonalityFlatlineConfig extends FlatlineReviewConfig {
  /** Optional personality-derived reviewer perspective.
   *  When present, the perspective's system_prompt_fragment is injected
   *  into the reviewer context. When null/undefined, standard review applies. */
  personality_perspective?: ReviewerPerspective | null
}

/** Result of applying personality perspective to a Flatline config */
export interface PerspectiveInjectionResult {
  /** The merged config with personality perspective applied */
  config: PersonalityFlatlineConfig
  /** Whether a personality perspective was actually injected */
  perspective_injected: boolean
  /** The perspective ID that was injected (null if none) */
  perspective_id: string | null
}

// ---------------------------------------------------------------------------
// Config Builder
// ---------------------------------------------------------------------------

/**
 * Extend a standard Flatline review config with a personality perspective.
 *
 * When a perspective is provided:
 * - The perspective's system_prompt_fragment is appended to system_prompt_additions
 * - The perspective is stored on the config for downstream consumers
 * - The emphasis weights are available for review weighting
 *
 * When perspective is null/undefined, the config is returned unchanged.
 *
 * @param baseConfig - Standard Flatline review configuration
 * @param perspective - Optional personality-derived reviewer perspective
 * @returns PerspectiveInjectionResult with merged config and injection metadata
 */
export function injectPersonalityPerspective(
  baseConfig: FlatlineReviewConfig,
  perspective: ReviewerPerspective | null | undefined,
): PerspectiveInjectionResult {
  if (!perspective) {
    return {
      config: { ...baseConfig, personality_perspective: null },
      perspective_injected: false,
      perspective_id: null,
    }
  }

  // Build merged system prompt additions
  const existingAdditions = baseConfig.system_prompt_additions ?? []
  const mergedAdditions = [
    ...existingAdditions,
    // Inject the personality perspective fragment with a clear delimiter
    "--- Derived Review Perspective ---",
    perspective.system_prompt_fragment,
    "--- End Review Perspective ---",
  ]

  const mergedConfig: PersonalityFlatlineConfig = {
    ...baseConfig,
    system_prompt_additions: mergedAdditions,
    personality_perspective: perspective,
  }

  return {
    config: mergedConfig,
    perspective_injected: true,
    perspective_id: perspective.perspective_id,
  }
}

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

/**
 * Validate a PersonalityFlatlineConfig.
 *
 * Checks:
 * - models array is non-empty
 * - consensus_threshold is in [0, 1]
 * - max_iterations is positive
 * - If personality_perspective is present, it has a non-empty system_prompt_fragment
 *
 * @returns Array of validation error messages (empty if valid)
 */
export function validatePersonalityFlatlineConfig(
  config: PersonalityFlatlineConfig,
): string[] {
  const errors: string[] = []

  if (!config.models || config.models.length === 0) {
    errors.push("models array must be non-empty")
  }

  if (config.consensus_threshold < 0 || config.consensus_threshold > 1) {
    errors.push("consensus_threshold must be between 0 and 1")
  }

  if (config.max_iterations < 1) {
    errors.push("max_iterations must be at least 1")
  }

  if (config.personality_perspective) {
    const pp = config.personality_perspective
    if (!pp.system_prompt_fragment || pp.system_prompt_fragment.trim().length === 0) {
      errors.push("personality_perspective.system_prompt_fragment must be non-empty")
    }
    if (!pp.perspective_id || pp.perspective_id.trim().length === 0) {
      errors.push("personality_perspective.perspective_id must be non-empty")
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a default PersonalityFlatlineConfig with sensible defaults.
 * The personality_perspective is null by default (standard review).
 */
export function createDefaultFlatlineConfig(
  models?: string[],
): PersonalityFlatlineConfig {
  return {
    models: models ?? ["claude-sonnet-4", "gpt-4.1"],
    consensus_threshold: 0.7,
    max_iterations: 3,
    system_prompt_additions: [],
    personality_perspective: null,
  }
}
