/**
 * Routing Quality Store — Sprint 3 (GID 123), Task T3.1
 *
 * Tracks quality per (personality, pool) tuple to feed back into routing affinity.
 * This is the "epigenetic" layer — experience modulates the genotype's expression.
 *
 * Architecture:
 * - Write path: append RoutingQualityEvent to EventWriter on "routing_quality" stream
 * - Read path: in-memory LRU cache (max 1000, TTL 5 min), cache miss aggregates
 *   last 100 events with exponential decay (half-life configurable)
 * - Scoring reads from cache ONLY — guaranteed <1ms per call
 *
 * dAMP vocabulary: quality feedback is the epigenetic layer that modulates
 * how the genotype (96 dials) is expressed as phenotype (pool selection).
 */

import type { EventWriter } from "../events/writer.js"
import type { EventReader } from "../events/reader.js"
import { STREAM_ROUTING_QUALITY } from "../events/types.js"
import { metrics } from "../gateway/metrics-endpoint.js"

// ---------------------------------------------------------------------------
// Quality Event — emitted after each inference response
// ---------------------------------------------------------------------------

export interface RoutingQualityEvent {
  /** Personality composite key (collection:tokenId) */
  personality_id: string
  /** Pool that served this request */
  pool_id: string
  /** Model identifier */
  model: string
  /** Task type (e.g., "chat", "code", "review") */
  task_type: string
  /** Response latency in milliseconds */
  latency_ms: number
  /** Total tokens consumed */
  tokens_used: number
  /** Quality signals — each optional, normalized to [0-1] */
  quality_signals: QualitySignals
}

export interface QualitySignals {
  /** User satisfaction (future: thumbs up/down → 0.0 or 1.0) */
  user_satisfaction?: number
  /** Coherence score (future: LLM-as-judge) */
  coherence_score?: number
  /** Whether the response passed safety checks */
  safety_pass: boolean
}

// ---------------------------------------------------------------------------
// Aggregated Quality Score — returned from cache
// ---------------------------------------------------------------------------

export interface QualityScore {
  /** Weighted average quality [0-1] */
  score: number
  /** Number of events aggregated */
  sample_count: number
  /** Timestamp of most recent event */
  last_updated: number
}

// ---------------------------------------------------------------------------
// LRU Cache with TTL
// ---------------------------------------------------------------------------

interface CacheEntry {
  score: QualityScore
  expires_at: number
}

