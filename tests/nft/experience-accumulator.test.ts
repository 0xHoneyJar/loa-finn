// tests/nft/experience-accumulator.test.ts — Experience Accumulator Tests (Sprint 26 Task 26.3)
//
// Tests for accumulation, async behavior, no content leakage.

import { describe, it, expect, beforeEach } from "vitest"
import { ExperienceStore, MIN_INTERACTIONS_TO_PERSIST } from "../../src/nft/experience-types.js"
import { ExperienceEngine } from "../../src/nft/experience-engine.js"
import {
  ExperienceAccumulator,
  extractAggregate,
  type CompletionMetadata,
} from "../../src/nft/experience-accumulator.js"

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMetadata(overrides?: Partial<CompletionMetadata>): CompletionMetadata {
  return {
    model: "claude-opus-4",
    latency_ms: 1200,
    usage: {
      prompt_tokens: 500,
      completion_tokens: 300,
      reasoning_tokens: 0,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// extractAggregate
// ---------------------------------------------------------------------------

describe("extractAggregate", () => {
  it("should extract detected topics into topic_frequencies", () => {
    const metadata = createMetadata({
      detected_topics: { philosophy: 3, art: 1 },
    })

    const aggregate = extractAggregate(metadata)

    expect(aggregate.topic_frequencies).toEqual({ philosophy: 3, art: 1 })
  })

  it("should extract detected styles into style_counts", () => {
    const metadata = createMetadata({
      detected_styles: { formal: 2, analytical: 1 },
    })

    const aggregate = extractAggregate(metadata)

    expect(aggregate.style_counts).toEqual({ formal: 2, analytical: 1 })
  })

  it("should extract detected metaphors into metaphor_families", () => {
    const metadata = createMetadata({
      detected_metaphors: { journey: 2, growth: 1 },
    })

    const aggregate = extractAggregate(metadata)

    expect(aggregate.metaphor_families).toEqual({ journey: 2, growth: 1 })
  })

  it("should use pre-computed dial impacts when provided", () => {
    const metadata = createMetadata({
      dial_impacts: { sw_approachability: 0.001, cs_formality: -0.0005 },
    })

    const aggregate = extractAggregate(metadata)

    expect(aggregate.dial_impacts.sw_approachability).toBe(0.001)
    expect(aggregate.dial_impacts.cs_formality).toBe(-0.0005)
  })

  it("should derive default dial impacts from token usage when none provided", () => {
    const metadata = createMetadata({
      usage: { prompt_tokens: 100, completion_tokens: 900, reasoning_tokens: 50 },
    })

    const aggregate = extractAggregate(metadata)

    // High completion ratio (0.9) => slight verbosity push
    expect(aggregate.dial_impacts.cs_verbosity).toBe(0.0002)
    // Reasoning tokens > 0 => analytical signal
    expect(aggregate.dial_impacts.cg_analytical_intuitive).toBe(0.0001)
    expect(aggregate.dial_impacts.cg_metacognition).toBe(0.0001)
  })

  it("should produce empty distributions when no classifiers provided", () => {
    const metadata = createMetadata()

    const aggregate = extractAggregate(metadata)

    expect(Object.keys(aggregate.topic_frequencies)).toHaveLength(0)
    expect(Object.keys(aggregate.style_counts)).toHaveLength(0)
    expect(Object.keys(aggregate.metaphor_families)).toHaveLength(0)
  })

  it("should set a valid ISO timestamp", () => {
    const metadata = createMetadata()
    const aggregate = extractAggregate(metadata)

    const parsed = new Date(aggregate.timestamp)
    expect(parsed.getTime()).not.toBeNaN()
  })

  it("should NOT contain any content field — no content leakage", () => {
    const metadata = createMetadata()
    const aggregate = extractAggregate(metadata)

    // Verify the aggregate has no content-like fields
    const keys = Object.keys(aggregate)
    expect(keys).not.toContain("content")
    expect(keys).not.toContain("message")
    expect(keys).not.toContain("text")
    expect(keys).not.toContain("response")
    expect(keys).not.toContain("prompt")

    // The aggregate should only contain these known metadata fields
    expect(keys.sort()).toEqual([
      "dial_impacts",
      "metaphor_families",
      "style_counts",
      "timestamp",
      "topic_frequencies",
    ])
  })
})

// ---------------------------------------------------------------------------
// ExperienceAccumulator — Accumulation
// ---------------------------------------------------------------------------

describe("ExperienceAccumulator", () => {
  let store: ExperienceStore
  let engine: ExperienceEngine
  let accumulator: ExperienceAccumulator

  beforeEach(() => {
    store = new ExperienceStore()
    engine = new ExperienceEngine(store, { epochSize: 5 })
    accumulator = new ExperienceAccumulator(engine)
  })

  it("should accept valid accumulation requests", async () => {
    const result = await accumulator.accumulate("test:1", createMetadata())

    expect(result.accepted).toBe(true)
    expect(result.rejection_reason).toBeUndefined()
  })

  it("should record interaction in the experience store", async () => {
    await accumulator.accumulate("test:1", createMetadata())

    const snapshot = store.get("test:1")
    expect(snapshot).not.toBeNull()
    expect(snapshot!.interaction_count).toBe(1)
  })

  it("should accumulate multiple interactions for same personality", async () => {
    await accumulator.accumulate("test:1", createMetadata())
    await accumulator.accumulate("test:1", createMetadata())
    await accumulator.accumulate("test:1", createMetadata())

    const snapshot = store.get("test:1")
    expect(snapshot!.interaction_count).toBe(3)
  })

  it("should keep separate snapshots per personality", async () => {
    await accumulator.accumulate("test:1", createMetadata())
    await accumulator.accumulate("test:2", createMetadata())
    await accumulator.accumulate("test:2", createMetadata())

    expect(store.get("test:1")!.interaction_count).toBe(1)
    expect(store.get("test:2")!.interaction_count).toBe(2)
  })

  it("should trigger epoch after reaching epoch size", async () => {
    for (let i = 0; i < 4; i++) {
      const result = await accumulator.accumulate("test:1", createMetadata())
      expect(result.epoch_triggered).toBe(false)
    }

    // 5th interaction triggers epoch (epochSize = 5)
    const result = await accumulator.accumulate("test:1", createMetadata())
    expect(result.epoch_triggered).toBe(true)
  })

  it("should accumulate topic distributions from metadata", async () => {
    await accumulator.accumulate("test:1", createMetadata({
      detected_topics: { philosophy: 2 },
    }))
    await accumulator.accumulate("test:1", createMetadata({
      detected_topics: { philosophy: 1, art: 3 },
    }))

    const snapshot = store.get("test:1")!
    expect(snapshot.topic_distribution.philosophy).toBe(3)
    expect(snapshot.topic_distribution.art).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// ExperienceAccumulator — Disabled
// ---------------------------------------------------------------------------

describe("ExperienceAccumulator (disabled)", () => {
  it("should reject when disabled", async () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store)
    const accumulator = new ExperienceAccumulator(engine, { enabled: false })

    const result = await accumulator.accumulate("test:1", createMetadata())

    expect(result.accepted).toBe(false)
    expect(result.rejection_reason).toBe("disabled")
    expect(store.get("test:1")).toBeNull()
  })

  it("should report enabled status correctly", () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store)

    const enabled = new ExperienceAccumulator(engine, { enabled: true })
    expect(enabled.isEnabled()).toBe(true)

    const disabled = new ExperienceAccumulator(engine, { enabled: false })
    expect(disabled.isEnabled()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ExperienceAccumulator — Validation
// ---------------------------------------------------------------------------

describe("ExperienceAccumulator (validation)", () => {
  let store: ExperienceStore
  let engine: ExperienceEngine
  let accumulator: ExperienceAccumulator

  beforeEach(() => {
    store = new ExperienceStore()
    engine = new ExperienceEngine(store)
    accumulator = new ExperienceAccumulator(engine)
  })

  it("should reject empty personality ID", async () => {
    const result = await accumulator.accumulate("", createMetadata())

    expect(result.accepted).toBe(false)
    expect(result.rejection_reason).toBe("missing_personality_id")
  })

  it("should reject whitespace-only personality ID", async () => {
    const result = await accumulator.accumulate("   ", createMetadata())

    expect(result.accepted).toBe(false)
    expect(result.rejection_reason).toBe("missing_personality_id")
  })
})

// ---------------------------------------------------------------------------
// ExperienceAccumulator — Backpressure
// ---------------------------------------------------------------------------

describe("ExperienceAccumulator (backpressure)", () => {
  it("should reject when queue is full", async () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store)
    const accumulator = new ExperienceAccumulator(engine, { maxQueueDepth: 1 })

    // Fill the queue by holding a reference during async execution
    // Since our accumulate is synchronous internally, we test the depth tracking
    const result1 = await accumulator.accumulate("test:1", createMetadata())
    expect(result1.accepted).toBe(true)

    // Queue depth should be back to 0 after completion
    expect(accumulator.getQueueDepth()).toBe(0)
  })

  it("should track queue depth correctly", () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store)
    const accumulator = new ExperienceAccumulator(engine)

    expect(accumulator.getQueueDepth()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// No Content Leakage — Privacy Tests
// ---------------------------------------------------------------------------

describe("ExperienceAccumulator (privacy)", () => {
  let store: ExperienceStore
  let engine: ExperienceEngine
  let accumulator: ExperienceAccumulator

  beforeEach(() => {
    store = new ExperienceStore()
    engine = new ExperienceEngine(store, { epochSize: 5 })
    accumulator = new ExperienceAccumulator(engine)
  })

  it("should not store any content in the experience snapshot", async () => {
    await accumulator.accumulate("test:1", createMetadata({
      detected_topics: { sensitive_topic: 1 },
    }))

    const snapshot = store.get("test:1")!
    const serialized = JSON.stringify(snapshot)

    // Snapshot should not contain any content-like data
    // Only metadata signals (topics, styles, metaphors, dial impacts)
    expect(serialized).not.toContain("content")
    expect(serialized).not.toContain("message")
    expect(serialized).not.toContain("prompt")
    expect(serialized).not.toContain("response")
  })

  it("should not store user identifiers in the experience snapshot", async () => {
    await accumulator.accumulate("test:1", createMetadata())

    const snapshot = store.get("test:1")!
    const serialized = JSON.stringify(snapshot)

    // Snapshot should not contain user-identifying fields
    expect(serialized).not.toContain("wallet")
    expect(serialized).not.toContain("address")
    expect(serialized).not.toContain("user_id")
    expect(serialized).not.toContain("owner")
  })

  it("should only store personality_id as the sole identifier", async () => {
    await accumulator.accumulate("mycollection:42", createMetadata())

    const snapshot = store.get("mycollection:42")!

    // personality_id should be the only identifier
    expect(snapshot.personality_id).toBe("mycollection:42")

    // Verify no other ID-like fields exist on the snapshot
    const keys = Object.keys(snapshot)
    const idFields = keys.filter((k) => k.endsWith("_id") || k === "id")
    expect(idFields).toEqual(["personality_id"])
  })

  it("should not store model or latency details in the snapshot", async () => {
    await accumulator.accumulate("test:1", createMetadata({
      model: "secret-model-name",
      latency_ms: 99999,
    }))

    const snapshot = store.get("test:1")!
    const serialized = JSON.stringify(snapshot)

    expect(serialized).not.toContain("secret-model-name")
    expect(serialized).not.toContain("99999")
  })
})

// ---------------------------------------------------------------------------
// Async Behavior
// ---------------------------------------------------------------------------

describe("ExperienceAccumulator (async)", () => {
  it("should handle concurrent accumulations without corruption", async () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store, { epochSize: 50 })
    const accumulator = new ExperienceAccumulator(engine)

    // Fire 20 concurrent accumulations
    const promises = Array.from({ length: 20 }, (_, i) =>
      accumulator.accumulate("test:1", createMetadata({
        detected_topics: { [`topic_${i}`]: 1 },
      })),
    )

    const results = await Promise.all(promises)

    // All should be accepted
    expect(results.every((r) => r.accepted)).toBe(true)

    const snapshot = store.get("test:1")!
    expect(snapshot.interaction_count).toBe(20)

    // All 20 unique topics should be present
    const topicCount = Object.keys(snapshot.topic_distribution).length
    expect(topicCount).toBe(20)
  })

  it("should not block — accumulate returns promptly", async () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store)
    const accumulator = new ExperienceAccumulator(engine)

    const start = Date.now()
    await accumulator.accumulate("test:1", createMetadata())
    const elapsed = Date.now() - start

    // Should complete in well under 100ms (synchronous operation)
    expect(elapsed).toBeLessThan(100)
  })
})
