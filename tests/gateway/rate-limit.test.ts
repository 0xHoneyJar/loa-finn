// tests/gateway/rate-limit.test.ts — Multi-Tier Rate Limiter Tests (Sprint 3 T3.5)

import { describe, it, expect, beforeEach } from "vitest"
import { MultiTierRateLimiter, RATE_LIMIT_TIERS } from "../../src/gateway/rate-limit.js"

// ---------------------------------------------------------------------------
// Mock Redis with sorted set support
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, { value: string; expiresAt?: number }>()
  const sortedSets = new Map<string, Map<string, number>>() // key -> { member -> score }
  let evalCallCount = 0

  return {
    store,
    sortedSets,
    get evalCalls() { return evalCallCount },

    async get(key: string): Promise<string | null> {
      const entry = store.get(key)
      if (!entry) return null
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key)
        return null
      }
      return entry.value
    },
    async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
      let expiresAt: number | undefined
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === "EX" && i + 1 < args.length) {
          expiresAt = Date.now() + Number(args[i + 1]) * 1000
        }
      }
      store.set(key, { value, expiresAt })
      return "OK"
    },
    async del(...keys: string[]): Promise<number> {
      let count = 0
      for (const key of keys) {
        if (store.delete(key)) count++
        if (sortedSets.delete(key)) count++
      }
      return count
    },
    async incrby(_key: string, _inc: number) { return 0 },
    async incrbyfloat(_key: string, _inc: number) { return "0" },
    async expire(_key: string, _s: number) { return 0 },
    async exists(..._keys: string[]) { return 0 },
    async ping() { return "PONG" },
    async eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
      evalCallCount++

      // Simulate the sliding window Lua script behavior
      const key = String(args[0])
      const windowStart = Number(args[1])
      const now = Number(args[2])
      const maxRequests = Number(args[3])
      const ttl = Number(args[4])

      if (!sortedSets.has(key)) {
        sortedSets.set(key, new Map())
      }
      const set = sortedSets.get(key)!

      // Remove expired entries
      for (const [member, score] of set) {
        if (score < windowStart) {
          set.delete(member)
        }
      }

      const count = set.size

      if (count < maxRequests) {
        // Under limit — add entry
        set.set(`${now}:${Math.random()}`, now)
        return [1, count + 1]
      } else {
        return [0, count]
      }
    },
    async hgetall(_key: string) { return {} },
    async hincrby(_key: string, _field: string, _inc: number) { return 0 },
    async zadd(key: string, score: number, member: string) {
      if (!sortedSets.has(key)) sortedSets.set(key, new Map())
      sortedSets.get(key)!.set(member, score)
      return 1
    },
    async zpopmin(_key: string, _count?: number) { return [] as string[] },
    async zremrangebyscore(key: string, min: string | number, max: string | number) {
      const set = sortedSets.get(key)
      if (!set) return 0
      let count = 0
      for (const [member, score] of set) {
        if (score >= Number(min) && score <= Number(max)) {
          set.delete(member)
          count++
        }
      }
      return count
    },
    async zcard(key: string) {
      return sortedSets.get(key)?.size ?? 0
    },
    async publish(_channel: string, _message: string) { return 0 },
    async quit() { return "OK" },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MultiTierRateLimiter", () => {
  let redis: ReturnType<typeof createMockRedis>
  let limiter: MultiTierRateLimiter

  beforeEach(() => {
    redis = createMockRedis()
    limiter = new MultiTierRateLimiter({ redis: redis as any })
  })

  describe("basic behavior", () => {
    it("allows first request", async () => {
      const result = await limiter.check("free_per_ip", "1.2.3.4", 60, 60000)
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(59) // 60 - 1 = 59
    })

    it("allows requests up to the limit", async () => {
      const maxRequests = 5
      for (let i = 0; i < maxRequests; i++) {
        const result = await limiter.check("test", "user1", maxRequests, 60000)
        expect(result.allowed).toBe(true)
      }
    })

    it("rejects request exceeding the limit", async () => {
      const maxRequests = 3
      // Fill up
      for (let i = 0; i < maxRequests; i++) {
        await limiter.check("test", "user1", maxRequests, 60000)
      }
      // Should be rejected
      const result = await limiter.check("test", "user1", maxRequests, 60000)
      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.retryAfterSeconds).toBeGreaterThan(0)
    })

    it("different identifiers have separate limits", async () => {
      const max = 2
      // User1 uses up their limit
      await limiter.check("test", "user1", max, 60000)
      await limiter.check("test", "user1", max, 60000)
      const user1 = await limiter.check("test", "user1", max, 60000)
      expect(user1.allowed).toBe(false)

      // User2 should still be allowed
      const user2 = await limiter.check("test", "user2", max, 60000)
      expect(user2.allowed).toBe(true)
    })

    it("different tiers have separate limits", async () => {
      const max = 2
      // Fill tier A for user1
      await limiter.check("tier_a", "user1", max, 60000)
      await limiter.check("tier_a", "user1", max, 60000)
      const tierA = await limiter.check("tier_a", "user1", max, 60000)
      expect(tierA.allowed).toBe(false)

      // Tier B for same user should still be allowed
      const tierB = await limiter.check("tier_b", "user1", max, 60000)
      expect(tierB.allowed).toBe(true)
    })
  })

  describe("tier configurations", () => {
    it("free_per_ip: 60 requests per minute", () => {
      expect(RATE_LIMIT_TIERS.free_per_ip.maxRequests).toBe(60)
      expect(RATE_LIMIT_TIERS.free_per_ip.windowMs).toBe(60000)
    })

    it("x402_per_wallet: 30 requests per minute", () => {
      expect(RATE_LIMIT_TIERS.x402_per_wallet.maxRequests).toBe(30)
      expect(RATE_LIMIT_TIERS.x402_per_wallet.windowMs).toBe(60000)
    })

    it("challenge_per_ip: 120 requests per minute", () => {
      expect(RATE_LIMIT_TIERS.challenge_per_ip.maxRequests).toBe(120)
      expect(RATE_LIMIT_TIERS.challenge_per_ip.windowMs).toBe(60000)
    })

    it("api_key_default: 60 requests per minute", () => {
      expect(RATE_LIMIT_TIERS.api_key_default.maxRequests).toBe(60)
      expect(RATE_LIMIT_TIERS.api_key_default.windowMs).toBe(60000)
    })
  })

  describe("response headers", () => {
    it("returns remaining count", async () => {
      const result = await limiter.check("test", "user1", 10, 60000)
      expect(result.remaining).toBe(9)
    })

    it("returns resetMs", async () => {
      const result = await limiter.check("test", "user1", 10, 60000)
      expect(result.resetMs).toBe(60000)
    })

    it("retryAfterSeconds is 0 when allowed", async () => {
      const result = await limiter.check("test", "user1", 10, 60000)
      expect(result.retryAfterSeconds).toBe(0)
    })

    it("retryAfterSeconds is positive when rejected", async () => {
      // Exhaust limit
      await limiter.check("test", "user1", 1, 60000)
      const result = await limiter.check("test", "user1", 1, 60000)
      expect(result.retryAfterSeconds).toBeGreaterThan(0)
    })
  })

  describe("uses Redis Lua for atomicity", () => {
    it("calls Redis eval for each check", async () => {
      await limiter.check("test", "user1", 10, 60000)
      expect(redis.evalCalls).toBe(1)

      await limiter.check("test", "user1", 10, 60000)
      expect(redis.evalCalls).toBe(2)
    })
  })
})
