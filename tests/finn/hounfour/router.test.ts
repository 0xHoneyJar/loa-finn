// tests/finn/hounfour/router.test.ts — Router Integration Tests (T-7.9)
//
// Covers the 4-state routing machine in resolvePoolForRequest():
//   disabled → deterministic
//   init_failed → deterministic + counter
//   shadow → run Goodhart, log divergence, return deterministic
//   enabled → reputation result or fallback
// Plus KillSwitch override and edge cases.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"

// --- Mock modules before import ---

// Mock tier-bridge to control deterministic pool resolution
vi.mock("../../../src/hounfour/tier-bridge.js", () => ({
  resolvePool: vi.fn().mockReturnValue("pool-deterministic"),
}))

// Mock resolve.ts to control Goodhart results
vi.mock("../../../src/hounfour/goodhart/resolve.js", () => ({
  resolveWithGoodhart: vi.fn().mockResolvedValue(null),
}))

// Mock routing-events to capture emitted events
vi.mock("../../../src/hounfour/goodhart/routing-events.js", () => ({
  emitRoutingOverride: vi.fn(),
}))

// Mock other imports that router.ts pulls in
vi.mock("../../../src/hounfour/registry.js", () => ({
  validateCapabilities: vi.fn(),
}))
vi.mock("../../../src/hounfour/cheval-invoker.js", () => ({
  createModelAdapter: vi.fn(),
}))
vi.mock("../../../src/hounfour/persona-loader.js", () => ({
  loadPersona: vi.fn(),
}))
vi.mock("../../../src/hounfour/types.js", () => ({
  validateExecutionContext: vi.fn(),
}))
vi.mock("../../../src/hounfour/pool-enforcement.js", () => ({
  selectAuthorizedPool: vi.fn(),
  selectAffinityRankedPools: vi.fn(),
}))
vi.mock("../../../src/gateway/metrics-endpoint.js", () => ({
  metrics: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
}))
vi.mock("../../../src/hounfour/knowledge-enricher.js", () => ({
  enrichSystemPrompt: vi.fn(),
}))

import { HounfourRouter, type RoutingState } from "../../../src/hounfour/router.js"
import type { GoodhartRuntime } from "../../../src/hounfour/goodhart/init.js"
import type { MechanismConfig } from "../../../src/hounfour/goodhart/mechanism-interaction.js"
import { resolvePool } from "../../../src/hounfour/tier-bridge.js"
import { resolveWithGoodhart } from "../../../src/hounfour/goodhart/resolve.js"
import { emitRoutingOverride } from "../../../src/hounfour/goodhart/routing-events.js"

// --- Helpers ---

function createMockMetrics() {
  return {
    recordRoutingDuration: vi.fn(),
    recordShadowDecision: vi.fn(),
    killswitchActivatedTotal: { inc: vi.fn() },
    killswitchCheckFailedTotal: { inc: vi.fn() },
    goodhartInitFailed: { inc: vi.fn() },
    goodhartInitFailedRequests: { inc: vi.fn() },
    goodhartTimeoutTotal: { inc: vi.fn() },
    setRoutingMode: vi.fn(),
    recoveryAttemptTotal: { inc: vi.fn() },
    recoverySuccessTotal: { inc: vi.fn() },
  } as any
}

function createMockKillSwitch(state: "normal" | "disabled" = "normal") {
  return {
    getState: vi.fn().mockResolvedValue(state),
  }
}

function createMockConfig(overrides: Partial<MechanismConfig> = {}): MechanismConfig {
  return {
    decay: {} as any,
    exploration: {} as any,
    calibration: {} as any,
    killSwitch: createMockKillSwitch(),
    explorationFeedbackWeight: 0.5,
    metrics: createMockMetrics(),
    ...overrides,
  }
}

function createRuntime(
  routingState: RoutingState = "disabled",
  goodhartConfig?: MechanismConfig,
  metrics?: any,
): GoodhartRuntime {
  return {
    routingState,
    goodhartConfig,
    goodhartMetrics: metrics ?? createMockMetrics(),
  }
}

function createRouter(runtime: GoodhartRuntime): HounfourRouter {
  return new HounfourRouter({
    registry: {} as any,
    budget: {} as any,
    health: {} as any,
    cheval: {} as any,
    scopeMeta: { projectId: "test", phaseId: "test", sprintId: "test" },
    goodhartRuntime: runtime,
  })
}

