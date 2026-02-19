// tests/finn/eval/dapm-eval.test.ts — dAPM Behavioral Distinctiveness Tests (Sprint 13 Task 13.1)

import { describe, it, expect } from "vitest"
import {
  welchTTest,
  scoreDAPMDistinctiveness,
  extractBehavioralFeatures,
  DAPM_DIMENSION_PREFIXES,
} from "../../../src/nft/eval/dapm-eval.js"
import type { DAPMEvalConfig } from "../../../src/nft/eval/dapm-eval.js"
import type { DAPMFingerprint, DAPMDialId } from "../../../src/nft/signal-types.js"
import { DAPM_DIAL_IDS } from "../../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DAPMFingerprint for testing */
function makeFakeFingerprint(baseValue: number = 0.5): DAPMFingerprint {
  const dials = {} as Record<DAPMDialId, number>
  for (const id of DAPM_DIAL_IDS) {
    dials[id] = baseValue
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-codex-sha",
    derived_at: Date.now(),
  }
}

/**
 * Generate deterministic but varied response texts for a given personality style.
 * "warm" style uses warm/social language, "cold" style uses analytical/formal language.
 */
function generateWarmResponses(count: number): Array<{ personality_id: string; response_text: string }> {
  const responses: Array<{ personality_id: string; response_text: string }> = []
  const warmPhrases = [
    "I love sharing ideas with friends and building community together. We care about each other deeply and embrace our differences with kindness and warmth.",
    "Welcome! Let me share something beautiful with you. Together we can create joy and comfort in our community. I feel grateful for our friendship.",
    "My dear friend, I think the most important thing is caring for one another. Love and compassion guide our shared journey together.",
    "We should embrace everyone with open arms and gentle hearts. Sharing our stories brings us together with warmth and affection.",
    "I find beauty in our connections. Friends, let us share this wonderful moment of joy and kindness together. I love our community!",
    "Together, our hearts create something beautiful. I care deeply about sharing warmth and compassion with everyone around us.",
    "My friends, let us celebrate our shared love and embrace the gentle warmth of community. We are kind and generous together.",
    "I think sharing kindness and warmth makes our community stronger. We embrace each other with love and open hearts.",
    "Welcome to our gentle gathering where friends share joy and comfort. Together we build something beautiful with love.",
    "I love how our community embraces everyone with warmth. We share kindness, compassion, and joy with our dear friends.",
    "Our hearts are full of love and gratitude. Let us share warmth and embrace the beauty of friendship together, dear ones.",
    "I care deeply about our shared warmth. Friends, together we create joy and spread kindness with gentle hearts.",
  ]
  for (let i = 0; i < count; i++) {
    responses.push({
      personality_id: "warm-personality",
      response_text: warmPhrases[i % warmPhrases.length],
    })
  }
  return responses
}

function generateColdResponses(count: number): Array<{ personality_id: string; response_text: string }> {
  const responses: Array<{ personality_id: string; response_text: string }> = []
  const coldPhrases = [
    "The systematic analysis reveals several interdependent variables. Consequently, the evidence threshold suggests a comprehensive review is necessary. Furthermore, the methodology requires scrutiny.",
    "Therefore, one must evaluate the underlying assumptions. Notwithstanding the preliminary data, the causal mechanisms remain insufficiently characterized. Moreover, additional verification is warranted.",
    "The analytical framework indicates multiple confounding factors. Subsequently, a rigorous assessment of the empirical evidence is required. Nevertheless, the preliminary conclusions merit consideration.",
    "Consequently, the systematic evaluation demonstrates clear methodological constraints. Furthermore, the epistemic foundations require careful examination. The evidence nonetheless suggests progress.",
    "Therefore, a comprehensive analysis of the structural parameters is necessary. Notwithstanding the theoretical framework, empirical validation remains incomplete. Moreover, the data requires replication.",
    "The methodological rigor of this analysis necessitates careful consideration. Consequently, the systematic review reveals important structural dependencies. Furthermore, replication is essential.",
    "Subsequently, the analytical evaluation demonstrates several critical constraints. Therefore, the evidence base requires expansion. Nevertheless, the preliminary framework provides adequate foundations.",
    "One must therefore examine the causal architecture with precision. Notwithstanding the complexity, systematic decomposition reveals tractable components. Furthermore, the methodology is sound.",
    "The empirical analysis consequently reveals structural patterns. Moreover, the systematic evaluation necessitates rigorous methodology. Nevertheless, preliminary results warrant cautious optimism.",
    "Therefore, the evidence threshold demands comprehensive verification. Subsequently, the analytical framework requires calibration. Notwithstanding the constraints, the methodology remains robust.",
    "Consequently, the systematic assessment reveals critical dependencies. Furthermore, empirical analysis demonstrates the necessity of methodological precision. The framework nevertheless provides clarity.",
    "The rigorous analysis therefore indicates structural complexity. Moreover, systematic evaluation of the causal mechanisms is consequently necessary. Notwithstanding limitations, progress is evident.",
  ]
  for (let i = 0; i < count; i++) {
    responses.push({
      personality_id: "cold-personality",
      response_text: coldPhrases[i % coldPhrases.length],
    })
  }
  return responses
}

