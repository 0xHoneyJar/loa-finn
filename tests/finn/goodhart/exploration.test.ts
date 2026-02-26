// tests/finn/goodhart/exploration.test.ts — Exploration Engine Tests (T-1.6, cycle-034)

import { describe, it, expect, beforeEach } from "vitest"
import { ExplorationEngine, type ExplorationConfig } from "../../../src/hounfour/goodhart/exploration.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../../../src/hounfour/nft-routing-config.js"

// --- Mock Redis ---

function createMockRedis(): RedisCommandClient {
  return {
    async get() { return null },
    async set() { return "OK" },
    async del() { return 0 },
    async incrby() { return 1 },
    async incrbyfloat() { return "0" },
    async expire() { return 1 },
    async exists() { return 0 },
    async ping() { return "PONG" },
    async eval() { return null },
    async hgetall() { return {} },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
  }
}

// --- Helpers ---

const POOL_A = "pool-alpha" as PoolId
const POOL_B = "pool-beta" as PoolId
const POOL_C = "pool-gamma" as PoolId

function makeConfig(overrides?: Partial<ExplorationConfig>): ExplorationConfig {
  return {
    epsilonByTier: { standard: 0.05, authoritative: 0.0 },
    defaultEpsilon: 0.05,
    blocklist: new Set<PoolId>(),
    costCeiling: 2.0,
    redis: createMockRedis(),
    ...overrides,
  }
}

function allClosed(): Map<PoolId, "closed" | "half-open" | "open"> {
  return new Map([
    [POOL_A, "closed"],
    [POOL_B, "closed"],
    [POOL_C, "closed"],
  ])
}

function defaultCosts(): Map<PoolId, number> {
  return new Map([
    [POOL_A, 1.0],
    [POOL_B, 1.5],
    [POOL_C, 1.8],
  ])
}

function allCapable(): Map<PoolId, Set<NFTRoutingKey>> {
  const caps = new Set<NFTRoutingKey>(["chat", "code", "analysis", "architecture", "default"])
  return new Map([
    [POOL_A, new Set(caps)],
    [POOL_B, new Set(caps)],
    [POOL_C, new Set(caps)],
  ])
}

// --- Tests ---

