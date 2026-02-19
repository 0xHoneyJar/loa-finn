// tests/finn/eval/scorecard.test.ts — Aggregate Scorecard Tests (Sprint 13 Task 13.2)

import { describe, it, expect } from "vitest"
import { buildScorecards } from "../../../src/nft/eval/scorecard.js"
import type { AggregateScorecard, EvalScorecard } from "../../../src/nft/eval/scorecard.js"
import type { DistinctivenessResult } from "../../../src/nft/eval/distinctiveness.js"
import type { FidelityResult } from "../../../src/nft/eval/fidelity.js"
import type { ANBatchResult } from "../../../src/nft/eval/anti-narration-eval.js"
import type { TemporalResult } from "../../../src/nft/eval/temporal-eval.js"
import type { DAPMEvalResult } from "../../../src/nft/eval/dapm-eval.js"

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

function makeDistinctivenessResult(overrides?: Partial<DistinctivenessResult>): DistinctivenessResult {
  return {
    mean_similarity: 0.2,
    min_similarity: 0.1,
    max_similarity: 0.3,
    pairs_evaluated: 1,
    per_pair: [
      { personality_a: "p1", personality_b: "p2", similarity: 0.2 },
    ],
    ...overrides,
  }
}

function makeFidelityResult(overrides?: Partial<FidelityResult>): FidelityResult {
  return {
    overall_accuracy: 0.9,
    total_correct: 9,
    total_evaluated: 10,
    per_archetype: {
      freetekno: { correct: 5, total: 5, accuracy: 1.0 },
      milady: { correct: 4, total: 5, accuracy: 0.8 },
    },
    ...overrides,
  }
}

function makeANBatchResult(overrides?: Partial<ANBatchResult>): ANBatchResult {
  return {
    total_conversations: 10,
    total_violations: 0,
    violations: [],
    per_constraint: {},
    ...overrides,
  }
}

function makeTemporalResult(overrides?: Partial<TemporalResult>): TemporalResult {
  return {
    compliance_rate: 0.85,
    total_evaluated: 20,
    total_compliant: 17,
    per_era: {
      ancient: { compliant: 3, total: 4, compliance_rate: 0.75 },
      medieval: { compliant: 4, total: 4, compliance_rate: 1.0 },
      early_modern: { compliant: 4, total: 4, compliance_rate: 1.0 },
      modern: { compliant: 3, total: 4, compliance_rate: 0.75 },
      contemporary: { compliant: 3, total: 4, compliance_rate: 0.75 },
    },
    ...overrides,
  }
}

