// tests/finn/oracle-rate-limit.test.ts — Rate limiter tests (Sprint 3 Task 3.7)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import {
  OracleRateLimiter,
  oracleRateLimitMiddleware,
  utcDateKey,
  type OracleIdentity,
  type OracleRateLimitConfig,
} from "../../src/gateway/oracle-rate-limit.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// --- Mock Redis ---

function createMockRedis(overrides?: Partial<RedisCommandClient>): RedisCommandClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(1),
    incrbyfloat: vi.fn().mockResolvedValue("1"),
    expire: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    ping: vi.fn().mockResolvedValue("PONG"),
    eval: vi.fn().mockResolvedValue(["ALLOWED", 5, 4]),
    hgetall: vi.fn().mockResolvedValue({}),
    hincrby: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(1),
    zpopmin: vi.fn().mockResolvedValue([]),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn().mockResolvedValue("OK"),
    ...overrides,
  }
}

const DEFAULT_CONFIG: OracleRateLimitConfig = {
  dailyCap: 200,
  publicDailyLimit: 5,
  authenticatedDailyLimit: 50,
  costCeilingCents: 2000,
}

describe("OracleRateLimiter", () => {
  let redis: RedisCommandClient
  let limiter: OracleRateLimiter

  beforeEach(() => {
    redis = createMockRedis()
    limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)
  })

  describe("check()", () => {
    it("should allow request when all tiers pass (IP identity)", async () => {
      const identity: OracleIdentity = { type: "ip", ip: "1.2.3.4" }
      const result = await limiter.check(identity)
      expect(result.allowed).toBe(true)
      expect(result.reason).toBeNull()
      expect(result.limit).toBe(5)
      expect(result.remaining).toBe(4)
    })

    it("should allow request for API key identity with higher limit", async () => {
      const identity: OracleIdentity = { type: "api_key", keyHash: "abc123", ip: "1.2.3.4" }
      const result = await limiter.check(identity)
      expect(result.allowed).toBe(true)

      // Verify eval was called with authenticatedDailyLimit
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String), // Lua script
        3,
        expect.stringContaining("oracle:cost:"),
        expect.stringContaining("oracle:ratelimit:key:abc123:"),
        expect.stringContaining("oracle:global:"),
        2000, 50, 200,
      )
    })

    it("should deny when identity limit exceeded", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue(["IDENTITY_LIMIT_EXCEEDED", 5, 0]),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.check({ type: "ip", ip: "1.2.3.4" })
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("IDENTITY_LIMIT_EXCEEDED")
      expect(result.limit).toBe(5)
      expect(result.retryAfterSeconds).toBeGreaterThan(0)
    })

    it("should deny when global cap exceeded", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue(["GLOBAL_CAP_EXCEEDED", 0, 0]),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.check({ type: "ip", ip: "1.2.3.4" })
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("GLOBAL_CAP_EXCEEDED")
    })

    it("should deny when cost ceiling exceeded", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue(["COST_CEILING_EXCEEDED", 0, 0]),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.check({ type: "ip", ip: "1.2.3.4" })
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("COST_CEILING_EXCEEDED")
    })

    it("should fail-open with conservative limit on Redis error", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error("Redis timeout")),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      // First request should be allowed (fallback)
      const result1 = await limiter.check({ type: "ip", ip: "1.2.3.4" })
      expect(result1.allowed).toBe(true)

      // Immediate second request from same IP should be denied (1 req/min fallback)
      const result2 = await limiter.check({ type: "ip", ip: "1.2.3.4" })
      expect(result2.allowed).toBe(false)
      expect(result2.reason).toBe("IDENTITY_LIMIT_EXCEEDED")
    })

    it("should use correct Redis key patterns", async () => {
      const dateKey = utcDateKey()
      const identity: OracleIdentity = { type: "ip", ip: "10.0.0.1" }
      await limiter.check(identity)

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        3,
        `oracle:cost:${dateKey}`,
        `oracle:ratelimit:ip:10.0.0.1:${dateKey}`,
        `oracle:global:${dateKey}`,
        2000, 5, 200,
      )
    })
  })

  describe("reserveCost()", () => {
    it("should allow reservation when under ceiling", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue([1, 50]),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      expect(result.allowed).toBe(true)
      expect(result.reservationId).toBeTruthy()
    })

    it("should deny reservation when over ceiling", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue([0, 1980]),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      expect(result.allowed).toBe(false)
    })

    it("should reconcile actual cost on release (overestimate refund)", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue([1, 50]),
        get: vi.fn().mockResolvedValue("50"),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      // Actual cost was 30 (refund 20)
      await result.release(30)

      expect(redis.incrby).toHaveBeenCalledWith(
        expect.stringContaining("oracle:cost:"),
        -20,
      )
    })

    it("should reconcile actual cost on release (underestimate charge)", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue([1, 50]),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      // Actual cost was 70 (charge 20 more)
      await result.release(70)

      expect(redis.incrby).toHaveBeenCalledWith(
        expect.stringContaining("oracle:cost:"),
        20,
      )
    })

    it("should be idempotent — double release is no-op", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue([1, 50]),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      await result.release(50)
      await result.release(50) // second call

      // incrby should NOT have been called (delta is 0 and second call is no-op)
      expect(redis.incrby).not.toHaveBeenCalled()
    })

    it("should clamp to prevent negative counters on reconciliation", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue([1, 50]),
        get: vi.fn().mockResolvedValue("10"), // Only 10 in the counter
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      // Release with actual cost of 0 → delta = -50, but counter only has 10
      await result.release(0)

      // Should only decrement by 10 (not 50) to prevent negative
      expect(redis.incrby).toHaveBeenCalledWith(
        expect.stringContaining("oracle:cost:"),
        -10,
      )
    })

    it("should fail-closed on Redis error for cost reservation", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockRejectedValue(new Error("Redis timeout")),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      expect(result.allowed).toBe(false)
    })

    it("should release(0) on failure for full refund", async () => {
      redis = createMockRedis({
        eval: vi.fn().mockResolvedValue([1, 50]),
        get: vi.fn().mockResolvedValue("50"),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const result = await limiter.reserveCost(50)
      await result.release(0) // full refund

      expect(redis.incrby).toHaveBeenCalledWith(
        expect.stringContaining("oracle:cost:"),
        -50,
      )
    })
  })

  describe("isHealthy()", () => {
    it("should return true when Redis is reachable", async () => {
      expect(await limiter.isHealthy()).toBe(true)
      expect(redis.ping).toHaveBeenCalled()
    })

    it("should return false when Redis is unreachable", async () => {
      redis = createMockRedis({
        ping: vi.fn().mockRejectedValue(new Error("Connection refused")),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)
      expect(await limiter.isHealthy()).toBe(false)
    })
  })

  describe("getDailyUsage()", () => {
    it("should return usage counters from Redis", async () => {
      redis = createMockRedis({
        get: vi.fn().mockImplementation((key: string) => {
          if (key.includes("global")) return Promise.resolve("42")
          if (key.includes("cost")) return Promise.resolve("1500")
          return Promise.resolve(null)
        }),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      const usage = await limiter.getDailyUsage()
      expect(usage).toEqual({ globalCount: 42, costCents: 1500 })
    })

    it("should return null on Redis error", async () => {
      redis = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error("Redis down")),
      })
      limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)

      expect(await limiter.getDailyUsage()).toBeNull()
    })
  })
})