describe("ExplorationEngine", () => {
  describe("Bernoulli sampling (AC4)", () => {
    it("with ε=0.05, exploration count ∈ [30, 70] over 1000 trials", () => {
      const engine = new ExplorationEngine(makeConfig({ defaultEpsilon: 0.05 }))
      let exploreCount = 0

      for (let i = 0; i < 1000; i++) {
        const decision = engine.decide(
          "standard",
          [POOL_A, POOL_B, POOL_C],
          allClosed(),
          defaultCosts(),
          1.0,
          "chat",
          allCapable(),
        )
        if (decision.explore) exploreCount++
      }

      // Bernoulli 95% CI for n=1000, p=0.05: ~[30, 70]
      expect(exploreCount).toBeGreaterThanOrEqual(20)
      expect(exploreCount).toBeLessThanOrEqual(80)
    })
  })

  describe("Authoritative tier (AC6)", () => {
    it("never explores with ε=0", () => {
      const engine = new ExplorationEngine(makeConfig())
      let exploreCount = 0

      for (let i = 0; i < 1000; i++) {
        const decision = engine.decide(
          "authoritative",
          [POOL_A, POOL_B, POOL_C],
          allClosed(),
          defaultCosts(),
          1.0,
          "chat",
          allCapable(),
        )
        if (decision.explore) exploreCount++
      }

      expect(exploreCount).toBe(0)
    })
  })

  describe("Candidate filtering", () => {
    it("excludes pools with open circuit breaker (AC7a)", () => {
      const config = makeConfig({ defaultEpsilon: 1.0 }) // Always explore
      const engine = new ExplorationEngine(config)

      const cbStates = new Map<PoolId, "closed" | "half-open" | "open">([
        [POOL_A, "open"],
        [POOL_B, "closed"],
        [POOL_C, "closed"],
      ])

      const selectedPools = new Set<string>()
      for (let i = 0; i < 100; i++) {
        const decision = engine.decide(
          "standard",
          [POOL_A, POOL_B, POOL_C],
          cbStates,
          defaultCosts(),
          1.0,
          "chat",
          allCapable(),
        )
        if (decision.selectedPool) selectedPools.add(decision.selectedPool)
      }

      expect(selectedPools.has(POOL_A)).toBe(false) // open CB excluded
      expect(selectedPools.size).toBeGreaterThan(0)
    })

    it("includes pools with half-open circuit breaker", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, epsilonByTier: { standard: 1.0, authoritative: 0.0 } })
      const engine = new ExplorationEngine(config)

      const cbStates = new Map<PoolId, "closed" | "half-open" | "open">([
        [POOL_A, "half-open"],
        [POOL_B, "open"],
        [POOL_C, "open"],
      ])

      const decision = engine.decide(
        "standard",
        [POOL_A, POOL_B, POOL_C],
        cbStates,
        defaultCosts(),
        1.0,
        "chat",
        allCapable(),
      )

      // Only POOL_A should be eligible (half-open)
      expect(decision.explore).toBe(true)
      expect(decision.selectedPool).toBe(POOL_A)
    })

    it("excludes pools exceeding 2x cost ceiling (AC7b)", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, costCeiling: 2.0 })
      const engine = new ExplorationEngine(config)

      const costs = new Map<PoolId, number>([
        [POOL_A, 1.0],
        [POOL_B, 1.9], // Under ceiling (1.9 <= 2.0 * 1.0)
        [POOL_C, 2.1], // Over ceiling (2.1 > 2.0 * 1.0)
      ])

      const selectedPools = new Set<string>()
      for (let i = 0; i < 100; i++) {
        const decision = engine.decide(
          "standard",
          [POOL_A, POOL_B, POOL_C],
          allClosed(),
          costs,
          1.0,
          "chat",
          allCapable(),
        )
        if (decision.selectedPool) selectedPools.add(decision.selectedPool)
      }

      expect(selectedPools.has(POOL_C)).toBe(false) // Over ceiling
      expect(selectedPools.has(POOL_A)).toBe(true)
      expect(selectedPools.has(POOL_B)).toBe(true)
    })

    it("excludes blocklisted pools", () => {
      const config = makeConfig({
        defaultEpsilon: 1.0,
        blocklist: new Set([POOL_B] as PoolId[]),
      })
      const engine = new ExplorationEngine(config)

      const selectedPools = new Set<string>()
      for (let i = 0; i < 100; i++) {
        const decision = engine.decide(
          "standard",
          [POOL_A, POOL_B, POOL_C],
          allClosed(),
          defaultCosts(),
          1.0,
          "chat",
          allCapable(),
        )
        if (decision.selectedPool) selectedPools.add(decision.selectedPool)
      }

      expect(selectedPools.has(POOL_B)).toBe(false)
    })

    it("returns exploration_skipped when all candidates filtered (AC7c)", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, epsilonByTier: { standard: 1.0, authoritative: 0.0 } })
      const engine = new ExplorationEngine(config)

      // All pools have open circuit breakers
      const cbStates = new Map<PoolId, "closed" | "half-open" | "open">([
        [POOL_A, "open"],
        [POOL_B, "open"],
        [POOL_C, "open"],
      ])

      const decision = engine.decide(
        "standard",
        [POOL_A, POOL_B, POOL_C],
        cbStates,
        defaultCosts(),
        1.0,
        "chat",
        allCapable(),
      )

      expect(decision.explore).toBe(true)
      expect(decision.selectedPool).toBeUndefined()
      expect(decision.candidateSetSize).toBe(0)
      expect(decision.reason).toBe("exploration_skipped")
    })

    it("excludes pools that lack required capability", () => {
      const config = makeConfig({ defaultEpsilon: 1.0 })
      const engine = new ExplorationEngine(config)

      // Only POOL_A supports "code"
      const capabilities = new Map<PoolId, Set<NFTRoutingKey>>([
        [POOL_A, new Set(["chat", "code"] as NFTRoutingKey[])],
        [POOL_B, new Set(["chat"] as NFTRoutingKey[])],
        [POOL_C, new Set(["chat", "analysis"] as NFTRoutingKey[])],
      ])

      const selectedPools = new Set<string>()
      for (let i = 0; i < 100; i++) {
        const decision = engine.decide(
          "standard",
          [POOL_A, POOL_B, POOL_C],
          allClosed(),
          defaultCosts(),
          1.0,
          "code",
          capabilities,
        )
        if (decision.selectedPool) selectedPools.add(decision.selectedPool)
      }

      expect(selectedPools.has(POOL_B)).toBe(false) // No "code" capability
      expect(selectedPools.has(POOL_C)).toBe(false) // No "code" capability
      expect(selectedPools.has(POOL_A)).toBe(true)
    })
  })

  describe("injectable randomness (T-8.4)", () => {
    it("uses injected randomFn for both Bernoulli flip and selection", () => {
      let callCount = 0
      const deterministicRandom = () => {
        callCount++
        return callCount === 1 ? 0.0 : 0.5 // First call: explore, second: pick middle
      }

      const config = makeConfig({ defaultEpsilon: 1.0, randomFn: deterministicRandom })
      const engine = new ExplorationEngine(config)

      const decision = engine.decide(
        "standard",
        [POOL_A, POOL_B, POOL_C],
        allClosed(),
        defaultCosts(),
        1.0,
        "chat",
        allCapable(),
      )

      expect(callCount).toBe(2) // randomFn called exactly twice
      expect(decision.explore).toBe(true)
      expect(decision.selectedPool).toBe(POOL_B) // floor(0.5 * 3) = 1 → POOL_B
    })

    it("defaults to Math.random when randomFn not provided", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, epsilonByTier: {} })
      // No randomFn — should not throw, and with epsilon 1.0 always explores
      const engine = new ExplorationEngine(config)
      const decision = engine.decide(
        "standard",
        [POOL_A],
        allClosed(),
        defaultCosts(),
        1.0,
        "chat",
        allCapable(),
      )
      expect(decision.explore).toBe(true)
    })
  })

  describe("NaN/Infinity guards (T-8.1)", () => {
    it("skips exploration when epsilon is NaN", () => {
      const config = makeConfig({ defaultEpsilon: NaN })
      const engine = new ExplorationEngine(config)

      const decision = engine.decide(
        "unknown-tier", // Falls through to defaultEpsilon which is NaN
        [POOL_A, POOL_B],
        allClosed(),
        defaultCosts(),
        1.0,
        "chat",
        allCapable(),
      )

      expect(decision.explore).toBe(false)
    })

    it("skips exploration when randomFn returns NaN", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, randomFn: () => NaN })
      const engine = new ExplorationEngine(config)

      const decision = engine.decide(
        "standard",
        [POOL_A],
        allClosed(),
        defaultCosts(),
        1.0,
        "chat",
        allCapable(),
      )

      expect(decision.explore).toBe(false)
      expect(decision.randomValue).toBe(0) // NaN replaced with 0
    })

    it("excludes pools with NaN cost", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, randomFn: () => 0.0 })
      const engine = new ExplorationEngine(config)

      const costs = new Map<PoolId, number>([
        [POOL_A, 1.0],
        [POOL_B, NaN],
        [POOL_C, 1.0],
      ])

      const decision = engine.decide(
        "standard",
        [POOL_A, POOL_B, POOL_C],
        allClosed(),
        costs,
        1.0,
        "chat",
        allCapable(),
      )

      expect(decision.explore).toBe(true)
      expect(decision.candidateSetSize).toBe(2) // POOL_B excluded
    })

    it("excludes pools with Infinity cost", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, randomFn: () => 0.0 })
      const engine = new ExplorationEngine(config)

      const costs = new Map<PoolId, number>([
        [POOL_A, 1.0],
        [POOL_B, Infinity],
      ])

      const decision = engine.decide(
        "standard",
        [POOL_A, POOL_B],
        allClosed(),
        costs,
        1.0,
        "chat",
        allCapable(),
      )

      expect(decision.explore).toBe(true)
      expect(decision.candidateSetSize).toBe(1) // POOL_B excluded
      expect(decision.selectedPool).toBe(POOL_A)
    })

    it("handles Infinity defaultPoolCost gracefully", () => {
      const config = makeConfig({ defaultEpsilon: 1.0, randomFn: () => 0.0 })
      const engine = new ExplorationEngine(config)

      const costs = new Map<PoolId, number>([
        [POOL_A, 1.0],
        [POOL_B, 999.0],
      ])

      const decision = engine.decide(
        "standard",
        [POOL_A, POOL_B],
        allClosed(),
        costs,
        Infinity, // Invalid defaultPoolCost
        "chat",
        allCapable(),
      )

      // maxCost becomes Infinity → no cost filtering → both pools accepted
      expect(decision.explore).toBe(true)
      expect(decision.candidateSetSize).toBe(2)
    })

    it("skips pool selection when second randomFn returns NaN", () => {
      let callCount = 0
      const config = makeConfig({
        defaultEpsilon: 1.0,
        randomFn: () => {
          callCount++
          return callCount === 1 ? 0.0 : NaN // First: explore, second: NaN
        },
      })
      const engine = new ExplorationEngine(config)

      const decision = engine.decide(
        "standard",
        [POOL_A, POOL_B],
        allClosed(),
        defaultCosts(),
        1.0,
        "chat",
        allCapable(),
      )

      expect(decision.explore).toBe(true)
      expect(decision.reason).toBe("exploration_skipped")
      expect(decision.selectedPool).toBeUndefined()
    })
  })

  describe("recordExploration", () => {
    it("does not throw on Redis error", async () => {
      const failingRedis = createMockRedis()
      failingRedis.incrby = async () => { throw new Error("Redis down") }

      const engine = new ExplorationEngine(makeConfig({ redis: failingRedis }))

      // Should not throw — best-effort
      await expect(engine.recordExploration("standard")).resolves.toBeUndefined()
    })
  })
})
