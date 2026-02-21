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
 * - Sprint 2 (GID 125): In-memory dual-index for O(1) lookups + collection grouping
 *
 * dAMP vocabulary: quality feedback is the epigenetic layer that modulates
 * how the genotype (96 dials) is expressed as phenotype (pool selection).
 */

import type { EventWriter } from "../events/writer.js"
import type { EventReader } from "../events/reader.js"
import type { EventEnvelope } from "../events/types.js"
import { STREAM_ROUTING_QUALITY, computePayloadChecksum, EVENT_ENVELOPE_SCHEMA_VERSION } from "../events/types.js"
import { JsonlEventWriter } from "../events/jsonl-writer.js"
import { JsonlEventReader } from "../events/jsonl-reader.js"
import { metrics } from "../gateway/metrics-endpoint.js"
import type { Archetype } from "./signal-types.js"
import { governedQualityFromSignals } from "./quality-governance.js"
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

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
  /** Archetype for governance-aware quality scoring */
  archetype?: string
}

export interface QualitySignals {
  /** User satisfaction (future: thumbs up/down → 0.0 or 1.0) */
  user_satisfaction?: number
  /** Coherence score (future: LLM-as-judge) */
  coherence_score?: number
  /** Whether the response passed safety checks */
  safety_pass: boolean
  /** Challenge rate [0-1]: how often the personality pushes back on user assumptions (Sprint 1, T1.1) */
  challenge_rate?: number
  /** Task completion [0-1]: downstream task success (Sprint 1, T1.1 — deferred signal, placeholder) */
  task_completion?: number
  /** Response depth [0-1]: engagement depth vs. surface agreement (Sprint 1, T1.1) */
  response_depth?: number
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
// Quality Event Index — Sprint 2 (GID 125), Task T2.1
// ---------------------------------------------------------------------------

/** Single indexed quality observation */
interface IndexEntry {
  quality: number
  timestamp: number
}

const DEFAULT_INDEX_MAX_KEYS = 1000
const DEFAULT_INDEX_MAX_EVENTS_PER_KEY = 100

export interface QualityEventIndexConfig {
  /** Max keys before LRU eviction (default: 1000) */
  maxIndexKeys?: number
  /** Max events per key — ring buffer (default: 100) */
  maxEventsPerKey?: number
  /** Enable index (default: true, overridden by FINN_QUALITY_INDEX_ENABLED) */
  enabled?: boolean
}

/**
 * Extract collection ID from a cache key.
 * Cache key format: "collection:tokenId:poolId"
 * Returns the first segment before ":".
 */
export function extractCollectionId(cacheKey: string): string {
  const idx = cacheKey.indexOf(":")
  return idx >= 0 ? cacheKey.slice(0, idx) : cacheKey
}

/**
 * Extract pool ID from a cache key.
 * Cache key format: "collection:tokenId:poolId"
 * Returns the segment after the last ":".
 */
export function extractPoolId(cacheKey: string): string {
  const idx = cacheKey.lastIndexOf(":")
  return idx >= 0 ? cacheKey.slice(idx + 1) : cacheKey
}

/**
 * In-memory dual-index for O(1) quality event lookups.
 *
 * Primary: Map<cacheKey, Array<{quality, timestamp}>> — for O(1) lookups on cache miss
 * Secondary: Map<collectionId, Set<cacheKey>> — for efficient collection-level aggregation
 *
 * Built lazily on first full stream scan. Updated incrementally on recordQuality().
 * Hard caps with LRU eviction prevent unbounded memory growth.
 */
export class QualityEventIndex {
  private readonly primary = new Map<string, IndexEntry[]>()
  private readonly accessOrder = new Map<string, number>()
  private readonly collectionIdx = new Map<string, Set<string>>()
  private readonly maxKeys: number
  private readonly maxEventsPerKey: number
  private readonly enabled: boolean
  private _built = false
  private accessCounter = 0

  constructor(config: QualityEventIndexConfig = {}) {
    this.maxKeys = config.maxIndexKeys ?? parseIntEnv("FINN_QUALITY_INDEX_MAX_KEYS", DEFAULT_INDEX_MAX_KEYS)
    this.maxEventsPerKey = config.maxEventsPerKey ?? DEFAULT_INDEX_MAX_EVENTS_PER_KEY
    this.enabled = config.enabled ?? (process.env.FINN_QUALITY_INDEX_ENABLED !== "false")
  }