class LRUCache {
  private readonly maxSize: number
  private readonly ttlMs: number
  private readonly entries = new Map<string, CacheEntry>()

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  get(key: string, now: number): QualityScore | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (now >= entry.expires_at) {
      this.entries.delete(key)
      return null
    }
    // Move to end (most recently used)
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.score
  }

  set(key: string, score: QualityScore, now: number): void {
    // Evict oldest if at capacity
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
    this.entries.set(key, { score, expires_at: now + this.ttlMs })
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

// ---------------------------------------------------------------------------
// Exponential Decay Aggregation
// ---------------------------------------------------------------------------

const DEFAULT_DECAY_HALF_LIFE_DAYS = 30
const DEFAULT_MAX_EVENTS_TO_AGGREGATE = 100
const DEFAULT_CACHE_MAX_SIZE = 1000
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Aggregate quality events with exponential decay.
 * More recent events have higher weight.
 */
function aggregateWithDecay(
  events: Array<{ quality: number; timestamp: number }>,
  halfLifeDays: number,
  now: number,
): QualityScore | null {
  if (events.length === 0) return null

  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000
  const lambda = Math.LN2 / halfLifeMs

  let weightedSum = 0
  let totalWeight = 0
  let maxTimestamp = 0

  for (const event of events) {
    const age = now - event.timestamp
    const weight = Math.exp(-lambda * Math.max(0, age))
    weightedSum += event.quality * weight
    totalWeight += weight
    if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp
  }

  if (totalWeight === 0) return null

  return {
    score: Math.max(0, Math.min(1, weightedSum / totalWeight)),
    sample_count: events.length,
    last_updated: maxTimestamp,
  }
}

/**
 * Compute a composite quality score from signals.
 * safety_pass contributes a floor — unsafe responses score 0.
 */
function qualityFromSignals(signals: QualitySignals): number {
  if (!signals.safety_pass) return 0

  const scores: number[] = []
  if (signals.user_satisfaction !== undefined) scores.push(signals.user_satisfaction)
  if (signals.coherence_score !== undefined) scores.push(signals.coherence_score)

  // If no explicit quality signals, use safety_pass as a baseline (0.5)
  if (scores.length === 0) return 0.5

  return scores.reduce((a, b) => a + b, 0) / scores.length
}

// ---------------------------------------------------------------------------
// RoutingQualityStore — Singleton
// ---------------------------------------------------------------------------

export interface RoutingQualityStoreConfig {
  /** Decay half-life in days (default: 30) */
  decayHalfLifeDays?: number
  /** Max events to aggregate on cache miss (default: 100) */
  maxEventsToAggregate?: number
  /** LRU cache max entries (default: 1000) */
  cacheMaxSize?: number
  /** Cache TTL in milliseconds (default: 300000 = 5 minutes) */
  cacheTtlMs?: number
  /** Clock function for testing (default: Date.now) */
  now?: () => number
}

export class RoutingQualityStore {
  private readonly writer: EventWriter | null
  private readonly reader: EventReader | null
  private readonly cache: LRUCache
  private readonly decayHalfLifeDays: number
  private readonly maxEventsToAggregate: number
  private readonly now: () => number

  constructor(
    writer: EventWriter | null,
    reader: EventReader | null,
    config: RoutingQualityStoreConfig = {},
  ) {
    this.writer = writer
    this.reader = reader
    this.decayHalfLifeDays = config.decayHalfLifeDays ?? DEFAULT_DECAY_HALF_LIFE_DAYS
    this.maxEventsToAggregate = config.maxEventsToAggregate ?? DEFAULT_MAX_EVENTS_TO_AGGREGATE
    this.now = config.now ?? Date.now
    this.cache = new LRUCache(
      config.cacheMaxSize ?? DEFAULT_CACHE_MAX_SIZE,
      config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    )
  }

  // -------------------------------------------------------------------------
  // Write path: append quality event to EventStore
  // -------------------------------------------------------------------------

  /**
   * Record a quality event. Fire-and-forget — errors are logged, not thrown.
   * Also updates the cache immediately for fast reads.
   */
  async recordQuality(event: RoutingQualityEvent, correlationId: string): Promise<void> {
    // Update cache proactively
    const cacheKey = `${event.personality_id}:${event.pool_id}`
    const quality = qualityFromSignals(event.quality_signals)
    const now = this.now()

    const existing = this.cache.get(cacheKey, now)
    if (existing) {
      // Incrementally update using exponential decay blending (consistent with cold path).
      // Recent observations get higher weight; older cached score decays.
      const halfLifeMs = this.decayHalfLifeDays * 24 * 60 * 60 * 1000
      const age = now - existing.last_updated
      const decayFactor = Math.exp(-(Math.LN2 / halfLifeMs) * Math.max(0, age))
      // Alpha = new observation's weight. Minimum of 1/(n+1) ensures new observations
      // always contribute, even at age=0. Decay increases alpha for stale cached scores.
      const alpha = Math.max(1 / (existing.sample_count + 1), 1 - decayFactor)
      const blendedScore = existing.score * (1 - alpha) + quality * alpha
      const newCount = existing.sample_count + 1
      this.cache.set(cacheKey, {
        score: Math.max(0, Math.min(1, blendedScore)),
        sample_count: newCount,
        last_updated: now,
      }, now)
    } else {
      this.cache.set(cacheKey, {
        score: quality,
        sample_count: 1,
        last_updated: now,
      }, now)
    }

    // Persist to EventStore (fire-and-forget)
    if (this.writer) {
      try {
        await this.writer.append(
          STREAM_ROUTING_QUALITY,
          "quality_observation",
          event,
          correlationId,
        )
      } catch (err) {
        console.warn(
          `[routing-quality] Failed to persist quality event: ${(err as Error).message}`,
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // Read path: cache-first, with EventStore fallback
  // -------------------------------------------------------------------------

  /**
   * Get aggregated quality score for a (personality, pool) pair.
   * Reads from cache (guaranteed <1ms). On cache miss, aggregates from EventStore.
   * Returns null if no quality data exists.
   */
  async getPoolQuality(personalityId: string, poolId: string): Promise<QualityScore | null> {
    const cacheKey = `${personalityId}:${poolId}`
    const now = this.now()

    // Cache hit — fast path
    const cached = this.cache.get(cacheKey, now)
    if (cached) {
      metrics.incrementCounter("finn_routing_quality_cache_hit_total")
      return cached
    }

    // Cache miss — aggregate from EventStore
    metrics.incrementCounter("finn_routing_quality_cache_miss_total")
    if (!this.reader) return null

    try {
      const allMatching: Array<{ quality: number; timestamp: number }> = []

      for await (const envelope of this.reader.replay<RoutingQualityEvent>(STREAM_ROUTING_QUALITY)) {
        if (
          envelope.payload.personality_id === personalityId &&
          envelope.payload.pool_id === poolId
        ) {
          allMatching.push({
            quality: qualityFromSignals(envelope.payload.quality_signals),
            timestamp: envelope.timestamp,
          })
        }
      }

      // Take the LAST N events (most recent by timestamp) for aggregation
      allMatching.sort((a, b) => b.timestamp - a.timestamp)
      const events = allMatching.slice(0, this.maxEventsToAggregate)

      const score = aggregateWithDecay(events, this.decayHalfLifeDays, now)
      if (score) {
        this.cache.set(cacheKey, score, now)
      }
      return score
    } catch (err) {
      console.warn(
        `[routing-quality] Failed to aggregate quality events: ${(err as Error).message}`,
      )
      return null
    }
  }

  /**
   * Synchronous cache-only read. For use in hot scoring paths.
   * Returns null on cache miss (no I/O fallback).
   */
  getPoolQualityCached(personalityId: string, poolId: string): QualityScore | null {
    const cacheKey = `${personalityId}:${poolId}`
    const result = this.cache.get(cacheKey, this.now())
    if (result) {
      metrics.incrementCounter("finn_routing_quality_cache_hit_total")
    } else {
      metrics.incrementCounter("finn_routing_quality_cache_miss_total")
    }
    return result
  }

  /**
   * Clear all cached scores. Used in testing.
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Current cache size. For monitoring.
   */
  get cacheSize(): number {
    return this.cache.size
  }
}

// Re-export for convenience
export { qualityFromSignals, aggregateWithDecay }
