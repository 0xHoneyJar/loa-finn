// tests/nft/experience-engine.test.ts — Experience Engine Tests (Sprint 25 Task 25.4)
//
// Tests for epoch trigger, drift computation with exponential decay,
// clamping (per-epoch and cumulative), and rebase transform.

import { describe, it, expect, beforeEach } from "vitest"
import type { DAMPDialId, DAMPFingerprint } from "../../src/nft/signal-types.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"
import type { InteractionAggregate, ExperienceOffset } from "../../src/nft/experience-types.js"
import {
  ExperienceStore,
  PER_EPOCH_CLAMP,
  CUMULATIVE_CLAMP,
  DEFAULT_EPOCH_SIZE,
  MIN_INTERACTIONS_TO_PERSIST,
} from "../../src/nft/experience-types.js"
import {
  computeDecayFactor,
  computeDecayedImpact,
  clampEpochDelta,
  clampCumulativeOffset,
  computeEffectiveDial,
  shouldTriggerEpoch,
  processEpoch,
  ExperienceEngine,
  DEFAULT_HALF_LIFE_DAYS,
} from "../../src/nft/experience-engine.js"
import {
  extractDirectionVectors,
  rebaseDial,
  rebaseExperience,
  applyRebasedOffsets,
} from "../../src/nft/experience-rebase.js"

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Create a uniform DAMPFingerprint with all dials set to a given value */
function createUniformFingerprint(value: number): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = value
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-snapshot",
    derived_at: Date.now(),
  }
}

/** Create a fingerprint with specific overrides */
function createFingerprint(
  baseValue: number,
  overrides: Partial<Record<DAMPDialId, number>> = {},
): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = overrides[id] ?? baseValue
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-snapshot",
    derived_at: Date.now(),
  }
}

/** Create a minimal interaction aggregate */
function createInteraction(
  dialImpacts: Partial<Record<DAMPDialId, number>>,
  timestamp?: string,
  topics?: Record<string, number>,
): InteractionAggregate {
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    topic_frequencies: topics ?? { general: 1 },
    style_counts: { neutral: 1 },
    metaphor_families: {},
    dial_impacts: dialImpacts,
  }
}

const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Decay Computation
// ---------------------------------------------------------------------------

describe("computeDecayFactor", () => {
  it("should return 1.0 for age 0", () => {
    expect(computeDecayFactor(0)).toBe(1.0)
  })

  it("should return 1.0 for negative age", () => {
    expect(computeDecayFactor(-5)).toBe(1.0)
  })

  it("should return 0.5 at exactly one half-life", () => {
    const result = computeDecayFactor(DEFAULT_HALF_LIFE_DAYS, DEFAULT_HALF_LIFE_DAYS)
    expect(result).toBeCloseTo(0.5, 10)
  })

  it("should return 0.25 at two half-lives", () => {
    const result = computeDecayFactor(2 * DEFAULT_HALF_LIFE_DAYS, DEFAULT_HALF_LIFE_DAYS)
    expect(result).toBeCloseTo(0.25, 10)
  })

  it("should return 0.0 for zero half-life", () => {
    expect(computeDecayFactor(1, 0)).toBe(0.0)
  })

  it("should decrease monotonically with age", () => {
    const f1 = computeDecayFactor(1)
    const f10 = computeDecayFactor(10)
    const f100 = computeDecayFactor(100)
    expect(f1).toBeGreaterThan(f10)
    expect(f10).toBeGreaterThan(f100)
    expect(f100).toBeGreaterThan(0)
  })

  it("should respect custom half-life", () => {
    // With 7-day half-life, factor at day 7 should be 0.5
    const result = computeDecayFactor(7, 7)
    expect(result).toBeCloseTo(0.5, 10)
  })
})

describe("computeDecayedImpact", () => {
  it("should return full impact at age 0", () => {
    expect(computeDecayedImpact(0.1, 0)).toBeCloseTo(0.1, 10)
  })

  it("should return half impact at one half-life", () => {
    const result = computeDecayedImpact(0.1, DEFAULT_HALF_LIFE_DAYS)
    expect(result).toBeCloseTo(0.05, 10)
  })

  it("should preserve sign for negative impacts", () => {
    const result = computeDecayedImpact(-0.1, 0)
    expect(result).toBeCloseTo(-0.1, 10)
  })

  it("should decay negative impacts toward zero", () => {
    const result = computeDecayedImpact(-0.1, DEFAULT_HALF_LIFE_DAYS)
    expect(result).toBeCloseTo(-0.05, 10)
  })
})

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

