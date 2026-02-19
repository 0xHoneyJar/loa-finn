// tests/finn/rate-limit.test.ts — Rate Limiter Tests (Sprint 16 Task 16.1)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createRateLimiter } from "../../src/nft/rate-limiter.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(evalResult: [number, number] = [1, 1]): RedisCommandClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(1),
    incrbyfloat: vi.fn().mockResolvedValue("1"),
    expire: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    ping: vi.fn().mockResolvedValue("PONG"),
    eval: vi.fn().mockResolvedValue(evalResult),
    hgetall: vi.fn().mockResolvedValue({}),
    hincrby: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(1),
    zpopmin: vi.fn().mockResolvedValue([]),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn().mockResolvedValue("OK"),
  }
}

// ---------------------------------------------------------------------------
// Mock Hono Context
// ---------------------------------------------------------------------------

function createMockContext(walletAddress = "0xabc123"): {
  c: { get: ReturnType<typeof vi.fn>; header: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }
  next: ReturnType<typeof vi.fn>
} {
  const headers = new Map<string, string>()
  return {
    c: {
      get: vi.fn((key: string) => {
        if (key === "wallet_address") return walletAddress
        return undefined
      }),
      header: vi.fn((name: string, value: string) => {
        headers.set(name, value)
      }),
      json: vi.fn((body: unknown, status?: number) => {
        return { body, status: status ?? 200 } as unknown as Response
      }),
    },
    next: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRateLimiter", () => {
  let mockRedis: RedisCommandClient

  beforeEach(() => {
    mockRedis = createMockRedis([1, 1])
  })

  it("should allow requests within the limit", async () => {
    const limiter = createRateLimiter(mockRedis, { maxRequests: 10, windowMs: 3_600_000 })
    const { c, next } = createMockContext()

    await limiter(c as any, next)

    expect(next).toHaveBeenCalled()
    expect(mockRedis.eval).toHaveBeenCalledOnce()
    expect(c.header).toHaveBeenCalledWith("X-RateLimit-Limit", "10")
  })

  it("should return 429 when rate limit is exceeded", async () => {
    const blockedRedis = createMockRedis([0, 10])
    const limiter = createRateLimiter(blockedRedis, { maxRequests: 10, windowMs: 3_600_000 })
    const { c, next } = createMockContext()

    const result = await limiter(c as any, next)

    expect(next).not.toHaveBeenCalled()
    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RATE_LIMITED" }),
      429,
    )
  })

  it("should use wallet_address from context for rate limit key", async () => {
    const limiter = createRateLimiter(mockRedis)
    const { c, next } = createMockContext("0xWALLET_ABC")

    await limiter(c as any, next)

    // Verify the Redis eval was called with a key containing the wallet address
    const evalCall = (mockRedis.eval as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(evalCall[2]).toBe("ratelimit:llm:0xWALLET_ABC")
  })

  it("should pass through on Redis failure (non-fatal)", async () => {
    const failingRedis = createMockRedis()
    ;(failingRedis.eval as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Redis down"))

    const limiter = createRateLimiter(failingRedis)
    const { c, next } = createMockContext()

    await limiter(c as any, next)

    // Should still call next despite Redis failure
    expect(next).toHaveBeenCalled()
  })

  it("should use default config when none provided", async () => {
    const limiter = createRateLimiter(mockRedis)
    const { c, next } = createMockContext()

    await limiter(c as any, next)

    expect(c.header).toHaveBeenCalledWith("X-RateLimit-Limit", "10")
    expect(c.header).toHaveBeenCalledWith("X-RateLimit-Window", "3600000")
  })

  it("should accept custom config overrides", async () => {
    const limiter = createRateLimiter(mockRedis, { maxRequests: 5, windowMs: 60_000 })
    const { c, next } = createMockContext()

    await limiter(c as any, next)

    expect(c.header).toHaveBeenCalledWith("X-RateLimit-Limit", "5")
    expect(c.header).toHaveBeenCalledWith("X-RateLimit-Window", "60000")
  })

  it("should set X-RateLimit-Remaining header correctly", async () => {
    // Allowed, count is 3 out of 10
    const redis3 = createMockRedis([1, 3])
    const limiter = createRateLimiter(redis3, { maxRequests: 10, windowMs: 3_600_000 })
    const { c, next } = createMockContext()

    await limiter(c as any, next)

    expect(c.header).toHaveBeenCalledWith("X-RateLimit-Remaining", "7")
  })

  it("should scope rate limit per wallet address", async () => {
    const limiter = createRateLimiter(mockRedis)

    // Two different wallets
    const ctx1 = createMockContext("0xWallet1")
    const ctx2 = createMockContext("0xWallet2")

    await limiter(ctx1.c as any, ctx1.next)
    await limiter(ctx2.c as any, ctx2.next)

    const calls = (mockRedis.eval as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][2]).toBe("ratelimit:llm:0xWallet1")
    expect(calls[1][2]).toBe("ratelimit:llm:0xWallet2")
  })
})
