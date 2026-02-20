// tests/nft/drift-detectability.test.ts — I-11 Validation (Sprint 26 Task 26.4)
//
// Invariant I-11: After 100 interactions with non-trivial dial impacts,
// at least 3 dials must drift > 0.5% (0.005) from birth values.
//
// This validates that the experience accumulation system produces
// detectable behavioral drift over a realistic interaction volume.

import { describe, it, expect } from "vitest"
import type { DAMPDialId, DAMPFingerprint } from "../../src/nft/signal-types.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"
import { ExperienceStore } from "../../src/nft/experience-types.js"
import { ExperienceEngine } from "../../src/nft/experience-engine.js"
import type { InteractionAggregate } from "../../src/nft/experience-types.js"

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Create a uniform birth fingerprint */
function createBirthFingerprint(value: number): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = value
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-birth",
    derived_at: Date.now(),
  }
}

/**
 * Create an interaction with specific dial impacts.
 * Uses a recent timestamp (now) so decay is minimal.
 */
function createInteraction(
  dialImpacts: Partial<Record<DAMPDialId, number>>,
  timestampMs?: number,
): InteractionAggregate {
  const ts = timestampMs ?? Date.now()
  return {
    timestamp: new Date(ts).toISOString(),
    topic_frequencies: { general: 1 },
    style_counts: { neutral: 1 },
    metaphor_families: {},
    dial_impacts: dialImpacts,
  }
}

/**
 * Count how many dials have drifted more than the given threshold
 * from the birth fingerprint.
 */
function countDriftedDials(
  birthFp: DAMPFingerprint,
  effectiveFp: DAMPFingerprint,
  threshold: number,
): { count: number; drifted: Array<{ dial: DAMPDialId; birth: number; effective: number; drift: number }> } {
  const drifted: Array<{ dial: DAMPDialId; birth: number; effective: number; drift: number }> = []

  for (const dialId of DAMP_DIAL_IDS) {
    const birthVal = birthFp.dials[dialId]
    const effectiveVal = effectiveFp.dials[dialId]
    const drift = Math.abs(effectiveVal - birthVal)
    if (drift > threshold) {
      drifted.push({ dial: dialId, birth: birthVal, effective: effectiveVal, drift })
    }
  }

  return { count: drifted.length, drifted }
}

// ---------------------------------------------------------------------------
// I-11 Invariant: 100 interactions => >= 3 dials drift > 0.5%
// ---------------------------------------------------------------------------

