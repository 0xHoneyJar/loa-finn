// src/nft/experience-config.ts — Per-Collection Experience Configuration (Sprint 26 Task 26.2)
//
// Configures experience accumulation behavior per collection:
// - Enable/disable experience accumulation
// - Drift bounds (per-epoch and cumulative clamps)
// - Decay half-life
// - Epoch size (interactions per epoch)
//
// Defaults are provided for all settings. Collections without explicit
// configuration inherit the global defaults.

import {
  PER_EPOCH_CLAMP,
  CUMULATIVE_CLAMP,
  DEFAULT_EPOCH_SIZE,
} from "./experience-types.js"
import { DEFAULT_HALF_LIFE_DAYS } from "./experience-engine.js"

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

/**
 * Per-collection experience configuration.
 * All fields are optional — missing fields inherit from GLOBAL_DEFAULTS.
 */
export interface CollectionExperienceConfig {
  /** Whether experience accumulation is enabled for this collection */
  enabled?: boolean
  /** Per-epoch clamp: maximum absolute drift per dial per epoch */
  per_epoch_clamp?: number
  /** Cumulative clamp: maximum absolute drift per dial from birth values */
  cumulative_clamp?: number
  /** Half-life in days for exponential decay of interaction impacts */
  decay_half_life_days?: number
  /** Number of interactions per epoch */
  epoch_size?: number
}

/**
 * Resolved experience configuration with all fields guaranteed present.
 * Produced by resolving a CollectionExperienceConfig against defaults.
 */
export interface ResolvedExperienceConfig {
  enabled: boolean
  per_epoch_clamp: number
  cumulative_clamp: number
  decay_half_life_days: number
  epoch_size: number
}

// ---------------------------------------------------------------------------
// Global Defaults
// ---------------------------------------------------------------------------

/**
 * Global default configuration values.
 * Used when no collection-specific override is provided.
 */
export const GLOBAL_DEFAULTS: Readonly<ResolvedExperienceConfig> = Object.freeze({
  enabled: true,
  per_epoch_clamp: PER_EPOCH_CLAMP,
  cumulative_clamp: CUMULATIVE_CLAMP,
  decay_half_life_days: DEFAULT_HALF_LIFE_DAYS,
  epoch_size: DEFAULT_EPOCH_SIZE,
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validation result for experience configuration.
 */
export interface ConfigValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate a collection experience configuration.
 *
 * Rules:
 * - per_epoch_clamp must be in (0, 1]
 * - cumulative_clamp must be in (0, 1]
 * - cumulative_clamp must be >= per_epoch_clamp
 * - decay_half_life_days must be > 0
 * - epoch_size must be >= 1
 *
 * @param config - Configuration to validate
 * @returns Validation result with any errors
 */
export function validateExperienceConfig(config: CollectionExperienceConfig): ConfigValidationResult {
  const errors: string[] = []

  if (config.per_epoch_clamp !== undefined) {
    if (config.per_epoch_clamp <= 0 || config.per_epoch_clamp > 1) {
      errors.push("per_epoch_clamp must be in (0, 1]")
    }
  }

  if (config.cumulative_clamp !== undefined) {
    if (config.cumulative_clamp <= 0 || config.cumulative_clamp > 1) {
      errors.push("cumulative_clamp must be in (0, 1]")
    }
  }

  // Cross-field validation: cumulative >= per_epoch
  const effectivePerEpoch = config.per_epoch_clamp ?? GLOBAL_DEFAULTS.per_epoch_clamp
  const effectiveCumulative = config.cumulative_clamp ?? GLOBAL_DEFAULTS.cumulative_clamp
  if (effectiveCumulative < effectivePerEpoch) {
    errors.push("cumulative_clamp must be >= per_epoch_clamp")
  }

  if (config.decay_half_life_days !== undefined) {
    if (config.decay_half_life_days <= 0) {
      errors.push("decay_half_life_days must be > 0")
    }
  }

  if (config.epoch_size !== undefined) {
    if (!Number.isInteger(config.epoch_size) || config.epoch_size < 1) {
      errors.push("epoch_size must be an integer >= 1")
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a partial collection config against global defaults.
 *
 * @param config - Partial collection config (may be undefined)
 * @returns Fully resolved config with all fields present
 */
export function resolveConfig(config?: CollectionExperienceConfig): ResolvedExperienceConfig {
  if (!config) return { ...GLOBAL_DEFAULTS }

  return {
    enabled: config.enabled ?? GLOBAL_DEFAULTS.enabled,
    per_epoch_clamp: config.per_epoch_clamp ?? GLOBAL_DEFAULTS.per_epoch_clamp,
    cumulative_clamp: config.cumulative_clamp ?? GLOBAL_DEFAULTS.cumulative_clamp,
    decay_half_life_days: config.decay_half_life_days ?? GLOBAL_DEFAULTS.decay_half_life_days,
    epoch_size: config.epoch_size ?? GLOBAL_DEFAULTS.epoch_size,
  }
}

// ---------------------------------------------------------------------------
// Experience Config Registry
// ---------------------------------------------------------------------------

/**
 * Registry of per-collection experience configurations.
 *
 * Collections without explicit configuration inherit GLOBAL_DEFAULTS.
 * The registry is designed for use at application startup — configurations
 * are loaded once and then resolved on demand.
 */
export class ExperienceConfigRegistry {
  private readonly configs = new Map<string, CollectionExperienceConfig>()

  /**
   * Register a configuration for a collection.
   * Validates the configuration before storing.
   *
   * @param collectionId - Collection identifier
   * @param config - Partial experience configuration
   * @throws Error if config is invalid
   */
  register(collectionId: string, config: CollectionExperienceConfig): void {
    const validation = validateExperienceConfig(config)
    if (!validation.valid) {
      throw new Error(
        `Invalid experience config for collection ${collectionId}: ${validation.errors.join(", ")}`,
      )
    }
    this.configs.set(collectionId, config)
  }

  /**
   * Get the resolved configuration for a collection.
   * Returns global defaults if no collection-specific config is registered.
   *
   * @param collectionId - Collection identifier
   * @returns Fully resolved configuration
   */
  resolve(collectionId: string): ResolvedExperienceConfig {
    const config = this.configs.get(collectionId)
    return resolveConfig(config)
  }

  /**
   * Check if a collection has experience enabled.
   *
   * @param collectionId - Collection identifier
   * @returns true if experience is enabled for this collection
   */
  isEnabled(collectionId: string): boolean {
    return this.resolve(collectionId).enabled
  }

  /**
   * Remove a collection's configuration (reverts to global defaults).
   */
  unregister(collectionId: string): boolean {
    return this.configs.delete(collectionId)
  }

  /**
   * Get the number of registered collection configs.
   */
  get size(): number {
    return this.configs.size
  }

  /**
   * List all registered collection IDs.
   */
  registeredCollections(): string[] {
    return Array.from(this.configs.keys())
  }
}