const defaultArgs = {
  tier: "free" as any,
  nftId: "nft-001",
  taskType: "chat",
  nftPreferences: undefined,
  accessiblePools: ["pool-a", "pool-b"] as readonly string[],
  circuitBreakerStates: new Map<string, "closed" | "half-open" | "open">(),
  poolCosts: new Map<string, number>(),
  defaultPoolCost: 1.0,
  poolCapabilities: new Map<string, Set<string>>(),
  requestId: "req-001",
}

function callResolve(router: HounfourRouter) {
  return router.resolvePoolForRequest(
    defaultArgs.tier,
    defaultArgs.nftId,
    defaultArgs.taskType,
    defaultArgs.nftPreferences,
    defaultArgs.accessiblePools,
    defaultArgs.circuitBreakerStates,
    defaultArgs.poolCosts,
    defaultArgs.defaultPoolCost,
    defaultArgs.poolCapabilities as any,
    defaultArgs.requestId,
  )
}

// --- Tests ---

describe("HounfourRouter.resolvePoolForRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(resolvePool as Mock).mockReturnValue("pool-deterministic")
    ;(resolveWithGoodhart as Mock).mockResolvedValue(null)
  })

  // === State: disabled ===

  describe("routing state: disabled", () => {
    it("returns deterministic pool", async () => {
      const runtime = createRuntime("disabled")
      const router = createRouter(runtime)

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-deterministic", source: "deterministic" })
    })

    it("records disabled duration metric", async () => {
      const metrics = createMockMetrics()
      const runtime = createRuntime("disabled", undefined, metrics)
      const router = createRouter(runtime)

      await callResolve(router)

      expect(metrics.recordRoutingDuration).toHaveBeenCalledWith("disabled", expect.any(Number))
    })

    it("does not invoke Goodhart resolve", async () => {
      const runtime = createRuntime("disabled")
      const router = createRouter(runtime)

      await callResolve(router)

      expect(resolveWithGoodhart).not.toHaveBeenCalled()
    })
  })

  // === State: init_failed ===

  describe("routing state: init_failed", () => {
    it("returns deterministic pool", async () => {
      const runtime = createRuntime("init_failed")
      const router = createRouter(runtime)

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-deterministic", source: "deterministic" })
    })

    it("increments init_failed request counter", async () => {
      const metrics = createMockMetrics()
      const runtime = createRuntime("init_failed", undefined, metrics)
      const router = createRouter(runtime)

      await callResolve(router)

      expect(metrics.goodhartInitFailedRequests.inc).toHaveBeenCalled()
    })

    it("records init_failed duration metric", async () => {
      const metrics = createMockMetrics()
      const runtime = createRuntime("init_failed", undefined, metrics)
      const router = createRouter(runtime)

      await callResolve(router)

      expect(metrics.recordRoutingDuration).toHaveBeenCalledWith("init_failed", expect.any(Number))
    })
  })

  // === State: shadow ===

  describe("routing state: shadow", () => {
    it("returns deterministic pool regardless of reputation result", async () => {
      const config = createMockConfig()
      const runtime = createRuntime("shadow", config)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue({
        pool: "pool-reputation",
        score: 0.85,
        explored: false,
        scoredPools: [{ pool: "pool-reputation", score: 0.85 }],
        path: "reputation",
      })

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-deterministic", source: "shadow" })
    })

    it("invokes Goodhart resolve in shadow mode", async () => {
      const config = createMockConfig()
      const runtime = createRuntime("shadow", config)
      const router = createRouter(runtime)

      await callResolve(router)

      expect(resolveWithGoodhart).toHaveBeenCalledWith(
        config,
        defaultArgs.tier,
        defaultArgs.nftId,
        defaultArgs.taskType,
        defaultArgs.nftPreferences,
        defaultArgs.accessiblePools,
        defaultArgs.circuitBreakerStates,
        defaultArgs.poolCosts,
        defaultArgs.defaultPoolCost,
        defaultArgs.poolCapabilities,
        { mode: "shadow" },
        runtime.goodhartMetrics,
      )
    })

    it("records shadow decision with divergence=true when pools differ", async () => {
      const metrics = createMockMetrics()
      const config = createMockConfig({ metrics })
      const runtime = createRuntime("shadow", config, metrics)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue({
        pool: "pool-reputation",
        score: 0.85,
        explored: false,
        scoredPools: [{ pool: "pool-reputation", score: 0.85 }],
        path: "reputation",
      })

      await callResolve(router)

      expect(metrics.recordShadowDecision).toHaveBeenCalledWith(defaultArgs.tier, true)
    })

    it("records shadow decision with divergence=false when pools match", async () => {
      const metrics = createMockMetrics()
      const config = createMockConfig({ metrics })
      const runtime = createRuntime("shadow", config, metrics)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue({
        pool: "pool-deterministic",
        score: 0.85,
        explored: false,
        scoredPools: [],
        path: "reputation",
      })

      await callResolve(router)

      expect(metrics.recordShadowDecision).toHaveBeenCalledWith(defaultArgs.tier, false)
    })

    it("handles null Goodhart result gracefully in shadow", async () => {
      const config = createMockConfig()
      const runtime = createRuntime("shadow", config)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue(null)

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-deterministic", source: "shadow" })
    })
  })

  // === State: enabled ===

  describe("routing state: enabled", () => {
    it("returns reputation pool when Goodhart returns a result", async () => {
      const config = createMockConfig()
      const runtime = createRuntime("enabled", config)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue({
        pool: "pool-reputation",
        score: 0.9,
        explored: false,
        scoredPools: [{ pool: "pool-reputation", score: 0.9 }],
        path: "reputation",
      })

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-reputation", source: "reputation" })
    })

    it("falls back to deterministic when Goodhart returns null", async () => {
      const config = createMockConfig()
      const runtime = createRuntime("enabled", config)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue(null)

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-deterministic", source: "deterministic" })
    })

    it("records reputation duration metric on success", async () => {
      const metrics = createMockMetrics()
      const config = createMockConfig({ metrics })
      const runtime = createRuntime("enabled", config, metrics)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue({
        pool: "pool-reputation",
        score: 0.9,
        explored: false,
        scoredPools: [],
        path: "reputation",
      })

      await callResolve(router)

      expect(metrics.recordRoutingDuration).toHaveBeenCalledWith("reputation", expect.any(Number))
    })

    it("records fallback duration metric when Goodhart returns null", async () => {
      const metrics = createMockMetrics()
      const config = createMockConfig({ metrics })
      const runtime = createRuntime("enabled", config, metrics)
      const router = createRouter(runtime)

      ;(resolveWithGoodhart as Mock).mockResolvedValue(null)

      await callResolve(router)

      expect(metrics.recordRoutingDuration).toHaveBeenCalledWith("fallback", expect.any(Number))
    })
  })

  // === KillSwitch override ===

  describe("KillSwitch override", () => {
    it("returns deterministic when killswitch is disabled (kill state)", async () => {
      const killSwitch = createMockKillSwitch("disabled")
      const config = createMockConfig({ killSwitch })
      const runtime = createRuntime("enabled", config)
      const router = createRouter(runtime)

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-deterministic", source: "deterministic" })
      expect(resolveWithGoodhart).not.toHaveBeenCalled()
    })

    it("emits killswitch activated event on first kill", async () => {
      const killSwitch = createMockKillSwitch("disabled")
      const config = createMockConfig({ killSwitch })
      const runtime = createRuntime("enabled", config)
      const router = createRouter(runtime)

      await callResolve(router)

      expect(emitRoutingOverride).toHaveBeenCalledWith("killswitch", "activated")
    })

    it("does not emit activated again on consecutive kill checks", async () => {
      const killSwitch = createMockKillSwitch("disabled")
      const config = createMockConfig({ killSwitch })
      const runtime = createRuntime("enabled", config)
      const router = createRouter(runtime)

      await callResolve(router)
      await callResolve(router)

      // Should only be called once (state change, not every request)
      expect(emitRoutingOverride).toHaveBeenCalledTimes(1)
    })

    it("emits deactivated when killswitch transitions from kill to normal", async () => {
      const killSwitch = createMockKillSwitch("disabled")
      const config = createMockConfig({ killSwitch })
      const runtime = createRuntime("enabled", config)
      const router = createRouter(runtime)

      // First call: killswitch active
      await callResolve(router)
      vi.clearAllMocks()

      // Transition to normal
      killSwitch.getState.mockResolvedValue("normal")
      ;(resolveWithGoodhart as Mock).mockResolvedValue(null)
      ;(resolvePool as Mock).mockReturnValue("pool-deterministic")

      await callResolve(router)

      expect(emitRoutingOverride).toHaveBeenCalledWith("killswitch", "deactivated")
    })

    it("proceeds with routing state when killswitch is normal", async () => {
      const killSwitch = createMockKillSwitch("normal")
      const config = createMockConfig({ killSwitch })
      const runtime = createRuntime("shadow", config)
      const router = createRouter(runtime)

      const result = await callResolve(router)

      expect(result.source).toBe("shadow")
      expect(resolveWithGoodhart).toHaveBeenCalled()
    })

    it("fail-opens on killswitch check error", async () => {
      const killSwitch = {
        getState: vi.fn().mockRejectedValue(new Error("Redis timeout")),
      }
      const metrics = createMockMetrics()
      const config = createMockConfig({ killSwitch, metrics })
      const runtime = createRuntime("shadow", config, metrics)
      const router = createRouter(runtime)

      const result = await callResolve(router)

      // Should continue to shadow mode (fail-open)
      expect(result.source).toBe("shadow")
      expect(metrics.killswitchCheckFailedTotal.inc).toHaveBeenCalled()
    })

    it("increments killswitch activated counter", async () => {
      const killSwitch = createMockKillSwitch("disabled")
      const metrics = createMockMetrics()
      const config = createMockConfig({ killSwitch, metrics })
      const runtime = createRuntime("enabled", config, metrics)
      const router = createRouter(runtime)

      await callResolve(router)

      expect(metrics.killswitchActivatedTotal.inc).toHaveBeenCalled()
    })
  })

  // === Edge cases ===

  describe("edge cases", () => {
    it("falls back to deterministic when goodhartConfig is undefined in shadow/enabled", async () => {
      const runtime = createRuntime("shadow", undefined)
      const router = createRouter(runtime)

      const result = await callResolve(router)

      expect(result).toEqual({ pool: "pool-deterministic", source: "deterministic" })
    })

    it("router reads from shared GoodhartRuntime holder (live updates)", async () => {
      const runtime = createRuntime("disabled")
      const router = createRouter(runtime)

      // Initially disabled
      let result = await callResolve(router)
      expect(result.source).toBe("deterministic")

      // Simulate recovery updating the holder
      const config = createMockConfig()
      runtime.goodhartConfig = config
      runtime.routingState = "enabled"
      ;(resolveWithGoodhart as Mock).mockResolvedValue({
        pool: "pool-reputation",
        score: 0.9,
        explored: false,
        scoredPools: [],
        path: "reputation",
      })

      // Router should now use enabled path
      result = await callResolve(router)
      expect(result).toEqual({ pool: "pool-reputation", source: "reputation" })
    })

    it("handles concurrent requests without interference", async () => {
      const config = createMockConfig()
      const runtime = createRuntime("enabled", config)
      const router = createRouter(runtime)

      let callCount = 0
      ;(resolveWithGoodhart as Mock).mockImplementation(async () => {
        callCount++
        // Simulate varying latency
        await new Promise(r => setTimeout(r, Math.random() * 10))
        return {
          pool: `pool-${callCount}`,
          score: 0.9,
          explored: false,
          scoredPools: [],
          path: "reputation",
        }
      })

      const results = await Promise.all([
        callResolve(router),
        callResolve(router),
        callResolve(router),
      ])

      // All should complete without error
      expect(results).toHaveLength(3)
      results.forEach(r => expect(r.source).toBe("reputation"))
    })

    it("returns deterministic with killswitch duration when killswitch kills", async () => {
      const killSwitch = createMockKillSwitch("disabled")
      const metrics = createMockMetrics()
      const config = createMockConfig({ killSwitch, metrics })
      const runtime = createRuntime("enabled", config, metrics)
      const router = createRouter(runtime)

      await callResolve(router)

      expect(metrics.recordRoutingDuration).toHaveBeenCalledWith("kill_switch", expect.any(Number))
    })
  })
})
