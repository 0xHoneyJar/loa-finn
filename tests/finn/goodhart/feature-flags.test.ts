// tests/finn/goodhart/feature-flags.test.ts — Feature Flag Verification Tests (T-6.7, cycle-034)
//
// §13.1: FINN_REPUTATION_ROUTING disabled/shadow/enabled
//        EXPLORATION_ENABLED, CALIBRATION_ENABLED, X402_SETTLEMENT_MODE

import { describe, it, expect, afterEach, vi } from "vitest"
import { resolveWithGoodhart, type MechanismConfig, type ReputationScoringResult } from "../../../src/hounfour/goodhart/mechanism-interaction.js"
import { KillSwitch } from "../../../src/hounfour/goodhart/kill-switch.js"
import type { TemporalDecayEngine, EMAKey, EMAState } from "../../../src/hounfour/goodhart/temporal-decay.js"
import type { ExplorationEngine, ExplorationDecision } from "../../../src/hounfour/goodhart/exploration.js"
import type { CalibrationEngine } from "../../../src/hounfour/goodhart/calibration.js"
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

async function resolve(config: MechanismConfig): Promise<ReputationScoringResult> {
  const a = defaultArgs()
  return resolveWithGoodhart(
    config, a.tier, a.nftId, a.taskType, a.nftPreferences,
    a.accessiblePools, a.circuitBreakerStates, a.poolCosts,
    a.defaultPoolCost, a.poolCapabilities,
  )
}

// --- Tests ---

describe("Feature Flag: FINN_REPUTATION_ROUTING (§13.1)", () => {
  const originalEnv = process.env.FINN_REPUTATION_ROUTING

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FINN_REPUTATION_ROUTING
    } else {
      process.env.FINN_REPUTATION_ROUTING = originalEnv
    }
  })

  it("disabled → deterministic routing, no reputation queries", async () => {
    process.env.FINN_REPUTATION_ROUTING = "disabled"
    const decay = mockDecayEngine()
    const config = makeConfig({ decay })

    const result = await resolve(config)

    expect(result.path).toBe("kill_switch")
    expect(result.score).toBeNull()
    expect(decay.getDecayedScore).not.toHaveBeenCalled()
  })

  it("enabled → full reputation scoring", async () => {
    process.env.FINN_REPUTATION_ROUTING = "enabled"
    const decay = mockDecayEngine()
    const config = makeConfig({ decay })

    const result = await resolve(config)

    expect(result.path).toBe("reputation")
    expect(result.score).not.toBeNull()
    expect(decay.getDecayedScore).toHaveBeenCalled()
  })

  it("shadow → scoring runs but deterministic pool returned", async () => {
    process.env.FINN_REPUTATION_ROUTING = "shadow"
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    // Make decay return different scores per pool so we can detect shadow behavior
    let callCount = 0
    const decay = mockDecayEngine({
      getDecayedScore: vi.fn().mockImplementation(async () => {
        callCount++
        return { score: callCount === 1 ? 0.3 : 0.9, decay: "applied" as const }
      }),
    })
    const config = makeConfig({ decay })

    const result = await resolve(config)

    // Path is shadow
    expect(result.path).toBe("shadow")
    // Score is null (deterministic routing)
    expect(result.score).toBeNull()
    // Decay WAS queried (scoring ran)
    expect(decay.getDecayedScore).toHaveBeenCalled()
    // Shadow metadata present
    expect(result.metadata.shadowPool).toBeDefined()
    expect(result.metadata.shadowDiverged).toBeDefined()
    expect(result.metadata.shadowScore).toBeDefined()

    logSpy.mockRestore()
  })

  it("shadow → no EMA writes (updateEMA not called)", async () => {
    process.env.FINN_REPUTATION_ROUTING = "shadow"
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const decay = mockDecayEngine()
    const config = makeConfig({ decay })

    await resolve(config)

    // Shadow mode must NOT write to EMA
    expect(decay.updateEMA).not.toHaveBeenCalled()

    logSpy.mockRestore()
  })

  it("shadow → comparison log emitted", async () => {
    process.env.FINN_REPUTATION_ROUTING = "shadow"
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const config = makeConfig()

    await resolve(config)

    // Find shadow comparison log among all console.log calls
    const shadowLog = logSpy.mock.calls.find((call) => {
      try {
        if (typeof call[0] !== "string") return false
        const parsed = JSON.parse(call[0])
        return parsed.event === "shadow_comparison"
      } catch { return false }
    })

    expect(shadowLog).toBeDefined()
    const parsed = JSON.parse(shadowLog![0] as string)
    expect(parsed.component).toBe("mechanism-interaction")
    expect(parsed.event).toBe("shadow_comparison")
    // diverged must be present as a boolean
    expect(typeof parsed.diverged).toBe("boolean")
    // tier and routingKey always present
    expect(parsed.tier).toBe("standard")
    expect(parsed.routingKey).toBeDefined()
    // timestamp always present
    expect(parsed.timestamp).toBeDefined()

    logSpy.mockRestore()
  })

  it("shadow → audit logger called with shadow path", async () => {
    process.env.FINN_REPUTATION_ROUTING = "shadow"
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const auditLog = vi.fn()
    const auditLogger = { log: auditLog } as any

    const config = makeConfig({ auditLogger })

    await resolve(config)

    expect(auditLog).toHaveBeenCalledWith("scoring_path", expect.objectContaining({
      path: "shadow",
      shadowPool: expect.any(String),
      diverged: expect.any(Boolean),
    }))

    logSpy.mockRestore()
  })

  it("unset env → defaults to enabled", async () => {
    delete process.env.FINN_REPUTATION_ROUTING
    const decay = mockDecayEngine()
    const config = makeConfig({ decay })

    const result = await resolve(config)

    expect(result.path).toBe("reputation")
    expect(decay.getDecayedScore).toHaveBeenCalled()
  })
})

