// tests/finn/reputation-event-normalizer.test.ts — ReputationEvent Normalizer Tests (Sprint 133 Task 2.2)

import { describe, it, expect } from "vitest"
import "../../src/hounfour/typebox-formats.js" // Register uuid/date-time formats
import { normalizeReputationEvent } from "../../src/hounfour/reputation-event-normalizer.js"

// --- Shared envelope fields for valid events ---

const envelope = {
  event_id: "550e8400-e29b-41d4-a716-446655440000",
  agent_id: "agent-001",
  collection_id: "collection-001",
  timestamp: "2026-01-15T12:00:00.000Z", // Deterministic — no new Date() (T-3.5)
}

// --- Tests ---

describe("ReputationEvent Normalizer", () => {
  // Track A: All 4 variants recognized and metered

  it("normalizes quality_signal variant", () => {
    const result = normalizeReputationEvent({
      ...envelope,
      type: "quality_signal",
      score: 0.85,
    })
    expect(result.type).toBe("quality_signal")
    expect(result.recognized).toBe(true)
    expect(result.metered).toBe(true)
  })

  it("normalizes task_completed variant", () => {
    const result = normalizeReputationEvent({
      ...envelope,
      type: "task_completed",
      task_type: "analysis",
      success: true,
    })
    expect(result.type).toBe("task_completed")
    expect(result.recognized).toBe(true)
    expect(result.metered).toBe(true)
  })

  it("normalizes credential_update variant", () => {
    const result = normalizeReputationEvent({
      ...envelope,
      type: "credential_update",
      credential_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      action: "issued",
    })
    expect(result.type).toBe("credential_update")
    expect(result.recognized).toBe(true)
    expect(result.metered).toBe(true)
  })

  it("normalizes model_performance variant", () => {
    const result = normalizeReputationEvent({
      ...envelope,
      type: "model_performance",
      model_id: "claude-opus-4-6",
      provider: "anthropic",
      pool_id: "pool-premium",
      task_type: "code_review",
      quality_observation: {
        score: 0.92,
      },
    })
    expect(result.type).toBe("model_performance")
    expect(result.recognized).toBe(true)
    expect(result.metered).toBe(true)
  })

  // Schema validation: invalid input throws

  it("throws on invalid input (missing required fields)", () => {
    expect(() => normalizeReputationEvent({ type: "quality_signal" })).toThrow(
      "Invalid ReputationEvent",
    )
  })

  it("throws on completely invalid input", () => {
    expect(() => normalizeReputationEvent("not-an-object")).toThrow(
      "Invalid ReputationEvent",
    )
  })

  it("throws on null input", () => {
    expect(() => normalizeReputationEvent(null)).toThrow(
      "Invalid ReputationEvent",
    )
  })

  it("throws on unknown type value", () => {
    expect(() =>
      normalizeReputationEvent({
        ...envelope,
        type: "unknown_type",
        score: 0.5,
      }),
    ).toThrow("Invalid ReputationEvent")
  })

  // Schema validation: partial variants fail

  it("throws on model_performance missing quality_observation", () => {
    expect(() =>
      normalizeReputationEvent({
        ...envelope,
        type: "model_performance",
        model_id: "test",
        provider: "test",
        pool_id: "pool-1",
        task_type: "general",
        // missing quality_observation
      }),
    ).toThrow("Invalid ReputationEvent")
  })

  // Return shape consistency

  it("all variants return consistent NormalizedReputationEvent shape", () => {
    const events = [
      { ...envelope, type: "quality_signal", score: 0.5 },
      { ...envelope, type: "task_completed", task_type: "general", success: true },
      { ...envelope, type: "credential_update", credential_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", action: "issued" },
      {
        ...envelope,
        type: "model_performance",
        model_id: "m1",
        provider: "p1",
        pool_id: "pool-1",
        task_type: "analysis",
        quality_observation: { score: 0.7 },
      },
    ]

    for (const event of events) {
      const result = normalizeReputationEvent(event)
      expect(result).toHaveProperty("type")
      expect(result).toHaveProperty("recognized")
      expect(result).toHaveProperty("metered")
      expect(typeof result.type).toBe("string")
      expect(typeof result.recognized).toBe("boolean")
      expect(typeof result.metered).toBe("boolean")
    }
  })
})
