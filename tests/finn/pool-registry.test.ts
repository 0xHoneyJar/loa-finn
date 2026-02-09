// tests/finn/pool-registry.test.ts — Model Pool Registry tests (T-A.4)

import { describe, it, expect } from "vitest"
import { PoolRegistry, DEFAULT_POOLS } from "../../src/hounfour/pool-registry.js"
import type { PoolConfig, Tier } from "../../src/hounfour/pool-registry.js"

function makePool(overrides: Partial<PoolConfig> & { id: string }): PoolConfig {
  return {
    description: `Pool ${overrides.id}`,
    provider: "test-provider",
    model: "test-model",
    capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
    tierAccess: ["free", "pro", "enterprise"],
    ...overrides,
  }
}

describe("PoolRegistry (T-A.4)", () => {
  describe("constructor", () => {
    it("creates registry with default pools", () => {
      const registry = new PoolRegistry(DEFAULT_POOLS)
      expect(registry.size).toBe(5)
    })

    it("throws on duplicate pool ID", () => {
      expect(() => new PoolRegistry([
        makePool({ id: "dup" }),
        makePool({ id: "dup" }),
      ])).toThrow("Duplicate pool ID: dup")
    })

    it("throws on unknown fallback reference", () => {
      expect(() => new PoolRegistry([
        makePool({ id: "a", fallback: "nonexistent" }),
      ])).toThrow('Pool "a" references unknown fallback "nonexistent"')
    })

    it("throws on circular fallback chain", () => {
      expect(() => new PoolRegistry([
        makePool({ id: "a", fallback: "b" }),
        makePool({ id: "b", fallback: "a" }),
      ])).toThrow("Circular fallback chain detected")
    })

    it("allows linear fallback chain", () => {
      const registry = new PoolRegistry([
        makePool({ id: "a", fallback: "b" }),
        makePool({ id: "b", fallback: "c" }),
        makePool({ id: "c" }),
      ])
      expect(registry.size).toBe(3)
    })
  })

  describe("resolve", () => {
    it("returns pool definition for known ID", () => {
      const registry = new PoolRegistry(DEFAULT_POOLS)
      const pool = registry.resolve("cheap")
      expect(pool).not.toBeNull()
      expect(pool!.id).toBe("cheap")
      expect(pool!.provider).toBe("qwen-local")
    })

    it("returns null for unknown pool ID", () => {
      const registry = new PoolRegistry(DEFAULT_POOLS)
      expect(registry.resolve("nonexistent")).toBeNull()
    })
  })

  describe("authorize", () => {
    const registry = new PoolRegistry(DEFAULT_POOLS)

    it("free tier → cheap only", () => {
      expect(registry.authorize("cheap", "free")).toBe(true)
      expect(registry.authorize("fast-code", "free")).toBe(false)
      expect(registry.authorize("reviewer", "free")).toBe(false)
      expect(registry.authorize("reasoning", "free")).toBe(false)
      expect(registry.authorize("architect", "free")).toBe(false)
    })

    it("pro tier → cheap + fast-code + reviewer", () => {
      expect(registry.authorize("cheap", "pro")).toBe(true)
      expect(registry.authorize("fast-code", "pro")).toBe(true)
      expect(registry.authorize("reviewer", "pro")).toBe(true)
      expect(registry.authorize("reasoning", "pro")).toBe(false)
      expect(registry.authorize("architect", "pro")).toBe(false)
    })

    it("enterprise tier → all pools", () => {
      expect(registry.authorize("cheap", "enterprise")).toBe(true)
      expect(registry.authorize("fast-code", "enterprise")).toBe(true)
      expect(registry.authorize("reviewer", "enterprise")).toBe(true)
      expect(registry.authorize("reasoning", "enterprise")).toBe(true)
      expect(registry.authorize("architect", "enterprise")).toBe(true)
    })

    it("returns false for unknown pool ID", () => {
      expect(registry.authorize("nonexistent", "enterprise")).toBe(false)
    })
  })

  describe("resolveForTier", () => {
    const registry = new PoolRegistry(DEFAULT_POOLS)

    it("free tier gets 1 pool", () => {
      const pools = registry.resolveForTier("free")
      expect(pools.length).toBe(1)
      expect(pools[0].id).toBe("cheap")
    })

    it("pro tier gets 3 pools", () => {
      const pools = registry.resolveForTier("pro")
      expect(pools.length).toBe(3)
      const ids = pools.map(p => p.id).sort()
      expect(ids).toEqual(["cheap", "fast-code", "reviewer"])
    })

    it("enterprise tier gets all 5 pools", () => {
      const pools = registry.resolveForTier("enterprise")
      expect(pools.length).toBe(5)
    })
  })

  describe("validatePreferences", () => {
    const registry = new PoolRegistry(DEFAULT_POOLS)

    it("valid preferences pass validation", () => {
      const result = registry.validatePreferences({
        chat: "fast-code",
        review: "reviewer",
      })
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("unknown pool ID fails validation", () => {
      const result = registry.validatePreferences({
        chat: "nonexistent",
      })
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("nonexistent")
    })

    it("empty preferences pass validation", () => {
      const result = registry.validatePreferences({})
      expect(result.valid).toBe(true)
    })

    it("multiple invalid preferences report all errors", () => {
      const result = registry.validatePreferences({
        a: "bad1",
        b: "bad2",
        c: "cheap",
      })
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(2)
    })
  })

  describe("resolveWithFallback", () => {
    it("returns primary pool when healthy", () => {
      const registry = new PoolRegistry(DEFAULT_POOLS)
      const pool = registry.resolveWithFallback("fast-code", () => true)
      expect(pool).not.toBeNull()
      expect(pool!.id).toBe("fast-code")
    })

    it("follows fallback when primary unhealthy", () => {
      // fast-code (qwen-local) → cheap (qwen-local): both same provider, both unhealthy → null
      const registry = new PoolRegistry(DEFAULT_POOLS)
      const unhealthy = new Set(["qwen-local"])
      const pool = registry.resolveWithFallback("fast-code", (p) => !unhealthy.has(p))
      expect(pool).toBeNull() // both use qwen-local

      // reviewer (openai) → fast-code (qwen-local): openai down, falls back to fast-code
      const unhealthyOpenai = new Set(["openai"])
      const pool2 = registry.resolveWithFallback("reviewer", (p) => !unhealthyOpenai.has(p))
      expect(pool2).not.toBeNull()
      expect(pool2!.id).toBe("fast-code")
    })

    it("returns null when all fallbacks unhealthy", () => {
      const registry = new PoolRegistry(DEFAULT_POOLS)
      const pool = registry.resolveWithFallback("fast-code", () => false)
      expect(pool).toBeNull()
    })

    it("follows multi-hop fallback chain", () => {
      const registry = new PoolRegistry([
        makePool({ id: "a", provider: "p1", fallback: "b" }),
        makePool({ id: "b", provider: "p2", fallback: "c" }),
        makePool({ id: "c", provider: "p3" }),
      ])
      const unhealthy = new Set(["p1", "p2"])
      const pool = registry.resolveWithFallback("a", (p) => !unhealthy.has(p))
      expect(pool).not.toBeNull()
      expect(pool!.id).toBe("c")
    })

    it("returns null for unknown pool ID", () => {
      const registry = new PoolRegistry(DEFAULT_POOLS)
      const pool = registry.resolveWithFallback("nonexistent", () => true)
      expect(pool).toBeNull()
    })
  })

  describe("getPoolIds", () => {
    it("returns all pool IDs", () => {
      const registry = new PoolRegistry(DEFAULT_POOLS)
      const ids = registry.getPoolIds().sort()
      expect(ids).toEqual(["architect", "cheap", "fast-code", "reasoning", "reviewer"])
    })
  })
})
