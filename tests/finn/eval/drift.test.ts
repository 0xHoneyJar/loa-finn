// tests/finn/eval/drift.test.ts — Personality Drift Analysis Tests (Sprint 16 Task 16.4)

import { describe, it, expect } from "vitest"
import { computeDrift, getTopChangedDials, analyzeDrift } from "../../../src/nft/eval/drift.js"
import { DAPM_DIAL_IDS, type DAPMFingerprint, type DAPMDialId } from "../../../src/nft/signal-types.js"
import type { PersonalityVersion } from "../../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fingerprint with all dials set to a given value */
function createUniformFingerprint(value: number, mode: "default" | "brainstorm" = "default"): DAPMFingerprint {
  const dials = {} as Record<DAPMDialId, number>
  for (const id of DAPM_DIAL_IDS) {
    dials[id] = value
  }
  return {
    dials,
    mode,
    derived_from: "test-snapshot",
    derived_at: Date.now(),
  }
}

/** Create a fingerprint with specific overrides on top of a base value */
function createFingerprint(
  baseValue: number,
  overrides: Partial<Record<DAPMDialId, number>> = {},
  mode: "default" | "brainstorm" = "default",
): DAPMFingerprint {
  const dials = {} as Record<DAPMDialId, number>
  for (const id of DAPM_DIAL_IDS) {
    dials[id] = overrides[id] ?? baseValue
  }
  return {
    dials,
    mode,
    derived_from: "test-snapshot",
    derived_at: Date.now(),
  }
}

/** Create a minimal PersonalityVersion with a fingerprint */
function createVersion(
  versionId: string,
  fingerprint: DAPMFingerprint | null,
  previousVersionId: string | null = null,
): PersonalityVersion {
  return {
    version_id: versionId,
    previous_version_id: previousVersionId,
    personality_id: "test-col:1",
    signal_snapshot: null,
    dapm_fingerprint: fingerprint,
    beauvoir_md: "# Test",
    authored_by: "0xtest",
    governance_model: "holder",
    codex_version: "v1.0.0",
    compatibility_mode: "signal_v2",
    created_at: Date.now(),
    change_summary: "test version",
  }
}

// ---------------------------------------------------------------------------
// computeDrift
// ---------------------------------------------------------------------------

