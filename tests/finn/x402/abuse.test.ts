// tests/finn/x402/abuse.test.ts — Abuse Protection Tests (T-3.11)

import { describe, it, expect, vi } from "vitest"
import {
  QuoteRateLimiter,
  VerificationSemaphore,
  rejectDustPayment,
  AbuseProtection,
} from "../../../src/x402/abuse-protection.js"
import { X402Error } from "../../../src/x402/types.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"

// --- Mock Redis ---

function mockRedis(): RedisCommandClient {
  const store = new Map<string, number>()
  return {
    incr: vi.fn().mockImplementation(async (key: string) => {
      const val = (store.get(key) ?? 0) + 1
      store.set(key, val)
      return val
    }),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(null),
    evalsha: vi.fn().mockResolvedValue(null),
    scriptLoad: vi.fn().mockResolvedValue("sha1"),
  } as unknown as RedisCommandClient
}

// --- Quote Rate Limiter ---

describe("QuoteRateLimiter", () => {
  it("allows requests under limit", async () => {
    const redis = mockRedis()
    const limiter = new QuoteRateLimiter(redis, 60)

    // 60 requests should all pass
    for (let i = 0; i < 60; i++) {
      await expect(limiter.checkQuoteRate("192.168.1.1")).resolves.toBeUndefined()
    }
  })

  it("rejects request #61 with 429 (AC: 60 quotes/min/IP)", async () => {
    const redis = mockRedis()
    const limiter = new QuoteRateLimiter(redis, 60)

    // Fill the bucket
    for (let i = 0; i < 60; i++) {
      await limiter.checkQuoteRate("192.168.1.1")
    }

    // 61st should fail
    await expect(limiter.checkQuoteRate("192.168.1.1")).rejects.toThrow(X402Error)
    try {
      await limiter.checkQuoteRate("192.168.1.1")
    } catch (err) {
      expect((err as X402Error).httpStatus).toBe(429)
      expect((err as X402Error).code).toBe("RATE_LIMITED")
    }
  })

  it("different IPs have separate limits", async () => {
    const redis = mockRedis()
    const limiter = new QuoteRateLimiter(redis, 2)

    await limiter.checkQuoteRate("10.0.0.1")
    await limiter.checkQuoteRate("10.0.0.1")
    await expect(limiter.checkQuoteRate("10.0.0.1")).rejects.toThrow(X402Error)

    // Different IP is fine
    await expect(limiter.checkQuoteRate("10.0.0.2")).resolves.toBeUndefined()
  })

  it("sets TTL on first increment", async () => {
    const redis = mockRedis()
    const limiter = new QuoteRateLimiter(redis, 60)

    await limiter.checkQuoteRate("10.0.0.1")
    expect(redis.expire).toHaveBeenCalledWith("x402:quote-rate:10.0.0.1", 60)
  })
})

// --- Dust Rejection ---

describe("Dust rejection", () => {
  it("accepts payment >= minimum (100 MicroUSDC)", () => {
    expect(() => rejectDustPayment(100n)).not.toThrow()
    expect(() => rejectDustPayment(1000000n)).not.toThrow()
  })

  it("rejects payment < minimum (AC: <100 MicroUSDC before sig verify)", () => {
    expect(() => rejectDustPayment(99n)).toThrow(X402Error)
    expect(() => rejectDustPayment(0n)).toThrow(X402Error)

    try {
      rejectDustPayment(50n)
    } catch (err) {
      expect((err as X402Error).code).toBe("PAYMENT_TOO_SMALL")
      expect((err as X402Error).httpStatus).toBe(402)
    }
  })

  it("respects custom minimum", () => {
    expect(() => rejectDustPayment(500n, 1000n)).toThrow(X402Error)
    expect(() => rejectDustPayment(1000n, 1000n)).not.toThrow()
  })
})

// --- Verification Semaphore ---

describe("VerificationSemaphore", () => {
  it("allows concurrent verifications up to limit", async () => {
    const semaphore = new VerificationSemaphore(3)
    const results: number[] = []

    const tasks = [1, 2, 3].map(n =>
      semaphore.verify(async () => {
        results.push(n)
        return n
      })
    )

    const out = await Promise.all(tasks)
    expect(out).toEqual([1, 2, 3])
    expect(results).toEqual([1, 2, 3])
  })

  it("rejects when queue full (AC: max 10 concurrent, 503)", async () => {
    const semaphore = new VerificationSemaphore(2)

    // Hold 2 slots
    let resolve1!: () => void
    let resolve2!: () => void
    const p1 = semaphore.verify(() => new Promise<void>(r => { resolve1 = r }))
    const p2 = semaphore.verify(() => new Promise<void>(r => { resolve2 = r }))

    // 3rd should fail
    await expect(
      semaphore.verify(async () => "should not run")
    ).rejects.toThrow("Signature verification queue full")

    try {
      await semaphore.verify(async () => "nope")
    } catch (err) {
      expect((err as X402Error).httpStatus).toBe(503)
    }

    // Clean up
    resolve1()
    resolve2()
    await Promise.all([p1, p2])
  })

  it("releases slot after completion", async () => {
    const semaphore = new VerificationSemaphore(1)

    await semaphore.verify(async () => "first")
    expect(semaphore.activeCount).toBe(0)

    // Should be able to run another
    await semaphore.verify(async () => "second")
  })

  it("releases slot on error", async () => {
    const semaphore = new VerificationSemaphore(1)

    await expect(
      semaphore.verify(async () => { throw new Error("oops") })
    ).rejects.toThrow("oops")

    expect(semaphore.activeCount).toBe(0)

    // Should be able to run another
    const result = await semaphore.verify(async () => "recovered")
    expect(result).toBe("recovered")
  })
})

// --- Composed AbuseProtection ---

describe("AbuseProtection (composed)", () => {
  it("provides all three protection layers", async () => {
    const redis = mockRedis()
    const protection = new AbuseProtection(redis)

    // Rate limit
    await expect(protection.checkQuoteRate("1.2.3.4")).resolves.toBeUndefined()

    // Dust check
    expect(() => protection.checkDustPayment(100n)).not.toThrow()
    expect(() => protection.checkDustPayment(50n)).toThrow(X402Error)

    // Semaphore
    const result = await protection.verifySignature(async () => true)
    expect(result).toBe(true)
  })
})
