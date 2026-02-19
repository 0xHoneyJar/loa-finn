// src/nft/experience-engine.ts — Epoch Trigger Engine & Drift Computation (Sprint 25 Task 25.2)
//
// Manages epoch lifecycle: triggers after N interactions, computes per-dial
// drift with exponential decay, and clamps offsets within bounds.
//
// Decay formula: interaction_impact * exp(-lambda * age_days)
//   where lambda = ln(2) / half_life_days
//
// Per-epoch clamp: +/-0.5% per dial per epoch
// Cumulative clamp: +/-5% from birth values

import type { DAMPDialId, DAMPFingerprint } from "./signal-types.js"
import { DAMP_DIAL_IDS } from "./signal-types.js"
import type {
  ExperienceSnapshot,
  ExperienceOffset,
  InteractionAggregate,
} from "./experience-types.js"
import {
  ExperienceStore,
  PER_EPOCH_CLAMP,
  CUMULATIVE_CLAMP,
  DEFAULT_EPOCH_SIZE,
} from "./experience-types.js"

// ---------------------------------------------------------------------------
// Decay Constants
// ---------------------------------------------------------------------------

/** Default half-life in days for exponential decay */
export const DEFAULT_HALF_LIFE_DAYS = 30

/** Milliseconds per day */
const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Decay Computation
// ---------------------------------------------------------------------------

/**
 * Compute the exponential decay factor for an interaction given its age.
 *
 * Formula: exp(-lambda * age_days)
 *   where lambda = ln(2) / half_life_days
 *
 * @param ageDays - Age of the interaction in days (fractional ok)
 * @param halfLifeDays - Half-life in days (default 30)
 * @returns Decay factor in (0, 1]
 */
export function computeDecayFactor(ageDays: number, halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS): number {
  if (ageDays <= 0) return 1.0
  if (halfLifeDays <= 0) return 0.0
  const lambda = Math.LN2 / halfLifeDays
  return Math.exp(-lambda * ageDays)
}

/**
 * Compute the decayed impact for a single dial from a single interaction.
 *
 * Formula: interaction_impact * exp(-lambda * age_days)
 *
 * @param impact - Raw signed impact value for this dial
 * @param ageDays - Age of the interaction in days
 * @param halfLifeDays - Half-life in days
 * @returns Decayed signed impact value
 */
