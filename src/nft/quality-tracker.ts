// src/nft/quality-tracker.ts — Logging-Only Quality Tracker (Sprint 27 Task 27.2)
//
// Correlates (fingerprint_hash, model, quality_score) tuples for observability.
// Append-only log format — NO routing decisions are made from this data.
// This is a pure observation layer; quality scores inform future analysis only.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single quality observation entry */
export interface QualityEntry {
  /** SHA-256 hash of dAMP fingerprint dials */
  fingerprint_hash: string
  /** LLM model used for synthesis (e.g., "claude-sonnet-4") */
  model: string
  /** Quality score (0.0-1.0) from evaluator */
  quality_score: number
  /** Personality ID for attribution */
  personality_id: string
  /** ISO timestamp of the observation */
  timestamp: string
  /** Optional metadata (eval provider, latency, etc.) */
  metadata?: Record<string, unknown>
}

/** Aggregated quality statistics for a (fingerprint_hash, model) pair */
export interface QualityMatrixCell {
  fingerprint_hash: string
  model: string
  count: number
  mean_score: number
  min_score: number
  max_score: number
}

/** The full quality matrix: all observed (fingerprint_hash, model) pairs */
export interface QualityMatrix {
  cells: QualityMatrixCell[]
  total_entries: number
  generated_at: string
}

/** Logger sink interface — decoupled from console for testability */
export interface QualityLogSink {
  append(entry: QualityEntry): void
}

// ---------------------------------------------------------------------------
// Default Console Sink
// ---------------------------------------------------------------------------

/**
 * Console-based log sink. Writes JSON lines to stdout.
 * Append-only: no deletion, no mutation, no routing.
 */
class ConsoleQualityLogSink implements QualityLogSink {
  append(entry: QualityEntry): void {
    console.log(JSON.stringify({
      type: "quality_observation",
      ...entry,
    }))
  }
}

// ---------------------------------------------------------------------------
// In-Memory Sink (for testing and matrix generation)
// ---------------------------------------------------------------------------

/**
 * In-memory append-only log. Useful for testing and local matrix generation.
 * Not suitable for production — use a persistent sink in production.
 */
export class InMemoryQualityLogSink implements QualityLogSink {
  private readonly entries: QualityEntry[] = []

  append(entry: QualityEntry): void {
    this.entries.push({ ...entry })
  }

  /** Read-only access to all entries (defensive copy) */
  getEntries(): readonly QualityEntry[] {
    return [...this.entries]
  }

  /** Entry count */
  get size(): number {
    return this.entries.length
  }
}

// ---------------------------------------------------------------------------
// Quality Tracker
// ---------------------------------------------------------------------------

/**
 * Logging-only quality tracker. Records (fingerprint_hash, model, quality_score)
 * tuples to an append-only log sink.
 *
 * IMPORTANT: This tracker makes NO routing decisions. It is purely observational.
 * Quality data is logged for offline analysis, dashboards, and future optimization.
 */
export class QualityTracker {
  private readonly sink: QualityLogSink

  constructor(sink?: QualityLogSink) {
    this.sink = sink ?? new ConsoleQualityLogSink()
  }

  /**
   * Record a quality observation.
   *
   * @param fingerprintHash - SHA-256 hash of dAMP fingerprint dials
   * @param model - LLM model identifier
   * @param qualityScore - Quality score from evaluator (0.0-1.0, clamped)
   * @param personalityId - Personality composite key for attribution
   * @param metadata - Optional additional metadata
   */
  record(
    fingerprintHash: string,
    model: string,
    qualityScore: number,
    personalityId: string,
    metadata?: Record<string, unknown>,
  ): void {
    // Clamp score to [0, 1] — defensive, evaluators should already enforce this
    const clampedScore = Math.max(0, Math.min(1, qualityScore))

    const entry: QualityEntry = {
      fingerprint_hash: fingerprintHash,
      model,
      quality_score: clampedScore,
      personality_id: personalityId,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    }

    this.sink.append(entry)
  }
}

// ---------------------------------------------------------------------------
// Matrix Generation
// ---------------------------------------------------------------------------

/**
 * Generate a quality matrix from an in-memory log sink.
 * Groups entries by (fingerprint_hash, model) and computes aggregate statistics.
 *
 * This function operates on a snapshot of logged entries. It does NOT affect
 * routing or any runtime behavior — it is for offline analysis only.
 *
 * @param sink - In-memory log sink containing quality entries
 * @returns QualityMatrix with aggregated statistics per (hash, model) pair
 */
export function generateQualityMatrix(sink: InMemoryQualityLogSink): QualityMatrix {
  const entries = sink.getEntries()
  const groups = new Map<string, QualityEntry[]>()

  for (const entry of entries) {
    const key = `${entry.fingerprint_hash}::${entry.model}`
    const group = groups.get(key)
    if (group) {
      group.push(entry)
    } else {
      groups.set(key, [entry])
    }
  }

  const cells: QualityMatrixCell[] = []

  for (const [, group] of groups) {
    const scores = group.map(e => e.quality_score)
    const sum = scores.reduce((a, b) => a + b, 0)

    cells.push({
      fingerprint_hash: group[0].fingerprint_hash,
      model: group[0].model,
      count: group.length,
      mean_score: sum / group.length,
      min_score: Math.min(...scores),
      max_score: Math.max(...scores),
    })
  }

  // Sort for deterministic output: by fingerprint_hash, then model
  cells.sort((a, b) => {
    const hashCmp = a.fingerprint_hash.localeCompare(b.fingerprint_hash)
    if (hashCmp !== 0) return hashCmp
    return a.model.localeCompare(b.model)
  })

  return {
    cells,
    total_entries: entries.length,
    generated_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a QualityTracker with the default console sink.
 * For testing, pass an InMemoryQualityLogSink instead.
 */
export function createQualityTracker(sink?: QualityLogSink): QualityTracker {
  return new QualityTracker(sink)
}
