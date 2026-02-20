// tests/nft/signal-cache.test.ts — Signal Cache Tests (Sprint 5 T5.2)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SignalCache } from "../../src/nft/signal-cache.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import type { OnChainReader } from "../../src/nft/on-chain-reader.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Mock Redis (in-memory with TTL support)
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, { value: string; expiresAt: number }>()

  function isExpired(key: string): boolean {
    const entry = store.get(key)
    if (!entry) return true
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      store.delete(key)
      return true
    }
    return false
  }

  return {
    async get(key: string) {
      if (isExpired(key)) return null
      return store.get(key)?.value ?? null
    },
    async set(key: string, value: string, ...args: (string | number)[]) {
      let ttlMs = 0
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === "EX" && i + 1 < args.length) {
          ttlMs = Number(args[i + 1]) * 1000
        }
      }
      store.set(key, {
        value,
        expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
      })
      return "OK"
    },
    async del(...keys: string[]) {
      let count = 0
      for (const key of keys) {
        if (store.delete(key)) count++
      }
      return count
    },
    async exists(...keys: string[]) {
      let count = 0
      for (const key of keys) {
        if (!isExpired(key) && store.has(key)) count++
      }
      return count
    },
    // Stubs for unused methods
    async incrby() { return 0 },
    async incrbyfloat() { return "0" },
    async expire() { return 0 },
    async ping() { return "PONG" },
    async eval() { return null },
    async hgetall() { return {} },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
  } as RedisCommandClient
}

// ---------------------------------------------------------------------------
// Mock OnChainReader
// ---------------------------------------------------------------------------

const MOCK_SNAPSHOT: SignalSnapshot = {
  archetype: "freetekno",
  ancestor: "Tesla",
  birthday: "1352-06-15",
  era: "medieval",
  molecule: "DMT",
  tarot: { name: "Card 5", number: 5, suit: "major", element: "fire" },
  element: "fire",
  swag_rank: "S",
  swag_score: 75,
  sun_sign: "aries",
  moon_sign: "cancer",
  ascending_sign: "leo",
}

const MOCK_OWNER = "0x1234567890abcdef1234567890abcdef12345678"

function createMockReader(callCount: { readSignals: number; readOwner: number }): OnChainReader {
  return {
    readSignals: vi.fn().mockImplementation(async () => {
      callCount.readSignals++
      return { snapshot: MOCK_SNAPSHOT, owner: MOCK_OWNER }
    }),
    readOwner: vi.fn().mockImplementation(async () => {
      callCount.readOwner++
      return MOCK_OWNER
    }),
  } as unknown as OnChainReader
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T5.2: SignalCache construction", () => {
  it("constructs with required config", () => {
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader({ readSignals: 0, readOwner: 0 }),
    })
    expect(cache).toBeDefined()
  })

  it("accepts custom TTL and prefix", () => {
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader({ readSignals: 0, readOwner: 0 }),
      ttlSeconds: 3600,
      keyPrefix: "test:signal:",
    })
    expect(cache).toBeDefined()
  })
})

describe("T5.2: getSignals — cache miss", () => {
  it("calls on-chain reader on cache miss", async () => {
    const calls = { readSignals: 0, readOwner: 0 }
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader(calls),
    })

    const result = await cache.getSignals("42")

    expect(result.fromCache).toBe(false)
    expect(result.snapshot.archetype).toBe("freetekno")
    expect(result.owner).toBe(MOCK_OWNER)
    expect(calls.readSignals).toBe(1)
  })
})

describe("T5.2: getSignals — cache hit", () => {
  it("returns cached value on second call", async () => {
    const calls = { readSignals: 0, readOwner: 0 }
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader(calls),
    })

    // First call — cache miss
    const result1 = await cache.getSignals("42")
    expect(result1.fromCache).toBe(false)
    expect(calls.readSignals).toBe(1)

    // Second call — cache hit
    const result2 = await cache.getSignals("42")
    expect(result2.fromCache).toBe(true)
    expect(result2.snapshot.archetype).toBe("freetekno")
    expect(calls.readSignals).toBe(1) // No additional RPC call
  })
})

describe("T5.2: getSignals — corrupted cache", () => {
  it("falls through on corrupted cache entry", async () => {
    const redis = createMockRedis()
    const calls = { readSignals: 0, readOwner: 0 }

    // Seed corrupted data
    await redis.set("finn:signal:42", "not-valid-json")

    const cache = new SignalCache({
      redis,
      onChainReader: createMockReader(calls),
    })

    const result = await cache.getSignals("42")
    expect(result.fromCache).toBe(false)
    expect(calls.readSignals).toBe(1)
  })
})

describe("T5.2: invalidate", () => {
  it("removes cached entry", async () => {
    const calls = { readSignals: 0, readOwner: 0 }
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader(calls),
    })

    // Populate cache
    await cache.getSignals("42")
    expect(await cache.hasCached("42")).toBe(true)

    // Invalidate
    await cache.invalidate("42")
    expect(await cache.hasCached("42")).toBe(false)

    // Next call hits on-chain again
    await cache.getSignals("42")
    expect(calls.readSignals).toBe(2)
  })
})

describe("T5.2: refreshOwner", () => {
  it("re-reads owner from on-chain", async () => {
    const calls = { readSignals: 0, readOwner: 0 }
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader(calls),
    })

    // Populate cache
    await cache.getSignals("42")

    // Refresh owner
    const newOwner = await cache.refreshOwner("42")
    expect(newOwner).toBe(MOCK_OWNER)
    expect(calls.readOwner).toBe(1)
  })

  it("updates owner in cache without full re-read", async () => {
    const calls = { readSignals: 0, readOwner: 0 }
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader(calls),
    })

    // Populate cache
    await cache.getSignals("42")
    expect(calls.readSignals).toBe(1)

    // Refresh owner (should NOT trigger readSignals)
    await cache.refreshOwner("42")
    expect(calls.readSignals).toBe(1)
    expect(calls.readOwner).toBe(1)
  })
})

describe("T5.2: hasCached", () => {
  it("returns false for uncached token", async () => {
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader({ readSignals: 0, readOwner: 0 }),
    })
    expect(await cache.hasCached("99")).toBe(false)
  })

  it("returns true after caching", async () => {
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader({ readSignals: 0, readOwner: 0 }),
    })
    await cache.getSignals("42")
    expect(await cache.hasCached("42")).toBe(true)
  })
})

describe("T5.2: different tokens are cached independently", () => {
  it("caches token 42 and token 99 separately", async () => {
    const calls = { readSignals: 0, readOwner: 0 }
    const cache = new SignalCache({
      redis: createMockRedis(),
      onChainReader: createMockReader(calls),
    })

    await cache.getSignals("42")
    await cache.getSignals("99")
    expect(calls.readSignals).toBe(2)

    // Both should be cached
    const r42 = await cache.getSignals("42")
    const r99 = await cache.getSignals("99")
    expect(r42.fromCache).toBe(true)
    expect(r99.fromCache).toBe(true)
    expect(calls.readSignals).toBe(2) // No additional calls
  })
})
