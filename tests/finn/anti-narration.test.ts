// tests/finn/anti-narration.test.ts — Anti-Narration Framework Tests (Sprint 2 Task 2.4)

import { describe, it, expect } from "vitest"
import {
  validateAntiNarration,
  checkAN1,
  checkAN2,
  checkAN3,
  checkAN4,
  checkAN5,
  checkAN6,
  checkAN7,
} from "../../src/nft/anti-narration.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides?: Partial<SignalSnapshot>): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "pythagoras",
    birthday: "1352-06-15",
    era: "medieval",
    molecule: "psilocybin",
    tarot: { name: "The Moon", number: 18, suit: "major", element: "fire" },
    element: "fire",
    swag_rank: "S",
    swag_score: 75,
    sun_sign: "leo",
    moon_sign: "scorpio",
    ascending_sign: "aquarius",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AN-6: Self-Narration Detection (HIGHEST PRIORITY)
// ---------------------------------------------------------------------------

describe("AN-6: Self-Narration Detection", () => {
  const snapshot = makeSnapshot()

  it("catches 'as a freetekno'", () => {
    const text = "I operate as a freetekno in every interaction."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
    expect(violations[0].source_text.toLowerCase()).toContain("as a freetekno")
  })

  it("catches 'as an acidhouse'", () => {
    const text = "Living as an acidhouse spirit."
    const violations = checkAN6(text, makeSnapshot({ archetype: "acidhouse" }))
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
    expect(violations[0].source_text.toLowerCase()).toContain("as an acidhouse")
  })

  it("catches 'as the ancestor'", () => {
    const text = "Channeling wisdom as the ancestor of all knowledge."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
    expect(violations[0].source_text.toLowerCase()).toContain("as the ancestor")
  })

  it("catches 'as a shaman'", () => {
    const text = "Approaching problems as a shaman would."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
  })

  it("catches 'as an oracle'", () => {
    const text = "Speaking as an oracle of truth."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
  })

  it("catches case-insensitive 'As A Freetekno'", () => {
    const text = "Operating As A Freetekno in all dealings."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it("does NOT flag 'as a developer' (generic role)", () => {
    const text = "Working as a developer on this project."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag 'as a helper' (generic role)", () => {
    const text = "Serving as a helper to the team."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("does NOT flag 'as a professional' (generic role)", () => {
    const text = "Behaving as a professional in all interactions."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })

  it("catches specific ancestor name in self-narration", () => {
    const text = "I guide others as the pythagoras of modern thought."
    const s = makeSnapshot({ ancestor: "pythagoras" })
    const violations = checkAN6(text, s)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations[0].constraint_id).toBe("AN-6")
  })

  it("catches multiple violations in the same text", () => {
    const text = "As a freetekno I speak, and as the ancestor I guide."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(2)
  })

  it("returns empty for clean text", () => {
    const text = "This agent approaches problems with curiosity and methodical thinking, drawing on deep cultural roots."
    const violations = checkAN6(text, snapshot)
    expect(violations.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AN-1 through AN-5, AN-7: Scaffold Functions
// ---------------------------------------------------------------------------

describe("AN-1 through AN-5, AN-7: Scaffold Functions", () => {
  const snapshot = makeSnapshot()

  it("AN-1 scaffold returns empty array", () => {
    expect(checkAN1("You are a freetekno entity.", snapshot)).toEqual([])
  })

  it("AN-2 scaffold returns empty array", () => {
    expect(checkAN2("In the medieval tradition...", snapshot)).toEqual([])
  })

  it("AN-3 scaffold returns empty array", () => {
    expect(checkAN3("The psilocybin experience guides us.", snapshot)).toEqual([])
  })

  it("AN-4 scaffold returns empty array", () => {
    expect(checkAN4("As the Oracle speaks...", snapshot)).toEqual([])
  })

  it("AN-5 scaffold returns empty array", () => {
    expect(checkAN5("Being water, flowing freely.", snapshot)).toEqual([])
  })

  it("AN-7 scaffold returns empty array", () => {
    expect(checkAN7("Your Leo sun makes you bold.", snapshot)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// validateAntiNarration (Entry Point)
// ---------------------------------------------------------------------------

describe("validateAntiNarration", () => {
  const snapshot = makeSnapshot()

  it("returns empty array for clean text", () => {
    const text = "A thoughtful agent with deep cultural roots and natural wisdom."
    expect(validateAntiNarration(text, snapshot)).toEqual([])
  })

  it("returns AN-6 violations for self-narration", () => {
    const text = "Operating as a freetekno in every task."
    const violations = validateAntiNarration(text, snapshot)
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations.some(v => v.constraint_id === "AN-6")).toBe(true)
  })

  it("aggregates violations from all checkers", () => {
    // Only AN-6 is active, so we test that path
    const text = "As a sage and as the ancestor, I guide."
    const violations = validateAntiNarration(text, snapshot)
    // Should catch both "as a sage" and "as the ancestor"
    expect(violations.length).toBeGreaterThanOrEqual(2)
  })
})
