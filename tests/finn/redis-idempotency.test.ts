// tests/finn/redis-idempotency.test.ts — Idempotency + Nonce tests (T-2.11)

import { describe, it, expect, vi } from "vitest"
import {
  stableKey,
  RedisIdempotencyCache,
  RedisNonceStore,
} from "../../src/hounfour/redis/idempotency.js"
import type { RedisStateBackend } from "../../src/hounfour/redis/client.js"

// --- Mock Redis ---

function mockRedis(connected = true) {
  const store = new Map<string, string>()

  const client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ex?: string, _ttl?: number, _nx?: string) => {
      if (_nx === "NX") {
        if (store.has(key)) return null // Already exists
        store.set(key, value)
        return "OK"
      }
      store.set(key, value)
      return "OK"
    }),
  }

  const backend = {
    isConnected: vi.fn(() => connected),
    key: vi.fn((...parts: string[]) => `finn:hounfour:${parts.join(":")}`),
    getClient: vi.fn(() => client),
  } as unknown as RedisStateBackend

  return { backend, client, store }
}

// --- stableKey ---

describe("stableKey", () => {
  it("produces deterministic key for same args", () => {
    const k1 = stableKey("tool_a", { foo: "bar", baz: 42 })
    const k2 = stableKey("tool_a", { foo: "bar", baz: 42 })
    expect(k1).toBe(k2)
  })

  it("produces same key regardless of key order", () => {
    const k1 = stableKey("tool_a", { z: 1, a: 2, m: 3 })
    const k2 = stableKey("tool_a", { a: 2, m: 3, z: 1 })
    expect(k1).toBe(k2)
  })

  it("handles nested objects with key reordering", () => {
    const k1 = stableKey("tool", { outer: { z: 1, a: 2 }, x: "val" })
    const k2 = stableKey("tool", { x: "val", outer: { a: 2, z: 1 } })
    expect(k1).toBe(k2)
  })

  it("preserves array order", () => {
    const k1 = stableKey("tool", { items: [1, 2, 3] })
    const k2 = stableKey("tool", { items: [3, 2, 1] })
    expect(k1).not.toBe(k2)
  })

  it("different tool names produce different keys", () => {
    const k1 = stableKey("tool_a", { x: 1 })
    const k2 = stableKey("tool_b", { x: 1 })
    expect(k1).not.toBe(k2)
  })

  it("different args produce different keys", () => {
    const k1 = stableKey("tool", { x: 1 })
    const k2 = stableKey("tool", { x: 2 })
    expect(k1).not.toBe(k2)
  })

  it("returns 32-char hex string", () => {
    const k = stableKey("tool", { a: 1 })
    expect(k).toMatch(/^[0-9a-f]{32}$/)
  })

  it("handles null values", () => {
    const k = stableKey("tool", { a: null })
    expect(k).toMatch(/^[0-9a-f]{32}$/)
  })

  it("handles empty args", () => {
    const k = stableKey("tool", {})
    expect(k).toMatch(/^[0-9a-f]{32}$/)
  })
})

// --- RedisIdempotencyCache ---

describe("RedisIdempotencyCache", () => {
  describe("get/set with Redis", () => {
    it("returns null for uncached key", async () => {
      const { backend } = mockRedis()
      const cache = new RedisIdempotencyCache(backend)

      const result = await cache.get("trace-1", "tool_a", { x: 1 })
      expect(result).toBeNull()
    })

    it("stores and retrieves a result", async () => {
      const { backend } = mockRedis()
      const cache = new RedisIdempotencyCache(backend)

      const toolResult = { output: "hello", is_error: false }
      await cache.set("trace-1", "tool_a", { x: 1 }, toolResult)

      const result = await cache.get("trace-1", "tool_a", { x: 1 })
      expect(result).toEqual(toolResult)
    })

    it("same tool+args but different trace_id = different entry", async () => {
      const { backend } = mockRedis()
      const cache = new RedisIdempotencyCache(backend)

      const result1 = { output: "result-1", is_error: false }
      const result2 = { output: "result-2", is_error: false }

      await cache.set("trace-1", "tool_a", { x: 1 }, result1)
      await cache.set("trace-2", "tool_a", { x: 1 }, result2)

      expect(await cache.get("trace-1", "tool_a", { x: 1 })).toEqual(result1)
      expect(await cache.get("trace-2", "tool_a", { x: 1 })).toEqual(result2)
    })

    it("has() returns true for cached entry", async () => {
      const { backend } = mockRedis()
      const cache = new RedisIdempotencyCache(backend)

      await cache.set("trace-1", "tool_a", { x: 1 }, { output: "ok", is_error: false })

      expect(await cache.has("trace-1", "tool_a", { x: 1 })).toBe(true)
    })

    it("has() returns false for uncached entry", async () => {
      const { backend } = mockRedis()
      const cache = new RedisIdempotencyCache(backend)

      expect(await cache.has("trace-1", "tool_a", { x: 1 })).toBe(false)
    })

    it("writes with TTL to Redis", async () => {
      const { backend, client } = mockRedis()
      const cache = new RedisIdempotencyCache(backend, 60_000)

      await cache.set("trace-1", "tool_a", { x: 1 }, { output: "ok", is_error: false })

      const setCall = client.set.mock.calls[0]
      expect(setCall[2]).toBe("EX")
      expect(setCall[3]).toBe(60) // 60_000ms = 60s
    })
  })

  describe("memory fallback", () => {
    it("falls back to memory when Redis disconnected", async () => {
      const { backend } = mockRedis(false)
      const cache = new RedisIdempotencyCache(backend)

      const result = { output: "mem", is_error: false }
      await cache.set("trace-1", "tool_a", { x: 1 }, result)

      expect(await cache.get("trace-1", "tool_a", { x: 1 })).toEqual(result)
    })

    it("falls back to memory when Redis is null", async () => {
      const cache = new RedisIdempotencyCache(null)

      const result = { output: "mem", is_error: false }
      await cache.set("trace-1", "tool_a", { x: 1 }, result)

      expect(await cache.get("trace-1", "tool_a", { x: 1 })).toEqual(result)
    })

    it("falls back to memory when Redis GET throws", async () => {
      const { backend, client } = mockRedis()
      const cache = new RedisIdempotencyCache(backend)

      // First set succeeds (writes to memory + Redis)
      const result = { output: "ok", is_error: false }
      await cache.set("trace-1", "tool_a", { x: 1 }, result)

      // Now GET fails
      client.get.mockRejectedValue(new Error("Redis error"))

      // Should still get from memory
      expect(await cache.get("trace-1", "tool_a", { x: 1 })).toEqual(result)
    })

    it("set continues without error when Redis SET throws", async () => {
      const { backend, client } = mockRedis()
      client.set.mockRejectedValue(new Error("Redis error"))
      const cache = new RedisIdempotencyCache(backend)

      // Should not throw — writes to memory only
      await cache.set("trace-1", "tool_a", { x: 1 }, { output: "ok", is_error: false })

      // Memory fallback works
      expect(await cache.get("trace-1", "tool_a", { x: 1 })).toEqual({
        output: "ok",
        is_error: false,
      })
    })
  })
})

