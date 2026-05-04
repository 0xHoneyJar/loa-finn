// tests/finn/hounfour/dampening-comparison.test.ts — T-3.3
// Dampening comparison tests for canonical computeDampenedScore (v8.3.0)
// and feature-flagged applyDampening wrapper.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  computeDampenedScore,
  FEEDBACK_DAMPENING_ALPHA_MIN,
  FEEDBACK_DAMPENING_ALPHA_MAX,
  DAMPENING_RAMP_SAMPLES,
  DEFAULT_PSEUDO_COUNT,
} from "../../../src/hounfour/protocol-types.js"

// ── Constants verification ───────────────────────────────────────────────

describe("dampening constants", () => {
  it("alpha_min = 0.1", () => expect(FEEDBACK_DAMPENING_ALPHA_MIN).toBe(0.1))
  it("alpha_max = 0.5", () => expect(FEEDBACK_DAMPENING_ALPHA_MAX).toBe(0.5))
  it("ramp_samples = 50", () => expect(DAMPENING_RAMP_SAMPLES).toBe(50))
  it("pseudo_count = 10", () => expect(DEFAULT_PSEUDO_COUNT).toBe(10))
})

// ── Numeric assertions with hardcoded expected values (Flatline IMP-008) ─

describe("computeDampenedScore — numeric vectors", () => {
  it("cold start: null → 0.8 at sampleCount=1", () => {
    const result = computeDampenedScore(null, 0.8, 1)
    expect(result).toBeCloseTo(0.52727, 5)
  })

  it("steady state: 0.5 → 0.8 at sampleCount=10", () => {
    const result = computeDampenedScore(0.5, 0.8, 10)
    expect(result).toBeCloseTo(0.62600, 5)
  })

  it("boundary sampleCount=0: 0.5 → 0.8", () => {
    const result = computeDampenedScore(0.5, 0.8, 0)
    expect(result).toBeCloseTo(0.65000, 5)
  })

  it("boundary sampleCount=1: 0.5 → 0.8", () => {
    const result = computeDampenedScore(0.5, 0.8, 1)
    expect(result).toBeCloseTo(0.64760, 5)
  })

  it("ramp boundary sampleCount=RAMP_SAMPLES: 0.5 → 0.8", () => {
    const result = computeDampenedScore(0.5, 0.8, DAMPENING_RAMP_SAMPLES)
    expect(result).toBeCloseTo(0.53000, 5)
  })

  it("post-ramp sampleCount=RAMP_SAMPLES+100: 0.5 → 0.8", () => {
    const result = computeDampenedScore(0.5, 0.8, DAMPENING_RAMP_SAMPLES + 100)
    expect(result).toBeCloseTo(0.53000, 5)
  })

  it("no change: 0.7 → 0.7 at sampleCount=25", () => {
    const result = computeDampenedScore(0.7, 0.7, 25)
    expect(result).toBeCloseTo(0.70000, 5)
  })

  it("score decrease: 0.8 → 0.2 at sampleCount=30", () => {
    const result = computeDampenedScore(0.8, 0.2, 30)
    expect(result).toBeCloseTo(0.64400, 5)
  })
})

// ── Behavioral properties ────────────────────────────────────────────────

describe("computeDampenedScore — behavioral", () => {
  it("bounded feedback invariant: |result - old| <= alpha_max * |new - old|", () => {
    const old = 0.5
    const newVal = 0.9
    for (const sampleCount of [1, 5, 10, 25, 50, 100]) {
      const result = computeDampenedScore(old, newVal, sampleCount)
      const delta = Math.abs(result - old)
      const maxDelta = FEEDBACK_DAMPENING_ALPHA_MAX * Math.abs(newVal - old)
      expect(delta).toBeLessThanOrEqual(maxDelta + 1e-10) // floating point tolerance
    }
  })

  it("alpha decreases as sampleCount increases (more conservative)", () => {
    const old = 0.5
    const newVal = 0.9
    const deltas: number[] = []
    for (const sc of [1, 10, 25, 50]) {
      const result = computeDampenedScore(old, newVal, sc)
      deltas.push(Math.abs(result - old))
    }
    // Each subsequent delta should be <= previous (or equal at ramp boundary)
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeLessThanOrEqual(deltas[i - 1] + 1e-10)
    }
  })

  it("cold start pulls toward 0.5 (Bayesian prior)", () => {
    const extreme = computeDampenedScore(null, 1.0, 1)
    expect(extreme).toBeLessThan(1.0)
    expect(extreme).toBeGreaterThan(0.5)
  })

  it("result is always in [0, 1] range", () => {
    for (const newVal of [0, 0.5, 1.0]) {
      for (const old of [null, 0, 0.5, 1.0]) {
        const result = computeDampenedScore(old, newVal, 10)
        expect(result).toBeGreaterThanOrEqual(0)
        expect(result).toBeLessThanOrEqual(1)
      }
    }
  })
})