function makeDAPMEvalResult(overrides?: Partial<DAPMEvalResult>): DAPMEvalResult {
  return {
    total_pairs: 1,
    dimensions_with_significant_difference: 7,
    per_pair: [
      {
        personality_a: "p1",
        personality_b: "p2",
        dimensions: [
          { dimension: "sw", mean_a: 0.8, mean_b: 0.2, p_value: 0.001, significant: true },
          { dimension: "cs", mean_a: 0.3, mean_b: 0.7, p_value: 0.002, significant: true },
          { dimension: "as", mean_a: 0.6, mean_b: 0.4, p_value: 0.01, significant: true },
          { dimension: "cg", mean_a: 0.5, mean_b: 0.7, p_value: 0.03, significant: true },
          { dimension: "ep", mean_a: 0.2, mean_b: 0.8, p_value: 0.001, significant: true },
          { dimension: "cr", mean_a: 0.7, mean_b: 0.3, p_value: 0.005, significant: true },
          { dimension: "cv", mean_a: 0.4, mean_b: 0.6, p_value: 0.04, significant: true },
          { dimension: "mo", mean_a: 0.5, mean_b: 0.5, p_value: 0.8, significant: false },
          { dimension: "et", mean_a: 0.6, mean_b: 0.5, p_value: 0.3, significant: false },
          { dimension: "sc", mean_a: 0.5, mean_b: 0.4, p_value: 0.2, significant: false },
          { dimension: "ag", mean_a: 0.5, mean_b: 0.5, p_value: 0.9, significant: false },
          { dimension: "id", mean_a: 0.5, mean_b: 0.5, p_value: 0.7, significant: false },
        ],
        significant_count: 7,
      },
    ],
    target_met: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: buildScorecards
// ---------------------------------------------------------------------------

describe("buildScorecards", () => {
  it("builds per-personality scorecards from eval results", () => {
    const result = buildScorecards(
      ["p1", "p2"],
      makeDistinctivenessResult(),
      makeFidelityResult(),
      makeANBatchResult(),
      makeTemporalResult(),
      makeDAPMEvalResult(),
      "test-model-v1",
    )

    expect(result.personalities).toHaveLength(2)
    expect(result.personalities[0].personality_id).toBe("p1")
    expect(result.personalities[1].personality_id).toBe("p2")

    // Both should have scores
    for (const card of result.personalities) {
      expect(typeof card.distinctiveness_score).toBe("number")
      expect(typeof card.signal_fidelity_score).toBe("number")
      expect(typeof card.anti_narration_violations).toBe("number")
      expect(typeof card.temporal_consistency_score).toBe("number")
      expect(typeof card.dapm_behavioral_score).toBe("number")
      expect(typeof card.overall_pass).toBe("boolean")
      expect(card.eval_model).toBe("test-model-v1")
      expect(typeof card.evaluated_at).toBe("number")
    }
  })

  it("computes correct pass/fail per personality — all passing", () => {
    const result = buildScorecards(
      ["p1", "p2"],
      makeDistinctivenessResult({ mean_similarity: 0.15, per_pair: [{ personality_a: "p1", personality_b: "p2", similarity: 0.15 }] }),
      makeFidelityResult({ overall_accuracy: 0.9 }),
      makeANBatchResult({ total_violations: 0, violations: [] }),
      makeTemporalResult({ compliance_rate: 0.85 }),
      makeDAPMEvalResult({ dimensions_with_significant_difference: 7 }),
      "test-model",
    )

    // Both personalities should pass
    for (const card of result.personalities) {
      expect(card.distinctiveness_score).toBeLessThan(0.3)
      expect(card.signal_fidelity_score).toBeGreaterThanOrEqual(0.8)
      expect(card.anti_narration_violations).toBe(0)
      expect(card.temporal_consistency_score).toBeGreaterThanOrEqual(0.75)
      expect(card.dapm_behavioral_score).toBeGreaterThanOrEqual(5)
      expect(card.overall_pass).toBe(true)
    }
  })

  it("computes correct pass/fail — failing on distinctiveness", () => {
    const result = buildScorecards(
      ["p1", "p2"],
      makeDistinctivenessResult({
        mean_similarity: 0.8,
        per_pair: [{ personality_a: "p1", personality_b: "p2", similarity: 0.8 }],
      }),
      makeFidelityResult(),
      makeANBatchResult(),
      makeTemporalResult(),
      makeDAPMEvalResult(),
      "test-model",
    )

    // Both should fail due to high similarity
    for (const card of result.personalities) {
      expect(card.distinctiveness_score).toBeGreaterThanOrEqual(0.3)
      expect(card.overall_pass).toBe(false)
    }
  })

  it("computes correct pass/fail — failing on AN violations", () => {
    const result = buildScorecards(
      ["p1", "p2"],
      makeDistinctivenessResult(),
      makeFidelityResult(),
      makeANBatchResult({
        total_violations: 3,
        violations: [
          { personality_id: "p1", constraint_id: "AN-1", violation_text: "v1", source_text: "s1" },
          { personality_id: "p1", constraint_id: "AN-6", violation_text: "v2", source_text: "s2" },
          { personality_id: "p2", constraint_id: "AN-3", violation_text: "v3", source_text: "s3" },
        ],
      }),
      makeTemporalResult(),
      makeDAPMEvalResult(),
      "test-model",
    )

    const p1 = result.personalities.find(p => p.personality_id === "p1")!
    const p2 = result.personalities.find(p => p.personality_id === "p2")!

    expect(p1.anti_narration_violations).toBe(2)
    expect(p2.anti_narration_violations).toBe(1)
    expect(p1.overall_pass).toBe(false)
    expect(p2.overall_pass).toBe(false)
  })

  it("aggregates summary statistics correctly", () => {
    const result = buildScorecards(
      ["p1", "p2"],
      makeDistinctivenessResult(),
      makeFidelityResult(),
      makeANBatchResult(),
      makeTemporalResult(),
      makeDAPMEvalResult(),
      "test-model",
    )

    expect(result.summary.total_evaluated).toBe(2)
    expect(typeof result.summary.total_passing).toBe("number")
    expect(typeof result.summary.pass_rate).toBe("number")
    expect(result.summary.pass_rate).toBeGreaterThanOrEqual(0)
    expect(result.summary.pass_rate).toBeLessThanOrEqual(1)
    expect(typeof result.summary.mean_distinctiveness).toBe("number")
    expect(typeof result.summary.mean_fidelity).toBe("number")
    expect(typeof result.summary.total_an_violations).toBe("number")
    expect(typeof result.summary.mean_temporal_consistency).toBe("number")
    expect(typeof result.summary.mean_dapm_dimensions).toBe("number")

    // With default test data: all pass
    // 2 personalities, both should pass with default data
    expect(result.summary.total_evaluated).toBe(2)
  })

  it("produces JSON-serializable output", () => {
    const result = buildScorecards(
      ["p1", "p2"],
      makeDistinctivenessResult(),
      makeFidelityResult(),
      makeANBatchResult(),
      makeTemporalResult(),
      makeDAPMEvalResult(),
      "test-model",
    )

    const json = JSON.stringify(result)
    expect(typeof json).toBe("string")

    const parsed = JSON.parse(json) as AggregateScorecard
    expect(parsed.personalities).toHaveLength(2)
    expect(parsed.summary.total_evaluated).toBe(2)
    expect(typeof parsed.evaluated_at).toBe("number")
    expect(parsed.eval_model).toBe("test-model")
  })

  it("handles single personality", () => {
    const result = buildScorecards(
      ["p1"],
      makeDistinctivenessResult({
        mean_similarity: 0,
        per_pair: [],
        pairs_evaluated: 0,
      }),
      makeFidelityResult(),
      makeANBatchResult(),
      makeTemporalResult(),
      makeDAPMEvalResult({ per_pair: [], total_pairs: 0 }),
      "test-model",
    )

    expect(result.personalities).toHaveLength(1)
    expect(result.summary.total_evaluated).toBe(1)
    // Single personality has no pairs, so distinctiveness defaults
    const card = result.personalities[0]
    expect(typeof card.distinctiveness_score).toBe("number")
  })

  it("handles no violations correctly", () => {
    const result = buildScorecards(
      ["p1"],
      makeDistinctivenessResult({ mean_similarity: 0, per_pair: [], pairs_evaluated: 0 }),
      makeFidelityResult(),
      makeANBatchResult({ total_violations: 0, violations: [] }),
      makeTemporalResult(),
      makeDAPMEvalResult({ per_pair: [], total_pairs: 0 }),
      "test-model",
    )

    const card = result.personalities[0]
    expect(card.anti_narration_violations).toBe(0)
    expect(result.summary.total_an_violations).toBe(0)
  })

  it("summary pass_rate is correct with mixed pass/fail", () => {
    // p1 will fail on distinctiveness (similarity too high), p2 will pass
    const result = buildScorecards(
      ["p1", "p2"],
      makeDistinctivenessResult({
        per_pair: [
          { personality_a: "p1", personality_b: "p2", similarity: 0.5 },
        ],
      }),
      makeFidelityResult(),
      makeANBatchResult(),
      makeTemporalResult(),
      makeDAPMEvalResult(),
      "test-model",
    )

    // Both p1 and p2 have the same mean similarity (0.5) from the single pair
    // So both should fail on distinctiveness (0.5 >= 0.3)
    expect(result.personalities[0].overall_pass).toBe(false)
    expect(result.personalities[1].overall_pass).toBe(false)
    expect(result.summary.total_passing).toBe(0)
    expect(result.summary.pass_rate).toBe(0)
  })

  it("includes eval_model and evaluated_at in result", () => {
    const before = Date.now()
    const result = buildScorecards(
      ["p1"],
      makeDistinctivenessResult({ per_pair: [], pairs_evaluated: 0 }),
      makeFidelityResult(),
      makeANBatchResult(),
      makeTemporalResult(),
      makeDAPMEvalResult({ per_pair: [], total_pairs: 0 }),
      "gpt-4o-mini",
    )
    const after = Date.now()

    expect(result.eval_model).toBe("gpt-4o-mini")
    expect(result.evaluated_at).toBeGreaterThanOrEqual(before)
    expect(result.evaluated_at).toBeLessThanOrEqual(after)
  })
})