describe("clampEpochDelta", () => {
  it("should pass through values within bounds", () => {
    expect(clampEpochDelta(0.001)).toBe(0.001)
    expect(clampEpochDelta(-0.001)).toBe(-0.001)
    expect(clampEpochDelta(0)).toBe(0)
  })

  it("should clamp to +PER_EPOCH_CLAMP", () => {
    expect(clampEpochDelta(0.01)).toBe(PER_EPOCH_CLAMP)
    expect(clampEpochDelta(1.0)).toBe(PER_EPOCH_CLAMP)
  })

  it("should clamp to -PER_EPOCH_CLAMP", () => {
    expect(clampEpochDelta(-0.01)).toBe(-PER_EPOCH_CLAMP)
    expect(clampEpochDelta(-1.0)).toBe(-PER_EPOCH_CLAMP)
  })

  it("should pass through exactly at boundary", () => {
    expect(clampEpochDelta(PER_EPOCH_CLAMP)).toBe(PER_EPOCH_CLAMP)
    expect(clampEpochDelta(-PER_EPOCH_CLAMP)).toBe(-PER_EPOCH_CLAMP)
  })
})

describe("clampCumulativeOffset", () => {
  it("should pass through values within bounds", () => {
    expect(clampCumulativeOffset(0.03)).toBe(0.03)
    expect(clampCumulativeOffset(-0.03)).toBe(-0.03)
  })

  it("should clamp to +CUMULATIVE_CLAMP", () => {
    expect(clampCumulativeOffset(0.1)).toBe(CUMULATIVE_CLAMP)
  })

  it("should clamp to -CUMULATIVE_CLAMP", () => {
    expect(clampCumulativeOffset(-0.1)).toBe(-CUMULATIVE_CLAMP)
  })

  it("should pass through exactly at boundary", () => {
    expect(clampCumulativeOffset(CUMULATIVE_CLAMP)).toBe(CUMULATIVE_CLAMP)
    expect(clampCumulativeOffset(-CUMULATIVE_CLAMP)).toBe(-CUMULATIVE_CLAMP)
  })
})

describe("computeEffectiveDial", () => {
  it("should add offset to birth value", () => {
    expect(computeEffectiveDial(0.5, 0.03)).toBeCloseTo(0.53, 10)
  })

  it("should subtract negative offset from birth value", () => {
    expect(computeEffectiveDial(0.5, -0.03)).toBeCloseTo(0.47, 10)
  })

  it("should clamp to birth +/- 0.05", () => {
    // Offset of +0.1 should be clamped to birth + 0.05
    expect(computeEffectiveDial(0.5, 0.1)).toBeCloseTo(0.55, 10)
    // Offset of -0.1 should be clamped to birth - 0.05
    expect(computeEffectiveDial(0.5, -0.1)).toBeCloseTo(0.45, 10)
  })

  it("should clamp to [0, 1] range", () => {
    // Birth near 0 with negative offset
    expect(computeEffectiveDial(0.02, -0.05)).toBe(0)
    // Birth near 1 with positive offset
    expect(computeEffectiveDial(0.98, 0.05)).toBe(1)
  })

  it("should return birth value for zero offset", () => {
    expect(computeEffectiveDial(0.6, 0)).toBe(0.6)
  })
})

// ---------------------------------------------------------------------------
// Epoch Trigger
// ---------------------------------------------------------------------------

