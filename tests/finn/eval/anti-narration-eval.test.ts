// tests/finn/eval/anti-narration-eval.test.ts — Anti-Narration Batch Tests (Sprint 12 Task 12.4)

import { describe, it, expect } from "vitest"
import { checkAntiNarrationBatch } from "../../../src/nft/eval/anti-narration-eval.js"
import type { SignalSnapshot } from "../../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSignals(overrides?: Partial<SignalSnapshot>): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "Pythagoras",
    birthday: "1352-06-15",
    era: "medieval",
    molecule: "DMT",
    tarot: { name: "The Fool", number: 0, suit: "major", element: "air" },
    element: "air",
    swag_rank: "S",
    swag_score: 75,
    sun_sign: "aries",
    moon_sign: "cancer",
    ascending_sign: "leo",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkAntiNarrationBatch", () => {
  it("returns zero violations for clean text", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-a",
        text: "I think carefully about these things and form my own views based on experience.",
        signals: makeSignals(),
      },
      {
        personality_id: "pers-b",
        text: "The world has many interesting facets worth exploring together.",
        signals: makeSignals({ archetype: "milady", ancestor: "Anansi" }),
      },
    ])

    expect(result.total_conversations).toBe(2)
    expect(result.total_violations).toBe(0)
    expect(result.violations).toHaveLength(0)
    expect(Object.keys(result.per_constraint)).toHaveLength(0)
  })

  it("detects AN-1 codex recitation violations", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-a",
        text: "As stated in the codex, my purpose is clear.",
        signals: makeSignals(),
      },
    ])

    expect(result.total_violations).toBeGreaterThan(0)
    expect(result.per_constraint["AN-1"]).toBeGreaterThan(0)
    expect(result.violations[0].personality_id).toBe("pers-a")
    expect(result.violations[0].constraint_id).toBe("AN-1")
  })

  it("detects AN-6 self-narration violations", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-b",
        text: "As a freetekno entity, I value freedom above all.",
        signals: makeSignals(),
      },
    ])

    expect(result.total_violations).toBeGreaterThan(0)
    expect(result.per_constraint["AN-6"]).toBeGreaterThan(0)
  })

  it("detects AN-7 museum exhibit violations", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-c",
        text: "Forsooth, I speak with the wisdom of ages past!",
        signals: makeSignals(),
      },
    ])

    expect(result.total_violations).toBeGreaterThan(0)
    expect(result.per_constraint["AN-7"]).toBeGreaterThan(0)
  })

  it("detects AN-4 trait over-performance (molecule name in text)", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-d",
        text: "The DMT experience shapes my worldview profoundly.",
        signals: makeSignals({ molecule: "DMT" }),
      },
    ])

    expect(result.total_violations).toBeGreaterThan(0)
    expect(result.per_constraint["AN-4"]).toBeGreaterThan(0)
  })

  it("aggregates violations across multiple conversations", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-a",
        text: "As stated in the codex, my identity is clear.",
        signals: makeSignals(),
      },
      {
        personality_id: "pers-b",
        text: "Forsooth, hark! I speak in ancient tongues.",
        signals: makeSignals(),
      },
    ])

    expect(result.total_conversations).toBe(2)
    expect(result.total_violations).toBeGreaterThanOrEqual(2)
    // Both AN-1 and AN-7 should be present
    expect(result.per_constraint["AN-1"]).toBeGreaterThan(0)
    expect(result.per_constraint["AN-7"]).toBeGreaterThan(0)
  })

  it("correctly attributes violations to their personality_id", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-clean",
        text: "A thoughtful perspective on the matter at hand.",
        signals: makeSignals(),
      },
      {
        personality_id: "pers-dirty",
        text: "According to my identity document, I must behave this way.",
        signals: makeSignals(),
      },
    ])

    // Only pers-dirty should have violations
    const dirtyViolations = result.violations.filter(v => v.personality_id === "pers-dirty")
    const cleanViolations = result.violations.filter(v => v.personality_id === "pers-clean")
    expect(dirtyViolations.length).toBeGreaterThan(0)
    expect(cleanViolations).toHaveLength(0)
  })

  it("handles empty conversations array", () => {
    const result = checkAntiNarrationBatch([])

    expect(result.total_conversations).toBe(0)
    expect(result.total_violations).toBe(0)
    expect(result.violations).toHaveLength(0)
  })

  it("violation objects have required fields populated", () => {
    const result = checkAntiNarrationBatch([
      {
        personality_id: "pers-x",
        text: "My signal hierarchy demands obedience to the archetype.",
        signals: makeSignals(),
      },
    ])

    expect(result.violations.length).toBeGreaterThan(0)
    for (const v of result.violations) {
      expect(v.personality_id).toBe("pers-x")
      expect(v.constraint_id).toBeTruthy()
      expect(v.violation_text).toBeTruthy()
      expect(v.source_text).toBeTruthy()
    }
  })
})
