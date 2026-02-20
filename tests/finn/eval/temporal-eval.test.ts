// tests/finn/eval/temporal-eval.test.ts — Temporal Consistency Tests (Sprint 12 Task 12.5)

import { describe, it, expect } from "vitest"
import { scoreTemporalConsistency } from "../../../src/nft/eval/temporal-eval.js"
import type { Era } from "../../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scoreTemporalConsistency", () => {
  it("returns 100% compliance for clean texts", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-a",
        text: "The temple fires burn brightly under the stars tonight.",
        era: "ancient" as Era,
      },
      {
        personality_id: "pers-b",
        text: "The guild forge rings with the sound of hammers on steel.",
        era: "medieval" as Era,
      },
    ])

    expect(result.compliance_rate).toBe(1)
    expect(result.total_compliant).toBe(2)
    expect(result.total_evaluated).toBe(2)
  })

  it("detects anachronistic terms in ancient era", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-a",
        text: "Let me check the algorithm to process this digital data through the CPU.",
        era: "ancient" as Era,
      },
    ])

    expect(result.compliance_rate).toBe(0)
    expect(result.total_compliant).toBe(0)
    expect(result.total_evaluated).toBe(1)
    expect(result.per_era.ancient.compliant).toBe(0)
    expect(result.per_era.ancient.total).toBe(1)
  })

  it("detects anachronistic terms in medieval era", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-b",
        text: "I posted it on social media and got many followers from my smartphone selfie.",
        era: "medieval" as Era,
      },
    ])

    expect(result.compliance_rate).toBe(0)
    expect(result.per_era.medieval.compliance_rate).toBe(0)
  })

  it("contemporary era is unrestricted (always compliant)", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-c",
        text: "I used the algorithm on my smartphone to check the blockchain and stream AI content.",
        era: "contemporary" as Era,
      },
    ])

    expect(result.compliance_rate).toBe(1)
    expect(result.per_era.contemporary.compliant).toBe(1)
    expect(result.per_era.contemporary.compliance_rate).toBe(1)
  })

  it("computes per-era breakdown correctly with mixed results", () => {
    const result = scoreTemporalConsistency([
      // Ancient: clean
      {
        personality_id: "pers-a",
        text: "The river flows past the stone temple at dawn.",
        era: "ancient" as Era,
      },
      // Ancient: violation (digital term)
      {
        personality_id: "pers-b",
        text: "Let me upload this to the internet for download.",
        era: "ancient" as Era,
      },
      // Medieval: clean
      {
        personality_id: "pers-c",
        text: "The knight rode through the castle gates at sunrise.",
        era: "medieval" as Era,
      },
    ])

    expect(result.total_evaluated).toBe(3)
    expect(result.total_compliant).toBe(2)
    expect(result.compliance_rate).toBeCloseTo(2 / 3, 5)

    // Ancient: 1 of 2 compliant
    expect(result.per_era.ancient.total).toBe(2)
    expect(result.per_era.ancient.compliant).toBe(1)
    expect(result.per_era.ancient.compliance_rate).toBeCloseTo(0.5, 5)

    // Medieval: 1 of 1 compliant
    expect(result.per_era.medieval.total).toBe(1)
    expect(result.per_era.medieval.compliant).toBe(1)
    expect(result.per_era.medieval.compliance_rate).toBe(1)
  })

  it("initializes all 5 eras in per_era even if not all present in input", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-a",
        text: "Simple text.",
        era: "ancient" as Era,
      },
    ])

    const allEras: Era[] = ["ancient", "medieval", "early_modern", "modern", "contemporary"]
    for (const era of allEras) {
      expect(result.per_era[era]).toBeDefined()
      expect(result.per_era[era].total).toBeGreaterThanOrEqual(0)
    }
  })

  it("eras with no entries have compliance_rate of 1 (vacuous truth)", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-a",
        text: "Simple text.",
        era: "ancient" as Era,
      },
    ])

    // Medieval has no entries, so compliance_rate should be 1
    expect(result.per_era.medieval.total).toBe(0)
    expect(result.per_era.medieval.compliance_rate).toBe(1)
  })

  it("handles empty input", () => {
    const result = scoreTemporalConsistency([])

    expect(result.compliance_rate).toBe(1)
    expect(result.total_evaluated).toBe(0)
    expect(result.total_compliant).toBe(0)
  })

  it("modern era forbids internet/smartphone terms", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-d",
        text: "I browsed the internet on my smartphone and checked email online.",
        era: "modern" as Era,
      },
    ])

    expect(result.compliance_rate).toBe(0)
    expect(result.per_era.modern.compliant).toBe(0)
  })

  it("early_modern era forbids digital technology terms", () => {
    const result = scoreTemporalConsistency([
      {
        personality_id: "pers-e",
        text: "The blockchain and cryptocurrency revolutionized the digital landscape.",
        era: "early_modern" as Era,
      },
    ])

    expect(result.compliance_rate).toBe(0)
    expect(result.per_era.early_modern.compliant).toBe(0)
  })

  it("all-compliant run has compliance_rate of 1", () => {
    const result = scoreTemporalConsistency([
      { personality_id: "a", text: "Stone and fire and rivers.", era: "ancient" as Era },
      { personality_id: "b", text: "Castle and guild and forge.", era: "medieval" as Era },
      { personality_id: "c", text: "Compass and merchant.", era: "early_modern" as Era },
      { personality_id: "d", text: "Telegraph and railroad.", era: "modern" as Era },
      { personality_id: "e", text: "Everything is allowed.", era: "contemporary" as Era },
    ])

    expect(result.compliance_rate).toBe(1)
    expect(result.total_compliant).toBe(5)
  })
})
