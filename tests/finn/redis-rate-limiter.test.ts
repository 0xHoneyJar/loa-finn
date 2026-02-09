// tests/finn/redis-rate-limiter.test.ts — RedisRateLimiter tests (T-2.10)

import { describe, it, expect, vi } from "vitest"
import { RedisRateLimiter } from "../../src/hounfour/redis/rate-limiter.js"
import type { RateLimitConfig } from "../../src/hounfour/redis/rate-limiter.js"
import type { RedisStateBackend } from "../../src/hounfour/redis/client.js"

// --- Mock Redis ---

function mockRedis(connected = true) {
  const sortedSets = new Map<string, Array<{ score: number; member: string }>>()
  const hashes = new Map<string, Map<string, number>>()

  const client = {
    eval: vi.fn(async (..._args: unknown[]) => 1), // Default: allow
    zremrangebyscore: vi.fn(async () => 0),
    zcard: vi.fn(async () => 0),
  }

  const backend = {
    isConnected: vi.fn(() => connected),
    key: vi.fn((...parts: string[]) => `finn:hounfour:${parts.join(":")}`),
    getClient: vi.fn(() => client),
  } as unknown as RedisStateBackend

  return { backend, client }
}

function makeLimits(overrides?: Partial<RateLimitConfig>): Map<string, RateLimitConfig> {
  const limits = new Map<string, RateLimitConfig>()
  limits.set("openai:gpt-4", { rpm: 60, tpm: 100000, ...overrides })
  return limits
}

// --- Tests ---

