// tests/finn/hounfour/runtime-config.test.ts — RuntimeConfig unit tests (cycle-035 T-1.7)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { RuntimeConfig, REDIS_CONFIG_KEY } from "../../../src/hounfour/runtime-config.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"

// --- Mock Redis client ---

function createMockRedis(store: Map<string, string> = new Map()): RedisCommandClient {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK" }),
    del: vi.fn(async () => 0),
    incrby: vi.fn(async () => 0),
    incrbyfloat: vi.fn(async () => "0"),
    expire: vi.fn(async () => 0),
    exists: vi.fn(async () => 0),
    ping: vi.fn(async () => "PONG"),
    eval: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    hincrby: vi.fn(async () => 0),
    zadd: vi.fn(async () => 0),
    zpopmin: vi.fn(async () => []),
    zremrangebyscore: vi.fn(async () => 0),
    zcard: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
    quit: vi.fn(async () => "OK"),
  }
}

describe("RuntimeConfig", () => {
  beforeEach(() => {
    delete process.env.FINN_REPUTATION_ROUTING
  })

  describe("getMode() with Redis", () => {
    it("reads mode from Redis", async () => {
      const store = new Map([[REDIS_CONFIG_KEY, "enabled"]])
      const rc = new RuntimeConfig(createMockRedis(store))

      expect(await rc.getMode()).toBe("enabled")
    })

    it("returns shadow for missing Redis key", async () => {
      const rc = new RuntimeConfig(createMockRedis())

      expect(await rc.getMode()).toBe("shadow")
    })

    it("ignores invalid Redis values and falls to env var", async () => {
      const store = new Map([[REDIS_CONFIG_KEY, "invalid_value"]])
      process.env.FINN_REPUTATION_ROUTING = "disabled"
      const rc = new RuntimeConfig(createMockRedis(store))

      expect(await rc.getMode()).toBe("disabled")
    })

    it("falls back to env var when Redis throws", async () => {
      const redis = createMockRedis()
      ;(redis.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"))
      process.env.FINN_REPUTATION_ROUTING = "enabled"
      const rc = new RuntimeConfig(redis)

      expect(await rc.getMode()).toBe("enabled")
    })

    it("falls back to last known mode on Redis failure", async () => {
      const store = new Map([[REDIS_CONFIG_KEY, "enabled"]])
      const redis = createMockRedis(store)
      const rc = new RuntimeConfig(redis)

      // First call succeeds
      expect(await rc.getMode()).toBe("enabled")

      // Simulate Redis failure
      ;(redis.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"))
      delete process.env.FINN_REPUTATION_ROUTING

      // Should return last known "enabled"
      expect(await rc.getMode()).toBe("enabled")
    })
  })

  describe("getMode() without Redis", () => {
    it("returns env var value", async () => {
      process.env.FINN_REPUTATION_ROUTING = "disabled"
      const rc = new RuntimeConfig(null)

      expect(await rc.getMode()).toBe("disabled")
    })

    it("returns shadow as default", async () => {
      const rc = new RuntimeConfig(null)

      expect(await rc.getMode()).toBe("shadow")
    })
  })

  describe("setMode()", () => {
    it("writes mode to Redis", async () => {
      const store = new Map<string, string>()
      const redis = createMockRedis(store)
      const rc = new RuntimeConfig(redis)

      await rc.setMode("enabled")

      expect(store.get(REDIS_CONFIG_KEY)).toBe("enabled")
    })

    it("throws for invalid mode", async () => {
      const rc = new RuntimeConfig(createMockRedis())

      await expect(rc.setMode("bogus" as any)).rejects.toThrow("Invalid routing mode")
    })

    it("throws when Redis not available", async () => {
      const rc = new RuntimeConfig(null)

      await expect(rc.setMode("enabled")).rejects.toThrow("Redis not available")
    })
  })

  describe("mode change effective <1s", () => {
    it("reflects mode change on immediate re-read", async () => {
      const store = new Map([[REDIS_CONFIG_KEY, "shadow"]])
      const redis = createMockRedis(store)
      const rc = new RuntimeConfig(redis)

      expect(await rc.getMode()).toBe("shadow")

      await rc.setMode("enabled")
      expect(await rc.getMode()).toBe("enabled")

      await rc.setMode("disabled")
      expect(await rc.getMode()).toBe("disabled")
    })
  })
})