  get isBuilt(): boolean { return this._built }
  get isEnabled(): boolean { return this.enabled }
  get keyCount(): number { return this.primary.size }

  /**
   * Build the index from a full set of events (lazy initialization).
   * Called on first cache miss that triggers a full stream replay.
   */
  buildFromEvents(events: Array<{ key: string; quality: number; timestamp: number }>): void {
    if (!this.enabled) return

    this.primary.clear()
    this.collectionIdx.clear()
    this.accessOrder.clear()
    this.accessCounter = 0

    // Group by key
    const grouped = new Map<string, IndexEntry[]>()
    for (const event of events) {
      let entries = grouped.get(event.key)
      if (!entries) {
        entries = []
        grouped.set(event.key, entries)
      }
      entries.push({ quality: event.quality, timestamp: event.timestamp })
    }

    // Sort each group by timestamp descending, cap at maxEventsPerKey
    for (const [key, entries] of grouped) {
      entries.sort((a, b) => b.timestamp - a.timestamp)
      this.primary.set(key, entries.slice(0, this.maxEventsPerKey))
      this.accessOrder.set(key, this.accessCounter++)

      // Build collection secondary index
      const collectionId = extractCollectionId(key)
      let set = this.collectionIdx.get(collectionId)
      if (!set) {
        set = new Set()
        this.collectionIdx.set(collectionId, set)
      }
      set.add(key)
    }

    // LRU eviction if over maxKeys
    this.evictIfNeeded()
    this._built = true
  }

  /**
   * Add a single event incrementally (on recordQuality).
   */
  addEvent(key: string, quality: number, timestamp: number): void {
    if (!this.enabled) return

    let entries = this.primary.get(key)
    if (!entries) {
      entries = []
      this.primary.set(key, entries)

      // Add to collection index
      const collectionId = extractCollectionId(key)
      let set = this.collectionIdx.get(collectionId)
      if (!set) {
        set = new Set()
        this.collectionIdx.set(collectionId, set)
      }
      set.add(key)
    }

    // Ring buffer: drop oldest if at capacity
    if (entries.length >= this.maxEventsPerKey) {
      let minIdx = 0
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].timestamp < entries[minIdx].timestamp) {
          minIdx = i
        }
      }
      entries.splice(minIdx, 1)
    }

    entries.push({ quality, timestamp })
    this.accessOrder.set(key, this.accessCounter++)
    this.evictIfNeeded()
  }

  /**
   * Get indexed events for a cache key. Returns null if key not found.
   */
  getEvents(key: string): IndexEntry[] | null {
    const entries = this.primary.get(key)
    if (!entries) return null
    this.accessOrder.set(key, this.accessCounter++)
    return entries
  }

  /**
   * Get all cache keys for a collection (via secondary index).
   */
  getCollectionKeys(collectionId: string): Set<string> | null {
    return this.collectionIdx.get(collectionId) ?? null
  }

  /** Clear and mark as unbuilt. */
  clear(): void {
    this.primary.clear()
    this.collectionIdx.clear()
    this.accessOrder.clear()
    this.accessCounter = 0
    this._built = false
  }

  private evictIfNeeded(): void {
    while (this.primary.size > this.maxKeys) {
      // Evict least recently accessed key
      let lruKey: string | null = null
      let lruAccess = Infinity
      for (const [key, access] of this.accessOrder) {
        if (access < lruAccess) {
          lruAccess = access
          lruKey = key
        }
      }
      if (!lruKey) break

      this.primary.delete(lruKey)
      this.accessOrder.delete(lruKey)

      // Remove from collection index
      const collectionId = extractCollectionId(lruKey)
      const set = this.collectionIdx.get(collectionId)
      if (set) {
        set.delete(lruKey)
        if (set.size === 0) {
          this.collectionIdx.delete(collectionId)
        }
      }
    }
  }
}

