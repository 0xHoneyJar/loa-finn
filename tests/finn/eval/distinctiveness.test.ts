// tests/finn/eval/distinctiveness.test.ts — Distinctiveness Scorer Tests (Sprint 12 Task 12.2)

import { describe, it, expect } from "vitest"
import { cosineSimilarity, scoreDistinctiveness } from "../../../src/nft/eval/distinctiveness.js"
import { FakeEmbeddingProvider } from "../../../src/nft/eval/providers.js"
import type { EvalResponse } from "../../../src/nft/eval/harness.js"

// ---------------------------------------------------------------------------
// cosineSimilarity — pure function tests
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10)
  })

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0, 0]
    const b = [-1, 0, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10)
  })

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10)
  })

  it("returns 0 for zero-magnitude vector", () => {
    const a = [0, 0, 0]
    const b = [1, 2, 3]
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("Vector length mismatch")
  })

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it("handles normalized unit vectors correctly", () => {
    const a = [1 / Math.sqrt(2), 1 / Math.sqrt(2)]
    const b = [1, 0]
    // cos(45deg) = 1/sqrt(2) ≈ 0.7071
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 5)
  })

  it("is commutative: sim(a,b) === sim(b,a)", () => {
    const a = [3, 7, 2, 9]
    const b = [1, 4, 6, 8]
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10)
  })
})

// ---------------------------------------------------------------------------
// scoreDistinctiveness — integration tests with FakeEmbeddingProvider
// ---------------------------------------------------------------------------

describe("scoreDistinctiveness", () => {
  const provider = new FakeEmbeddingProvider()

  function makeResponses(personalityIds: string[], responseTexts: string[][]): EvalResponse[] {
    const responses: EvalResponse[] = []
    for (let i = 0; i < personalityIds.length; i++) {
      for (let j = 0; j < responseTexts[i].length; j++) {
        responses.push({
          personality_id: personalityIds[i],
          prompt_id: `p${j}`,
          response_text: responseTexts[i][j],
          latency_ms: 0,
        })
      }
    }
    return responses
  }

  it("returns zero pairs for a single personality", async () => {
    const responses = makeResponses(["pers-a"], [["Hello world"]])
    const result = await scoreDistinctiveness(responses, provider)

    expect(result.pairs_evaluated).toBe(0)
    expect(result.mean_similarity).toBe(0)
    expect(result.per_pair).toHaveLength(0)
  })

  it("returns one pair for two personalities", async () => {
    const responses = makeResponses(
      ["pers-a", "pers-b"],
      [["Response A text here"], ["Response B different text"]],
    )
    const result = await scoreDistinctiveness(responses, provider)

    expect(result.pairs_evaluated).toBe(1)
    expect(result.per_pair).toHaveLength(1)
    expect(result.per_pair[0].personality_a).toBe("pers-a")
    expect(result.per_pair[0].personality_b).toBe("pers-b")
  })

  it("computes n*(n-1)/2 pairs for n personalities", async () => {
    const responses = makeResponses(
      ["a", "b", "c", "d"],
      [["text a"], ["text b"], ["text c"], ["text d"]],
    )
    const result = await scoreDistinctiveness(responses, provider)

    // 4 choose 2 = 6 pairs
    expect(result.pairs_evaluated).toBe(6)
    expect(result.per_pair).toHaveLength(6)
  })

  it("respects maxPairs limit", async () => {
    const responses = makeResponses(
      ["a", "b", "c", "d"],
      [["text a"], ["text b"], ["text c"], ["text d"]],
    )
    const result = await scoreDistinctiveness(responses, provider, 3)

    expect(result.pairs_evaluated).toBe(3)
    expect(result.per_pair).toHaveLength(3)
  })

  it("similarity values are bounded between -1 and 1", async () => {
    const responses = makeResponses(
      ["pers-a", "pers-b"],
      [
        ["Short response", "Another short one"],
        ["A very different and much longer response with many words in it"],
      ],
    )
    const result = await scoreDistinctiveness(responses, provider)

    for (const pair of result.per_pair) {
      expect(pair.similarity).toBeGreaterThanOrEqual(-1)
      expect(pair.similarity).toBeLessThanOrEqual(1)
    }
  })

  it("min <= mean <= max similarity", async () => {
    const responses = makeResponses(
      ["a", "b", "c"],
      [["text aaa"], ["text bbbbb"], ["text ccccccccc"]],
    )
    const result = await scoreDistinctiveness(responses, provider)

    expect(result.min_similarity).toBeLessThanOrEqual(result.mean_similarity)
    expect(result.mean_similarity).toBeLessThanOrEqual(result.max_similarity)
  })

  it("returns empty result for no responses", async () => {
    const result = await scoreDistinctiveness([], provider)

    expect(result.pairs_evaluated).toBe(0)
    expect(result.per_pair).toHaveLength(0)
  })
})