describe("I-11: Drift Detectability", () => {
  it("100 interactions with consistent dial impacts should produce >= 3 dials drifting > 0.5%", () => {
    const store = new ExperienceStore()
    // Use epoch size of 10 to trigger multiple epochs within 100 interactions
    const engine = new ExperienceEngine(store, { epochSize: 10, halfLifeDays: 30 })
    const birthFp = createBirthFingerprint(0.5)

    const now = Date.now()

    // Simulate 100 interactions with consistent impacts across several dials
    // Each interaction nudges 5 different dials in the same direction
    const dialImpacts: Partial<Record<DAMPDialId, number>> = {
      sw_approachability: 0.002,
      cs_formality: -0.0015,
      cg_analytical_intuitive: 0.001,
      cr_playfulness: 0.0018,
      et_positivity_bias: 0.0012,
    }

    for (let i = 0; i < 100; i++) {
      // All interactions are recent (within last hour) to minimize decay
      const interaction = createInteraction(dialImpacts, now - (100 - i) * 60_000)
      engine.recordInteraction("test:1", interaction)
    }

    // Apply experience to birth fingerprint
    const effectiveFp = engine.applyExperience(birthFp, "test:1")

    // Validate I-11: at least 3 dials should drift > 0.5% (0.005)
    const threshold = 0.005
    const { count, drifted } = countDriftedDials(birthFp, effectiveFp, threshold)

    expect(count).toBeGreaterThanOrEqual(3)

    // Verify that the drifted dials are the ones we targeted
    const driftedDialIds = new Set(drifted.map((d) => d.dial))
    const targetedDials: DAMPDialId[] = [
      "sw_approachability",
      "cs_formality",
      "cg_analytical_intuitive",
      "cr_playfulness",
      "et_positivity_bias",
    ]
    // At least 3 of our targeted dials should show drift
    const targetedDrifted = targetedDials.filter((d) => driftedDialIds.has(d))
    expect(targetedDrifted.length).toBeGreaterThanOrEqual(3)
  })

  it("100 interactions with zero dial impacts should produce NO drift", () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store, { epochSize: 10 })
    const birthFp = createBirthFingerprint(0.5)

    // 100 interactions with zero impacts
    for (let i = 0; i < 100; i++) {
      engine.recordInteraction("test:zero", createInteraction({}))
    }

    const effectiveFp = engine.applyExperience(birthFp, "test:zero")
    const { count } = countDriftedDials(birthFp, effectiveFp, 0.005)

    expect(count).toBe(0)
  })

  it("drift should be bounded by cumulative clamp (5%)", () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store, { epochSize: 5, halfLifeDays: 30 })
    const birthFp = createBirthFingerprint(0.5)

    const now = Date.now()

    // 500 interactions with large impacts to try to exceed cumulative clamp
    for (let i = 0; i < 500; i++) {
      engine.recordInteraction("test:bounded", createInteraction(
        { sw_approachability: 0.01 },
        now - i * 1000,
      ))
    }

    const effectiveFp = engine.applyExperience(birthFp, "test:bounded")

    // Drift should never exceed cumulative clamp of 5% (0.05)
    // Use toBeCloseTo to account for IEEE 754 floating-point precision
    const drift = Math.abs(effectiveFp.dials.sw_approachability - birthFp.dials.sw_approachability)
    expect(drift).toBeCloseTo(0.05, 10)
    // Also verify it does not meaningfully exceed the clamp (allow 1e-12 epsilon)
    expect(drift).toBeLessThanOrEqual(0.05 + 1e-12)
  })

  it("drift direction should match consistent interaction impact direction", () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store, { epochSize: 10, halfLifeDays: 30 })
    const birthFp = createBirthFingerprint(0.5)

    const now = Date.now()

    // 100 interactions pushing approachability UP
    for (let i = 0; i < 100; i++) {
      engine.recordInteraction("test:direction", createInteraction(
        { sw_approachability: 0.002 },
        now - (100 - i) * 60_000,
      ))
    }

    const effectiveFp = engine.applyExperience(birthFp, "test:direction")

    // Effective value should be HIGHER than birth value
    expect(effectiveFp.dials.sw_approachability).toBeGreaterThan(birthFp.dials.sw_approachability)
  })

  it("opposing interactions should partially cancel drift", () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store, { epochSize: 10, halfLifeDays: 30 })
    const birthFp = createBirthFingerprint(0.5)

    const now = Date.now()

    // 50 interactions pushing UP, then 50 pushing DOWN
    for (let i = 0; i < 50; i++) {
      engine.recordInteraction("test:cancel", createInteraction(
        { sw_approachability: 0.002 },
        now - (100 - i) * 60_000,
      ))
    }
    for (let i = 50; i < 100; i++) {
      engine.recordInteraction("test:cancel", createInteraction(
        { sw_approachability: -0.002 },
        now - (100 - i) * 60_000,
      ))
    }

    const effectiveFp = engine.applyExperience(birthFp, "test:cancel")

    // Drift should be smaller than if all 100 pushed in the same direction
    const drift = Math.abs(effectiveFp.dials.sw_approachability - 0.5)

    // Compare with one-directional scenario
    const store2 = new ExperienceStore()
    const engine2 = new ExperienceEngine(store2, { epochSize: 10, halfLifeDays: 30 })
    for (let i = 0; i < 100; i++) {
      engine2.recordInteraction("test:oneway", createInteraction(
        { sw_approachability: 0.002 },
        now - (100 - i) * 60_000,
      ))
    }
    const oneWayFp = engine2.applyExperience(birthFp, "test:oneway")
    const oneWayDrift = Math.abs(oneWayFp.dials.sw_approachability - 0.5)

    expect(drift).toBeLessThan(oneWayDrift)
  })

  it("older interactions should contribute less drift than recent ones (decay)", () => {
    const now = Date.now()

    // Scenario A: all interactions are recent (within last hour)
    const storeRecent = new ExperienceStore()
    const engineRecent = new ExperienceEngine(storeRecent, { epochSize: 10, halfLifeDays: 7 })
    for (let i = 0; i < 100; i++) {
      engineRecent.recordInteraction("test:recent", createInteraction(
        { sw_approachability: 0.002 },
        now - i * 60_000, // last 100 minutes
      ))
    }

    // Scenario B: all interactions are old (90 days ago, >12 half-lives with 7-day half-life)
    const storeOld = new ExperienceStore()
    const engineOld = new ExperienceEngine(storeOld, { epochSize: 10, halfLifeDays: 7 })
    const ninetyDaysAgoMs = now - 90 * 86_400_000
    for (let i = 0; i < 100; i++) {
      engineOld.recordInteraction("test:old", createInteraction(
        { sw_approachability: 0.002 },
        ninetyDaysAgoMs - i * 60_000,
      ))
    }

    const birthFp = createBirthFingerprint(0.5)
    const recentFp = engineRecent.applyExperience(birthFp, "test:recent")
    const oldFp = engineOld.applyExperience(birthFp, "test:old")

    const recentDrift = Math.abs(recentFp.dials.sw_approachability - 0.5)
    const oldDrift = Math.abs(oldFp.dials.sw_approachability - 0.5)

    // Recent interactions should produce more drift than old ones
    expect(recentDrift).toBeGreaterThan(oldDrift)
  })

  it("multiple epochs should accumulate drift progressively", () => {
    const store = new ExperienceStore()
    const engine = new ExperienceEngine(store, { epochSize: 10, halfLifeDays: 30 })
    const birthFp = createBirthFingerprint(0.5)

    const now = Date.now()
    const drifts: number[] = []

    // Record 50 interactions, checking drift after each epoch
    for (let i = 0; i < 50; i++) {
      engine.recordInteraction("test:progressive", createInteraction(
        { sw_approachability: 0.002 },
        now - (50 - i) * 60_000,
      ))

      // Check drift at epoch boundaries (every 10 interactions)
      if ((i + 1) % 10 === 0) {
        const fp = engine.applyExperience(birthFp, "test:progressive")
        drifts.push(Math.abs(fp.dials.sw_approachability - 0.5))
      }
    }

    // Each epoch should produce >= previous drift (monotonically increasing)
    for (let i = 1; i < drifts.length; i++) {
      expect(drifts[i]).toBeGreaterThanOrEqual(drifts[i - 1])
    }
  })
})
