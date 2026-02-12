// tests/finn/nft-routing-config.test.ts — NFT Personality Routing Config (Task 4.1, C.1)

import { describe, it, expect } from "vitest"
import {
  validateNFTRoutingConfig,
  NFTRoutingCache,
  type NFTRoutingPolicy,
  type PersonalityRouting,
} from "../../src/hounfour/nft-routing-config.js"

// --- Fixtures ---

function makeValidConfig(overrides: Partial<NFTRoutingPolicy> = {}): NFTRoutingPolicy {
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
        preferences: {
          temperature: 0.7,
          max_tokens: 4096,
        },
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
    ...overrides,
  }
}

// --- Validation Tests ---

describe("validateNFTRoutingConfig", () => {
  it("passes valid config", () => {
    const errors = validateNFTRoutingConfig(makeValidConfig())
    expect(errors).toHaveLength(0)
  })

  it("rejects null config", () => {
    const errors = validateNFTRoutingConfig(null)
    expect(errors).toContain("Config must be a non-null object")
  })

  it("rejects missing version", () => {
    const errors = validateNFTRoutingConfig({ personalities: [] })
    expect(errors.some(e => e.includes("version"))).toBe(true)
  })

  it("rejects invalid version format", () => {
    const errors = validateNFTRoutingConfig({ version: "abc", personalities: [] })
    expect(errors.some(e => e.includes("semver"))).toBe(true)
  })

  it("rejects missing personalities array", () => {
    const errors = validateNFTRoutingConfig({ version: "1.0.0" })
    expect(errors).toContain("personalities must be an array")
  })

  it("rejects duplicate personality_id", () => {
    const config = makeValidConfig()
    config.personalities[1].personality_id = "bear-001"
    const errors = validateNFTRoutingConfig(config)
    expect(errors.some(e => e.includes("duplicated"))).toBe(true)
  })

  it("rejects empty personality_id", () => {
    const config = makeValidConfig()
    config.personalities[0].personality_id = ""
    const errors = validateNFTRoutingConfig(config)
    expect(errors.some(e => e.includes("non-empty string"))).toBe(true)
  })

  it("rejects invalid pool ID in task_routing", () => {
    const config = makeValidConfig()
    ;(config.personalities[0].task_routing as Record<string, string>).chat = "invalid-pool"
    const errors = validateNFTRoutingConfig(config)
    expect(errors.some(e => e.includes("not a valid pool ID"))).toBe(true)
  })

  it("rejects missing required task types", () => {
    const config = makeValidConfig()
    delete (config.personalities[0].task_routing as Record<string, string>).analysis
    const errors = validateNFTRoutingConfig(config)
    expect(errors.some(e => e.includes("analysis"))).toBe(true)
  })

  it("rejects temperature out of range", () => {
    const config = makeValidConfig()
    config.personalities[0].preferences = { temperature: 3 }
    const errors = validateNFTRoutingConfig(config)
    expect(errors.some(e => e.includes("temperature"))).toBe(true)
  })

  it("rejects non-integer max_tokens", () => {
    const config = makeValidConfig()
    config.personalities[0].preferences = { max_tokens: 1.5 }
    const errors = validateNFTRoutingConfig(config)
    expect(errors.some(e => e.includes("max_tokens"))).toBe(true)
  })

  it("allows config with no personalities", () => {
    const errors = validateNFTRoutingConfig({ version: "1.0.0", personalities: [] })
    expect(errors).toHaveLength(0)
  })
})

// --- Cache Tests ---

describe("NFTRoutingCache", () => {
  describe("load", () => {
    it("loads valid config", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.size).toBe(2)
      expect(cache.getVersion()).toBe("1.0.0")
    })

    it("rejects invalid config", () => {
      const cache = new NFTRoutingCache()
      expect(() => cache.load({ version: "bad", personalities: [] } as unknown as NFTRoutingPolicy))
        .toThrow("CONFIG_INVALID")
    })

    it("full-replaces on reload", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.size).toBe(2)

      // Reload with single personality
      cache.load({
        version: "2.0.0",
        personalities: [{
          personality_id: "new-001",
          task_routing: {
            chat: "cheap", analysis: "cheap", architecture: "cheap",
            code: "cheap", default: "cheap",
          },
        }],
      })

      expect(cache.size).toBe(1)
      expect(cache.has("bear-001")).toBe(false)
      expect(cache.has("new-001")).toBe(true)
      expect(cache.getVersion()).toBe("2.0.0")
    })

    it("sets loadedAt timestamp", () => {
      const cache = new NFTRoutingCache()
      const before = Date.now()
      cache.load(makeValidConfig())
      expect(cache.getLoadedAt()).toBeGreaterThanOrEqual(before)
    })
  })

  describe("resolvePool", () => {
    it("resolves task-specific pool", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.resolvePool("bear-001", "chat")).toBe("fast-code")
      expect(cache.resolvePool("bear-001", "analysis")).toBe("reasoning")
      expect(cache.resolvePool("bear-001", "architecture")).toBe("architect")
    })

    it("uses default for unknown task type", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.resolvePool("bear-001", "default")).toBe("cheap")
    })

    it("returns null for unknown personality", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.resolvePool("unknown-999", "chat")).toBeNull()
    })
  })

  describe("getPreferences", () => {
    it("returns preferences for personality with them", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      const prefs = cache.getPreferences("bear-001")
      expect(prefs).not.toBeNull()
      expect(prefs!.temperature).toBe(0.7)
      expect(prefs!.max_tokens).toBe(4096)
    })

    it("returns null for personality without preferences", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.getPreferences("bear-002")).toBeNull()
    })

    it("returns null for unknown personality", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.getPreferences("unknown")).toBeNull()
    })
  })

  describe("listPersonalities", () => {
    it("lists all personality IDs", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      const ids = cache.listPersonalities()
      expect(ids).toContain("bear-001")
      expect(ids).toContain("bear-002")
      expect(ids).toHaveLength(2)
    })
  })

  describe("clear", () => {
    it("clears all entries", () => {
      const cache = new NFTRoutingCache()
      cache.load(makeValidConfig())
      expect(cache.size).toBe(2)

      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.getVersion()).toBe("0.0.0")
      expect(cache.getLoadedAt()).toBe(0)
    })
  })

  describe("scale", () => {
    it("handles 1000 personality entries", () => {
      const cache = new NFTRoutingCache()
      const personalities: PersonalityRouting[] = Array.from({ length: 1000 }, (_, i) => ({
        personality_id: `bear-${String(i).padStart(4, "0")}`,
        task_routing: {
          chat: "fast-code" as const,
          analysis: "reasoning" as const,
          architecture: "architect" as const,
          code: "fast-code" as const,
          default: "cheap" as const,
        },
      }))

      cache.load({ version: "1.0.0", personalities })

      expect(cache.size).toBe(1000)
      expect(cache.resolvePool("bear-0500", "chat")).toBe("fast-code")
      expect(cache.resolvePool("bear-0999", "analysis")).toBe("reasoning")
    })
  })
})