describe("computeDrift", () => {
  it("should return zero drift for identical fingerprints", () => {
    const fp = createUniformFingerprint(0.5)

    const result = computeDrift(fp, fp)

    expect(result.total_drift).toBe(0)
    expect(result.mean_drift).toBe(0)
    expect(result.max_drift).toBe(0)
    expect(result.dial_count).toBe(96)
  })

  it("should compute correct total drift for uniform change", () => {
    const fpA = createUniformFingerprint(0.0)
    const fpB = createUniformFingerprint(1.0)

    const result = computeDrift(fpA, fpB)

    // Each of 96 dials changed by 1.0
    expect(result.total_drift).toBeCloseTo(96.0, 5)
    expect(result.mean_drift).toBeCloseTo(1.0, 5)
    expect(result.max_drift).toBeCloseTo(1.0, 5)
  })

  it("should compute correct drift for a single dial change", () => {
    const fpA = createFingerprint(0.5)
    const fpB = createFingerprint(0.5, { sw_approachability: 0.9 })

    const result = computeDrift(fpA, fpB)

    expect(result.total_drift).toBeCloseTo(0.4, 5)
    expect(result.max_drift).toBeCloseTo(0.4, 5)
    expect(result.mean_drift).toBeCloseTo(0.4 / 96, 5)
  })

  it("should return top_changed sorted by delta descending", () => {
    const fpA = createFingerprint(0.5)
    const fpB = createFingerprint(0.5, {
      sw_approachability: 0.9,     // delta 0.4
      cs_formality: 0.8,           // delta 0.3
      as_opinion_strength: 0.7,    // delta 0.2
    })

    const result = computeDrift(fpA, fpB)

    expect(result.top_changed[0].dial_id).toBe("sw_approachability")
    expect(result.top_changed[0].delta).toBeCloseTo(0.4, 5)
    expect(result.top_changed[1].dial_id).toBe("cs_formality")
    expect(result.top_changed[1].delta).toBeCloseTo(0.3, 5)
    expect(result.top_changed[2].dial_id).toBe("as_opinion_strength")
    expect(result.top_changed[2].delta).toBeCloseTo(0.2, 5)
  })

  it("should include old_value and new_value in top_changed entries", () => {
    const fpA = createFingerprint(0.3)
    const fpB = createFingerprint(0.3, { cr_playfulness: 0.8 })

    const result = computeDrift(fpA, fpB)

    const playfulness = result.top_changed.find((c) => c.dial_id === "cr_playfulness")
    expect(playfulness).toBeDefined()
    expect(playfulness!.old_value).toBeCloseTo(0.3, 5)
    expect(playfulness!.new_value).toBeCloseTo(0.8, 5)
    expect(playfulness!.delta).toBeCloseTo(0.5, 5)
  })

  it("should limit top_changed to 10 entries by default", () => {
    const fpA = createUniformFingerprint(0.0)
    const fpB = createUniformFingerprint(1.0)

    const result = computeDrift(fpA, fpB)

    expect(result.top_changed.length).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// getTopChangedDials
// ---------------------------------------------------------------------------

describe("getTopChangedDials", () => {
  it("should return the top N most-changed dials", () => {
    const fpA = createFingerprint(0.5)
    const fpB = createFingerprint(0.5, {
      sw_approachability: 1.0,     // delta 0.5
      cs_formality: 0.9,           // delta 0.4
      as_opinion_strength: 0.8,    // delta 0.3
    })

    const result = getTopChangedDials(fpA, fpB, 2)

    expect(result.length).toBe(2)
    expect(result[0].dial_id).toBe("sw_approachability")
    expect(result[1].dial_id).toBe("cs_formality")
  })

  it("should default to 10 when topN not specified", () => {
    const fpA = createUniformFingerprint(0.0)
    const fpB = createUniformFingerprint(0.5)

    const result = getTopChangedDials(fpA, fpB)

    expect(result.length).toBe(10)
  })

  it("should return all dials if topN > 96", () => {
    const fpA = createUniformFingerprint(0.0)
    const fpB = createUniformFingerprint(0.1)

    const result = getTopChangedDials(fpA, fpB, 200)

    expect(result.length).toBe(96)
  })

  it("should return empty changes for identical fingerprints (all deltas 0)", () => {
    const fp = createUniformFingerprint(0.5)

    const result = getTopChangedDials(fp, fp, 5)

    expect(result.length).toBe(5)
    for (const entry of result) {
      expect(entry.delta).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// analyzeDrift
// ---------------------------------------------------------------------------

describe("analyzeDrift", () => {
  it("should return empty result for single version", () => {
    const fp = createUniformFingerprint(0.5)
    const versions = [createVersion("v1", fp)]

    const result = analyzeDrift(versions)

    expect(result.transition_count).toBe(0)
    expect(result.transitions).toHaveLength(0)
    expect(result.cumulative_drift).toBe(0)
    expect(result.mean_transition_drift).toBe(0)
  })

  it("should compute drift across two versions", () => {
    const fpA = createUniformFingerprint(0.0)
    const fpB = createUniformFingerprint(0.5)
    const versions = [
      createVersion("v1", fpA),
      createVersion("v2", fpB, "v1"),
    ]

    const result = analyzeDrift(versions)

    expect(result.transition_count).toBe(1)
    expect(result.transitions[0].from_version).toBe("v1")
    expect(result.transitions[0].to_version).toBe("v2")
    expect(result.cumulative_drift).toBeCloseTo(48.0, 5) // 96 dials * 0.5 delta
  })

  it("should compute cumulative drift across multiple versions", () => {
    const fp1 = createUniformFingerprint(0.0)
    const fp2 = createUniformFingerprint(0.5)
    const fp3 = createUniformFingerprint(1.0)
    const versions = [
      createVersion("v1", fp1),
      createVersion("v2", fp2, "v1"),
      createVersion("v3", fp3, "v2"),
    ]

    const result = analyzeDrift(versions)

    expect(result.transition_count).toBe(2)
    // Each transition: 96 * 0.5 = 48.0
    expect(result.cumulative_drift).toBeCloseTo(96.0, 5)
    expect(result.mean_transition_drift).toBeCloseTo(48.0, 5)
  })

  it("should skip versions without dAPM fingerprints", () => {
    const fp1 = createUniformFingerprint(0.0)
    const fp3 = createUniformFingerprint(1.0)
    const versions = [
      createVersion("v1", fp1),
      createVersion("v2", null, "v1"),  // No fingerprint — skipped
      createVersion("v3", fp3, "v2"),
    ]

    const result = analyzeDrift(versions)

    // Only v1 → v3 transition (v2 skipped)
    expect(result.transition_count).toBe(1)
    expect(result.transitions[0].from_version).toBe("v1")
    expect(result.transitions[0].to_version).toBe("v3")
    expect(result.cumulative_drift).toBeCloseTo(96.0, 5)
  })

  it("should return empty result for all-null fingerprint versions", () => {
    const versions = [
      createVersion("v1", null),
      createVersion("v2", null, "v1"),
    ]

    const result = analyzeDrift(versions)

    expect(result.transition_count).toBe(0)
    expect(result.cumulative_drift).toBe(0)
  })

  it("should handle empty versions array", () => {
    const result = analyzeDrift([])

    expect(result.transition_count).toBe(0)
    expect(result.cumulative_drift).toBe(0)
    expect(result.mean_transition_drift).toBe(0)
  })
})
