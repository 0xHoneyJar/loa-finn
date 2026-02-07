// tests/finn/dashboard-rate-limit.test.ts — Dashboard rate limiter tests (TASK-6.7)

import assert from "node:assert/strict"
import {
  DashboardRateLimiter,
} from "../../src/gateway/dashboard-rate-limit.js"
import type {
  RateLimitConfig,
  RateLimitRequest,
  RateLimitResult,
} from "../../src/gateway/dashboard-rate-limit.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

async function main() {
  console.log("Dashboard Rate Limiter Tests (TASK-6.7)")
  console.log("========================================")

  // ── 1. Basic allow/deny ─────────────────────────────────

  console.log("\n--- Basic allow/deny ---")

  await test("first request is allowed with full remaining", () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 60 })
    const result = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(result.allowed, true)
    assert.equal(result.headers["X-RateLimit-Remaining"], "59")
  })

  await test("requests within limit all pass with decreasing remaining", () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 5 })
    for (let i = 1; i <= 5; i++) {
      const result = limiter.check({ remoteAddr: "10.0.0.1" })
      assert.equal(result.allowed, true)
      assert.equal(result.headers["X-RateLimit-Remaining"], String(5 - i))
    }
  })

  await test("request at limit (61st) returns 429 with retryAfter", () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 60 })
    for (let i = 0; i < 60; i++) limiter.check({ remoteAddr: "10.0.0.1" })
    const result = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(result.allowed, false)
    assert.ok(result.retryAfterSeconds !== undefined)
    assert.ok(result.retryAfterSeconds! > 0)
    assert.ok(result.headers["Retry-After"] !== undefined)
  })

  // ── 2. Window reset ─────────────────────────────────────

  console.log("\n--- Window reset ---")

  await test("window reset after timeout allows new requests", async () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 3, windowMs: 50 })
    for (let i = 0; i < 3; i++) limiter.check({ remoteAddr: "10.0.0.1" })
    const blocked = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(blocked.allowed, false)

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60))
    const fresh = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(fresh.allowed, true)
    assert.equal(fresh.headers["X-RateLimit-Remaining"], "2")
  })

  // ── 3. IP isolation ─────────────────────────────────────

  console.log("\n--- IP isolation ---")

  await test("different IPs have independent limits", () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 2 })
    limiter.check({ remoteAddr: "10.0.0.1" })
    limiter.check({ remoteAddr: "10.0.0.1" })
    const blocked = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(blocked.allowed, false)

    const otherIp = limiter.check({ remoteAddr: "10.0.0.2" })
    assert.equal(otherIp.allowed, true)
    assert.equal(otherIp.headers["X-RateLimit-Remaining"], "1")
  })

  // ── 4. Headers ──────────────────────────────────────────

  console.log("\n--- Headers ---")

  await test("X-RateLimit-Limit header always present", () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 42 })
    const result = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(result.headers["X-RateLimit-Limit"], "42")
  })

  await test("X-RateLimit-Remaining decreases correctly", () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 3 })
    const r1 = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(r1.headers["X-RateLimit-Remaining"], "2")
    const r2 = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(r2.headers["X-RateLimit-Remaining"], "1")
    const r3 = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(r3.headers["X-RateLimit-Remaining"], "0")
    // Past limit: remaining stays at 0
    const r4 = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(r4.headers["X-RateLimit-Remaining"], "0")
  })

  await test("X-RateLimit-Reset is valid unix timestamp", () => {
    const before = Math.floor(Date.now() / 1000)
    const limiter = new DashboardRateLimiter({ maxRequests: 60, windowMs: 60_000 })
    const result = limiter.check({ remoteAddr: "10.0.0.1" })
    const reset = Number(result.headers["X-RateLimit-Reset"])
    assert.ok(!isNaN(reset), "Reset should be a number")
    // Reset should be in the future (within the next ~60s)
    assert.ok(reset >= before, "Reset should be >= current time")
    assert.ok(reset <= before + 61, "Reset should be within the window")
  })

  // ── 5. Cleanup ──────────────────────────────────────────

  console.log("\n--- Cleanup ---")

  await test("cleanup removes stale entries", async () => {
    const limiter = new DashboardRateLimiter({ maxRequests: 10, windowMs: 30 })
    limiter.check({ remoteAddr: "10.0.0.1" })
    limiter.check({ remoteAddr: "10.0.0.2" })

    // Wait for entries to become stale (2x window = 60ms)
    await new Promise((r) => setTimeout(r, 70))

    limiter.cleanup()

    // After cleanup, a new request should have full remaining
    const result = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(result.headers["X-RateLimit-Remaining"], "9")
  })

  // ── 6. Default config ──────────────────────────────────

  console.log("\n--- Default config ---")

  await test("default config uses 60 req/min", () => {
    const limiter = new DashboardRateLimiter()
    const result = limiter.check({ remoteAddr: "10.0.0.1" })
    assert.equal(result.headers["X-RateLimit-Limit"], "60")
    assert.equal(result.headers["X-RateLimit-Remaining"], "59")
  })

  console.log("\nDone.")
}

main()