describe("RedisRateLimiter", () => {
  describe("acquireRequest (RPM)", () => {
    it("allows request when under RPM limit", async () => {
      const { backend, client } = mockRedis()
      client.eval.mockResolvedValue(1) // Lua returns 1 = allowed
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.acquireRequest("openai", "gpt-4")
      expect(allowed).toBe(true)
      expect(client.eval).toHaveBeenCalled()
    })

    it("rejects request when at RPM limit", async () => {
      const { backend, client } = mockRedis()
      client.eval.mockResolvedValue(0) // Lua returns 0 = rejected
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.acquireRequest("openai", "gpt-4")
      expect(allowed).toBe(false)
    })

    it("allows when no limit configured for provider/model", async () => {
      const { backend, client } = mockRedis()
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.acquireRequest("anthropic", "claude-3")
      expect(allowed).toBe(true)
      expect(client.eval).not.toHaveBeenCalled()
    })

    it("fail-open when Redis disconnected", async () => {
      const { backend } = mockRedis(false)
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.acquireRequest("openai", "gpt-4")
      expect(allowed).toBe(true)
    })

    it("fail-open when Redis is null", async () => {
      const limiter = new RedisRateLimiter(null, makeLimits())

      const allowed = await limiter.acquireRequest("openai", "gpt-4")
      expect(allowed).toBe(true)
    })

    it("fail-open when Lua eval throws", async () => {
      const { backend, client } = mockRedis()
      client.eval.mockRejectedValue(new Error("Redis timeout"))
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.acquireRequest("openai", "gpt-4")
      expect(allowed).toBe(true)
    })

    it("passes correct arguments to RPM Lua script", async () => {
      const { backend, client } = mockRedis()
      const limiter = new RedisRateLimiter(backend, makeLimits({ rpm: 100 }))

      await limiter.acquireRequest("openai", "gpt-4")

      const args = client.eval.mock.calls[0]
      // args: [lua_script, numkeys, key, now, window, limit, memberId]
      expect(args[1]).toBe(1) // numkeys
      expect(args[2]).toBe("finn:hounfour:rate:openai:gpt-4:rpm") // key
      expect(typeof args[3]).toBe("number") // now (timestamp)
      expect(args[4]).toBe(60000) // window = 60s
      expect(args[5]).toBe(100) // rpm limit
      expect(typeof args[6]).toBe("string") // memberId (UUID)
    })
  })

  describe("recordTokens (TPM)", () => {
    it("allows when under TPM limit", async () => {
      const { backend, client } = mockRedis()
      client.eval.mockResolvedValue(1)
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.recordTokens("openai", "gpt-4", 500)
      expect(allowed).toBe(true)
    })

    it("rejects when at TPM limit", async () => {
      const { backend, client } = mockRedis()
      client.eval.mockResolvedValue(0)
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.recordTokens("openai", "gpt-4", 500)
      expect(allowed).toBe(false)
    })

    it("allows when no limit configured", async () => {
      const { backend } = mockRedis()
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.recordTokens("unknown", "model", 500)
      expect(allowed).toBe(true)
    })

    it("fail-open when Redis disconnected", async () => {
      const { backend } = mockRedis(false)
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.recordTokens("openai", "gpt-4", 500)
      expect(allowed).toBe(true)
    })

    it("fail-open when Lua eval throws", async () => {
      const { backend, client } = mockRedis()
      client.eval.mockRejectedValue(new Error("Redis error"))
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const allowed = await limiter.recordTokens("openai", "gpt-4", 500)
      expect(allowed).toBe(true)
    })

    it("passes correct arguments to TPM Lua script", async () => {
      const { backend, client } = mockRedis()
      // First call is RPM — reset, second call is TPM
      const limiter = new RedisRateLimiter(backend, makeLimits({ tpm: 50000 }))

      await limiter.recordTokens("openai", "gpt-4", 1234)

      const args = client.eval.mock.calls[0]
      // args: [lua_script, numkeys=2, currKey, prevKey, bucket, tokens, limit, ttl, elapsed]
      expect(args[1]).toBe(2) // numkeys
      expect(args[5]).toBe(1234) // token count
      expect(args[6]).toBe(50000) // TPM limit
      expect(args[7]).toBe(120) // TTL = 2 windows
    })
  })

  describe("getRpmRemaining", () => {
    it("returns full capacity when no requests tracked", async () => {
      const { backend, client } = mockRedis()
      client.zcard.mockResolvedValue(0)
      const limiter = new RedisRateLimiter(backend, makeLimits({ rpm: 60 }))

      const remaining = await limiter.getRpmRemaining("openai", "gpt-4")
      expect(remaining).toBe(60)
    })

    it("returns reduced capacity after requests", async () => {
      const { backend, client } = mockRedis()
      client.zcard.mockResolvedValue(15)
      const limiter = new RedisRateLimiter(backend, makeLimits({ rpm: 60 }))

      const remaining = await limiter.getRpmRemaining("openai", "gpt-4")
      expect(remaining).toBe(45)
    })

    it("returns 0 when at limit", async () => {
      const { backend, client } = mockRedis()
      client.zcard.mockResolvedValue(60)
      const limiter = new RedisRateLimiter(backend, makeLimits({ rpm: 60 }))

      const remaining = await limiter.getRpmRemaining("openai", "gpt-4")
      expect(remaining).toBe(0)
    })

    it("returns 0 when over limit (never negative)", async () => {
      const { backend, client } = mockRedis()
      client.zcard.mockResolvedValue(100)
      const limiter = new RedisRateLimiter(backend, makeLimits({ rpm: 60 }))

      const remaining = await limiter.getRpmRemaining("openai", "gpt-4")
      expect(remaining).toBe(0)
    })

    it("returns Infinity when no limit configured", async () => {
      const { backend } = mockRedis()
      const limiter = new RedisRateLimiter(backend, makeLimits())

      const remaining = await limiter.getRpmRemaining("unknown", "model")
      expect(remaining).toBe(Infinity)
    })

    it("returns full capacity when Redis disconnected", async () => {
      const { backend } = mockRedis(false)
      const limiter = new RedisRateLimiter(backend, makeLimits({ rpm: 60 }))

      const remaining = await limiter.getRpmRemaining("openai", "gpt-4")
      expect(remaining).toBe(60)
    })

    it("returns full capacity when Redis throws (fail-open)", async () => {
      const { backend, client } = mockRedis()
      client.zremrangebyscore.mockRejectedValue(new Error("Redis error"))
      const limiter = new RedisRateLimiter(backend, makeLimits({ rpm: 60 }))

      const remaining = await limiter.getRpmRemaining("openai", "gpt-4")
      expect(remaining).toBe(60)
    })

    it("cleans expired entries before counting", async () => {
      const { backend, client } = mockRedis()
      client.zcard.mockResolvedValue(10)
      const limiter = new RedisRateLimiter(backend, makeLimits())

      await limiter.getRpmRemaining("openai", "gpt-4")

      expect(client.zremrangebyscore).toHaveBeenCalledWith(
        expect.any(String),
        "-inf",
        expect.any(Number),
      )
    })
  })
})