describe("shouldTriggerEpoch", () => {
  it("should not trigger below epoch size", () => {
    expect(shouldTriggerEpoch(0)).toBe(false)
    expect(shouldTriggerEpoch(49)).toBe(false)
  })

  it("should trigger at exactly epoch size", () => {
    expect(shouldTriggerEpoch(DEFAULT_EPOCH_SIZE)).toBe(true)
  })

  it("should trigger above epoch size", () => {
    expect(shouldTriggerEpoch(100)).toBe(true)
  })

  it("should respect custom epoch size", () => {
    expect(shouldTriggerEpoch(9, 10)).toBe(false)
    expect(shouldTriggerEpoch(10, 10)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Epoch Processing
// ---------------------------------------------------------------------------

describe("processEpoch", () => {
  it("should return empty deltas for no pending interactions", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    const deltas = processEpoch(snapshot)
    expect(Object.keys(deltas)).toHaveLength(0)
  })

  it("should fold pending interactions into offsets", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    const now = Date.now()
    const interaction = createInteraction(
      { sw_approachability: 0.002 },
      new Date(now).toISOString(),
    )
    snapshot.pending_interactions.push(interaction)

    const deltas = processEpoch(snapshot, now)

    expect(deltas.sw_approachability).toBeDefined()
    expect(deltas.sw_approachability).toBeGreaterThan(0)
    expect(snapshot.epoch_count).toBe(1)
    expect(snapshot.pending_interactions).toHaveLength(0)
  })

  it("should clamp epoch deltas to per-epoch bounds", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    const now = Date.now()

    // Add many interactions with large impacts to exceed per-epoch clamp
    for (let i = 0; i < 10; i++) {
      snapshot.pending_interactions.push(
        createInteraction(
          { sw_approachability: 0.01 },
          new Date(now).toISOString(),
        ),
      )
    }

    const deltas = processEpoch(snapshot, now)

    // Even though raw sum would be 0.1, epoch clamp limits to 0.005
    expect(Math.abs(deltas.sw_approachability!)).toBeLessThanOrEqual(PER_EPOCH_CLAMP)
  })

  it("should apply exponential decay based on interaction age", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    const now = Date.now()
    const halfLife = DEFAULT_HALF_LIFE_DAYS

    // Recent interaction (0 days ago)
    const recentInteraction = createInteraction(
      { sw_approachability: 0.004 },
      new Date(now).toISOString(),
    )

    // Old interaction (one half-life ago)
    const oldInteraction = createInteraction(
      { cs_formality: 0.004 },
      new Date(now - halfLife * MS_PER_DAY).toISOString(),
    )

    snapshot.pending_interactions.push(recentInteraction, oldInteraction)
    const deltas = processEpoch(snapshot, now, halfLife)

    // Recent interaction should have full impact, old should have ~half
    // Both are within epoch clamp so we can compare relative magnitudes
    const recentDelta = Math.abs(deltas.sw_approachability ?? 0)
    const oldDelta = Math.abs(deltas.cs_formality ?? 0)

    expect(recentDelta).toBeGreaterThan(0)
    expect(oldDelta).toBeGreaterThan(0)
    // Old interaction decayed to ~0.002, recent stays at ~0.004
    expect(recentDelta).toBeGreaterThan(oldDelta)
  })

  it("should accumulate cumulative offsets across multiple epochs", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    const now = Date.now()

    // First epoch
    snapshot.pending_interactions.push(
      createInteraction({ sw_approachability: 0.003 }, new Date(now).toISOString()),
    )
    processEpoch(snapshot, now)
    const offset1 = snapshot.offsets.dial_offsets.sw_approachability ?? 0

    // Second epoch
    snapshot.pending_interactions.push(
      createInteraction({ sw_approachability: 0.003 }, new Date(now).toISOString()),
    )
    processEpoch(snapshot, now)
    const offset2 = snapshot.offsets.dial_offsets.sw_approachability ?? 0

    expect(snapshot.epoch_count).toBe(2)
    expect(Math.abs(offset2)).toBeGreaterThanOrEqual(Math.abs(offset1))
  })

  it("should clamp cumulative offsets to cumulative bounds", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    const now = Date.now()

    // Run many epochs to try to exceed cumulative clamp
    for (let epoch = 0; epoch < 20; epoch++) {
      snapshot.pending_interactions.push(
        createInteraction({ sw_approachability: 0.005 }, new Date(now).toISOString()),
      )
      processEpoch(snapshot, now)
    }

    const cumulativeOffset = snapshot.offsets.dial_offsets.sw_approachability ?? 0
    expect(Math.abs(cumulativeOffset)).toBeLessThanOrEqual(CUMULATIVE_CLAMP)
  })
})

// ---------------------------------------------------------------------------
// ExperienceEngine
// ---------------------------------------------------------------------------

