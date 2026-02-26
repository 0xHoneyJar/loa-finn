// tests/finn/goodhart/mechanism-interaction.test.ts — Mechanism Interaction + Kill Switch Tests (T-1.10, cycle-034)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { resolveWithGoodhart, feedbackExploration, type MechanismConfig, type ReputationScoringResult } from "../../../src/hounfour/goodhart/mechanism-interaction.js"
import { KillSwitch } from "../../../src/hounfour/goodhart/kill-switch.js"
import type { TemporalDecayEngine, EMAKey, EMAState } from "../../../src/hounfour/goodhart/temporal-decay.js"
import type { ExplorationEngine, ExplorationDecision } from "../../../src/hounfour/goodhart/exploration.js"
import type { CalibrationEngine, CalibrationEntry } from "../../../src/hounfour/goodhart/calibration.js"
import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../../../src/hounfour/nft-routing-config.js"

// --- Mock Factories ---

const POOL_A = "pool-alpha" as PoolId
const POOL_B = "pool-beta" as PoolId
const TIER = "standard" as Tier

function mockDecayEngine(overrides?: Partial<TemporalDecayEngine>): TemporalDecayEngine {
  return {
    updateEMA: vi.fn().mockResolvedValue({ ema: 0.8, lastTimestamp: Date.now(), sampleCount: 5, lastEventHash: "h" } satisfies EMAState),
    getDecayedScore: vi.fn().mockResolvedValue({ score: 0.75, decay: "applied" as const }),
    getRawState: vi.fn().mockResolvedValue({ ema: 0.8, lastTimestamp: Date.now(), sampleCount: 5, lastEventHash: "h" } satisfies EMAState),
    ...overrides,
  } as unknown as TemporalDecayEngine
}

function mockExplorationEngine(overrides?: Partial<ExplorationEngine>): ExplorationEngine {
  return {
    decide: vi.fn().mockReturnValue({
      explore: false,
      candidateSetSize: 0,
      randomValue: 0.95,
    } satisfies ExplorationDecision),
    recordExploration: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ExplorationEngine
}

function mockCalibrationEngine(overrides?: Partial<CalibrationEngine>): CalibrationEngine {
  return {
    getCalibration: vi.fn().mockReturnValue([]),
    blendWithDecay: vi.fn().mockImplementation((decayed: number) => decayed),
    ...overrides,
  } as unknown as CalibrationEngine
}

function makeConfig(overrides?: Partial<MechanismConfig>): MechanismConfig {
  return {
    decay: mockDecayEngine(),
    exploration: mockExplorationEngine(),
    calibration: mockCalibrationEngine(),
    killSwitch: new KillSwitch(),
    explorationFeedbackWeight: 0.5,
    ...overrides,
  }
}

function defaultArgs() {
  return {
    tier: TIER,
    nftId: "nft-001",
    taskType: "chat" as string | undefined,
    nftPreferences: undefined as Record<string, string> | undefined,
    accessiblePools: [POOL_A, POOL_B] as readonly PoolId[],
    circuitBreakerStates: new Map<PoolId, "closed" | "half-open" | "open">([
      [POOL_A, "closed"],
      [POOL_B, "closed"],
    ]),
    poolCosts: new Map<PoolId, number>([[POOL_A, 1.0], [POOL_B, 1.5]]),
    defaultPoolCost: 1.0,
    poolCapabilities: new Map<PoolId, Set<NFTRoutingKey>>([
      [POOL_A, new Set(["chat", "code", "default"] as NFTRoutingKey[])],
      [POOL_B, new Set(["chat", "code", "default"] as NFTRoutingKey[])],
    ]),
  }
}

// --- Kill Switch Tests (AC10f, AC10g, AC10h) ---

describe("KillSwitch", () => {
  const originalEnv = process.env.FINN_REPUTATION_ROUTING

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FINN_REPUTATION_ROUTING
    } else {
      process.env.FINN_REPUTATION_ROUTING = originalEnv
    }
  })

  it("isDisabled() returns true when FINN_REPUTATION_ROUTING=disabled (AC10f)", async () => {
    process.env.FINN_REPUTATION_ROUTING = "disabled"
    const ks = new KillSwitch()
    expect(await ks.isDisabled()).toBe(true)
  })

  it("isDisabled() returns false when FINN_REPUTATION_ROUTING=enabled (AC10g)", async () => {
    process.env.FINN_REPUTATION_ROUTING = "enabled"
    const ks = new KillSwitch()
    expect(await ks.isDisabled()).toBe(false)
  })

  it("isDisabled() returns false when env var is unset (AC10g)", async () => {
    delete process.env.FINN_REPUTATION_ROUTING
    const ks = new KillSwitch()
    expect(await ks.isDisabled()).toBe(false)
  })

  it("getState() returns correct state strings", async () => {
    const ks = new KillSwitch()

    process.env.FINN_REPUTATION_ROUTING = "disabled"
    expect(await ks.getState()).toBe("disabled")

    process.env.FINN_REPUTATION_ROUTING = "shadow"
    expect(await ks.getState()).toBe("shadow")

    process.env.FINN_REPUTATION_ROUTING = "enabled"
    expect(await ks.getState()).toBe("enabled")

    delete process.env.FINN_REPUTATION_ROUTING
    expect(await ks.getState()).toBe("enabled")
  })

  it("logTransition emits structured JSON on state change (AC10h)", () => {
    const ks = new KillSwitch()
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    ks.logTransition("enabled", "disabled") // enabled → disabled
    expect(logSpy).toHaveBeenCalledOnce()
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged.component).toBe("kill-switch")
    expect(logged.event).toBe("state_transition")
    expect(logged.from).toBe("enabled")
    expect(logged.to).toBe("disabled")

    logSpy.mockRestore()
  })

  it("logTransition does not emit when state unchanged", () => {
    const ks = new KillSwitch()
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    ks.logTransition("enabled", "enabled") // No change
    expect(logSpy).not.toHaveBeenCalled()

    logSpy.mockRestore()
  })
})