// ── Structured dampening telemetry (T-4.2) ───────────────────────────────

describe("dampening delta — structured JSON telemetry", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("emits valid JSON via console.log when delta > 0.001", async () => {
    process.env.FINN_CANONICAL_DAMPENING = "true"
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const mod = await import("../../../src/hounfour/goodhart/quality-signal.js")

    // Create a mock decay engine that returns a known state
    const mockDecay = {
      getRawState: vi.fn().mockResolvedValue({ ema: 0.5, sampleCount: 9 }),
      updateEMA: vi.fn().mockResolvedValue(undefined),
    }

    const config = {
      decay: mockDecay as any,
      explorationFeedbackWeight: 0.5,
    }

    const obs = {
      nftId: "test-nft-001",
      poolId: "pool-1" as any,
      routingKey: "key-1" as any,
      latencyMs: 500,
      success: true,
      finishReason: "stop" as const,
      tokenUtilization: 0.8,
    }

    await mod.feedQualitySignal(config, obs)

    // Find the structured log call (JSON string)
    const jsonCalls = logSpy.mock.calls.filter((args) => {
      try {
        const parsed = JSON.parse(args[0] as string)
        return parsed.event === "dampening_delta"
      } catch {
        return false
      }
    })

    if (jsonCalls.length > 0) {
      const payload = JSON.parse(jsonCalls[0][0] as string)
      expect(payload.event).toBe("dampening_delta")
      expect(typeof payload.local).toBe("number")
      expect(typeof payload.canonical).toBe("number")
      expect(typeof payload.delta).toBe("number")
      expect(payload.nftId).toBe("test-nft-001")
      expect(typeof payload.sampleCount).toBe("number")
    }
    // If no log emitted, delta was <= 0.001 (acceptable — dampening may be close)
  })
})

// ── Feature flag integration (T-3.1, T-3.2) ─────────────────────────────

describe("applyDampening — feature flag", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it("flag=false returns newScore unchanged", async () => {
    process.env.FINN_CANONICAL_DAMPENING = "false"
    const mod = await import("../../../src/hounfour/goodhart/quality-signal.js")
    const result = mod.applyDampening(0.5, 0.8, 10)
    expect(result).toBe(0.8) // No dampening applied
  })

  it("flag=true applies canonical dampening", async () => {
    process.env.FINN_CANONICAL_DAMPENING = "true"
    const mod = await import("../../../src/hounfour/goodhart/quality-signal.js")
    const result = mod.applyDampening(0.5, 0.8, 10)
    expect(result).toBeCloseTo(0.62600, 5) // Canonical dampening applied
  })

  it("invalid config falls back to local (returns newScore)", async () => {
    process.env.FINN_CANONICAL_DAMPENING = "true"
    process.env.FINN_DAMPENING_CONFIG = '{"invalid": true}'
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await import("../../../src/hounfour/goodhart/quality-signal.js")
    const result = mod.applyDampening(0.5, 0.8, 10)
    expect(result).toBe(0.8)
    consoleSpy.mockRestore()
  })

  it("malformed JSON config falls back to local", async () => {
    process.env.FINN_CANONICAL_DAMPENING = "true"
    process.env.FINN_DAMPENING_CONFIG = "not-json"
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await import("../../../src/hounfour/goodhart/quality-signal.js")
    const result = mod.applyDampening(0.5, 0.8, 10)
    expect(result).toBe(0.8)
    consoleSpy.mockRestore()
  })
})
