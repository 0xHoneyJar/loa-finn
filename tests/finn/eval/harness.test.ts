// tests/finn/eval/harness.test.ts — EvalRunner Tests (Sprint 12 Task 12.1)

import { describe, it, expect, vi } from "vitest"
import { EvalRunner, STANDARD_EVAL_PROMPTS } from "../../../src/nft/eval/harness.js"
import { FakeEvalLLMProvider } from "../../../src/nft/eval/providers.js"
import type { EvalPrompt, EvalPersonality } from "../../../src/nft/eval/harness.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_PROMPTS: EvalPrompt[] = [
  { id: "p1", text: "What do you think about art?", category: "general" },
  { id: "p2", text: "Write a short poem.", category: "creative" },
  { id: "p3", text: "Explain causation vs correlation.", category: "analytical" },
]

const TEST_PERSONALITIES: EvalPersonality[] = [
  { id: "pers-a", systemPrompt: "You are a philosopher.", archetype: "freetekno", era: "ancient" },
  { id: "pers-b", systemPrompt: "You are a trickster.", archetype: "milady", era: "contemporary" },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvalRunner", () => {
  it("produces responses for every personality x prompt combination", async () => {
    const runner = new EvalRunner({
      prompts: TEST_PROMPTS,
      personalities: TEST_PERSONALITIES,
      provider: new FakeEvalLLMProvider(),
    })

    const result = await runner.run()

    expect(result.responses).toHaveLength(TEST_PROMPTS.length * TEST_PERSONALITIES.length)
    expect(result.total_prompts).toBe(TEST_PROMPTS.length)
    expect(result.total_personalities).toBe(TEST_PERSONALITIES.length)
  })

  it("correctly attributes personality_id and prompt_id", async () => {
    const runner = new EvalRunner({
      prompts: TEST_PROMPTS,
      personalities: TEST_PERSONALITIES,
      provider: new FakeEvalLLMProvider(),
    })

    const result = await runner.run()

    // First personality should have all prompts
    const persAResponses = result.responses.filter(r => r.personality_id === "pers-a")
    expect(persAResponses).toHaveLength(TEST_PROMPTS.length)
    expect(persAResponses.map(r => r.prompt_id).sort()).toEqual(["p1", "p2", "p3"])
  })

  it("records non-negative latency_ms for each response", async () => {
    const runner = new EvalRunner({
      prompts: TEST_PROMPTS,
      personalities: TEST_PERSONALITIES,
      provider: new FakeEvalLLMProvider(),
    })

    const result = await runner.run()

    for (const r of result.responses) {
      expect(r.latency_ms).toBeGreaterThanOrEqual(0)
    }
  })

  it("tracks timestamps: started_at <= completed_at", async () => {
    const runner = new EvalRunner({
      prompts: TEST_PROMPTS,
      personalities: TEST_PERSONALITIES,
      provider: new FakeEvalLLMProvider(),
    })

    const result = await runner.run()

    expect(result.started_at).toBeLessThanOrEqual(result.completed_at)
  })

  it("reports progress via onProgress callback", async () => {
    const progressCalls: Array<[number, number]> = []
    const runner = new EvalRunner({
      prompts: TEST_PROMPTS,
      personalities: TEST_PERSONALITIES,
      provider: new FakeEvalLLMProvider(),
      onProgress: (completed, total) => progressCalls.push([completed, total]),
    })

    await runner.run()

    const expectedTotal = TEST_PROMPTS.length * TEST_PERSONALITIES.length
    expect(progressCalls).toHaveLength(expectedTotal)
    // First call should be (1, total), last should be (total, total)
    expect(progressCalls[0]).toEqual([1, expectedTotal])
    expect(progressCalls[progressCalls.length - 1]).toEqual([expectedTotal, expectedTotal])
  })

  it("generates non-empty response text from FakeEvalLLMProvider", async () => {
    const runner = new EvalRunner({
      prompts: TEST_PROMPTS,
      personalities: TEST_PERSONALITIES,
      provider: new FakeEvalLLMProvider(),
    })

    const result = await runner.run()

    for (const r of result.responses) {
      expect(r.response_text.length).toBeGreaterThan(0)
    }
  })

  it("handles empty prompts array", async () => {
    const runner = new EvalRunner({
      prompts: [],
      personalities: TEST_PERSONALITIES,
      provider: new FakeEvalLLMProvider(),
    })

    const result = await runner.run()

    expect(result.responses).toHaveLength(0)
    expect(result.total_prompts).toBe(0)
  })

  it("handles empty personalities array", async () => {
    const runner = new EvalRunner({
      prompts: TEST_PROMPTS,
      personalities: [],
      provider: new FakeEvalLLMProvider(),
    })

    const result = await runner.run()

    expect(result.responses).toHaveLength(0)
    expect(result.total_personalities).toBe(0)
  })
})

describe("STANDARD_EVAL_PROMPTS", () => {
  it("contains exactly 50 prompts", () => {
    expect(STANDARD_EVAL_PROMPTS).toHaveLength(50)
  })

  it("has unique IDs", () => {
    const ids = STANDARD_EVAL_PROMPTS.map(p => p.id)
    expect(new Set(ids).size).toBe(50)
  })

  it("covers all 5 categories with 10 each", () => {
    const categories = new Map<string, number>()
    for (const p of STANDARD_EVAL_PROMPTS) {
      categories.set(p.category, (categories.get(p.category) ?? 0) + 1)
    }
    expect(categories.size).toBe(5)
    for (const [, count] of categories) {
      expect(count).toBe(10)
    }
  })

  it("includes general, creative, analytical, ethical, domain categories", () => {
    const categories = new Set(STANDARD_EVAL_PROMPTS.map(p => p.category))
    expect(categories).toContain("general")
    expect(categories).toContain("creative")
    expect(categories).toContain("analytical")
    expect(categories).toContain("ethical")
    expect(categories).toContain("domain")
  })

  it("all prompts have non-empty text", () => {
    for (const p of STANDARD_EVAL_PROMPTS) {
      expect(p.text.length).toBeGreaterThan(10)
    }
  })
})