describe("ExperienceEngine", () => {
  let store: ExperienceStore
  let engine: ExperienceEngine

  beforeEach(() => {
    store = new ExperienceStore()
    engine = new ExperienceEngine(store, { epochSize: 5, halfLifeDays: 30 })
  })

  it("should create snapshot on first interaction", () => {
    const interaction = createInteraction({ sw_approachability: 0.001 })
    engine.recordInteraction("test:1", interaction)

    expect(store.has("test:1")).toBe(true)
    const snapshot = store.get("test:1")!
    expect(snapshot.interaction_count).toBe(1)
    expect(snapshot.pending_interactions).toHaveLength(1)
  })

  it("should accumulate topic distributions", () => {
    engine.recordInteraction("test:1", createInteraction({}, undefined, { philosophy: 3 }))
    engine.recordInteraction("test:1", createInteraction({}, undefined, { philosophy: 2, art: 1 }))

    const snapshot = store.get("test:1")!
    expect(snapshot.topic_distribution.philosophy).toBe(5)
    expect(snapshot.topic_distribution.art).toBe(1)
  })

  it("should trigger epoch after reaching epoch size", () => {
    for (let i = 0; i < 4; i++) {
      const result = engine.recordInteraction("test:1", createInteraction({ sw_approachability: 0.001 }))
      expect(result.epochTriggered).toBe(false)
    }

    // 5th interaction should trigger epoch (epochSize = 5)
    const result = engine.recordInteraction("test:1", createInteraction({ sw_approachability: 0.001 }))
    expect(result.epochTriggered).toBe(true)
    expect(result.epochDeltas).not.toBeNull()

    const snapshot = store.get("test:1")!
    expect(snapshot.epoch_count).toBe(1)
    expect(snapshot.pending_interactions).toHaveLength(0)
  })

  it("should not trigger epoch before reaching epoch size", () => {
    for (let i = 0; i < 4; i++) {
      const result = engine.recordInteraction("test:1", createInteraction({ sw_approachability: 0.001 }))
      expect(result.epochTriggered).toBe(false)
      expect(result.epochDeltas).toBeNull()
    }
  })

  it("should apply experience offsets to birth fingerprint", () => {
    const birthFp = createUniformFingerprint(0.5)

    // Manually set an offset in the store
    const snapshot = ExperienceStore.createEmpty("test:1")
    snapshot.offsets.dial_offsets.sw_approachability = 0.03
    snapshot.interaction_count = MIN_INTERACTIONS_TO_PERSIST
    store.set(snapshot)

    const effective = engine.applyExperience(birthFp, "test:1")

    expect(effective.dials.sw_approachability).toBeCloseTo(0.53, 10)
    // Unaffected dials should remain at birth value
    expect(effective.dials.cs_formality).toBe(0.5)
  })

  it("should return birth fingerprint when no experience exists", () => {
    const birthFp = createUniformFingerprint(0.5)
    const result = engine.applyExperience(birthFp, "nonexistent:1")

    expect(result.dials.sw_approachability).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// ExperienceStore
// ---------------------------------------------------------------------------

describe("ExperienceStore", () => {
  let store: ExperienceStore

  beforeEach(() => {
    store = new ExperienceStore()
  })

  it("should return null for nonexistent personality", () => {
    expect(store.get("nonexistent:1")).toBeNull()
  })

  it("should store and retrieve snapshots", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    snapshot.interaction_count = MIN_INTERACTIONS_TO_PERSIST
    store.set(snapshot)

    const retrieved = store.get("test:1")
    expect(retrieved).not.toBeNull()
    expect(retrieved!.personality_id).toBe("test:1")
  })

  it("should return false when below persist threshold", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    snapshot.interaction_count = 5
    const persisted = store.set(snapshot)
    expect(persisted).toBe(false)

    // Still retrievable from memory though
    expect(store.get("test:1")).not.toBeNull()
  })

  it("should return true when at or above persist threshold", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    snapshot.interaction_count = MIN_INTERACTIONS_TO_PERSIST
    const persisted = store.set(snapshot)
    expect(persisted).toBe(true)
  })

  it("should delete snapshots", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    store.set(snapshot)
    expect(store.delete("test:1")).toBe(true)
    expect(store.get("test:1")).toBeNull()
  })

  it("should track size correctly", () => {
    expect(store.size).toBe(0)
    store.set(ExperienceStore.createEmpty("test:1"))
    store.set(ExperienceStore.createEmpty("test:2"))
    expect(store.size).toBe(2)
    store.delete("test:1")
    expect(store.size).toBe(1)
  })

  it("should clear all data", () => {
    store.set(ExperienceStore.createEmpty("test:1"))
    store.set(ExperienceStore.createEmpty("test:2"))
    store.clear()
    expect(store.size).toBe(0)
  })

  it("should create empty snapshots with correct defaults", () => {
    const snapshot = ExperienceStore.createEmpty("test:1")
    expect(snapshot.personality_id).toBe("test:1")
    expect(snapshot.interaction_count).toBe(0)
    expect(snapshot.epoch_count).toBe(0)
    expect(snapshot.pending_interactions).toHaveLength(0)
    expect(Object.keys(snapshot.topic_distribution)).toHaveLength(0)
    expect(Object.keys(snapshot.style_counts)).toHaveLength(0)
    expect(Object.keys(snapshot.metaphor_families)).toHaveLength(0)
    expect(Object.keys(snapshot.offsets.dial_offsets)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rebase — Direction Vector Extraction
// ---------------------------------------------------------------------------

describe("extractDirectionVectors", () => {
  it("should extract vectors for non-zero offsets", () => {
    const offsets: ExperienceOffset = {
      dial_offsets: {
        sw_approachability: 0.03,
        cs_formality: -0.02,
      },
      epoch_count: 2,
      interaction_count: 100,
      updated_at: Date.now(),
    }

    const vectors = extractDirectionVectors(offsets)

    expect(vectors).toHaveLength(2)
    const approachability = vectors.find((v) => v.dial_id === "sw_approachability")!
    expect(approachability.direction).toBe(1)
    expect(approachability.offset).toBe(0.03)

    const formality = vectors.find((v) => v.dial_id === "cs_formality")!
    expect(formality.direction).toBe(-1)
    expect(formality.offset).toBe(-0.02)
  })

  it("should skip zero offsets", () => {
    const offsets: ExperienceOffset = {
      dial_offsets: {},
      epoch_count: 0,
      interaction_count: 0,
      updated_at: Date.now(),
    }

    const vectors = extractDirectionVectors(offsets)
    expect(vectors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rebase — Single Dial
// ---------------------------------------------------------------------------

describe("rebaseDial", () => {
  it("should preserve offset within cumulative bounds", () => {
    // rebase(old_birth=0.6, new_birth=0.7, old_offset=+0.03) => rebased=+0.03, effective=0.73
    const { rebasedOffset, effectiveValue } = rebaseDial(0.6, 0.7, 0.03)
    expect(rebasedOffset).toBeCloseTo(0.03, 10)
    expect(effectiveValue).toBeCloseTo(0.73, 10)
  })

  it("should clamp offset exceeding cumulative bounds", () => {
    // rebase(old_birth=0.6, new_birth=0.7, old_offset=+0.06) => rebased=+0.05, effective=0.75
    const { rebasedOffset, effectiveValue } = rebaseDial(0.6, 0.7, 0.06)
    expect(rebasedOffset).toBeCloseTo(0.05, 10)
    expect(effectiveValue).toBeCloseTo(0.75, 10)
  })

  it("should preserve negative offsets", () => {
    const { rebasedOffset, effectiveValue } = rebaseDial(0.5, 0.6, -0.03)
    expect(rebasedOffset).toBeCloseTo(-0.03, 10)
    expect(effectiveValue).toBeCloseTo(0.57, 10)
  })

  it("should clamp negative offset exceeding cumulative bounds", () => {
    const { rebasedOffset, effectiveValue } = rebaseDial(0.5, 0.6, -0.08)
    expect(rebasedOffset).toBeCloseTo(-0.05, 10)
    expect(effectiveValue).toBeCloseTo(0.55, 10)
  })

  it("should handle zero offset", () => {
    const { rebasedOffset, effectiveValue } = rebaseDial(0.5, 0.7, 0)
    expect(rebasedOffset).toBe(0)
    expect(effectiveValue).toBeCloseTo(0.7, 10)
  })

  it("should clamp effective value to [0, 1]", () => {
    // New birth near 1 with positive offset
    const { effectiveValue } = rebaseDial(0.5, 0.98, 0.04)
    expect(effectiveValue).toBeLessThanOrEqual(1.0)

    // New birth near 0 with negative offset
    const { effectiveValue: ev2 } = rebaseDial(0.5, 0.02, -0.04)
    expect(ev2).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Rebase — Full Transform
// ---------------------------------------------------------------------------

describe("rebaseExperience", () => {
  it("should rebase all dials with offsets", () => {
    const oldBirth = createUniformFingerprint(0.5)
    const newBirth = createUniformFingerprint(0.6)
    const offsets: ExperienceOffset = {
      dial_offsets: {
        sw_approachability: 0.03,
        cs_formality: -0.02,
      },
      epoch_count: 2,
      interaction_count: 100,
      updated_at: Date.now(),
    }

    const result = rebaseExperience(oldBirth, newBirth, offsets)

    expect(result.rebasedDialCount).toBe(2)
    expect(result.rebasedOffsets.dial_offsets.sw_approachability).toBeCloseTo(0.03, 10)
    expect(result.rebasedOffsets.dial_offsets.cs_formality).toBeCloseTo(-0.02, 10)
    expect(result.effectiveValues.sw_approachability).toBeCloseTo(0.63, 10)
    expect(result.effectiveValues.cs_formality).toBeCloseTo(0.58, 10)
  })

  it("should preserve direction vectors during rebase", () => {
    const oldBirth = createUniformFingerprint(0.5)
    const newBirth = createUniformFingerprint(0.6)
    const offsets: ExperienceOffset = {
      dial_offsets: {
        sw_approachability: 0.03,
        cs_formality: -0.02,
      },
      epoch_count: 2,
      interaction_count: 100,
      updated_at: Date.now(),
    }

    const result = rebaseExperience(oldBirth, newBirth, offsets)

    // Both directions should be preserved (offsets within bounds)
    expect(result.preservedDirections).toHaveLength(2)
    const approachDir = result.preservedDirections.find((d) => d.dial_id === "sw_approachability")
    expect(approachDir?.direction).toBe(1)
    const formalDir = result.preservedDirections.find((d) => d.dial_id === "cs_formality")
    expect(formalDir?.direction).toBe(-1)
  })

  it("should preserve metadata (epoch_count, interaction_count)", () => {
    const oldBirth = createUniformFingerprint(0.5)
    const newBirth = createUniformFingerprint(0.6)
    const offsets: ExperienceOffset = {
      dial_offsets: { sw_approachability: 0.03 },
      epoch_count: 5,
      interaction_count: 250,
      updated_at: Date.now(),
    }

    const result = rebaseExperience(oldBirth, newBirth, offsets)

    expect(result.rebasedOffsets.epoch_count).toBe(5)
    expect(result.rebasedOffsets.interaction_count).toBe(250)
  })

  it("should handle empty offsets", () => {
    const oldBirth = createUniformFingerprint(0.5)
    const newBirth = createUniformFingerprint(0.6)
    const offsets: ExperienceOffset = {
      dial_offsets: {},
      epoch_count: 0,
      interaction_count: 0,
      updated_at: Date.now(),
    }

    const result = rebaseExperience(oldBirth, newBirth, offsets)

    expect(result.rebasedDialCount).toBe(0)
    expect(result.preservedDirections).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Rebase — Apply Rebased Offsets
// ---------------------------------------------------------------------------

describe("applyRebasedOffsets", () => {
  it("should produce correct effective fingerprint", () => {
    const newBirth = createFingerprint(0.6, { sw_approachability: 0.7 })
    const rebasedOffsets: ExperienceOffset = {
      dial_offsets: { sw_approachability: 0.03 },
      epoch_count: 2,
      interaction_count: 100,
      updated_at: Date.now(),
    }

    const effective = applyRebasedOffsets(newBirth, rebasedOffsets)

    expect(effective.dials.sw_approachability).toBeCloseTo(0.73, 10)
    // Unaffected dials should remain at birth value
    expect(effective.dials.cs_formality).toBe(0.6)
  })

  it("should respect cumulative clamp in effective values", () => {
    const newBirth = createUniformFingerprint(0.5)
    const rebasedOffsets: ExperienceOffset = {
      dial_offsets: { sw_approachability: 0.05 },
      epoch_count: 10,
      interaction_count: 500,
      updated_at: Date.now(),
    }

    const effective = applyRebasedOffsets(newBirth, rebasedOffsets)

    expect(effective.dials.sw_approachability).toBeCloseTo(0.55, 10)
  })
})