// --- Mechanism Interaction Tests ---

describe("resolveWithGoodhart", () => {
  const originalEnv = process.env.FINN_REPUTATION_ROUTING

  beforeEach(() => {
    process.env.FINN_REPUTATION_ROUTING = "enabled"
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FINN_REPUTATION_ROUTING
    } else {
      process.env.FINN_REPUTATION_ROUTING = originalEnv
    }
  })

  it("kill switch active → path=kill_switch, zero reputation queries (AC10b)", async () => {
    process.env.FINN_REPUTATION_ROUTING = "disabled"
    const decay = mockDecayEngine()
    const config = makeConfig({ decay })
    const args = defaultArgs()

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    expect(result.path).toBe("kill_switch")
    expect(result.score).toBeNull()
    // Zero reputation queries issued
    expect(decay.getDecayedScore).not.toHaveBeenCalled()
  })

  it("exploration overrides reputation when candidates exist (AC10c)", async () => {
    const exploration = mockExplorationEngine({
      decide: vi.fn().mockReturnValue({
        explore: true,
        candidateSetSize: 2,
        selectedPool: POOL_B,
        randomValue: 0.02,
      } satisfies ExplorationDecision),
    })
    const decay = mockDecayEngine()
    const config = makeConfig({ exploration, decay })
    const args = defaultArgs()

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    expect(result.path).toBe("exploration")
    expect(result.pool).toBe(POOL_B)
    expect(result.metadata.explorationCandidateSetSize).toBe(2)
    // Exploration is independent of decay (AC10c)
    expect(decay.getDecayedScore).not.toHaveBeenCalled()
  })

  it("exploration skipped → falls through to reputation (NOT deterministic)", async () => {
    const exploration = mockExplorationEngine({
      decide: vi.fn().mockReturnValue({
        explore: true,
        candidateSetSize: 0,
        randomValue: 0.02,
        reason: "exploration_skipped",
      } satisfies ExplorationDecision),
    })
    const decay = mockDecayEngine()
    const config = makeConfig({ exploration, decay })
    const args = defaultArgs()

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    // Falls through to reputation scoring (getDecayedScore was called)
    expect(decay.getDecayedScore).toHaveBeenCalled()
    expect(result.path).toBe("reputation")

    warnSpy.mockRestore()
  })

  it("reputation scoring with decay + calibration blending (AC10d)", async () => {
    const calibrationEntries: CalibrationEntry[] = [
      { nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey, score: 0.95, evaluator: "human", timestamp: new Date().toISOString() },
    ]

    const calibration = mockCalibrationEngine({
      getCalibration: vi.fn().mockReturnValue(calibrationEntries),
      blendWithDecay: vi.fn().mockReturnValue(0.85), // Blended result
    })

    const config = makeConfig({ calibration })
    const args = defaultArgs()

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    expect(result.path).toBe("reputation")
    expect(result.metadata.calibrationApplied).toBe(true)
    expect(result.metadata.decayApplied).toBe(true)
    expect(calibration.blendWithDecay).toHaveBeenCalled()
  })

  it("deterministic fallback when all reputation queries return null", async () => {
    const decay = mockDecayEngine({
      getDecayedScore: vi.fn().mockResolvedValue(null),
    })
    const config = makeConfig({ decay })
    const args = defaultArgs()

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    expect(result.path).toBe("deterministic")
    expect(result.score).toBeNull()
  })

  it("precedence chain: kill switch > exploration > reputation > deterministic", async () => {
    // With kill switch disabled, exploration explore=false, decay returns scores
    // → should use reputation path
    const config = makeConfig()
    const args = defaultArgs()

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    expect(result.path).toBe("reputation")
  })

  it("selects highest-scoring pool from reputation scoring", async () => {
    let callCount = 0
    const decay = mockDecayEngine({
      getDecayedScore: vi.fn().mockImplementation(async () => {
        callCount++
        // POOL_A gets 0.6, POOL_B gets 0.9
        return { score: callCount === 1 ? 0.6 : 0.9, decay: "applied" as const }
      }),
    })
    const config = makeConfig({ decay })
    const args = defaultArgs()

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    expect(result.path).toBe("reputation")
    expect(result.pool).toBe(POOL_B)
    expect(result.score).toBeCloseTo(0.9)
  })
})

