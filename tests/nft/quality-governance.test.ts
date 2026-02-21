/**
 * Quality Governance Tests — Sprint 1 (GID 124), Task T1.6
 *
 * Tests cover:
 * - Anti-sycophancy detection (T1.2)
 * - Archetype-aware signal weighting (T1.3)
 * - Governance integration into quality scoring (T1.4)
 * - Backward compatibility with ungoverned scoring
 * - Env var validation for governance overrides
 * - Safety floor (safety_pass=false → 0) overrides governance
 * - Fire-and-forget invariant (governance errors never block)
 * - E2E: governance adjustments in quality store cache
 * - Prometheus metrics registration (T1.5)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock loa-hounfour to avoid broken index.js (missing billing.js)
vi.mock("@0xhoneyjar/loa-hounfour", () => {
  const pools = ["cheap", "fast-code", "reviewer", "reasoning", "architect"] as const
  const tierAccess: Record<string, readonly string[]> = {
    free: ["cheap"],
    pro: ["cheap", "fast-code", "reviewer"],
    enterprise: ["cheap", "fast-code", "reviewer", "reasoning", "architect"],
  }
  return {
    POOL_IDS: pools,
    TIER_POOL_ACCESS: tierAccess,
    TIER_DEFAULT_POOL: { free: "cheap", pro: "fast-code", enterprise: "reviewer" },
    isValidPoolId: (id: string) => (pools as readonly string[]).includes(id),
    tierHasAccess: (tier: string, poolId: string) => tierAccess[tier]?.includes(poolId) ?? false,
  }
})
import {
  detectSycophancyRisk,
  adjustForSycophancy,
  getSignalWeights,
  parseGovernanceOverrides,
  governedQualityFromSignals,
  GOVERNANCE_SIGNAL_KEYS,
} from "../../src/nft/quality-governance.js"
import {
  qualityFromSignals,
  RoutingQualityStore,
} from "../../src/nft/routing-quality.js"
import type {
  QualitySignals,
  RoutingQualityEvent,
} from "../../src/nft/routing-quality.js"

// ---------------------------------------------------------------------------
// Env var isolation — governance reads process.env at call time
// ---------------------------------------------------------------------------

const savedGovernanceEnv = process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES
const savedSycophancyEnv = process.env.FINN_SYCOPHANCY_DETECTION_ENABLED

beforeEach(() => {
  delete process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES
  delete process.env.FINN_SYCOPHANCY_DETECTION_ENABLED
})

afterEach(() => {
  if (savedGovernanceEnv !== undefined) {
    process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES = savedGovernanceEnv
  } else {
    delete process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES
  }
  if (savedSycophancyEnv !== undefined) {
    process.env.FINN_SYCOPHANCY_DETECTION_ENABLED = savedSycophancyEnv
  } else {
    delete process.env.FINN_SYCOPHANCY_DETECTION_ENABLED
  }
})

// ---------------------------------------------------------------------------
// Anti-sycophancy detection (T1.2)
// ---------------------------------------------------------------------------

describe("detectSycophancyRisk", () => {
  it("detects HIGH risk: perfect satisfaction + low coherence", () => {
    const result = detectSycophancyRisk({
      safety_pass: true,
      user_satisfaction: 1.0,
      coherence_score: 0.3,
    })
    expect(result.risk).toBe(true)
    expect(result.confidence).toBe(0.9)
    expect(result.reason).toContain("high satisfaction")
  })

  it("detects MEDIUM risk: high satisfaction + near-zero challenge rate", () => {
    const result = detectSycophancyRisk({
      safety_pass: true,
      user_satisfaction: 0.85,
      challenge_rate: 0.05,
    })
    expect(result.risk).toBe(true)
    expect(result.confidence).toBe(0.7)
    expect(result.reason).toContain("challenge rate")
  })

  it("detects MEDIUM risk: very high satisfaction + shallow depth", () => {
    const result = detectSycophancyRisk({
      safety_pass: true,
      user_satisfaction: 0.95,
      response_depth: 0.2,
    })
    expect(result.risk).toBe(true)
    expect(result.confidence).toBe(0.6)
    expect(result.reason).toContain("shallow depth")
  })

  it("returns no risk when all signals absent", () => {
    const result = detectSycophancyRisk({ safety_pass: true })
    expect(result.risk).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it("returns no risk for healthy signal combination", () => {
    const result = detectSycophancyRisk({
      safety_pass: true,
      user_satisfaction: 0.8,
      coherence_score: 0.9,
      challenge_rate: 0.3,
      response_depth: 0.7,
    })
    expect(result.risk).toBe(false)
  })

  it("returns no risk at exact boundary (satisfaction=0.8, challenge=0.1)", () => {
    // Rule (b) requires satisfaction > 0.8 AND challenge < 0.1
    const result = detectSycophancyRisk({
      safety_pass: true,
      user_satisfaction: 0.8,
      challenge_rate: 0.1,
    })
    expect(result.risk).toBe(false)
  })

  it("returns no risk when only satisfaction provided (no counter-signals)", () => {
    const result = detectSycophancyRisk({
      safety_pass: true,
      user_satisfaction: 1.0,
    })
    expect(result.risk).toBe(false)
  })
})

describe("adjustForSycophancy", () => {
  it("caps satisfaction at coherence when sycophancy detected", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 1.0,
      coherence_score: 0.3,
    }
    const adjusted = adjustForSycophancy(signals)
    expect(adjusted.user_satisfaction).toBe(0.3)
    expect(adjusted.coherence_score).toBe(0.3)
  })

  it("returns same reference when no sycophancy detected", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 0.7,
      coherence_score: 0.8,
    }
    const adjusted = adjustForSycophancy(signals)
    expect(adjusted).toBe(signals)
  })

  it("does not mutate input signals", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 1.0,
      coherence_score: 0.3,
    }
    adjustForSycophancy(signals)
    expect(signals.user_satisfaction).toBe(1.0)
  })
})

// ---------------------------------------------------------------------------
// Signal weighting (T1.3)
// ---------------------------------------------------------------------------

describe("getSignalWeights", () => {
  it("returns default weights without archetype", () => {
    const weights = getSignalWeights()
    expect(weights.user_satisfaction).toBeCloseTo(0.3, 2)
    expect(weights.coherence_score).toBeCloseTo(0.3, 2)
    expect(weights.challenge_rate).toBeCloseTo(0.2, 2)
  })

  it("all archetypes produce weights summing to 1.0", () => {
    const archetypes = ["freetekno", "milady", "chicago_detroit", "acidhouse"] as const
    for (const archetype of archetypes) {
      const weights = getSignalWeights(archetype)
      const sum = Object.values(weights).reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(1.0, 6)
    }
  })

  it("freetekno emphasizes challenge_rate", () => {
    const weights = getSignalWeights("freetekno")
    const defaults = getSignalWeights()
    expect(weights.challenge_rate).toBeGreaterThan(defaults.challenge_rate)
  })

  it("milady emphasizes user_satisfaction", () => {
    const weights = getSignalWeights("milady")
    const defaults = getSignalWeights()
    expect(weights.user_satisfaction).toBeGreaterThan(defaults.user_satisfaction)
  })

  it("chicago_detroit emphasizes task_completion", () => {
    const weights = getSignalWeights("chicago_detroit")
    const defaults = getSignalWeights()
    expect(weights.task_completion).toBeGreaterThan(defaults.task_completion)
  })

  it("acidhouse emphasizes response_depth", () => {
    const weights = getSignalWeights("acidhouse")
    const defaults = getSignalWeights()
    expect(weights.response_depth).toBeGreaterThan(defaults.response_depth)
  })

  it("different archetypes produce different weight distributions", () => {
    const freetekno = getSignalWeights("freetekno")
    const milady = getSignalWeights("milady")
    const differs = GOVERNANCE_SIGNAL_KEYS.some(
      key => Math.abs(freetekno[key] - milady[key]) > 0.01,
    )
    expect(differs).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Env var validation (T1.3)
// ---------------------------------------------------------------------------

describe("parseGovernanceOverrides", () => {
  it("returns null for undefined input", () => {
    expect(parseGovernanceOverrides(undefined)).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(parseGovernanceOverrides("")).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseGovernanceOverrides("{not valid json}")).toBeNull()
  })

  it("returns null for non-object JSON (array)", () => {
    expect(parseGovernanceOverrides("[1,2,3]")).toBeNull()
  })

  it("returns null for non-object JSON (string)", () => {
    expect(parseGovernanceOverrides('"hello"')).toBeNull()
  })

  it("rejects safety_pass key", () => {
    const result = parseGovernanceOverrides('{"safety_pass": 0.5}')
    expect(result).toBeNull()
  })

  it("rejects unknown keys", () => {
    const result = parseGovernanceOverrides('{"unknown_signal": 0.5}')
    expect(result).toBeNull()
  })

  it("rejects negative weights", () => {
    const result = parseGovernanceOverrides('{"user_satisfaction": -0.5}')
    expect(result).toBeNull()
  })

  it("rejects non-number weights", () => {
    const result = parseGovernanceOverrides('{"user_satisfaction": "not_a_number"}')
    expect(result).toBeNull()
  })

  it("accepts valid overrides", () => {
    const result = parseGovernanceOverrides('{"user_satisfaction": 0.5, "coherence_score": 0.8}')
    expect(result).not.toBeNull()
    expect(result!.user_satisfaction).toBe(0.5)
    expect(result!.coherence_score).toBe(0.8)
  })

  it("accepts zero weights", () => {
    const result = parseGovernanceOverrides('{"challenge_rate": 0}')
    expect(result).not.toBeNull()
    expect(result!.challenge_rate).toBe(0)
  })

  it("skips invalid keys but keeps valid ones", () => {
    const result = parseGovernanceOverrides(
      '{"user_satisfaction": 0.5, "unknown": 1.0, "safety_pass": 0.5}',
    )
    expect(result).not.toBeNull()
    expect(result!.user_satisfaction).toBe(0.5)
    expect(result).not.toHaveProperty("unknown")
    expect(result).not.toHaveProperty("safety_pass")
  })
})

describe("getSignalWeights — env var integration", () => {
  it("env var overrides take highest priority", () => {
    process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES = '{"challenge_rate": 0.9}'
    const weights = getSignalWeights("milady")
    // milady defaults: challenge_rate = 0.1
    // After env override: challenge_rate = 0.9 (before normalization)
    // Normalized: 0.9 / (0.4+0.3+0.9+0.15+0.05) = 0.9/1.8 = 0.5
    expect(weights.challenge_rate).toBeCloseTo(0.5, 2)
  })

  it("malformed env var falls back to archetype defaults", () => {
    process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES = "not json"
    const weights = getSignalWeights("freetekno")
    // freetekno challenge_rate override is 0.3 → after normalization ~0.3
    const sum = Object.values(weights).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1.0, 6)
    expect(weights.challenge_rate).toBeGreaterThan(0.25)
  })
})

// ---------------------------------------------------------------------------
// Governed quality scoring (T1.4)
// ---------------------------------------------------------------------------

describe("governedQualityFromSignals", () => {
  it("returns null when no signals available", () => {
    expect(governedQualityFromSignals({ safety_pass: true })).toBeNull()
  })

  it("backward compat: without archetype returns simple average", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 0.8,
      coherence_score: 0.6,
    }
    expect(governedQualityFromSignals(signals)).toBeCloseTo(0.7, 4)
  })

  it("backward compat: includes new fields in ungoverned average", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 0.8,
      coherence_score: 0.6,
      challenge_rate: 0.4,
    }
    // (0.8 + 0.6 + 0.4) / 3 = 0.6
    expect(governedQualityFromSignals(signals)).toBeCloseTo(0.6, 4)
  })

  it("different archetypes produce different scores for same signals", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 0.9,
      coherence_score: 0.7,
      challenge_rate: 0.3,
      task_completion: 0.8,
      response_depth: 0.5,
    }
    const freeteknoScore = governedQualityFromSignals(signals, "freetekno")
    const miladyScore = governedQualityFromSignals(signals, "milady")
    expect(freeteknoScore).not.toBeNull()
    expect(miladyScore).not.toBeNull()
    expect(freeteknoScore).not.toBeCloseTo(miladyScore!, 4)
  })

  it("sycophancy adjustment reduces score for agreeable-but-incoherent", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 1.0,
      coherence_score: 0.3,
    }
    const ungovScore = governedQualityFromSignals(signals)
    const govScore = governedQualityFromSignals(signals, "freetekno")
    expect(govScore).not.toBeNull()
    // Without archetype: (1.0 + 0.3) / 2 = 0.65
    // With archetype: satisfaction capped at 0.3, then weighted
    expect(ungovScore).toBeCloseTo(0.65, 2)
    expect(govScore!).toBeLessThan(ungovScore!)
  })

  it("score is always clamped to [0, 1]", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 1.0,
      coherence_score: 1.0,
      challenge_rate: 1.0,
      task_completion: 1.0,
      response_depth: 1.0,
    }
    const score = governedQualityFromSignals(signals, "freetekno")
    expect(score).not.toBeNull()
    expect(score!).toBeLessThanOrEqual(1)
    expect(score!).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// qualityFromSignals integration (T1.4)
// ---------------------------------------------------------------------------

describe("qualityFromSignals — governance integration", () => {
  it("safety_pass=false always returns 0, even with archetype", () => {
    expect(
      qualityFromSignals(
        { safety_pass: false, user_satisfaction: 1.0, coherence_score: 1.0 },
        "freetekno",
      ),
    ).toBe(0)
  })

  it("without archetype: original behavior for user_satisfaction + coherence", () => {
    expect(
      qualityFromSignals({ safety_pass: true, user_satisfaction: 0.9, coherence_score: 0.7 }),
    ).toBe(0.8)
  })

  it("without archetype: new fields contribute to average", () => {
    const score = qualityFromSignals({
      safety_pass: true,
      user_satisfaction: 0.8,
      coherence_score: 0.6,
      challenge_rate: 0.4,
    })
    // (0.8 + 0.6 + 0.4) / 3 = 0.6
    expect(score).toBeCloseTo(0.6, 4)
  })

  it("without archetype and no signals: 0.5 baseline", () => {
    expect(qualityFromSignals({ safety_pass: true })).toBe(0.5)
  })

  it("with archetype: uses governance scoring", () => {
    const signals: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 0.9,
      coherence_score: 0.7,
      challenge_rate: 0.3,
      task_completion: 0.8,
      response_depth: 0.5,
    }
    const ungoverned = qualityFromSignals(signals)
    const governed = qualityFromSignals(signals, "freetekno")
    // Governed uses archetype-specific weights, ungoverned uses simple average
    expect(governed).not.toBeCloseTo(ungoverned, 4)
  })

  it("with archetype: sycophancy reduces quality", () => {
    const sycophantic: QualitySignals = {
      safety_pass: true,
      user_satisfaction: 1.0,
      coherence_score: 0.3,
    }
    const scored = qualityFromSignals(sycophantic, "freetekno")
    // Without governance: (1.0 + 0.3) / 2 = 0.65
    // With governance: satisfaction capped at 0.3, then weighted average
    expect(scored).toBeLessThan(0.65)
  })
})

// ---------------------------------------------------------------------------
// Safety floor overrides governance (T1.6.f)
// ---------------------------------------------------------------------------

describe("Safety floor overrides governance", () => {
  it("safety_pass=false returns 0 regardless of governance signals", () => {
    const signals: QualitySignals = {
      safety_pass: false,
      user_satisfaction: 1.0,
      coherence_score: 1.0,
      challenge_rate: 1.0,
      task_completion: 1.0,
      response_depth: 1.0,
    }
    expect(qualityFromSignals(signals)).toBe(0)
    expect(qualityFromSignals(signals, "freetekno")).toBe(0)
    expect(qualityFromSignals(signals, "milady")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Fire-and-forget invariant (T1.6.g)
// ---------------------------------------------------------------------------

describe("Fire-and-forget — governance errors never block", () => {
  it("recordQuality succeeds with archetype and valid signals", async () => {
    const store = new RoutingQualityStore(null, null)

    const event: RoutingQualityEvent = {
      personality_id: "bears:42",
      pool_id: "architect",
      model: "test",
      task_type: "chat",
      latency_ms: 100,
      tokens_used: 500,
      quality_signals: {
        safety_pass: true,
        user_satisfaction: 0.9,
      },
      archetype: "freetekno",
    }

    // Should not throw
    await store.recordQuality(event, "corr-1")

    const cached = store.getPoolQualityCached("bears:42", "architect")
    expect(cached).not.toBeNull()
    expect(cached!.score).toBeGreaterThan(0)
    expect(cached!.score).toBeLessThanOrEqual(1)
  })

  it("recordQuality succeeds with malformed governance env var", async () => {
    process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES = "{{{{broken json"
    const store = new RoutingQualityStore(null, null)

    const event: RoutingQualityEvent = {
      personality_id: "bears:42",
      pool_id: "architect",
      model: "test",
      task_type: "chat",
      latency_ms: 100,
      tokens_used: 500,
      quality_signals: {
        safety_pass: true,
        user_satisfaction: 0.8,
        coherence_score: 0.6,
      },
      archetype: "freetekno",
    }

    // Should not throw — governance falls back to defaults
    await store.recordQuality(event, "corr-1")

    const cached = store.getPoolQualityCached("bears:42", "architect")
    expect(cached).not.toBeNull()
    expect(cached!.score).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// E2E: governance adjustments in quality store cache (T1.6.h)
// ---------------------------------------------------------------------------

describe("E2E: governance adjustments flow through quality store", () => {
  it("archetype-aware quality events produce governed cached scores", async () => {
    const store = new RoutingQualityStore(null, null)

    const sycophantic: RoutingQualityEvent = {
      personality_id: "bears:42",
      pool_id: "architect",
      model: "test",
      task_type: "chat",
      latency_ms: 100,
      tokens_used: 500,
      quality_signals: {
        safety_pass: true,
        user_satisfaction: 1.0,
        coherence_score: 0.3,
      },
      archetype: "freetekno",
    }

    await store.recordQuality(sycophantic, "c1")

    const cached = store.getPoolQualityCached("bears:42", "architect")
    expect(cached).not.toBeNull()
    // Sycophancy detection: satisfaction capped at coherence (0.3), then weighted
    // Without governance: (1.0 + 0.3) / 2 = 0.65
    expect(cached!.score).toBeLessThan(0.65)
  })

  it("events without archetype use ungoverned scoring", async () => {
    const store = new RoutingQualityStore(null, null)

    const event: RoutingQualityEvent = {
      personality_id: "bears:42",
      pool_id: "architect",
      model: "test",
      task_type: "chat",
      latency_ms: 100,
      tokens_used: 500,
      quality_signals: {
        safety_pass: true,
        user_satisfaction: 0.9,
        coherence_score: 0.7,
      },
    }

    await store.recordQuality(event, "c1")

    const cached = store.getPoolQualityCached("bears:42", "architect")
    expect(cached).not.toBeNull()
    // Simple average: (0.9 + 0.7) / 2 = 0.8
    expect(cached!.score).toBeCloseTo(0.8, 2)
  })

  it("governed scoring applies across multiple events", async () => {
    const store = new RoutingQualityStore(null, null)

    // First event: sycophantic (governed → reduced score)
    await store.recordQuality(
      {
        personality_id: "bears:42",
        pool_id: "architect",
        model: "test",
        task_type: "chat",
        latency_ms: 100,
        tokens_used: 500,
        quality_signals: {
          safety_pass: true,
          user_satisfaction: 1.0,
          coherence_score: 0.3,
        },
        archetype: "freetekno",
      },
      "c1",
    )

    // Second event: healthy signals (governed → reasonable score)
    await store.recordQuality(
      {
        personality_id: "bears:42",
        pool_id: "architect",
        model: "test",
        task_type: "chat",
        latency_ms: 100,
        tokens_used: 500,
        quality_signals: {
          safety_pass: true,
          user_satisfaction: 0.7,
          coherence_score: 0.8,
          challenge_rate: 0.4,
        },
        archetype: "freetekno",
      },
      "c2",
    )

    const cached = store.getPoolQualityCached("bears:42", "architect")
    expect(cached).not.toBeNull()
    expect(cached!.sample_count).toBe(2)
    // Blended score should be between the two individual scores
    expect(cached!.score).toBeGreaterThan(0)
    expect(cached!.score).toBeLessThan(1)
  })
})

// ---------------------------------------------------------------------------
// Prometheus metrics registration (T1.5)
// ---------------------------------------------------------------------------

describe("Prometheus metrics — governance counters (T1.5)", () => {
  it("governance metrics are registered", async () => {
    const { metrics } = await import("../../src/gateway/metrics-endpoint.js")
    const serialized = metrics.serialize()

    expect(serialized).toContain("finn_quality_sycophancy_detected_total")
    expect(serialized).toContain("finn_quality_governance_error_total")
  })

  it("governance metrics use bounded labels (archetype only)", async () => {
    const { metrics } = await import("../../src/gateway/metrics-endpoint.js")

    metrics.incrementCounter("finn_quality_sycophancy_detected_total", {
      archetype: "freetekno",
    })

    const serialized = metrics.serialize()
    expect(serialized).toContain('archetype="freetekno"')
    // Verify NO unbounded labels
    expect(serialized).not.toContain("personality_id=")
  })
})
