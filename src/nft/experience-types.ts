// src/nft/experience-types.ts — Experience Accumulation Types (Sprint 25 Task 25.1)
//
// Type definitions for experience accumulation: snapshots, offsets, interaction
// aggregates, and in-memory experience storage. Storage keyed by personality_id
// only — no user identifiers for privacy.

import type { DAMPDialId } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Interaction Aggregate — metadata extracted from a single interaction
// ---------------------------------------------------------------------------

/**
 * Aggregated metadata from a single interaction.
 * Captures topic, style, and metaphor signals WITHOUT storing content.
 * Privacy: no user identifiers, no message content.
 */
export interface InteractionAggregate {
  /** ISO 8601 timestamp of the interaction */
  timestamp: string
  /** Detected topics with frequency counts */
  topic_frequencies: Record<string, number>
  /** Detected conversational style labels (e.g., "formal", "playful") */
  style_counts: Record<string, number>
  /** Detected metaphor families (e.g., "journey", "battle", "growth") */
  metaphor_families: Record<string, number>
  /** Per-dial signed impact from this interaction, sparse (only affected dials) */
  dial_impacts: Partial<Record<DAMPDialId, number>>
}

// ---------------------------------------------------------------------------
// Experience Offset — accumulated per-dial drift from birth values
// ---------------------------------------------------------------------------

/**
 * Per-dial signed delta offset accumulated from experience.
 * Applied to birth dials: effective_dial_i = clamp(birth_dial_i + offset_i, min, max)
 *
 * Per-epoch clamp: +/-0.5% (0.005) per dial per epoch.
 * Cumulative clamp: +/-5% (0.05) from birth values.
 */
export interface ExperienceOffset {
  /** Per-dial signed delta offsets (sparse — only dials with non-zero offset) */
  dial_offsets: Partial<Record<DAMPDialId, number>>
  /** Number of epochs that contributed to this offset */
  epoch_count: number
  /** Total number of interactions processed */
  interaction_count: number
  /** Last updated timestamp (Unix ms) */
  updated_at: number
}

// ---------------------------------------------------------------------------
// Experience Snapshot — full experience state for a personality
// ---------------------------------------------------------------------------

/**
 * Complete experience state for a personality.
 * Captures aggregated topic/style/metaphor distributions, interaction count,
 * epoch count, and per-dial signed delta offsets.
 *
 * Storage keyed by personality_id only — no user identifiers.
 * Minimum 10 interactions before persisting.
 */
export interface ExperienceSnapshot {
  /** Personality ID (collection:tokenId) — sole storage key */
  personality_id: string
  /** Aggregated topic frequency distribution across all interactions */
  topic_distribution: Record<string, number>
  /** Aggregated style counts across all interactions */
  style_counts: Record<string, number>
  /** Aggregated metaphor family usage across all interactions */
  metaphor_families: Record<string, number>
  /** Total number of interactions processed */
  interaction_count: number
  /** Number of completed epochs */
  epoch_count: number
  /** Per-dial signed delta offsets from experience */
  offsets: ExperienceOffset
  /** Pending interactions since last epoch (not yet folded into offsets) */
  pending_interactions: InteractionAggregate[]
  /** Creation timestamp (Unix ms) */
  created_at: number
  /** Last updated timestamp (Unix ms) */
  updated_at: number
}

// ---------------------------------------------------------------------------
// Experience Direction Vector — preserved during rebase
// ---------------------------------------------------------------------------

/**
 * Represents the direction of experience drift for a single dial.
 * Preserved during rebase operations to maintain behavioral trajectory.
 */
export interface ExperienceDirectionVector {
  dial_id: DAMPDialId
  /** Signed delta from birth value */
  offset: number
  /** Direction: +1 (increasing), -1 (decreasing), 0 (neutral) */
  direction: 1 | -1 | 0
}

// ---------------------------------------------------------------------------
// In-Memory Experience Storage
// ---------------------------------------------------------------------------

/** Minimum interactions required before persisting a snapshot */
export const MIN_INTERACTIONS_TO_PERSIST = 10

/** Default epoch size (interactions per epoch) */
export const DEFAULT_EPOCH_SIZE = 50

/** Per-epoch clamp: +/-0.5% per dial per epoch */
export const PER_EPOCH_CLAMP = 0.005

/** Cumulative clamp: +/-5% from birth values */
export const CUMULATIVE_CLAMP = 0.05

/**
 * In-memory experience storage keyed by personality_id.
 * Thread-safe for single-process usage (Node.js single-threaded event loop).
 *
 * Privacy: keyed by personality_id only — no user identifiers stored.
 */
export class ExperienceStore {
  private readonly snapshots = new Map<string, ExperienceSnapshot>()

  /**
   * Get the experience snapshot for a personality.
   * Returns null if no experience has been recorded.
   */
  get(personalityId: string): ExperienceSnapshot | null {
    return this.snapshots.get(personalityId) ?? null
  }

  /**
   * Store or update an experience snapshot.
   * Only persists if interaction_count >= MIN_INTERACTIONS_TO_PERSIST.
   *
   * @returns true if the snapshot was persisted, false if below threshold
   */
  set(snapshot: ExperienceSnapshot): boolean {
    if (snapshot.interaction_count < MIN_INTERACTIONS_TO_PERSIST) {
      // Still store in memory for accumulation, but mark as below threshold
      this.snapshots.set(snapshot.personality_id, snapshot)
      return false
    }
    this.snapshots.set(snapshot.personality_id, snapshot)
    return true
  }

  /**
   * Delete the experience snapshot for a personality.
   * Returns true if a snapshot was deleted, false if none existed.
   */
  delete(personalityId: string): boolean {
    return this.snapshots.delete(personalityId)
  }

  /**
   * Check if a personality has an experience snapshot.
   */
  has(personalityId: string): boolean {
    return this.snapshots.has(personalityId)
  }

  /**
   * Get the count of stored experience snapshots.
   */
  get size(): number {
    return this.snapshots.size
  }

  /**
   * Get all personality IDs with stored experience.
   */
  keys(): IterableIterator<string> {
    return this.snapshots.keys()
  }

  /**
   * Clear all stored experience data.
   */
  clear(): void {
    this.snapshots.clear()
  }

  /**
   * Create a fresh, empty experience snapshot for a personality.
   */
  static createEmpty(personalityId: string): ExperienceSnapshot {
    const now = Date.now()
    return {
      personality_id: personalityId,
      topic_distribution: {},
      style_counts: {},
      metaphor_families: {},
      interaction_count: 0,
      epoch_count: 0,
      offsets: {
        dial_offsets: {},
        epoch_count: 0,
        interaction_count: 0,
        updated_at: now,
      },
      pending_interactions: [],
      created_at: now,
      updated_at: now,
    }
  }
}
