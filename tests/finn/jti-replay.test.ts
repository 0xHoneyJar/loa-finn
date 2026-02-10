// tests/finn/jti-replay.test.ts — JTI Replay Protection tests (F6b, T-31.2)

import { describe, it, expect, afterEach } from "vitest"
import {
  InMemoryJtiReplayGuard,
  deriveJtiTtl,
  createJtiReplayGuard,
} from "../../src/hounfour/jti-replay.js"

describe("deriveJtiTtl", () => {
  const CLOCK_SKEW = 60

  it("derives TTL from exp claim with clock skew", () => {
    const now = 1000
    const exp = now + 300 // 5 minutes
    const ttl = deriveJtiTtl(exp, now)
    // raw = 300 + 60 = 360
    expect(ttl).toBe(360)
  })

  it("short-lived token (exp in 30s) → TTL = 90s (30 + 60 skew)", () => {
    const now = 1000
    const exp = now + 30
    const ttl = deriveJtiTtl(exp, now)
    // raw = 30 + 60 = 90
    expect(ttl).toBe(90)
  })

  it("long-lived token (exp in 3h) → TTL capped at 7200s", () => {
    const now = 1000
    const exp = now + 10800 // 3 hours
    const ttl = deriveJtiTtl(exp, now)
    // raw = 10800 + 60 = 10860 → clamped to 7200
    expect(ttl).toBe(7200)
  })

  it("expired token within clock skew → floor at 30s", () => {
    const now = 1000
    const exp = now - 20 // expired 20s ago
    const ttl = deriveJtiTtl(exp, now)
    // raw = -20 + 60 = 40 → 40 >= 30, so 40
    expect(ttl).toBe(40)
  })

  it("very expired token → floor at 30s", () => {
    const now = 1000
    const exp = now - 100 // expired 100s ago
    const ttl = deriveJtiTtl(exp, now)
    // raw = -100 + 60 = -40 → clamped to 30
    expect(ttl).toBe(30)
  })

  it("clock skew boundary (exp - now = -30s)", () => {
    const now = 1000
    const exp = now - 30
    const ttl = deriveJtiTtl(exp, now)
    // raw = -30 + 60 = 30 → exactly the floor
    expect(ttl).toBe(30)
  })
})

describe("InMemoryJtiReplayGuard", () => {
  let guard: InMemoryJtiReplayGuard

  afterEach(() => {
    if (guard) guard.dispose()
  })

  it("fresh JTI returns false (not a replay)", async () => {
    guard = new InMemoryJtiReplayGuard()
    const isReplay = await guard.checkAndStore("jti-001", 60)
    expect(isReplay).toBe(false)
  })

  it("replay within TTL returns true", async () => {
    guard = new InMemoryJtiReplayGuard()
    await guard.checkAndStore("jti-001", 60)
    const isReplay = await guard.checkAndStore("jti-001", 60)
    expect(isReplay).toBe(true)
  })

  it("different JTIs do not conflict", async () => {
    guard = new InMemoryJtiReplayGuard()
    await guard.checkAndStore("jti-001", 60)
    const isReplay = await guard.checkAndStore("jti-002", 60)
    expect(isReplay).toBe(false)
  })

  it("replay after TTL expiry returns false (window expired)", async () => {
    guard = new InMemoryJtiReplayGuard()
    // Store with very short TTL (we'll manually test via internal state)
    // Use TTL of 0 seconds — entry expires immediately
    await guard.checkAndStore("jti-expire", 0)
    // Wait briefly so Date.now() advances past expiresAt
    await new Promise(r => setTimeout(r, 10))
    const isReplay = await guard.checkAndStore("jti-expire", 60)
    expect(isReplay).toBe(false) // Window expired, ID reclaimed
  })

  it("max size eviction: 100,001st JTI evicts oldest entry", async () => {
    guard = new InMemoryJtiReplayGuard(5) // Small max for testing
    // Fill up with 5 entries
    for (let i = 0; i < 5; i++) {
      await guard.checkAndStore(`jti-${i}`, 3600)
    }
    expect(guard.size).toBe(5)

    // 6th entry should evict the oldest (jti-0)
    await guard.checkAndStore("jti-new", 3600)
    expect(guard.size).toBe(5) // Still 5 (one evicted)

    // jti-0 was evicted, so it should not be detected as replay
    const isReplay = await guard.checkAndStore("jti-0", 3600)
    expect(isReplay).toBe(false) // Was evicted
  })

  it("dispose clears all entries", async () => {
    guard = new InMemoryJtiReplayGuard()
    await guard.checkAndStore("jti-001", 60)
    guard.dispose()
    expect(guard.size).toBe(0)
  })
})

describe("createJtiReplayGuard", () => {
  it("creates in-memory guard when no Redis provided", () => {
    const guard = createJtiReplayGuard()
    expect(guard).toBeInstanceOf(InMemoryJtiReplayGuard)
    guard.dispose()
  })

  it("creates in-memory guard when Redis is disconnected", () => {
    const fakeRedis = { isConnected: () => false } as any
    const guard = createJtiReplayGuard(fakeRedis)
    expect(guard).toBeInstanceOf(InMemoryJtiReplayGuard)
    guard.dispose()
  })
})
