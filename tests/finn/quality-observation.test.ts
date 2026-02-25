// tests/finn/quality-observation.test.ts — QualityObservation Schema Tests (Sprint 133 Task 2.7)

import { describe, it, expect } from "vitest"
import { Value } from "@sinclair/typebox/value"
import "../../src/hounfour/typebox-formats.js" // Register uuid/date-time formats
import { QualityObservationSchema } from "@0xhoneyjar/loa-hounfour/governance"

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
