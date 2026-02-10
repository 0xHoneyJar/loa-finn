// tests/finn/pool-registry-validation.test.ts — Pool Registry Provider Validation (T-31.4)

import { describe, it, expect } from "vitest"
import { PoolRegistry } from "../../src/hounfour/pool-registry.js"
import type { PoolConfig, ProviderRegistryLike } from "../../src/hounfour/pool-registry.js"
import type { ModelEntry } from "../../src/hounfour/types.js"

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

function makeProviderRegistry(
  providers: Record<string, string[]>, // provider → model IDs
): ProviderRegistryLike {
  return {
    getProvider(name: string) {
      if (name in providers) return { name }
      return undefined
    },
    getModel(provider: string, modelId: string): ModelEntry | undefined {
      if (providers[provider]?.includes(modelId)) {
        return {
          id: modelId,
          name: modelId,
          capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
          limit: { context: 128000, output: 4096 },
        }
      }
      return undefined
    },
  }
}

describe("Pool Registry Provider Validation (T-31.4)", () => {
  describe("without provider registry (backward compatible)", () => {
    it("constructs without validation when no registry provided", () => {
      const registry = new PoolRegistry([
        makePool({ id: "a", provider: "any-provider", model: "any-model" }),
      ])
      expect(registry.size).toBe(1)
    })
  })

  describe("with provider registry", () => {
    it("valid pools construct without error", () => {
      const providerReg = makeProviderRegistry({
        "test-provider": ["test-model"],
      })
      const registry = new PoolRegistry(
        [makePool({ id: "a" })],
        providerReg,
      )
      expect(registry.size).toBe(1)
    })

    it("pool referencing nonexistent provider throws at construction", () => {
      const providerReg = makeProviderRegistry({
        "real-provider": ["real-model"],
      })
      expect(() => new PoolRegistry(
        [makePool({ id: "a", provider: "nonexistent-provider", model: "some-model" })],
        providerReg,
      )).toThrow('Pool "a" references unknown provider "nonexistent-provider"')
    })

    it("pool referencing nonexistent model throws at construction", () => {
      const providerReg = makeProviderRegistry({
        "test-provider": ["model-a", "model-b"],
      })
      expect(() => new PoolRegistry(
        [makePool({ id: "a", provider: "test-provider", model: "nonexistent-model" })],
        providerReg,
      )).toThrow('Pool "a" references unknown model "nonexistent-model" in provider "test-provider"')
    })

    it("multiple valid pools with different providers", () => {
      const providerReg = makeProviderRegistry({
        "openai": ["gpt-4o"],
        "anthropic": ["claude-opus-4-6"],
      })
      const registry = new PoolRegistry(
        [
          makePool({ id: "a", provider: "openai", model: "gpt-4o" }),
          makePool({ id: "b", provider: "anthropic", model: "claude-opus-4-6", fallback: "a" }),
        ],
        providerReg,
      )
      expect(registry.size).toBe(2)
    })

    it("fallback validation still runs alongside provider validation", () => {
      const providerReg = makeProviderRegistry({
        "test-provider": ["test-model"],
      })
      // Fallback references unknown pool — should throw from fallback validation
      expect(() => new PoolRegistry(
        [makePool({ id: "a", fallback: "nonexistent-pool" })],
        providerReg,
      )).toThrow('Pool "a" references unknown fallback "nonexistent-pool"')
    })

    it("circular fallback detection still runs alongside provider validation", () => {
      const providerReg = makeProviderRegistry({
        "test-provider": ["test-model"],
      })
      expect(() => new PoolRegistry(
        [
          makePool({ id: "a", fallback: "b" }),
          makePool({ id: "b", fallback: "a" }),
        ],
        providerReg,
      )).toThrow("Circular fallback chain detected")
    })
  })
})
