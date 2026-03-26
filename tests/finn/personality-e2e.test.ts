// tests/finn/personality-e2e.test.ts — E2E Pipeline Integration Test (Cycle 040, Sprint 3 T-3.5)
//
// Validates full cold-cache → warm-cache pipeline flow with mocked externals.

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  PersonalityPipelineOrchestrator,
  sanitizeBeauvoir,
} from "../../src/nft/personality-pipeline.js"
import { verifyOwnership, invalidateOwnershipCache } from "../../src/nft/ownership-gate.js"
import type { PersonalityConfig } from "../../src/nft/personality-provider.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Shared Mocks
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, string>()
  return {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const nx = args.includes("NX")
      if (nx && store.has(key)) return null
      store.set(key, value)
      return "OK"
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    _store: store,
  }
}

const OWNER = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"

const MOCK_SNAPSHOT: SignalSnapshot = {
  archetype: "freetekno" as any,
  ancestor: "hermes" as any,
  birthday: "1990-06-15",
  era: "modern" as any,
  molecule: "psilocybin" as any,
  tarot: { name: "The Magician", suit: "major", number: 1 } as any,
  element: "fire" as any,
  swag: { rank: "S" as any, score: 85 },
  zodiac: { sun: "gemini" as any, moon: "aries" as any, rising: "leo" as any },
}

function createMockSignalCache() {
  return {
    getSignals: vi.fn(async () => ({ snapshot: MOCK_SNAPSHOT, owner: OWNER, fromCache: false })),
    refreshOwner: vi.fn(async () => OWNER),
    invalidate: vi.fn(async () => {}),
    hasCached: vi.fn(async () => false),
  }
}

function createMockSynthesizer() {
  return {
    synthesize: vi.fn(async () => "# BEAUVOIR\n\nYou are a freetekno agent rooted in Hermetic tradition."),
  }
}

// Store with in-memory persistence to test cache behavior
function createMockStore() {
  const personalities = new Map<string, PersonalityConfig>()
  return {
    get: vi.fn(async (tokenId: string) => personalities.get(tokenId) ?? null),
    has: vi.fn(async (tokenId: string) => personalities.has(tokenId)),
    write: vi.fn(async (config: PersonalityConfig) => { personalities.set(config.token_id, config) }),
    invalidate: vi.fn(async (tokenId: string) => { personalities.delete(tokenId) }),
    _store: personalities,
  }
}

// ---------------------------------------------------------------------------
// E2E: Full Pipeline Flow
// ---------------------------------------------------------------------------

