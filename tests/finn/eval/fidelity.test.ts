// tests/finn/eval/fidelity.test.ts — Signal Fidelity Scorer Tests (Sprint 12 Task 12.3)

import { describe, it, expect } from "vitest"
import { stripArchetypeLabels, scoreFidelity } from "../../../src/nft/eval/fidelity.js"
import { FakeJudgeProvider } from "../../../src/nft/eval/providers.js"
import type { EvalResponse, EvalPersonality } from "../../../src/nft/eval/harness.js"

// ---------------------------------------------------------------------------
// stripArchetypeLabels — pure function tests
// ---------------------------------------------------------------------------

describe("stripArchetypeLabels", () => {
  it("strips 'freetekno' label (case-insensitive)", () => {
    const text = "As a Freetekno entity, I believe in freedom."
    const result = stripArchetypeLabels(text)
    expect(result).not.toContain("Freetekno")
    expect(result).toContain("[REDACTED]")
  })

  it("strips 'milady' label", () => {
    const text = "The milady archetype values elegance."
    const result = stripArchetypeLabels(text)
    expect(result).not.toContain("milady")
    expect(result).toContain("[REDACTED]")
  })

  it("strips 'chicago_detroit' and 'chicago detroit' variants", () => {
    const text1 = "A chicago_detroit perspective."
    const text2 = "A Chicago Detroit perspective."
    expect(stripArchetypeLabels(text1)).toContain("[REDACTED]")
    expect(stripArchetypeLabels(text2)).toContain("[REDACTED]")
  })

  it("strips 'acidhouse' and 'acid house' variants", () => {
    const text1 = "The acidhouse movement."
    const text2 = "The Acid House scene."
    expect(stripArchetypeLabels(text1)).toContain("[REDACTED]")
    expect(stripArchetypeLabels(text2)).toContain("[REDACTED]")
  })

  it("preserves text without archetype labels", () => {
    const text = "I approach this with careful consideration and empathy."
    expect(stripArchetypeLabels(text)).toBe(text)
  })

  it("strips multiple occurrences in same text", () => {
    const text = "Freetekno and milady represent different worldviews."
    const result = stripArchetypeLabels(text)
    expect(result).not.toContain("Freetekno")
    expect(result).not.toContain("milady")
    // Two redactions
    const redactCount = (result.match(/\[REDACTED\]/g) ?? []).length
    expect(redactCount).toBe(2)
  })

  it("handles empty string", () => {
    expect(stripArchetypeLabels("")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// scoreFidelity — integration tests with FakeJudgeProvider
// ---------------------------------------------------------------------------

describe("scoreFidelity", () => {
  const provider = new FakeJudgeProvider()

  const personalities: EvalPersonality[] = [
    { id: "pers-a", systemPrompt: "You are a philosopher.", archetype: "freetekno" },
    { id: "pers-b", systemPrompt: "You are a trickster.", archetype: "milady" },
    { id: "pers-c", systemPrompt: "You are a builder.", archetype: "chicago_detroit" },
  ]

  function makeResponses(personalityId: string, texts: string[]): EvalResponse[] {
    return texts.map((text, i) => ({
      personality_id: personalityId,
      prompt_id: `p${i}`,
      response_text: text,
      latency_ms: 0,
    }))
  }

  it("returns accuracy between 0 and 1", async () => {
    const responses = [
      ...makeResponses("pers-a", ["Philosopher response one.", "Philosopher response two."]),
      ...makeResponses("pers-b", ["Trickster response one.", "Trickster response two."]),
    ]

    const result = await scoreFidelity(responses, personalities, provider)

    expect(result.overall_accuracy).toBeGreaterThanOrEqual(0)
    expect(result.overall_accuracy).toBeLessThanOrEqual(1)
  })

  it("evaluates correct number of personalities", async () => {
    const responses = [
      ...makeResponses("pers-a", ["Response A"]),
      ...makeResponses("pers-b", ["Response B"]),
      ...makeResponses("pers-c", ["Response C"]),
    ]

    const result = await scoreFidelity(responses, personalities, provider)

    expect(result.total_evaluated).toBe(3)
  })

  it("tracks per_archetype statistics", async () => {
    const responses = [
      ...makeResponses("pers-a", ["Response A"]),
      ...makeResponses("pers-b", ["Response B"]),
    ]

    const result = await scoreFidelity(responses, personalities, provider)

    // All three archetypes should be present in per_archetype
    expect(result.per_archetype).toHaveProperty("freetekno")
    expect(result.per_archetype).toHaveProperty("milady")
    expect(result.per_archetype).toHaveProperty("chicago_detroit")
  })

  it("handles personalities without archetype (skipped)", async () => {
    const noArchPersonalities: EvalPersonality[] = [
      { id: "pers-x", systemPrompt: "You are generic." },
    ]
    const responses = makeResponses("pers-x", ["Generic response."])

    const result = await scoreFidelity(responses, noArchPersonalities, provider)

    expect(result.total_evaluated).toBe(0)
    expect(result.overall_accuracy).toBe(0)
  })

  it("returns 0 accuracy when no archetypes exist", async () => {
    const result = await scoreFidelity([], [], provider)

    expect(result.overall_accuracy).toBe(0)
    expect(result.total_evaluated).toBe(0)
    expect(result.total_correct).toBe(0)
  })

  it("total_correct <= total_evaluated", async () => {
    const responses = [
      ...makeResponses("pers-a", ["Response A here"]),
      ...makeResponses("pers-b", ["Response B here"]),
      ...makeResponses("pers-c", ["Response C here"]),
    ]

    const result = await scoreFidelity(responses, personalities, provider)

    expect(result.total_correct).toBeLessThanOrEqual(result.total_evaluated)
  })

  it("per_archetype accuracy is consistent with correct/total", async () => {
    const responses = [
      ...makeResponses("pers-a", ["Response A"]),
      ...makeResponses("pers-b", ["Response B"]),
    ]

    const result = await scoreFidelity(responses, personalities, provider)

    for (const [, stats] of Object.entries(result.per_archetype)) {
      if (stats.total > 0) {
        expect(stats.accuracy).toBeCloseTo(stats.correct / stats.total, 10)
      }
    }
  })
})
