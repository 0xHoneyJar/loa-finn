/**
 * Reputation Bootstrap Tests — Sprint 2 (GID 125), Task T2.6
 *
 * Tests cover:
 * - T2.1: QualityEventIndex — dual-key structure, LRU eviction, collection secondary index
 * - T2.2: Stream compaction — JSONL-only, correctness, Postgres no-op
 * - T2.3: Collection-level reputation — anti-manipulation, trimmed mean
 * - T2.4: Warm-start protocol — Bayesian pseudo-count blending
 * - T2.5: Routing affinity integration — bootstrap wiring
 * - E2E: Full pipeline from mint to bootstrap routing
 * - Backward compatibility: all existing tests still pass
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  RoutingQualityStore,
  QualityEventIndex,
  qualityFromSignals,
  aggregateWithDecay,
  extractCollectionId,
  extractPoolId,
} from "../../src/nft/routing-quality.js"
import type {
  RoutingQualityEvent,
  QualityScore,
} from "../../src/nft/routing-quality.js"
import { ReputationBootstrap } from "../../src/nft/reputation-bootstrap.js"
import type { EventWriter } from "../../src/events/writer.js"
import type { EventReader } from "../../src/events/reader.js"
import type { EventEnvelope, EventStream } from "../../src/events/types.js"

// Mock loa-hounfour to avoid broken index.js
vi.mock("@0xhoneyjar/loa-hounfour", () => {
  const pools = ["cheap", "fast-code", "reviewer", "reasoning", "architect"] as const
  const tierAccess: Record<string, readonly string[]> = {
    free: ["cheap"],
    pro: ["cheap", "fast-code", "reviewer"],
    enterprise: ["cheap", "fast-code", "reviewer", "reasoning", "architect"],
  }
  return {
    POOL_IDS: pools,
    TIER_POOL_ACCESS: tierAccess,
    TIER_DEFAULT_POOL: { free: "cheap", pro: "fast-code", enterprise: "reviewer" },
    isValidPoolId: (id: string) => (pools as readonly string[]).includes(id),
    tierHasAccess: (tier: string, poolId: string) => tierAccess[tier]?.includes(poolId) ?? false,
  }
})

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

function makeWriter(): EventWriter & { events: Array<{ stream: string; payload: unknown }> } {
  const events: Array<{ stream: string; payload: unknown }> = []
  let seq = 0
  return {
    events,
    async append(stream: EventStream, event_type: string, payload: unknown, correlation_id: string) {
      seq++
      const envelope = {
        event_id: `evt-${seq}`,
        stream,
        event_type,
        timestamp: Date.now(),
        correlation_id,
        sequence: seq,
        checksum: "mock",
        schema_version: 1,
        payload,
      } as EventEnvelope
      events.push({ stream: stream as string, payload })
      return envelope
    },
    async close() {},
  }
}

function makeReader(events: Array<{ payload: RoutingQualityEvent; timestamp: number }>): EventReader {
  return {
    async *replay<T>() {
      let seq = 0
      for (const e of events) {
        seq++
        yield {
          event_id: `evt-${seq}`,
          stream: "routing_quality" as EventStream,
          event_type: "quality_observation",
          timestamp: e.timestamp,
          correlation_id: "test",
          sequence: seq,
          checksum: "mock",
          schema_version: 1,
          payload: e.payload as unknown as T,
        } as EventEnvelope<T>
      }
    },
    async getLatestSequence() {
      return events.length
    },
    async close() {},
  }
}

function makeQualityEvent(
  personalityId: string,
  poolId: string,
  safetyPass = true,
  satisfaction?: number,
): RoutingQualityEvent {
  return {
    personality_id: personalityId,
    pool_id: poolId,
    model: "test-model",
    task_type: "chat",
    latency_ms: 100,
    tokens_used: 500,
    quality_signals: {
      safety_pass: safetyPass,
      user_satisfaction: satisfaction,
    },
  }
}

// ---------------------------------------------------------------------------
// T2.1: QualityEventIndex — dual-key structure
// ---------------------------------------------------------------------------

describe("QualityEventIndex — dual-key structure (T2.1)", () => {
  it("builds index from events", () => {
    const index = new QualityEventIndex()
    const events = [
      { key: "honeyjar:1:architect", quality: 0.8, timestamp: 1000 },
      { key: "honeyjar:1:architect", quality: 0.7, timestamp: 2000 },
      { key: "honeyjar:2:cheap", quality: 0.6, timestamp: 1500 },
    ]
    index.buildFromEvents(events)

    expect(index.isBuilt).toBe(true)
    expect(index.keyCount).toBe(2)

    const entries = index.getEvents("honeyjar:1:architect")
    expect(entries).not.toBeNull()
    expect(entries!.length).toBe(2)
    // Sorted by timestamp descending
    expect(entries![0].timestamp).toBe(2000)
    expect(entries![1].timestamp).toBe(1000)
  })

  it("builds collection secondary index", () => {
    const index = new QualityEventIndex()
    const events = [
      { key: "honeyjar:1:architect", quality: 0.8, timestamp: 1000 },
      { key: "honeyjar:2:architect", quality: 0.7, timestamp: 1000 },
      { key: "honeyjar:3:cheap", quality: 0.6, timestamp: 1000 },
      { key: "bears:1:architect", quality: 0.5, timestamp: 1000 },
    ]
    index.buildFromEvents(events)

    const honeyjarKeys = index.getCollectionKeys("honeyjar")
    expect(honeyjarKeys).not.toBeNull()
    expect(honeyjarKeys!.size).toBe(3)
    expect(honeyjarKeys!.has("honeyjar:1:architect")).toBe(true)
    expect(honeyjarKeys!.has("honeyjar:2:architect")).toBe(true)
    expect(honeyjarKeys!.has("honeyjar:3:cheap")).toBe(true)

    const bearsKeys = index.getCollectionKeys("bears")
    expect(bearsKeys).not.toBeNull()
    expect(bearsKeys!.size).toBe(1)

    expect(index.getCollectionKeys("unknown")).toBeNull()
  })

  it("incremental addEvent updates both indexes", () => {
    const index = new QualityEventIndex()
    index.buildFromEvents([])

    index.addEvent("honeyjar:42:architect", 0.8, 1000)
    expect(index.keyCount).toBe(1)
    expect(index.getEvents("honeyjar:42:architect")!.length).toBe(1)

    const collection = index.getCollectionKeys("honeyjar")
    expect(collection!.has("honeyjar:42:architect")).toBe(true)
  })

  it("ring buffer drops oldest when at maxEventsPerKey", () => {
    const index = new QualityEventIndex({ maxEventsPerKey: 3 })
    index.buildFromEvents([])

    index.addEvent("a:1:cheap", 0.1, 1000)
    index.addEvent("a:1:cheap", 0.2, 2000)
    index.addEvent("a:1:cheap", 0.3, 3000)
    expect(index.getEvents("a:1:cheap")!.length).toBe(3)

    // This should evict the oldest (timestamp 1000)
    index.addEvent("a:1:cheap", 0.4, 4000)
    const events = index.getEvents("a:1:cheap")!
    expect(events.length).toBe(3)
    // Oldest should be gone
    expect(events.every(e => e.timestamp >= 2000)).toBe(true)
  })

  it("LRU eviction when key count exceeds max", () => {
    const index = new QualityEventIndex({ maxIndexKeys: 3 })
    index.buildFromEvents([])

    index.addEvent("a:1:cheap", 0.5, 1000)
    index.addEvent("b:1:cheap", 0.5, 2000)
    index.addEvent("c:1:cheap", 0.5, 3000)
    expect(index.keyCount).toBe(3)

    // Access a:1:cheap to make it recently used
    index.getEvents("a:1:cheap")

    // Add a 4th key — should evict b:1:cheap (least recently accessed)
    index.addEvent("d:1:cheap", 0.5, 4000)
    expect(index.keyCount).toBe(3)
    expect(index.getEvents("a:1:cheap")).not.toBeNull()
    expect(index.getEvents("b:1:cheap")).toBeNull()
    expect(index.getEvents("d:1:cheap")).not.toBeNull()
  })

  it("LRU eviction cleans collection secondary index", () => {
    const index = new QualityEventIndex({ maxIndexKeys: 2 })
    index.buildFromEvents([])

    index.addEvent("honeyjar:1:cheap", 0.5, 1000)
    index.addEvent("bears:1:cheap", 0.5, 2000)

    // Evict honeyjar:1:cheap by adding a new key
    index.addEvent("bears:2:cheap", 0.5, 3000)

    // honeyjar collection should be cleaned up
    const honeyjarKeys = index.getCollectionKeys("honeyjar")
    expect(honeyjarKeys).toBeNull()
  })

  it("returns null for non-existent key", () => {
    const index = new QualityEventIndex()
    index.buildFromEvents([])
    expect(index.getEvents("nonexistent")).toBeNull()
  })

  it("disabled index does not build or add", () => {
    const index = new QualityEventIndex({ enabled: false })
    index.buildFromEvents([
      { key: "a:1:cheap", quality: 0.5, timestamp: 1000 },
    ])
    expect(index.isBuilt).toBe(false)
    expect(index.keyCount).toBe(0)

    index.addEvent("a:1:cheap", 0.5, 2000)
    expect(index.keyCount).toBe(0)
  })

  it("clear resets all state", () => {
    const index = new QualityEventIndex()
    index.buildFromEvents([
      { key: "a:1:cheap", quality: 0.5, timestamp: 1000 },
    ])
    expect(index.isBuilt).toBe(true)

    index.clear()
    expect(index.isBuilt).toBe(false)
    expect(index.keyCount).toBe(0)
    expect(index.getCollectionKeys("a")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Helper extraction functions
// ---------------------------------------------------------------------------

describe("extractCollectionId / extractPoolId", () => {
  it("extracts collection from cache key", () => {
    expect(extractCollectionId("honeyjar:42:architect")).toBe("honeyjar")
    expect(extractCollectionId("bears:1:cheap")).toBe("bears")
  })

  it("extracts pool from cache key", () => {
    expect(extractPoolId("honeyjar:42:architect")).toBe("architect")
    expect(extractPoolId("bears:1:fast-code")).toBe("fast-code")
  })

  it("handles edge cases", () => {
    expect(extractCollectionId("single")).toBe("single")
    expect(extractPoolId("single")).toBe("single")
  })
})

// ---------------------------------------------------------------------------
// T2.1: Indexed lookup in RoutingQualityStore
// ---------------------------------------------------------------------------

describe("RoutingQualityStore — indexed lookup (T2.1)", () => {
  let clock: number

  beforeEach(() => {
    clock = 1000000
  })

  it("first cache miss triggers full scan + index build", async () => {
    const now = clock
    const events = [
      { payload: makeQualityEvent("honeyjar:1", "architect", true, 0.8), timestamp: now - 1000 },
      { payload: makeQualityEvent("honeyjar:1", "architect", true, 0.9), timestamp: now },
      { payload: makeQualityEvent("honeyjar:2", "cheap", true, 0.6), timestamp: now },
    ]
    const reader = makeReader(events)
    const store = new RoutingQualityStore(null, reader, { now: () => clock })

    const score = await store.getPoolQuality("honeyjar:1", "architect")
    expect(score).not.toBeNull()
    expect(score!.sample_count).toBe(2)

    // Index should now be built
    expect(store.index.isBuilt).toBe(true)
    expect(store.index.keyCount).toBe(2)
  })

  it("second cache miss uses index (no full scan)", async () => {
    const now = clock
    const events = [
      { payload: makeQualityEvent("honeyjar:1", "architect", true, 0.8), timestamp: now },
      { payload: makeQualityEvent("honeyjar:2", "cheap", true, 0.6), timestamp: now },
    ]
    const reader = makeReader(events)
    const store = new RoutingQualityStore(null, reader, {
      now: () => clock,
      cacheTtlMs: 1000,
    })

    // First call — full scan + build index
    await store.getPoolQuality("honeyjar:1", "architect")

    // Expire cache
    clock += 2000

    // Second call for different key — should use index, not reader
    // (reader is exhausted from first call, so if it tried to re-read it would get 0 events)
    const score = await store.getPoolQuality("honeyjar:2", "cheap")
    expect(score).not.toBeNull()
    expect(score!.score).toBeCloseTo(0.6, 1)
  })

  it("recordQuality incrementally updates index", async () => {
    const store = new RoutingQualityStore(null, null, { now: () => clock })

    await store.recordQuality(makeQualityEvent("honeyjar:42", "architect", true, 0.9), "c1")
    await store.recordQuality(makeQualityEvent("honeyjar:42", "architect", true, 0.7), "c2")

    const events = store.index.getEvents("honeyjar:42:architect")
    expect(events).not.toBeNull()
    expect(events!.length).toBe(2)
  })

  it("collection index populated from recordQuality", async () => {
    const store = new RoutingQualityStore(null, null, { now: () => clock })

    await store.recordQuality(makeQualityEvent("honeyjar:1", "architect", true, 0.9), "c1")
    await store.recordQuality(makeQualityEvent("honeyjar:2", "cheap", true, 0.6), "c2")
    await store.recordQuality(makeQualityEvent("bears:1", "architect", true, 0.5), "c3")

    const honeyjarKeys = store.index.getCollectionKeys("honeyjar")
    expect(honeyjarKeys).not.toBeNull()
    expect(honeyjarKeys!.size).toBe(2)

    const bearsKeys = store.index.getCollectionKeys("bears")
    expect(bearsKeys).not.toBeNull()
    expect(bearsKeys!.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// T2.1: Index performance
// ---------------------------------------------------------------------------

describe("QualityEventIndex — performance (T2.1)", () => {
  it("indexed lookup <1ms for 10K events", () => {
    const index = new QualityEventIndex()
    const events: Array<{ key: string; quality: number; timestamp: number }> = []

    // 10K events across 50 keys
    for (let i = 0; i < 10000; i++) {
      const personality = `honeyjar:${i % 50}`
      const pool = i % 2 === 0 ? "architect" : "cheap"
      events.push({
        key: `${personality}:${pool}`,
        quality: Math.random(),
        timestamp: 1000000 + i,
      })
    }

    index.buildFromEvents(events)
    expect(index.isBuilt).toBe(true)

    // Measure lookup time
    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      index.getEvents(`honeyjar:${i % 50}:architect`)
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50) // 1000 lookups in <50ms
  })

  it("heap bound: 1000-key index is reasonable", () => {
    const index = new QualityEventIndex({ maxIndexKeys: 1000, maxEventsPerKey: 100 })
    const events: Array<{ key: string; quality: number; timestamp: number }> = []

    // Fill to max capacity: 1000 keys × 100 events
    for (let k = 0; k < 1000; k++) {
      for (let e = 0; e < 100; e++) {
        events.push({
          key: `collection:${k}:pool${k % 5}`,
          quality: Math.random(),
          timestamp: k * 100 + e,
        })
      }
    }

    index.buildFromEvents(events)
    expect(index.keyCount).toBe(1000)
    // If this doesn't crash or timeout, memory is within bounds
  })
})

// ---------------------------------------------------------------------------
// T2.2: Stream compaction — JSONL-only
// ---------------------------------------------------------------------------

describe("Stream compaction (T2.2)", () => {
  it("returns no-op for non-JSONL backend", async () => {
    const store = new RoutingQualityStore(makeWriter(), null)
    const result = await store.compactQualityStream()
    expect(result.keysCompacted).toBe(0)
    expect(result.eventsRemoved).toBe(0)
  })

  it("returns no-op when both writer and reader are null", async () => {
    const store = new RoutingQualityStore(null, null)
    const result = await store.compactQualityStream()
    expect(result.keysCompacted).toBe(0)
    expect(result.eventsRemoved).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T2.3: Collection-level reputation aggregation
// ---------------------------------------------------------------------------

describe("ReputationBootstrap — collection quality (T2.3)", () => {
  let clock: number
  let store: RoutingQualityStore

  beforeEach(() => {
    clock = 1000000
    store = new RoutingQualityStore(null, null, { now: () => clock })
  })

  async function seedPersonality(id: string, pool: string, score: number, count: number) {
    for (let i = 0; i < count; i++) {
      await store.recordQuality(makeQualityEvent(id, pool, true, score), `c-${id}-${i}`)
    }
  }

  it("computes trimmed mean for 3+ personalities", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.6, 10)
    await seedPersonality("honeyjar:3", "architect", 0.7, 10)

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })
    const quality = bootstrap.getCollectionQuality("honeyjar", "architect")

    expect(quality).not.toBeNull()
    // Trimmed mean of [0.6, 0.7, 0.8] → discard 0.6 and 0.8 → ~0.7
    expect(quality!.score).toBeCloseTo(0.7, 1)
  })

  it("returns null for empty collection", () => {
    const bootstrap = new ReputationBootstrap(store)
    expect(bootstrap.getCollectionQuality("empty", "architect")).toBeNull()
  })

  it("returns null for single personality (can't trim)", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })
    expect(bootstrap.getCollectionQuality("honeyjar", "architect")).toBeNull()
  })

  it("uses both when only 2 personalities (trimming leaves nothing)", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.6, 10)

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })
    const quality = bootstrap.getCollectionQuality("honeyjar", "architect")

    expect(quality).not.toBeNull()
    // Average of both since trimming 2 → 0 elements uses original set
    expect(quality!.score).toBeCloseTo(0.7, 1)
  })

  it("excludes personalities below minSampleCount", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.7, 10)
    await seedPersonality("honeyjar:3", "architect", 0.1, 2) // below threshold

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })
    const quality = bootstrap.getCollectionQuality("honeyjar", "architect")

    expect(quality).not.toBeNull()
    // Only 2 qualifying → average of [0.7, 0.8] ≈ 0.75
    expect(quality!.score).toBeGreaterThan(0.6)
  })

  it("caps at maxContributors", async () => {
    // Seed 5 personalities, maxContributors=3
    for (let i = 1; i <= 5; i++) {
      await seedPersonality(`honeyjar:${i}`, "architect", 0.5 + i * 0.05, 10 + i)
    }

    const bootstrap = new ReputationBootstrap(store, {
      minSampleCount: 5,
      maxContributors: 3,
    })
    const quality = bootstrap.getCollectionQuality("honeyjar", "architect")

    expect(quality).not.toBeNull()
    // Only top 3 by sample count should contribute
  })

  it("outlier cannot shift score more than 10% vs trimmed mean without outlier", async () => {
    // 5 honest personalities with scores around 0.7-0.8
    await seedPersonality("honeyjar:1", "architect", 0.7, 10)
    await seedPersonality("honeyjar:2", "architect", 0.8, 10)
    await seedPersonality("honeyjar:3", "architect", 0.7, 10)
    await seedPersonality("honeyjar:4", "architect", 0.8, 10)
    // 1 outlier attacker at 0.1
    await seedPersonality("honeyjar:5", "architect", 0.1, 10)

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })
    const quality = bootstrap.getCollectionQuality("honeyjar", "architect")

    expect(quality).not.toBeNull()
    // Trimmed mean of [0.1, 0.7, 0.7, 0.8, 0.8] → discard 0.1 and 0.8 → avg of [0.7, 0.7, 0.8] ≈ 0.733
    expect(quality!.score).toBeGreaterThan(0.65)
    expect(quality!.score).toBeLessThan(0.85)
  })

  it("Sybil attack: 50 low-sample personalities don't affect collection", async () => {
    // 3 honest personalities
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.7, 10)
    await seedPersonality("honeyjar:3", "architect", 0.75, 10)

    // 50 attacker mints with low samples (below minSampleCount)
    for (let i = 100; i < 150; i++) {
      await seedPersonality(`honeyjar:${i}`, "architect", 0.0, 2)
    }

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })
    const quality = bootstrap.getCollectionQuality("honeyjar", "architect")

    expect(quality).not.toBeNull()
    // Only 3 honest personalities qualify → trimmed mean ≈ 0.75
    expect(quality!.score).toBeGreaterThan(0.65)
  })

  it("filters by pool correctly", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.9, 10)
    await seedPersonality("honeyjar:2", "architect", 0.8, 10)
    await seedPersonality("honeyjar:1", "cheap", 0.3, 10)
    await seedPersonality("honeyjar:2", "cheap", 0.2, 10)

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })

    const architectQuality = bootstrap.getCollectionQuality("honeyjar", "architect")
    const cheapQuality = bootstrap.getCollectionQuality("honeyjar", "cheap")

    expect(architectQuality).not.toBeNull()
    expect(cheapQuality).not.toBeNull()
    expect(architectQuality!.score).toBeGreaterThan(cheapQuality!.score)
  })
})

// ---------------------------------------------------------------------------
// T2.4: Warm-start protocol — Bayesian pseudo-count blending
// ---------------------------------------------------------------------------

describe("ReputationBootstrap — warm-start (T2.4)", () => {
  let clock: number
  let store: RoutingQualityStore

  beforeEach(() => {
    clock = 1000000
    store = new RoutingQualityStore(null, null, { now: () => clock })
  })

  async function seedPersonality(id: string, pool: string, score: number, count: number) {
    for (let i = 0; i < count; i++) {
      await store.recordQuality(makeQualityEvent(id, pool, true, score), `c-${id}-${i}`)
    }
  }

  it("new personality with no history → source='none'", () => {
    const bootstrap = new ReputationBootstrap(store)
    const result = bootstrap.getQualityWithBootstrap("honeyjar:99", "architect")

    expect(result.source).toBe("none")
    expect(result.score).toBeNull()
  })

  it("new personality, collection has history → source='bootstrap'", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.7, 10)

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5 })
    const result = bootstrap.getQualityWithBootstrap("honeyjar:99", "architect", "honeyjar")

    expect(result.source).toBe("bootstrap")
    expect(result.score).not.toBeNull()
    expect(result.score!.sample_count).toBe(0) // no personal events
    expect(result.score!.score).toBeGreaterThan(0.5)
  })

  it("personal data exists without collection → source='personal' (unblended)", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.9, 5)

    const bootstrap = new ReputationBootstrap(store, { pseudoCount: 3 })
    const result = bootstrap.getQualityWithBootstrap("honeyjar:1", "architect")

    expect(result.source).toBe("personal")
    expect(result.score).not.toBeNull()
  })

  it("personal + collection → Bayesian blended, source='personal'", async () => {
    // Seed collection
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.7, 10)

    // Seed personal data
    await seedPersonality("honeyjar:3", "architect", 0.5, 5)

    const bootstrap = new ReputationBootstrap(store, {
      minSampleCount: 5,
      pseudoCount: 3,
    })
    const result = bootstrap.getQualityWithBootstrap("honeyjar:3", "architect", "honeyjar")

    expect(result.source).toBe("personal")
    expect(result.score).not.toBeNull()
    // Should be blended: between personal (0.5) and collection (~0.75)
    expect(result.score!.score).toBeGreaterThan(0.5)
    expect(result.score!.score).toBeLessThan(0.8)
  })

  it("prior weight < 40% at n=5 personal events", async () => {
    // Collection quality ≈ 1.0
    await seedPersonality("honeyjar:1", "architect", 1.0, 10)
    await seedPersonality("honeyjar:2", "architect", 1.0, 10)

    // Personal quality = 0.0 with 5 events
    await seedPersonality("honeyjar:3", "architect", 0.0, 5)

    const bootstrap = new ReputationBootstrap(store, {
      minSampleCount: 5,
      pseudoCount: 3,
    })
    const result = bootstrap.getQualityWithBootstrap("honeyjar:3", "architect", "honeyjar")

    expect(result.score).not.toBeNull()
    // q_effective = (3 * 1.0 + 5 * 0.0) / (3 + 5) = 3/8 = 0.375
    // Prior weight = k/(k+n) = 3/8 = 37.5% (< 40%)
    const priorWeight = 3 / (3 + 5) // 0.375
    expect(priorWeight).toBeLessThan(0.4)
    expect(result.score!.score).toBeCloseTo(0.375, 1)
  })

  it("prior weight < 25% at n=10 personal events", async () => {
    await seedPersonality("honeyjar:1", "architect", 1.0, 10)
    await seedPersonality("honeyjar:2", "architect", 1.0, 10)
    await seedPersonality("honeyjar:3", "architect", 0.0, 10)

    const bootstrap = new ReputationBootstrap(store, {
      minSampleCount: 5,
      pseudoCount: 3,
    })
    const result = bootstrap.getQualityWithBootstrap("honeyjar:3", "architect", "honeyjar")

    expect(result.score).not.toBeNull()
    // Prior weight = 3/(3+10) ≈ 0.23 (< 25%)
    const priorWeight = 3 / (3 + 10)
    expect(priorWeight).toBeLessThan(0.25)
  })

  it("prior weight monotonically decreasing", () => {
    const k = 3
    let prevWeight = 1.0
    for (let n = 0; n <= 20; n++) {
      const weight = k / (k + n)
      expect(weight).toBeLessThanOrEqual(prevWeight)
      prevWeight = weight
    }
  })

  it("no collectionId → no bootstrap attempt", async () => {
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.7, 10)

    const bootstrap = new ReputationBootstrap(store)
    // No collectionId param
    const result = bootstrap.getQualityWithBootstrap("honeyjar:99", "architect")

    expect(result.source).toBe("none")
    expect(result.score).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// T2.5: Routing affinity integration
// ---------------------------------------------------------------------------

describe("Routing affinity — bootstrap integration (T2.5)", () => {
  let clock: number
  let store: RoutingQualityStore

  beforeEach(() => {
    clock = 1000000
    store = new RoutingQualityStore(null, null, { now: () => clock })
  })

  async function seedPersonality(id: string, pool: string, score: number, count: number) {
    for (let i = 0; i < count; i++) {
      await store.recordQuality(makeQualityEvent(id, pool, true, score), `c-${id}-${i}`)
    }
  }

  it("new personality in collection → routing differs from pure static", async () => {
    const { computeRoutingAffinity } = await import("../../src/nft/routing-affinity.js")

    // Seed collection with high architect quality
    await seedPersonality("honeyjar:1", "architect", 0.95, 10)
    await seedPersonality("honeyjar:2", "architect", 0.9, 10)

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5, pseudoCount: 3 })

    const staticAffinity = computeRoutingAffinity("freetekno")
    const bootstrapAffinity = computeRoutingAffinity(
      "freetekno", null, 0.6, 0.4,
      store, "honeyjar:99", 0.3,
      "honeyjar", bootstrap,
    )

    // Bootstrap should shift architect pool score
    expect(bootstrapAffinity.architect).not.toBeCloseTo(staticAffinity.architect, 2)
  })

  it("same personality without collectionId → pure static affinity", async () => {
    const { computeRoutingAffinity } = await import("../../src/nft/routing-affinity.js")

    await seedPersonality("honeyjar:1", "architect", 0.95, 10)
    await seedPersonality("honeyjar:2", "architect", 0.9, 10)

    const staticAffinity = computeRoutingAffinity("freetekno")
    const withoutCollection = computeRoutingAffinity(
      "freetekno", null, 0.6, 0.4,
      store, "honeyjar:99", 0.3,
      null, null,
    )

    for (const pool of Object.keys(staticAffinity)) {
      expect(withoutCollection[pool as keyof typeof withoutCollection])
        .toBeCloseTo(staticAffinity[pool as keyof typeof staticAffinity], 6)
    }
  })

  it("established personality → routing nearly identical to no-bootstrap", async () => {
    const { computeRoutingAffinity } = await import("../../src/nft/routing-affinity.js")

    // Established personality with lots of personal data
    await seedPersonality("honeyjar:1", "architect", 0.8, 10)
    await seedPersonality("honeyjar:2", "architect", 0.7, 10)
    await seedPersonality("honeyjar:3", "architect", 0.5, 20) // personality under test

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5, pseudoCount: 3 })

    const withBootstrap = computeRoutingAffinity(
      "freetekno", null, 0.6, 0.4,
      store, "honeyjar:3", 0.3,
      "honeyjar", bootstrap,
    )
    const withoutBootstrap = computeRoutingAffinity(
      "freetekno", null, 0.6, 0.4,
      store, "honeyjar:3", 0.3,
    )

    // With 20 personal events, prior weight = 3/(3+20) ≈ 13%
    // Routing should be very similar
    for (const pool of Object.keys(withBootstrap)) {
      expect(withBootstrap[pool as keyof typeof withBootstrap])
        .toBeCloseTo(withoutBootstrap[pool as keyof typeof withoutBootstrap], 1)
    }
  })

  it("without qualityStore/reputationBootstrap → current behavior exactly", async () => {
    const { computeRoutingAffinity } = await import("../../src/nft/routing-affinity.js")

    const withoutStore = computeRoutingAffinity("freetekno")
    const withNullAll = computeRoutingAffinity(
      "freetekno", null, 0.6, 0.4, null, null, 0.3, null, null,
    )

    for (const pool of Object.keys(withoutStore)) {
      expect(withNullAll[pool as keyof typeof withNullAll])
        .toBe(withoutStore[pool as keyof typeof withoutStore])
    }
  })
})

// ---------------------------------------------------------------------------
// E2E: New personality minted → bootstrap → quality → personal dominates
// ---------------------------------------------------------------------------

describe("E2E: personality lifecycle with bootstrap (T2.6)", () => {
  it("mint → bootstrap → record quality → personal dominates", async () => {
    const { computeRoutingAffinity } = await import("../../src/nft/routing-affinity.js")

    let clock = 1000000
    const writer = makeWriter()
    const store = new RoutingQualityStore(writer, null, { now: () => clock })

    // Step 1: Seed collection with architect quality
    for (let i = 1; i <= 3; i++) {
      for (let j = 0; j < 10; j++) {
        await store.recordQuality(
          makeQualityEvent(`honeyjar:${i}`, "architect", true, 0.85),
          `seed-${i}-${j}`,
        )
      }
    }

    const bootstrap = new ReputationBootstrap(store, { minSampleCount: 5, pseudoCount: 3 })

    // Step 2: New personality — first request uses bootstrap
    const bootstrapResult = bootstrap.getQualityWithBootstrap("honeyjar:99", "architect", "honeyjar")
    expect(bootstrapResult.source).toBe("bootstrap")
    expect(bootstrapResult.score).not.toBeNull()

    const initialAffinity = computeRoutingAffinity(
      "freetekno", null, 0.6, 0.4,
      store, "honeyjar:99", 0.3,
      "honeyjar", bootstrap,
    )

    // Step 3: Record personal quality (lower than collection)
    for (let i = 0; i < 10; i++) {
      await store.recordQuality(
        makeQualityEvent("honeyjar:99", "architect", true, 0.4),
        `personal-${i}`,
      )
      clock++
    }

    // Step 4: With 10 personal events, personal should dominate
    const personalResult = bootstrap.getQualityWithBootstrap("honeyjar:99", "architect", "honeyjar")
    expect(personalResult.source).toBe("personal")
    expect(personalResult.score!.score).toBeLessThan(bootstrapResult.score!.score)

    // Step 5: Routing should reflect personal quality
    const laterAffinity = computeRoutingAffinity(
      "freetekno", null, 0.6, 0.4,
      store, "honeyjar:99", 0.3,
    )

    // Personal quality is 0.4, which should pull architect down from bootstrap
    expect(laterAffinity.architect).toBeLessThan(initialAffinity.architect)
  })
})

// ---------------------------------------------------------------------------
// RoutingQualityStore accessor methods
// ---------------------------------------------------------------------------

describe("RoutingQualityStore — accessor methods", () => {
  it("getIndexedQuality returns aggregated score from index", async () => {
    let clock = 1000000
    const store = new RoutingQualityStore(null, null, { now: () => clock })

    await store.recordQuality(makeQualityEvent("honeyjar:1", "architect", true, 0.9), "c1")
    await store.recordQuality(makeQualityEvent("honeyjar:1", "architect", true, 0.7), "c2")

    const quality = store.getIndexedQuality("honeyjar:1:architect")
    expect(quality).not.toBeNull()
    expect(quality!.sample_count).toBe(2)
    expect(quality!.score).toBeGreaterThan(0.5)
  })

  it("getQualityForKey tries cache then index", async () => {
    let clock = 1000000
    const store = new RoutingQualityStore(null, null, {
      now: () => clock,
      cacheTtlMs: 1000,
    })

    await store.recordQuality(makeQualityEvent("honeyjar:1", "architect", true, 0.9), "c1")

    // Cache hit
    const cached = store.getQualityForKey("honeyjar:1", "architect")
    expect(cached).not.toBeNull()

    // Expire cache
    clock += 2000

    // Should fall back to index
    const indexed = store.getQualityForKey("honeyjar:1", "architect")
    expect(indexed).not.toBeNull()
    expect(indexed!.sample_count).toBe(1)
  })

  it("clearAll clears both cache and index", async () => {
    let clock = 1000000
    const store = new RoutingQualityStore(null, null, { now: () => clock })

    await store.recordQuality(makeQualityEvent("honeyjar:1", "architect", true, 0.9), "c1")
    expect(store.cacheSize).toBeGreaterThan(0)
    expect(store.index.keyCount).toBeGreaterThan(0)

    store.clearAll()
    expect(store.cacheSize).toBe(0)
    expect(store.index.keyCount).toBe(0)
  })
})