export function computeDecayedImpact(
  impact: number,
  ageDays: number,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  return impact * computeDecayFactor(ageDays, halfLifeDays)
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

/**
 * Clamp a per-epoch dial delta to the per-epoch bounds.
 *
 * @param delta - Raw epoch delta for a single dial
 * @returns Clamped delta within [-PER_EPOCH_CLAMP, +PER_EPOCH_CLAMP]
 */
export function clampEpochDelta(delta: number): number {
  return Math.max(-PER_EPOCH_CLAMP, Math.min(PER_EPOCH_CLAMP, delta))
}

/**
 * Clamp a cumulative offset to the cumulative bounds.
 *
 * @param offset - Current cumulative offset for a single dial
 * @returns Clamped offset within [-CUMULATIVE_CLAMP, +CUMULATIVE_CLAMP]
 */
export function clampCumulativeOffset(offset: number): number {
  return Math.max(-CUMULATIVE_CLAMP, Math.min(CUMULATIVE_CLAMP, offset))
}

/**
 * Compute the effective dial value after applying experience offset.
 *
 * Formula: clamp(birth_dial_i + experience_offset_i, birth_dial_i - 0.05, birth_dial_i + 0.05)
 * Also clamped to [0, 1] for valid dial range.
 *
 * @param birthValue - Original birth dial value (0-1)
 * @param experienceOffset - Accumulated experience offset (signed)
 * @returns Effective dial value in [0, 1]
 */
export function computeEffectiveDial(birthValue: number, experienceOffset: number): number {
  const clamped = Math.max(
    birthValue - CUMULATIVE_CLAMP,
    Math.min(birthValue + CUMULATIVE_CLAMP, birthValue + experienceOffset),
  )
  // Also clamp to valid dial range [0, 1]
  return Math.max(0, Math.min(1, clamped))
}

// ---------------------------------------------------------------------------
// Epoch Processing
// ---------------------------------------------------------------------------

/**
 * Check whether an epoch should trigger based on pending interaction count.
 *
 * @param pendingCount - Number of pending interactions since last epoch
 * @param epochSize - Interactions per epoch (default 50)
 * @returns true if an epoch should trigger
 */
export function shouldTriggerEpoch(pendingCount: number, epochSize: number = DEFAULT_EPOCH_SIZE): boolean {
  return pendingCount >= epochSize
}

/**
 * Process a single epoch: fold pending interactions into offsets.
 *
 * For each pending interaction, compute decayed impact per dial,
 * sum into epoch deltas, clamp each epoch delta, then merge
 * into cumulative offsets with cumulative clamping.
 *
 * @param snapshot - Current experience snapshot (mutated in place)
 * @param nowMs - Current time in milliseconds (for decay computation)
 * @param halfLifeDays - Half-life in days for decay
 * @returns The epoch deltas that were applied (for observability)
 */
export function processEpoch(
  snapshot: ExperienceSnapshot,
  nowMs: number = Date.now(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): Partial<Record<DAMPDialId, number>> {
  const pending = snapshot.pending_interactions
  if (pending.length === 0) {
    return {}
  }

  // Accumulate decayed impacts into epoch deltas
  const epochDeltas: Partial<Record<DAMPDialId, number>> = {}

  for (const interaction of pending) {
    const interactionTime = new Date(interaction.timestamp).getTime()
    const ageDays = Math.max(0, (nowMs - interactionTime) / MS_PER_DAY)

    for (const [dialIdStr, impact] of Object.entries(interaction.dial_impacts)) {
      const dialId = dialIdStr as DAMPDialId
      const decayed = computeDecayedImpact(impact, ageDays, halfLifeDays)
      epochDeltas[dialId] = (epochDeltas[dialId] ?? 0) + decayed
    }
  }

  // Clamp each epoch delta to per-epoch bounds
  for (const dialId of Object.keys(epochDeltas) as DAMPDialId[]) {
    epochDeltas[dialId] = clampEpochDelta(epochDeltas[dialId]!)
  }

  // Merge epoch deltas into cumulative offsets with cumulative clamping
  const offsets = snapshot.offsets
  for (const dialId of Object.keys(epochDeltas) as DAMPDialId[]) {
    const currentOffset = offsets.dial_offsets[dialId] ?? 0
    const newOffset = currentOffset + epochDeltas[dialId]!
    offsets.dial_offsets[dialId] = clampCumulativeOffset(newOffset)
  }

  // Update epoch metadata
  offsets.epoch_count += 1
  offsets.interaction_count += pending.length
  offsets.updated_at = nowMs

  snapshot.epoch_count += 1
  snapshot.pending_interactions = []
  snapshot.updated_at = nowMs

  return epochDeltas
}

// ---------------------------------------------------------------------------
// Experience Engine — orchestrates accumulation + epoch triggering
// ---------------------------------------------------------------------------

export interface ExperienceEngineConfig {
  /** Interactions per epoch (default 50) */
  epochSize?: number
  /** Half-life in days for exponential decay (default 30) */
  halfLifeDays?: number
}

/**
 * Experience Engine — orchestrates interaction accumulation and epoch processing.
 *
 * Records interactions into pending buffers and triggers epoch processing
 * when the buffer reaches the configured epoch size.
 */
export class ExperienceEngine {
  private readonly store: ExperienceStore
  private readonly epochSize: number
  private readonly halfLifeDays: number

  constructor(store: ExperienceStore, config: ExperienceEngineConfig = {}) {
    this.store = store
    this.epochSize = config.epochSize ?? DEFAULT_EPOCH_SIZE
    this.halfLifeDays = config.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  }

  /**
   * Record a single interaction for a personality.
   * Automatically triggers epoch processing if threshold reached.
   *
   * @param personalityId - Personality ID (collection:tokenId)
   * @param aggregate - Interaction metadata aggregate
   * @returns Object indicating if an epoch was processed and the epoch deltas
   */
  recordInteraction(
    personalityId: string,
    aggregate: InteractionAggregate,
  ): { epochTriggered: boolean; epochDeltas: Partial<Record<DAMPDialId, number>> | null } {
    // Get or create snapshot
    let snapshot = this.store.get(personalityId)
    if (!snapshot) {
      snapshot = ExperienceStore.createEmpty(personalityId)
    }

    // Merge aggregate into snapshot distributions
    mergeTopics(snapshot, aggregate)
    mergeStyles(snapshot, aggregate)
    mergeMetaphors(snapshot, aggregate)

    // Add to pending interactions
    snapshot.pending_interactions.push(aggregate)
    snapshot.interaction_count += 1
    snapshot.updated_at = Date.now()

    // Check epoch trigger
    let epochTriggered = false
    let epochDeltas: Partial<Record<DAMPDialId, number>> | null = null

    if (shouldTriggerEpoch(snapshot.pending_interactions.length, this.epochSize)) {
      epochDeltas = processEpoch(snapshot, Date.now(), this.halfLifeDays)
      epochTriggered = true
    }

    // Persist
    this.store.set(snapshot)

    return { epochTriggered, epochDeltas }
  }

  /**
   * Apply experience offsets to a birth fingerprint to produce effective dials.
   *
   * @param birthFingerprint - Original birth dAMP fingerprint
   * @param personalityId - Personality ID to look up experience
   * @returns New fingerprint with experience offsets applied, or birth fingerprint if no experience
   */
  applyExperience(
    birthFingerprint: DAMPFingerprint,
    personalityId: string,
  ): DAMPFingerprint {
    const snapshot = this.store.get(personalityId)
    if (!snapshot) return birthFingerprint

    const offsets = snapshot.offsets.dial_offsets
    const newDials = { ...birthFingerprint.dials }

    for (const dialId of DAMP_DIAL_IDS) {
      const offset = offsets[dialId]
      if (offset !== undefined && offset !== 0) {
        newDials[dialId] = computeEffectiveDial(birthFingerprint.dials[dialId], offset)
      }
    }

    return {
      ...birthFingerprint,
      dials: newDials,
      derived_at: Date.now(),
    }
  }

  /** Get the backing store for direct access */
  getStore(): ExperienceStore {
    return this.store
  }
}

// ---------------------------------------------------------------------------
// Distribution Merge Helpers
// ---------------------------------------------------------------------------

function mergeTopics(snapshot: ExperienceSnapshot, aggregate: InteractionAggregate): void {
  for (const [topic, count] of Object.entries(aggregate.topic_frequencies)) {
    snapshot.topic_distribution[topic] = (snapshot.topic_distribution[topic] ?? 0) + count
  }
}

function mergeStyles(snapshot: ExperienceSnapshot, aggregate: InteractionAggregate): void {
  for (const [style, count] of Object.entries(aggregate.style_counts)) {
    snapshot.style_counts[style] = (snapshot.style_counts[style] ?? 0) + count
  }
}

function mergeMetaphors(snapshot: ExperienceSnapshot, aggregate: InteractionAggregate): void {
  for (const [family, count] of Object.entries(aggregate.metaphor_families)) {
    snapshot.metaphor_families[family] = (snapshot.metaphor_families[family] ?? 0) + count
  }
}