function generateSameStyleResponses(
  personalityId: string,
  count: number,
): Array<{ personality_id: string; response_text: string }> {
  const responses: Array<{ personality_id: string; response_text: string }> = []
  const phrases = [
    "I approach this topic with careful consideration. There are many perspectives to evaluate and the nuances matter in every context.",
    "Let me think about this carefully. The situation requires balanced analysis and thoughtful consideration of multiple viewpoints.",
    "This is an interesting question. I would approach it with careful consideration, evaluating the different perspectives and nuances.",
    "I think careful consideration is key here. The many perspectives deserve thoughtful analysis and balanced evaluation.",
    "The nuances of this topic require careful thought. I would evaluate multiple perspectives with balanced consideration.",
    "With careful consideration, I think there are many important perspectives here. The nuances matter and deserve balanced evaluation.",
    "I believe this requires thoughtful analysis. The multiple perspectives and nuances deserve careful and balanced consideration.",
    "Let me consider this carefully. The topic has many perspectives that require thoughtful and balanced evaluation of the nuances.",
    "Careful consideration reveals many perspectives worth evaluating. The nuances of this topic deserve thoughtful and balanced analysis.",
    "I would approach this with balanced consideration. The nuances and multiple perspectives here deserve careful, thoughtful evaluation.",
    "Thoughtful analysis of this topic reveals multiple perspectives. With careful consideration, the nuances become clearer and more balanced.",
    "The many perspectives on this topic merit careful consideration. Balanced evaluation of the nuances leads to thoughtful understanding.",
  ]
  for (let i = 0; i < count; i++) {
    responses.push({
      personality_id: personalityId,
      response_text: phrases[i % phrases.length],
    })
  }
  return responses
}

// ---------------------------------------------------------------------------
// Tests: welchTTest
// ---------------------------------------------------------------------------

describe("welchTTest", () => {
  it("computes correct t-statistic for known distributions", () => {
    // Two clearly different distributions
    const a = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    const b = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]

    const result = welchTTest(a, b)

    // t-statistic should be strongly negative (a < b)
    expect(result.t).toBeLessThan(-5)
    // p-value should be very small (highly significant)
    expect(result.p).toBeLessThan(0.001)
  })

  it("returns p close to 1 for identical distributions", () => {
    const a = [5, 5, 5, 5, 5]
    const b = [5, 5, 5, 5, 5]

    const result = welchTTest(a, b)

    // t should be 0 and p should be 1 (no difference)
    expect(result.t).toBe(0)
    expect(result.p).toBe(1)
  })

  it("returns p=1 for samples with fewer than 2 values", () => {
    const result1 = welchTTest([1], [2, 3, 4])
    expect(result1.p).toBe(1)

    const result2 = welchTTest([], [2, 3, 4])
    expect(result2.p).toBe(1)
  })

  it("detects significance between overlapping but different distributions", () => {
    // Overlapping but shifted distributions
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const b = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

    const result = welchTTest(a, b)
    expect(result.p).toBeLessThan(0.05)
  })

  it("does not detect significance for very similar distributions", () => {
    // Very similar distributions with high variance
    const a = [1, 10, 2, 9, 3, 8, 4, 7, 5, 6]
    const b = [2, 9, 3, 8, 4, 7, 5, 6, 1, 10]

    const result = welchTTest(a, b)
    expect(result.p).toBeGreaterThan(0.05)
  })

  it("p-value is symmetric (swapping a and b gives same p)", () => {
    const a = [1, 2, 3, 4, 5]
    const b = [6, 7, 8, 9, 10]

    const resultAB = welchTTest(a, b)
    const resultBA = welchTTest(b, a)

    expect(resultAB.p).toBeCloseTo(resultBA.p, 10)
    // t-statistics should be negatives of each other
    expect(resultAB.t).toBeCloseTo(-resultBA.t, 10)
  })
})