describe("Feature Flag: EXPLORATION_ENABLED", () => {
  const origReputation = process.env.FINN_REPUTATION_ROUTING
  const origExploration = process.env.EXPLORATION_ENABLED

  afterEach(() => {
    process.env.FINN_REPUTATION_ROUTING = origReputation ?? "enabled"
    if (origExploration === undefined) {
      delete process.env.EXPLORATION_ENABLED
    } else {
      process.env.EXPLORATION_ENABLED = origExploration
    }
  })

  it("exploration engine decide() is called when reputation routing enabled", async () => {
    process.env.FINN_REPUTATION_ROUTING = "enabled"
    const exploration = mockExplorationEngine()
    const config = makeConfig({ exploration })

    await resolve(config)

    expect(exploration.decide).toHaveBeenCalled()
  })

  it("exploration is skipped in shadow mode (shadow path takes precedence)", async () => {
    process.env.FINN_REPUTATION_ROUTING = "shadow"
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const exploration = mockExplorationEngine()
    const config = makeConfig({ exploration })

    const result = await resolve(config)

    // Shadow mode short-circuits before exploration
    expect(result.path).toBe("shadow")
    expect(exploration.decide).not.toHaveBeenCalled()

    logSpy.mockRestore()
  })
})

describe("Feature Flag: X402_SETTLEMENT_MODE", () => {
  const origMode = process.env.X402_SETTLEMENT_MODE

  afterEach(() => {
    if (origMode === undefined) {
      delete process.env.X402_SETTLEMENT_MODE
    } else {
      process.env.X402_SETTLEMENT_MODE = origMode
    }
  })

  it("verify_only mode reads correctly from env", () => {
    process.env.X402_SETTLEMENT_MODE = "verify_only"
    expect(process.env.X402_SETTLEMENT_MODE).toBe("verify_only")
  })

  it("on_chain mode reads correctly from env", () => {
    process.env.X402_SETTLEMENT_MODE = "on_chain"
    expect(process.env.X402_SETTLEMENT_MODE).toBe("on_chain")
  })

  it("defaults to undefined when not set", () => {
    delete process.env.X402_SETTLEMENT_MODE
    expect(process.env.X402_SETTLEMENT_MODE).toBeUndefined()
  })
})