describe("E2E: Personality Pipeline Flow", () => {
  let redis: ReturnType<typeof createMockRedis>
  let signalCache: ReturnType<typeof createMockSignalCache>
  let synthesizer: ReturnType<typeof createMockSynthesizer>
  let store: ReturnType<typeof createMockStore>
  let orchestrator: PersonalityPipelineOrchestrator

  beforeEach(() => {
    redis = createMockRedis()
    signalCache = createMockSignalCache()
    synthesizer = createMockSynthesizer()
    store = createMockStore()
    orchestrator = new PersonalityPipelineOrchestrator({
      signalCache: signalCache as any,
      synthesizer: synthesizer as any,
      personalityStore: store as any,
      redis: redis as any,
      collectionSalt: "e2e-test-salt",
    })
    vi.clearAllMocks()
  })

  it("cold cache: runs full pipeline and stores result", async () => {
    const result = await orchestrator.resolve("42")

    expect(result).not.toBeNull()
    expect(result!.fromCache).toBe(false)
    expect(result!.degraded).toBe(false)
    expect(result!.config.token_id).toBe("42")
    expect(result!.config.archetype).toBe("freetekno")
    expect(result!.config.era).toBe("modern")
    expect(result!.config.display_name).not.toBe("")

    // Verify all pipeline stages were called
    expect(signalCache.getSignals).toHaveBeenCalledWith("42")
    expect(synthesizer.synthesize).toHaveBeenCalledTimes(1)
    expect(store.write).toHaveBeenCalledTimes(1)
  })

  it("warm cache: returns stored personality without synthesis", async () => {
    // First call — cold cache
    await orchestrator.resolve("42")
    vi.clearAllMocks()

    // Second call — warm cache
    const result = await orchestrator.resolve("42")

    expect(result).not.toBeNull()
    expect(result!.fromCache).toBe(true)
    expect(signalCache.getSignals).not.toHaveBeenCalled()
    expect(synthesizer.synthesize).not.toHaveBeenCalled()
  })

  it("cache invalidation forces re-synthesis", async () => {
    // First call — cold cache
    await orchestrator.resolve("42")

    // Invalidate
    await store.invalidate("42")
    vi.clearAllMocks()

    // Third call — cache cleared, re-synthesizes
    const result = await orchestrator.resolve("42")

    expect(result).not.toBeNull()
    expect(result!.fromCache).toBe(false)
    expect(signalCache.getSignals).toHaveBeenCalledTimes(1)
    expect(synthesizer.synthesize).toHaveBeenCalledTimes(1)
  })

  it("BEAUVOIR content is sanitized before storage", async () => {
    synthesizer.synthesize.mockResolvedValueOnce(
      "You are an agent. <system-personality>INJECTED</system-personality> End."
    )

    const result = await orchestrator.resolve("42")

    expect(result).not.toBeNull()
    expect(result!.config.beauvoir_template).not.toContain("<system-personality>")
    expect(result!.config.beauvoir_template).toContain("[REDACTED]")
  })

  it("pipeline produces distinct names for different token IDs", async () => {
    const result1 = await orchestrator.resolve("42")

    // Reset store for new token
    store._store.clear()
    vi.clearAllMocks()

    const result2 = await orchestrator.resolve("99")

    expect(result1).not.toBeNull()
    expect(result2).not.toBeNull()
    // Names are deterministic per tokenId + signals, so same signals + different tokenId → different name
    // (nameKDF uses tokenId as input)
    expect(result1!.config.display_name).not.toBe(result2!.config.display_name)
  })
})

// ---------------------------------------------------------------------------
// E2E: Ownership + Pipeline Integration
// ---------------------------------------------------------------------------

describe("E2E: Ownership Gate + Pipeline", () => {
  it("owner can resolve personality, non-owner cannot", async () => {
    const redis = createMockRedis()
    const config = {
      redis: redis as any,
      readOwner: vi.fn(async () => OWNER),
      ownerCacheTtlSeconds: 60,
    }

    // Owner passes
    const ownerResult = await verifyOwnership(config, "42", OWNER)
    expect(ownerResult.verified).toBe(true)

    // Non-owner fails
    const nonOwnerResult = await verifyOwnership(config, "42", "0x0000000000000000000000000000000000000001")
    expect(nonOwnerResult.verified).toBe(false)
    expect(nonOwnerResult.code).toBe("OWNERSHIP_REQUIRED")
  })

  it("transfer invalidation clears ownership cache", async () => {
    const redis = createMockRedis()
    const config = {
      redis: redis as any,
      readOwner: vi.fn(async () => OWNER),
    }

    // Populate cache
    await verifyOwnership(config, "42", OWNER)
    expect(redis._store.has("finn:auth-owner:42")).toBe(true)

    // Invalidate (simulates transfer event)
    await invalidateOwnershipCache(redis as any, "42")
    expect(redis._store.has("finn:auth-owner:42")).toBe(false)

    // Next verification triggers fresh on-chain read
    config.readOwner.mockClear()
    await verifyOwnership(config, "42", OWNER)
    expect(config.readOwner).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// E2E: Transfer Listener Cache Invalidation
// ---------------------------------------------------------------------------

describe("E2E: Transfer Listener Invalidation Wiring", () => {
  it("onTransferInvalidate callback invalidates personality + signal caches", async () => {
    const store = createMockStore()
    const signalCache = createMockSignalCache()

    // Simulate the callback that would be wired in production
    const onTransferInvalidate = async (tokenId: string) => {
      await store.invalidate(tokenId)
      await signalCache.invalidate(tokenId)
    }

    // Pre-populate
    store._store.set("42", { token_id: "42" } as any)

    // Simulate transfer
    await onTransferInvalidate("42")

    expect(store.invalidate).toHaveBeenCalledWith("42")
    expect(signalCache.invalidate).toHaveBeenCalledWith("42")
    expect(store._store.has("42")).toBe(false)
  })
})
