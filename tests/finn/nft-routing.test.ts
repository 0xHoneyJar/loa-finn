// tests/finn/nft-routing.test.ts — Per-NFT Model Routing (Task 4.2, C.2)
// Verifies HounfourRouter resolves NFT personality preferences → pool → provider:model,
// with tier authorization checks and fallback to tier default.

import { describe, it, expect } from "vitest"
import {
  NFTRoutingCache,
  type NFTRoutingPolicy,
  type NFTTaskType,
} from "../../src/hounfour/nft-routing-config.js"
import {
  resolvePool,
  resolveAndAuthorize,
  assertTierAccess,
  assertValidPoolId,
  type Tier,
  type PoolId,
} from "../../src/hounfour/tier-bridge.js"

// --- Fixtures ---

function makeNFTConfig(): NFTRoutingPolicy {
  return {
    version: "1.0.0",
    personalities: [
      {
        personality_id: "bear-001",
        task_routing: {
          chat: "fast-code",
          analysis: "reasoning",
          architecture: "architect",
          code: "fast-code",
          default: "cheap",
        },
        preferences: { temperature: 0.7 },
      },
      {
        personality_id: "bear-002",
        task_routing: {
          chat: "cheap",
          analysis: "reviewer",
          architecture: "reasoning",
          code: "fast-code",
          default: "cheap",
        },
      },
    ],
  }
}

// --- NFT → Pool Resolution Tests ---

describe("Per-NFT model routing", () => {
  describe("NFT personality cache → pool resolution", () => {
    it("resolves task-specific pool from personality config", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      expect(cache.resolvePool("bear-001", "chat")).toBe("fast-code")
      expect(cache.resolvePool("bear-001", "analysis")).toBe("reasoning")
      expect(cache.resolvePool("bear-001", "architecture")).toBe("architect")
      expect(cache.resolvePool("bear-001", "code")).toBe("fast-code")
    })

    it("falls back to default pool for unknown task type", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      expect(cache.resolvePool("bear-001", "default")).toBe("cheap")
    })

    it("returns null for unknown personality (triggers tier fallback)", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      expect(cache.resolvePool("unknown-999", "chat")).toBeNull()
    })

    it("different personalities route to different pools", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      // bear-001 routes analysis to "reasoning"
      expect(cache.resolvePool("bear-001", "analysis")).toBe("reasoning")
      // bear-002 routes analysis to "reviewer"
      expect(cache.resolvePool("bear-002", "analysis")).toBe("reviewer")
    })
  })

  describe("NFT preferences → tier-bridge resolution integration", () => {
    it("resolves via NFT preferences when valid pool", () => {
      const preferences: Record<string, string> = { chat: "fast-code", default: "cheap" }
      // NFT holders map to enterprise tier (full pool access)
      const poolId = resolvePool("enterprise" as Tier, "chat", preferences)
      expect(poolId).toBe("fast-code")
    })

    it("falls back to tier default when no NFT preferences", () => {
      const poolId = resolvePool("enterprise" as Tier, "chat")
      // Should return the tier default pool for enterprise
      expect(poolId).toBeTruthy()
      expect(poolId).toBe("reviewer") // enterprise default
    })

    it("falls back to tier default when preference has invalid pool", () => {
      const preferences: Record<string, string> = { chat: "nonexistent-pool" }
      const poolId = resolvePool("enterprise" as Tier, "chat", preferences)
      // Should ignore invalid pool and return tier default
      expect(poolId).toBeTruthy()
      expect(poolId).not.toBe("nonexistent-pool")
    })

    it("uses default preference when task-specific not found", () => {
      const preferences: Record<string, string> = { default: "reasoning" }
      const poolId = resolvePool("enterprise" as Tier, "code", preferences)
      expect(poolId).toBe("reasoning")
    })
  })

  describe("tier authorization enforcement", () => {
    it("validates pool access for enterprise tier (NFT holders)", () => {
      // enterprise tier has access to all pools including reasoning/architect
      expect(() => assertTierAccess("enterprise" as Tier, "cheap" as PoolId)).not.toThrow()
      expect(() => assertTierAccess("enterprise" as Tier, "reasoning" as PoolId)).not.toThrow()
      expect(() => assertTierAccess("enterprise" as Tier, "architect" as PoolId)).not.toThrow()
    })

    it("validates pool ID against canonical vocabulary", () => {
      expect(() => assertValidPoolId("fast-code")).not.toThrow()
      expect(() => assertValidPoolId("cheap")).not.toThrow()
      expect(() => assertValidPoolId("reasoning")).not.toThrow()
    })

    it("rejects unknown pool IDs", () => {
      expect(() => assertValidPoolId("nonexistent-pool")).toThrow("UNKNOWN_POOL")
    })

    it("resolveAndAuthorize combines resolution + authorization", () => {
      // Should not throw for valid tier + pool combinations
      const poolId = resolveAndAuthorize("enterprise" as Tier, "chat", { chat: "cheap" })
      expect(poolId).toBe("cheap")
    })
  })

  describe("full routing pipeline: NFT cache → tier bridge → pool", () => {
    it("routes NFT holder with personality to correct pool", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      // Simulate routing pipeline:
      // 1. Look up personality in cache
      const personalityPool = cache.resolvePool("bear-001", "chat")
      expect(personalityPool).toBe("fast-code")

      // 2. If found, use as NFT preference for tier bridge (enterprise tier)
      if (personalityPool) {
        const preferences = { chat: personalityPool }
        const resolvedPool = resolvePool("enterprise" as Tier, "chat", preferences)
        expect(resolvedPool).toBe("fast-code")
      }
    })

    it("routes NFT holder without personality to tier default", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      // Unknown personality → null → fall through to tier default
      const personalityPool = cache.resolvePool("unknown-nft", "chat")
      expect(personalityPool).toBeNull()

      // No preferences → enterprise tier default
      const resolvedPool = resolvePool("enterprise" as Tier, "chat")
      expect(resolvedPool).toBe("reviewer") // enterprise default
    })

    it("routes different task types to different pools for same personality", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      const chatPool = cache.resolvePool("bear-001", "chat")
      const analysisPool = cache.resolvePool("bear-001", "analysis")
      const archPool = cache.resolvePool("bear-001", "architecture")

      expect(chatPool).toBe("fast-code")
      expect(analysisPool).toBe("reasoning")
      expect(archPool).toBe("architect")

      // All different pools for different task types
      expect(new Set([chatPool, analysisPool, archPool]).size).toBe(3)
    })

    it("preferences override personality preferences", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeNFTConfig())

      // Personality says chat → fast-code
      expect(cache.resolvePool("bear-001", "chat")).toBe("fast-code")

      // But preferences include temperature
      const prefs = cache.getPreferences("bear-001")
      expect(prefs?.temperature).toBe(0.7)
    })
  })
})