// --- RedisNonceStore ---

describe("RedisNonceStore", () => {
  describe("checkAndStore (required=true)", () => {
    it("returns true for new nonce", async () => {
      const { backend } = mockRedis()
      const store = new RedisNonceStore(backend, true)

      const result = await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      expect(result).toBe(true)
    })

    it("returns false for replayed nonce", async () => {
      const { backend } = mockRedis()
      const store = new RedisNonceStore(backend, true)

      await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      const result = await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      expect(result).toBe(false)
    })

    it("same nonce different minute bucket = allowed", async () => {
      const { backend } = mockRedis()
      const store = new RedisNonceStore(backend, true)

      await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      const result = await store.checkAndStore("nonce-1", "2026-02-08T12:01:00Z")
      expect(result).toBe(true)
    })

    it("throws when Redis disconnected and required=true", async () => {
      const { backend } = mockRedis(false)
      const store = new RedisNonceStore(backend, true)

      await expect(
        store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z"),
      ).rejects.toThrow("NONCE_UNAVAILABLE")
    })

    it("throws when Redis is null and required=true", async () => {
      const store = new RedisNonceStore(null, true)

      await expect(
        store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z"),
      ).rejects.toThrow("NONCE_UNAVAILABLE")
    })

    it("throws when Redis SET NX fails and required=true", async () => {
      const { backend, client } = mockRedis()
      client.set.mockRejectedValue(new Error("Redis error"))
      const store = new RedisNonceStore(backend, true)

      await expect(
        store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z"),
      ).rejects.toThrow("NONCE_UNAVAILABLE")
    })

    it("uses SET NX with EX 60", async () => {
      const { backend, client } = mockRedis()
      const store = new RedisNonceStore(backend, true)

      await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")

      expect(client.set).toHaveBeenCalledWith(
        expect.stringContaining("nonce"),
        "",
        "EX",
        60,
        "NX",
      )
    })
  })

  describe("checkAndStore (required=false)", () => {
    it("falls back to LRU when Redis disconnected", async () => {
      const { backend } = mockRedis(false)
      const store = new RedisNonceStore(backend, false)

      const r1 = await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      expect(r1).toBe(true)

      const r2 = await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      expect(r2).toBe(false)
    })

    it("falls back to LRU when Redis SET throws", async () => {
      const { backend, client } = mockRedis()
      client.set.mockRejectedValue(new Error("Redis error"))
      const store = new RedisNonceStore(backend, false)

      const r1 = await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      expect(r1).toBe(true) // LRU allows first use

      const r2 = await store.checkAndStore("nonce-1", "2026-02-08T12:00:00Z")
      expect(r2).toBe(false) // LRU detects replay
    })

    it("evicts oldest entries when LRU exceeds max size", async () => {
      const store = new RedisNonceStore(null, false, 3) // max 3 entries

      await store.checkAndStore("n1", "2026-02-08T12:00:00Z")
      await store.checkAndStore("n2", "2026-02-08T12:00:00Z")
      await store.checkAndStore("n3", "2026-02-08T12:00:00Z")
      await store.checkAndStore("n4", "2026-02-08T12:00:00Z") // Evicts n1

      // n1 was evicted when n4 was added, so it's "new" again
      const r = await store.checkAndStore("n1", "2026-02-08T12:00:00Z")
      expect(r).toBe(true)

      // n4 should still be in LRU (was not evicted)
      const r4 = await store.checkAndStore("n4", "2026-02-08T12:00:00Z")
      expect(r4).toBe(false)
    })
  })

  describe("isDegraded", () => {
    it("returns false when Redis connected", () => {
      const { backend } = mockRedis(true)
      const store = new RedisNonceStore(backend, false)
      expect(store.isDegraded()).toBe(false)
    })

    it("returns true when Redis disconnected and not required", () => {
      const { backend } = mockRedis(false)
      const store = new RedisNonceStore(backend, false)
      expect(store.isDegraded()).toBe(true)
    })

    it("returns false when required (would throw, not degrade)", () => {
      const { backend } = mockRedis(false)
      const store = new RedisNonceStore(backend, true)
      expect(store.isDegraded()).toBe(false)
    })

    it("returns true when Redis is null and not required", () => {
      const store = new RedisNonceStore(null, false)
      expect(store.isDegraded()).toBe(true)
    })
  })
})