/** Parse int from env var with fallback */
function parseIntEnv(key: string, fallback: number): number {
  const val = process.env[key]
  if (!val) return fallback
  const parsed = parseInt(val, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
function qualityFromSignals(signals: QualitySignals, archetype?: Archetype): number {
  if (!signals.safety_pass) return 0

  // Governance path: anti-sycophancy + archetype-aware weighting
  if (archetype) {
    try {
      const governed = governedQualityFromSignals(signals, archetype)
      if (governed !== null) return governed
    } catch {
      // Fall back to ungoverned scoring (fire-and-forget invariant)
    }
  }

  // Ungoverned path: simple average of all available signals
  const scores: number[] = []
  if (signals.user_satisfaction !== undefined) scores.push(signals.user_satisfaction)
  if (signals.coherence_score !== undefined) scores.push(signals.coherence_score)
  if (signals.challenge_rate !== undefined) scores.push(signals.challenge_rate)
  if (signals.task_completion !== undefined) scores.push(signals.task_completion)
  if (signals.response_depth !== undefined) scores.push(signals.response_depth)

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
  /** Quality event index config (Sprint 2, T2.1) */
  indexConfig?: QualityEventIndexConfig
}

export class RoutingQualityStore {
  private readonly writer: EventWriter | null
  private readonly reader: EventReader | null
  private readonly cache: LRUCache
  private readonly decayHalfLifeDays: number
  private readonly maxEventsToAggregate: number
  private readonly now: () => number
  /** In-memory dual-index for O(1) lookups (Sprint 2, T2.1) */
  readonly index: QualityEventIndex

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
    this.index = new QualityEventIndex(config.indexConfig)
  }

  // -------------------------------------------------------------------------
  // Write path: append quality event to EventStore
  // -------------------------------------------------------------------------

  /**
   * Record a quality event. Fire-and-forget — errors are logged, not thrown.
   * Also updates the cache and index immediately for fast reads.
   */
  async recordQuality(event: RoutingQualityEvent, correlationId: string): Promise<void> {
    // Update cache proactively
    const cacheKey = `${event.personality_id}:${event.pool_id}`
    let quality: number
    try {
      quality = qualityFromSignals(event.quality_signals, event.archetype as Archetype | undefined)
    } catch {
      // Fire-and-forget: governance failure → ungoverned fallback
      console.warn("[routing-quality] Governance failed, using ungoverned quality")
      quality = qualityFromSignals(event.quality_signals)
    }
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

    // Update index incrementally (Sprint 2, T2.1)
    this.index.addEvent(cacheKey, quality, now)

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
  // Read path: cache-first, with index fallback, then EventStore fallback
  // -------------------------------------------------------------------------

  /**
   * Get aggregated quality score for a (personality, pool) pair.
   * Reads from cache (guaranteed <1ms). On cache miss:
   * - If index is built → O(1) indexed lookup
   * - If index not built → full stream replay + build index
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

    // Cache miss — try index first (Sprint 2, T2.1)
    metrics.incrementCounter("finn_routing_quality_cache_miss_total")

    if (this.index.isEnabled && this.index.isBuilt) {
      // O(1) indexed lookup
      const indexed = this.index.getEvents(cacheKey)
      if (indexed && indexed.length > 0) {
        const sorted = [...indexed].sort((a, b) => b.timestamp - a.timestamp)
        const events = sorted.slice(0, this.maxEventsToAggregate)
        const score = aggregateWithDecay(events, this.decayHalfLifeDays, now)
        if (score) {
          this.cache.set(cacheKey, score, now)
        }
        return score
      }
      // Key not in index — no data exists
      return null
    }

    // Index not built — full stream replay + build index
    if (!this.reader) return null

    try {
      const allEvents: Array<{ key: string; quality: number; timestamp: number }> = []

      for await (const envelope of this.reader.replay<RoutingQualityEvent>(STREAM_ROUTING_QUALITY)) {
        const key = `${envelope.payload.personality_id}:${envelope.payload.pool_id}`
        allEvents.push({
          key,
          quality: qualityFromSignals(envelope.payload.quality_signals, envelope.payload.archetype as Archetype | undefined),
          timestamp: envelope.timestamp,
        })
      }

      // Build index from all events (lazy initialization)
      this.index.buildFromEvents(allEvents)

      // Now extract matching events for the requested key
      const allMatching = allEvents.filter(e => e.key === cacheKey)

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

  // -------------------------------------------------------------------------
  // Index accessors for Reputation Bootstrap (Sprint 2, T2.3)
  // -------------------------------------------------------------------------

  /**
   * Get aggregated quality from the index for a cache key.
   * Returns null if key not found in index.
   */
  getIndexedQuality(cacheKey: string): QualityScore | null {
    const events = this.index.getEvents(cacheKey)
    if (!events || events.length === 0) return null
    return aggregateWithDecay(events, this.decayHalfLifeDays, this.now())
  }

  /**
   * Get quality for a key, trying cache first then index.
   */
  getQualityForKey(personalityId: string, poolId: string): QualityScore | null {
    // Try cache first
    const cached = this.getPoolQualityCached(personalityId, poolId)
    if (cached) return cached

    // Fall back to index
    const cacheKey = `${personalityId}:${poolId}`
    return this.getIndexedQuality(cacheKey)
  }

  // -------------------------------------------------------------------------
  // Stream Compaction (Sprint 2, T2.2) — JSONL-only
  // -------------------------------------------------------------------------

  /**
   * Compact the quality event stream, retaining only the most recent events per key.
   * JSONL-only: returns no-op for non-JSONL backends.
   *
   * Algorithm:
   * 1. Full scan of routing_quality stream
   * 2. Group by personality_id:pool_id
   * 3. For each key, retain only retainPerKey most recent events
   * 4. Write compacted events to new segment file
   * 5. Atomically swap (rename old → .bak, rename new → active)
   * 6. Rebuild in-memory index
   */
  async compactQualityStream(
    retainPerKey: number = parseIntEnv("FINN_QUALITY_COMPACTION_RETAIN", 100),
  ): Promise<{ keysCompacted: number; eventsRemoved: number }> {
    // Backend type check — JSONL-only
    if (!(this.writer instanceof JsonlEventWriter) || !(this.reader instanceof JsonlEventReader)) {
      return { keysCompacted: 0, eventsRemoved: 0 }
    }

    const dir = this.writer.dataDir

    // Full scan — collect all envelopes
    const grouped = new Map<string, Array<EventEnvelope<RoutingQualityEvent>>>()
    let totalBefore = 0

    for await (const envelope of this.reader.replay<RoutingQualityEvent>(STREAM_ROUTING_QUALITY)) {
      const key = `${envelope.payload.personality_id}:${envelope.payload.pool_id}`
      let entries = grouped.get(key)
      if (!entries) {
        entries = []
        grouped.set(key, entries)
      }
      entries.push(envelope)
      totalBefore++
    }

    // For each key: sort by timestamp desc, keep retainPerKey most recent
    let totalAfter = 0
    let keysCompacted = 0
    const compacted: EventEnvelope<RoutingQualityEvent>[] = []

    for (const [, entries] of grouped) {
      entries.sort((a, b) => b.timestamp - a.timestamp)
      const kept = entries.slice(0, retainPerKey)
      if (kept.length < entries.length) keysCompacted++
      totalAfter += kept.length
      compacted.push(...kept)
    }

    if (keysCompacted === 0) {
      return { keysCompacted: 0, eventsRemoved: 0 }
    }

    // Sort compacted by sequence for correct ordering
    compacted.sort((a, b) => a.sequence - b.sequence)

    // Write compacted events to new segment file
    const streamName = STREAM_ROUTING_QUALITY as string
    const newSegmentName = `events-${streamName}-compacted-${Date.now()}.jsonl`
    const newPath = join(dir, newSegmentName)
    const lines = compacted.map(e => JSON.stringify(e)).join("\n") + "\n"
    writeFileSync(newPath, lines, "utf-8")

    // Rename old segments to .bak
    const oldSegments = readdirSync(dir)
      .filter(f => f.startsWith(`events-${streamName}-`) && f.endsWith(".jsonl") && f !== newSegmentName)
    for (const seg of oldSegments) {
      const oldPath = join(dir, seg)
      if (existsSync(oldPath)) {
        renameSync(oldPath, oldPath + ".bak")
      }
    }

    // Rebuild in-memory index from compacted data
    const indexEvents: Array<{ key: string; quality: number; timestamp: number }> = []
    for (const envelope of compacted) {
      indexEvents.push({
        key: `${envelope.payload.personality_id}:${envelope.payload.pool_id}`,
        quality: qualityFromSignals(
          envelope.payload.quality_signals,
          envelope.payload.archetype as Archetype | undefined,
        ),
        timestamp: envelope.timestamp,
      })
    }
    this.index.buildFromEvents(indexEvents)

    return { keysCompacted, eventsRemoved: totalBefore - totalAfter }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clear all cached scores. Used in testing.
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Clear both cache and index. Used in testing.
   */
  clearAll(): void {
    this.cache.clear()
    this.index.clear()
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