describe("oracleRateLimitMiddleware", () => {
  it("should pass through when allowed", async () => {
    const redis = createMockRedis()
    const limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)
    const app = new Hono()

    // Simulate auth middleware setting identity
    app.use("*", async (c, next) => {
      c.set("oracleIdentity", { type: "ip", ip: "1.2.3.4" } as OracleIdentity)
      return next()
    })
    app.use("*", oracleRateLimitMiddleware(limiter))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(200)
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4")
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5")
  })

  it("should return 429 for identity limit exceeded", async () => {
    const redis = createMockRedis({
      eval: vi.fn().mockResolvedValue(["IDENTITY_LIMIT_EXCEEDED", 5, 0]),
    })
    const limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)
    const app = new Hono()

    app.use("*", async (c, next) => {
      c.set("oracleIdentity", { type: "ip", ip: "1.2.3.4" } as OracleIdentity)
      return next()
    })
    app.use("*", oracleRateLimitMiddleware(limiter))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBeTruthy()
  })

  it("should return 503 for global cap exceeded", async () => {
    const redis = createMockRedis({
      eval: vi.fn().mockResolvedValue(["GLOBAL_CAP_EXCEEDED", 0, 0]),
    })
    const limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)
    const app = new Hono()

    app.use("*", async (c, next) => {
      c.set("oracleIdentity", { type: "ip", ip: "1.2.3.4" } as OracleIdentity)
      return next()
    })
    app.use("*", oracleRateLimitMiddleware(limiter))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(503)
  })

  it("should return 500 when identity not set", async () => {
    const redis = createMockRedis()
    const limiter = new OracleRateLimiter(redis, DEFAULT_CONFIG)
    const app = new Hono()

    app.use("*", oracleRateLimitMiddleware(limiter))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(500)
  })
})

describe("utcDateKey()", () => {
  it("should return YYYY-MM-DD format", () => {
    const key = utcDateKey()
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