// ---------------------------------------------------------------------------
// Tests: extractBehavioralFeatures
// ---------------------------------------------------------------------------

describe("extractBehavioralFeatures", () => {
  it("returns all 12 dimension prefixes", () => {
    const features = extractBehavioralFeatures("Hello world, this is a test.")
    for (const prefix of DAPM_DIMENSION_PREFIXES) {
      expect(features).toHaveProperty(prefix)
      expect(typeof features[prefix]).toBe("number")
    }
  })

  it("returns values in [0, 1] range", () => {
    const features = extractBehavioralFeatures(
      "A wonderful and beautiful day filled with joy! I love sharing warmth with my dear friends and community.",
    )
    for (const prefix of DAPM_DIMENSION_PREFIXES) {
      expect(features[prefix]).toBeGreaterThanOrEqual(0)
      expect(features[prefix]).toBeLessThanOrEqual(1)
    }
  })

  it("warm text scores higher on sw (Social Warmth) than cold text", () => {
    const warmFeatures = extractBehavioralFeatures(
      "I love sharing with friends! Welcome everyone, let us embrace warmth and kindness together. We care deeply about our community.",
    )
    const coldFeatures = extractBehavioralFeatures(
      "The systematic analysis reveals interdependent variables. Consequently, the evidence threshold demands comprehensive verification. Furthermore, the methodology requires scrutiny.",
    )
    expect(warmFeatures.sw).toBeGreaterThan(coldFeatures.sw)
  })

  it("formal text scores higher on ep (Epistemic) than casual text", () => {
    const formalFeatures = extractBehavioralFeatures(
      "Perhaps this is debatable, and it is arguable that the uncertainty remains. Maybe the evidence is unclear and tentative at best.",
    )
    const casualFeatures = extractBehavioralFeatures(
      "Yeah I think this is great! Love it. Super cool stuff happening here with the team.",
    )
    expect(formalFeatures.ep).toBeGreaterThan(casualFeatures.ep)
  })

  it("handles empty string without errors", () => {
    const features = extractBehavioralFeatures("")
    for (const prefix of DAPM_DIMENSION_PREFIXES) {
      expect(typeof features[prefix]).toBe("number")
      expect(isNaN(features[prefix])).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: scoreDAPMDistinctiveness
// ---------------------------------------------------------------------------

describe("scoreDAPMDistinctiveness", () => {
  it("responses from different personalities produce significant differences", () => {
    const warmResponses = generateWarmResponses(12)
    const coldResponses = generateColdResponses(12)
    const allResponses = [...warmResponses, ...coldResponses]

    const config: DAPMEvalConfig = {
      fingerprints: new Map([
        ["warm-personality", makeFakeFingerprint(0.8)],
        ["cold-personality", makeFakeFingerprint(0.2)],
      ]),
      minSamplesPerPersonality: 10,
    }

    const result = scoreDAPMDistinctiveness(allResponses, config)

    expect(result.total_pairs).toBe(1)
    expect(result.per_pair).toHaveLength(1)

    // Expect at least some significant dimensions
    const pair = result.per_pair[0]
    expect(pair.personality_a).toBe("cold-personality")
    expect(pair.personality_b).toBe("warm-personality")
    expect(pair.significant_count).toBeGreaterThan(0)
    expect(pair.dimensions).toHaveLength(DAPM_DIMENSION_PREFIXES.length)
  })

  it("responses from same personality show no significant difference", () => {
    const responsesA = generateSameStyleResponses("personality-a", 12)
    const responsesB = generateSameStyleResponses("personality-b", 12)
    const allResponses = [...responsesA, ...responsesB]

    const config: DAPMEvalConfig = {
      fingerprints: new Map([
        ["personality-a", makeFakeFingerprint(0.5)],
        ["personality-b", makeFakeFingerprint(0.5)],
      ]),
      minSamplesPerPersonality: 10,
    }

    const result = scoreDAPMDistinctiveness(allResponses, config)

    expect(result.total_pairs).toBe(1)
    const pair = result.per_pair[0]
    // Same-style responses should have few or no significant differences
    expect(pair.significant_count).toBeLessThanOrEqual(2)
  })

  it("reports correct number of significant dimensions", () => {
    const warmResponses = generateWarmResponses(12)
    const coldResponses = generateColdResponses(12)

    const config: DAPMEvalConfig = {
      fingerprints: new Map([
        ["warm-personality", makeFakeFingerprint(0.8)],
        ["cold-personality", makeFakeFingerprint(0.2)],
      ]),
      minSamplesPerPersonality: 10,
    }

    const result = scoreDAPMDistinctiveness([...warmResponses, ...coldResponses], config)

    // Verify dimensions_with_significant_difference matches per_pair max
    const maxSig = Math.max(...result.per_pair.map(p => p.significant_count))
    expect(result.dimensions_with_significant_difference).toBe(maxSig)

    // Each dimension result should have valid p_value
    for (const pair of result.per_pair) {
      for (const dim of pair.dimensions) {
        expect(dim.p_value).toBeGreaterThanOrEqual(0)
        expect(dim.p_value).toBeLessThanOrEqual(1)
        expect(dim.significant).toBe(dim.p_value < 0.05)
      }
    }
  })

  it("target_met is true when >= 5 dimensions differ", () => {
    const warmResponses = generateWarmResponses(12)
    const coldResponses = generateColdResponses(12)

    const config: DAPMEvalConfig = {
      fingerprints: new Map([
        ["warm-personality", makeFakeFingerprint(0.8)],
        ["cold-personality", makeFakeFingerprint(0.2)],
      ]),
      minSamplesPerPersonality: 10,
    }

    const result = scoreDAPMDistinctiveness([...warmResponses, ...coldResponses], config)

    // The warm vs cold texts should differ on enough dimensions
    if (result.dimensions_with_significant_difference >= 5) {
      expect(result.target_met).toBe(true)
    } else {
      expect(result.target_met).toBe(false)
    }
    // Verify target_met is correctly computed
    expect(result.target_met).toBe(result.dimensions_with_significant_difference >= 5)
  })

  it("skips personalities with insufficient samples", () => {
    const fewResponses: Array<{ personality_id: string; response_text: string }> = [
      { personality_id: "few-samples", response_text: "Just one response." },
    ]
    const enoughResponses = generateWarmResponses(12)

    const config: DAPMEvalConfig = {
      fingerprints: new Map([
        ["few-samples", makeFakeFingerprint(0.5)],
        ["warm-personality", makeFakeFingerprint(0.8)],
      ]),
      minSamplesPerPersonality: 10,
    }

    const result = scoreDAPMDistinctiveness([...fewResponses, ...enoughResponses], config)

    // Only one personality has enough samples, so no pairs can be formed
    expect(result.total_pairs).toBe(0)
    expect(result.per_pair).toHaveLength(0)
    expect(result.target_met).toBe(false)
  })

  it("handles empty responses gracefully", () => {
    const config: DAPMEvalConfig = {
      fingerprints: new Map([
        ["p1", makeFakeFingerprint(0.5)],
      ]),
      minSamplesPerPersonality: 10,
    }

    const result = scoreDAPMDistinctiveness([], config)

    expect(result.total_pairs).toBe(0)
    expect(result.per_pair).toHaveLength(0)
    expect(result.target_met).toBe(false)
  })
})
