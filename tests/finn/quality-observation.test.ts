// tests/finn/quality-observation.test.ts — QualityObservation Schema Tests (Sprint 133 Task 2.7)

import { describe, it, expect, vi } from "vitest"
import { Value } from "@sinclair/typebox/value"
import "../../src/hounfour/typebox-formats.js" // Register uuid/date-time formats
import { QualityObservationSchema } from "@0xhoneyjar/loa-hounfour/governance"
import { QualityGateScorer } from "../../src/hounfour/quality-gate-scorer.js"
import type { QualityMetricsCollector } from "../../src/hounfour/metrics.js"

describe("QualityObservation Schema Validation (AC6)", () => {
  // --- Positive tests ---

  it("validates minimal observation (score only)", () => {
    const obs = { score: 0.85 }
    expect(Value.Check(QualityObservationSchema, obs)).toBe(true)
  })

  it("validates full observation with all optional fields", () => {
    const obs = {
      score: 0.92,
      dimensions: { coherence: 0.95, accuracy: 0.88, relevance: 0.93 },
      latency_ms: 1250,
      evaluated_by: "quality-gate-scorer",
    }
    expect(Value.Check(QualityObservationSchema, obs)).toBe(true)
  })

  it("validates observation with dimensions only", () => {
    const obs = {
      score: 0.7,
      dimensions: { clarity: 0.8 },
    }
    expect(Value.Check(QualityObservationSchema, obs)).toBe(true)
  })

  it("validates boundary score values", () => {
    expect(Value.Check(QualityObservationSchema, { score: 0 })).toBe(true)
    expect(Value.Check(QualityObservationSchema, { score: 1 })).toBe(true)
    expect(Value.Check(QualityObservationSchema, { score: 0.5 })).toBe(true)
  })

  it("validates observation with latency_ms only", () => {
    const obs = { score: 0.6, latency_ms: 500 }
    expect(Value.Check(QualityObservationSchema, obs)).toBe(true)
  })

  // --- Negative tests ---

  it("rejects missing score", () => {
    expect(Value.Check(QualityObservationSchema, {})).toBe(false)
  })

  it("rejects non-numeric score", () => {
    expect(Value.Check(QualityObservationSchema, { score: "high" })).toBe(false)
  })

  it("rejects null", () => {
    expect(Value.Check(QualityObservationSchema, null)).toBe(false)
  })

  it("rejects non-object", () => {
    expect(Value.Check(QualityObservationSchema, "not-an-object")).toBe(false)
  })

  it("rejects non-numeric dimension values", () => {
    const obs = {
      score: 0.5,
      dimensions: { coherence: "high" },
    }
    expect(Value.Check(QualityObservationSchema, obs)).toBe(false)
  })

  it("rejects non-integer latency_ms", () => {
    const obs = { score: 0.5, latency_ms: 1.5 }
    expect(Value.Check(QualityObservationSchema, obs)).toBe(false)
  })

  // --- Error message quality ---

  it("produces meaningful error paths for invalid input", () => {
    const errors = [...Value.Errors(QualityObservationSchema, { score: "bad" })]
    expect(errors.length).toBeGreaterThan(0)
    const scorePaths = errors.filter((e) => e.path.includes("score"))
    expect(scorePaths.length).toBeGreaterThan(0)
  })

  // --- AC16: scoreToObservation with dimensions (T-3.8) ---

  it("validates observation with dimensions from scoreToObservation shape", () => {
    const obs = {
      score: 0.88,
      latency_ms: 1500,
      evaluated_by: "quality-gate-scorer",
      dimensions: { coherence: 0.95, accuracy: 0.82, relevance: 0.87 },
    }
    expect(Value.Check(QualityObservationSchema, obs)).toBe(true)
  })
})

// --- QualityMetricsCollector integration (T-6.3) ---

describe("QualityGateScorer metrics (T-6.3)", () => {
  it("emits qualityObservationProduced after scoreToObservation", async () => {
    const metrics: QualityMetricsCollector = {
      qualityObservationProduced: vi.fn(),
      qualityGateFailure: vi.fn(),
    }

    // Use a non-existent script path — score() will catch the error and return 0.0
    // But scoreToObservation wraps score() and emits the observation metric
    const scorer = new QualityGateScorer({
      gateScriptPath: "/nonexistent/quality-gates.sh",
      metrics,
    })

    const mockResult = {
      content: "test content",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
      metadata: { model: "test", latency_ms: 100, trace_id: "t-1" },
    }

    const obs = await scorer.scoreToObservation(mockResult)

    // Score is 0.0 because script doesn't exist — but metric should still fire
    expect(obs.score).toBe(0.0)
    expect(obs.evaluated_by).toBe("quality-gate-scorer")
    expect(metrics.qualityObservationProduced).toHaveBeenCalledOnce()
    expect(metrics.qualityObservationProduced).toHaveBeenCalledWith({
      score: 0.0,
      latency_ms: expect.any(Number),
      evaluator: "quality-gate-scorer",
    })
  })

  it("emits qualityGateFailure when gate script fails", async () => {
    const metrics: QualityMetricsCollector = {
      qualityObservationProduced: vi.fn(),
      qualityGateFailure: vi.fn(),
    }

    const scorer = new QualityGateScorer({
      gateScriptPath: "/nonexistent/quality-gates.sh",
      metrics,
    })

    const mockResult = {
      content: "test",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0 },
      metadata: { model: "test", latency_ms: 1, trace_id: "t-2" },
    }

    const score = await scorer.score(mockResult)
    expect(score).toBe(0.0)
    expect(metrics.qualityGateFailure).toHaveBeenCalledOnce()
    expect(metrics.qualityGateFailure).toHaveBeenCalledWith({
      error_type: expect.any(String),
      evaluator: "quality-gate-scorer",
    })
  })

  it("does not emit metrics when collector not provided", async () => {
    // No metrics option — should not throw
    const scorer = new QualityGateScorer({
      gateScriptPath: "/nonexistent/quality-gates.sh",
    })

    const mockResult = {
      content: "test",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0 },
      metadata: { model: "test", latency_ms: 1, trace_id: "t-3" },
    }

    // Should complete without errors (no metrics to emit to)
    const obs = await scorer.scoreToObservation(mockResult)
    expect(obs.score).toBe(0.0)
  })
})