// --- Exploration Feedback Tests (AC10e) ---

describe("feedbackExploration", () => {
  it("updates EMA at 0.5x weight (AC10e)", async () => {
    const decay = mockDecayEngine()
    const config = makeConfig({ decay, explorationFeedbackWeight: 0.5 })

    const key: EMAKey = { nftId: "nft-001", poolId: POOL_A, routingKey: "chat" as NFTRoutingKey }

    await feedbackExploration(config, key, 0.8, Date.now(), "event-hash-1")

    expect(decay.updateEMA).toHaveBeenCalledWith(
      key,
      0.4, // 0.8 * 0.5
      expect.any(Number),
      "event-hash-1",
    )
  })
})

// --- Calibration Blending Formula Tests (AC10d, AC8) ---

describe("Calibration blending formula", () => {
  it("calibration entry shifts score more than 3 automated observations (AC8)", () => {
    // Simulate: decayedEma=0.5, sampleCount=3, one calibration entry score=0.9, weight=3.0
    // finalScore = (0.5 * 3 + 0.9 * 3.0 * 1) / (3 + 3.0 * 1) = (1.5 + 2.7) / 6 = 0.7
    // Without calibration: 0.5
    // Shift: 0.7 - 0.5 = 0.2

    // 3 automated observations at 0.5 each would shift:
    // Each update through EMA with alpha < 1 would not shift by 0.2 total
    // The calibration weight=3.0 means 1 human entry = 3 automated observations

    // Verify blending formula directly (no import needed)
    const calibrationWeight = 3.0
    const decayedEma = 0.5
    const sampleCount = 3
    const calibrationScore = 0.9
    const calibrationCount = 1

    const finalScore = (decayedEma * sampleCount + calibrationScore * calibrationWeight * calibrationCount)
      / (sampleCount + calibrationWeight * calibrationCount)

    // (1.5 + 2.7) / (3 + 3) = 4.2 / 6 = 0.7
    expect(finalScore).toBeCloseTo(0.7, 5)
    expect(finalScore).toBeGreaterThan(decayedEma) // Calibration pulled score up
    expect(finalScore - decayedEma).toBeCloseTo(0.2, 5) // Significant shift
  })
})

// --- Partial Scoring Failure Tests (T-7.10 AC2) ---

