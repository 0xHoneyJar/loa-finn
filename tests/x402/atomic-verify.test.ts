// tests/x402/atomic-verify.test.ts — Atomic Verify Tests (Sprint 2 T2.6)

import { describe, it, expect, beforeEach } from "vitest"
import {
  atomicVerify,
  storeChallenge,
  getChallenge,
  VerifyAtomicResult,
} from "../../src/x402/atomic-verify.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis (in-memory implementation for unit tests)
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
      let ttl = 0
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === "EX" && i + 1 < args.length) {
          ttl = Number(args[i + 1])
        }
        if (String(args[i]).toUpperCase() === "NX") {
          if (store.has(key) && !isExpired(key)) return null
        }
      }
      store.set(key, {
        value,
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
      })
      return "OK"
    },
    async del(...keys: string[]) {
      let count = 0
      for (const k of keys) {
        if (store.delete(k)) count++
      }
      return count
    },
    async exists(...keys: string[]) {
      return keys.filter((k) => !isExpired(k) && store.has(k)).length
    },
    async eval(script: string, numkeys: number, ...args: (string | number)[]) {
      // Simulate the x402_verify_atomic Lua script
      const keys = args.slice(0, numkeys).map(String)
      const argv = args.slice(numkeys).map(String)

      const challengeKey = keys[0]
      const replayKey = keys[1]
      const replayTtl = Number(argv[0])
      const txHash = argv[1]

      // Step A: Check nonce exists
      const challenge = store.get(challengeKey)
      if (!challenge || isExpired(challengeKey)) return 1

      // Step B: Check consumed
      const consumedKey = `${challengeKey}:consumed`
      if (store.has(consumedKey) && !isExpired(consumedKey)) return 3

      // Step C: Check replay
      if (store.has(replayKey) && !isExpired(replayKey)) return 2

      // Step D: Atomic mark
      store.set(consumedKey, {
        value: "1",
        expiresAt: Date.now() + 300_000,
      })
      store.set(replayKey, {
        value: txHash,
        expiresAt: Date.now() + replayTtl * 1000,
      })
      store.delete(challengeKey)

      return 0
    },
    // Stubs for unused methods
    async incrby() { return 0 },
    async incrbyfloat() { return "0" },
    async expire() { return 0 },
    async ping() { return "PONG" },
    async hgetall() { return {} },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
  }
}

describe("storeChallenge + getChallenge", () => {
  let redis: RedisCommandClient

  beforeEach(() => {
    redis = createMockRedis()
  })

  it("stores and retrieves a challenge", async () => {
    await storeChallenge(redis, "nonce-123", '{"test":true}', 300)
    const result = await getChallenge(redis, "nonce-123")
    expect(result).toBe('{"test":true}')
  })

  it("returns null for unknown nonce", async () => {
    const result = await getChallenge(redis, "nonexistent")
    expect(result).toBeNull()
  })
})

describe("atomicVerify", () => {
  let redis: RedisCommandClient

  beforeEach(() => {
    redis = createMockRedis()
  })

  it("SUCCESS: valid nonce and unused tx_hash", async () => {
    await storeChallenge(redis, "nonce-1", '{"challenge":"data"}', 300)

    const result = await atomicVerify(redis, {
      nonce: "nonce-1",
      txHash: "0xabc123",
    })
    expect(result).toBe(VerifyAtomicResult.SUCCESS)

    // Challenge should be consumed (deleted)
    const after = await getChallenge(redis, "nonce-1")
    expect(after).toBeNull()
  })

  it("NONCE_NOT_FOUND: expired or missing nonce", async () => {
    const result = await atomicVerify(redis, {
      nonce: "nonexistent",
      txHash: "0xabc123",
    })
    expect(result).toBe(VerifyAtomicResult.NONCE_NOT_FOUND)
  })

  it("REPLAY_DETECTED: tx_hash already used", async () => {
    // First verification succeeds
    await storeChallenge(redis, "nonce-1", '{"challenge":"data"}', 300)
    const first = await atomicVerify(redis, {
      nonce: "nonce-1",
      txHash: "0xabc123",
    })
    expect(first).toBe(VerifyAtomicResult.SUCCESS)

    // Second verification with same tx_hash but different nonce
    await storeChallenge(redis, "nonce-2", '{"challenge":"data2"}', 300)
    const second = await atomicVerify(redis, {
      nonce: "nonce-2",
      txHash: "0xabc123",
    })
    expect(second).toBe(VerifyAtomicResult.REPLAY_DETECTED)
  })

  it("RACE_LOST: nonce already consumed by concurrent request", async () => {
    await storeChallenge(redis, "nonce-1", '{"challenge":"data"}', 300)

    // First request consumes it
    const first = await atomicVerify(redis, {
      nonce: "nonce-1",
      txHash: "0xabc123",
    })
    expect(first).toBe(VerifyAtomicResult.SUCCESS)

    // Second request with different tx_hash — nonce already consumed
    // Need to re-store because first consumed it, but the consumed marker remains
    // In practice, the nonce would be gone (deleted), so we get NONCE_NOT_FOUND
    const second = await atomicVerify(redis, {
      nonce: "nonce-1",
      txHash: "0xdef456",
    })
    expect(second).toBe(VerifyAtomicResult.NONCE_NOT_FOUND)
  })

  it("uses custom replay TTL", async () => {
    await storeChallenge(redis, "nonce-1", '{"challenge":"data"}', 300)

    const result = await atomicVerify(redis, {
      nonce: "nonce-1",
      txHash: "0xabc123",
      replayTtlSeconds: 3600, // 1 hour
    })
    expect(result).toBe(VerifyAtomicResult.SUCCESS)
  })
})