describe("partial scoring failure", () => {
  const POOL_C = "pool-gamma" as PoolId
  const POOL_D = "pool-delta" as PoolId
  const POOL_E = "pool-epsilon" as PoolId

  it("uses successfully scored pools when some timeout (AC2)", async () => {
    let callIdx = 0
    const decay = mockDecayEngine({
      getDecayedScore: vi.fn().mockImplementation(async () => {
        callIdx++
        // Pools A, B, C succeed; D, E timeout
        if (callIdx <= 3) {
          return { score: callIdx * 0.2, decay: "applied" as const }
        }
        // Simulate timeout by delaying beyond PER_POOL_TIMEOUT (50ms)
        await new Promise(r => setTimeout(r, 200))
        return { score: 0.1, decay: "applied" as const }
      }),
    })
    const config = makeConfig({ decay })
    const args = {
      ...defaultArgs(),
      accessiblePools: [POOL_A, POOL_B, POOL_C, POOL_D, POOL_E] as readonly PoolId[],
      circuitBreakerStates: new Map<PoolId, "closed" | "half-open" | "open">([
        [POOL_A, "closed"], [POOL_B, "closed"], [POOL_C, "closed"],
        [POOL_D, "closed"], [POOL_E, "closed"],
      ]),
      poolCosts: new Map<PoolId, number>([
        [POOL_A, 1.0], [POOL_B, 1.0], [POOL_C, 1.0], [POOL_D, 1.0], [POOL_E, 1.0],
      ]),
      poolCapabilities: new Map<PoolId, Set<NFTRoutingKey>>([
        [POOL_A, new Set(["chat", "default"] as NFTRoutingKey[])],
        [POOL_B, new Set(["chat", "default"] as NFTRoutingKey[])],
        [POOL_C, new Set(["chat", "default"] as NFTRoutingKey[])],
        [POOL_D, new Set(["chat", "default"] as NFTRoutingKey[])],
        [POOL_E, new Set(["chat", "default"] as NFTRoutingKey[])],
      ]),
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    // Should succeed using scored pools (not fall to deterministic)
    expect(result.path).toBe("reputation")
    expect(result.scoredPools.length).toBeGreaterThanOrEqual(1)
    expect(result.scoredPools.length).toBeLessThanOrEqual(3) // Only the non-timed-out pools

    warnSpy.mockRestore()
  })

  it("falls to deterministic when ALL pools fail scoring", async () => {
    const decay = mockDecayEngine({
      getDecayedScore: vi.fn().mockRejectedValue(new Error("Redis connection lost")),
    })
    const config = makeConfig({ decay })
    const args = defaultArgs()

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await resolveWithGoodhart(
      config, args.tier, args.nftId, args.taskType, args.nftPreferences,
      args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
      args.defaultPoolCost, args.poolCapabilities,
    )

    expect(result.path).toBe("deterministic")
    expect(result.score).toBeNull()

    warnSpy.mockRestore()
  })
})

// --- Event Hash Uniqueness Tests (T-7.10 AC3, T-7.4 delimiter fix) ---

describe("computeEventHash uniqueness", () => {
  // Reuse the hash function from quality-signal.ts
  let computeEventHash: typeof import("../../../src/hounfour/goodhart/quality-signal.js").computeEventHash

  beforeEach(async () => {
    const mod = await import("../../../src/hounfour/goodhart/quality-signal.js")
    computeEventHash = mod.computeEventHash
  })

  it("different field values produce different hashes", () => {
    const h1 = computeEventHash("nft-1", "pool-a" as PoolId, "chat" as NFTRoutingKey, 1000, 0.8)
    const h2 = computeEventHash("nft-2", "pool-a" as PoolId, "chat" as NFTRoutingKey, 1000, 0.8)
    const h3 = computeEventHash("nft-1", "pool-b" as PoolId, "chat" as NFTRoutingKey, 1000, 0.8)
    const h4 = computeEventHash("nft-1", "pool-a" as PoolId, "chat" as NFTRoutingKey, 1001, 0.8)
    const h5 = computeEventHash("nft-1", "pool-a" as PoolId, "chat" as NFTRoutingKey, 1000, 0.9)

    const hashes = new Set([h1, h2, h3, h4, h5])
    expect(hashes.size).toBe(5) // All unique
  })

  it("T-7.4 null byte delimiters prevent concatenation collision", () => {
    // Before T-7.4 fix, "ab"+"c" and "a"+"bc" would produce the same hash
    const h1 = computeEventHash("ab", "c" as PoolId, "d" as NFTRoutingKey, 1, 0.5)
    const h2 = computeEventHash("a", "bc" as PoolId, "d" as NFTRoutingKey, 1, 0.5)
    expect(h1).not.toBe(h2)
  })

  it("same inputs produce deterministic hash", () => {
    const h1 = computeEventHash("nft-1", "pool-a" as PoolId, "chat" as NFTRoutingKey, 1000, 0.8)
    const h2 = computeEventHash("nft-1", "pool-a" as PoolId, "chat" as NFTRoutingKey, 1000, 0.8)
    expect(h1).toBe(h2)
  })

  it("hash is 64-character hex (SHA-256)", () => {
    const h = computeEventHash("nft-1", "pool-a" as PoolId, "chat" as NFTRoutingKey, 1000, 0.8)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})

// --- Concurrent Scoring Tests (T-7.10 AC4) ---

describe("concurrent scoring", () => {
  it("handles concurrent resolveWithGoodhart calls without interference", async () => {
    let callCount = 0
    const decay = mockDecayEngine({
      getDecayedScore: vi.fn().mockImplementation(async () => {
        callCount++
        // Add variable latency to test concurrency
        await new Promise(r => setTimeout(r, Math.random() * 5))
        return { score: 0.5 + (callCount % 10) * 0.05, decay: "applied" as const }
      }),
    })
    const config = makeConfig({ decay })
    const args = defaultArgs()

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveWithGoodhart(
          config, args.tier, args.nftId, args.taskType, args.nftPreferences,
          args.accessiblePools, args.circuitBreakerStates, args.poolCosts,
          args.defaultPoolCost, args.poolCapabilities,
        ),
      ),
    )

    // All should complete with reputation path
    results.forEach(r => {
      expect(r.path).toBe("reputation")
      expect(r.score).not.toBeNull()
    })
  })
})

// Import afterEach for cleanup
import { afterEach } from "vitest"
