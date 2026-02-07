// tests/finn/rate-limiter.test.ts — Rate Limiter tests (SDD §4.10)

import assert from "node:assert/strict"
import {
  TokenBucket,
  RateLimiter,
  classifyRateLimit,
  getBackoffMs,
} from "../../src/cron/rate-limiter.js"
import type { RateLimitEvent } from "../../src/cron/rate-limiter.js"

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
  console.log("Rate Limiter Tests")
  console.log("==================")

  // ── 1. TokenBucket ────────────────────────────────────────

  console.log("\n--- TokenBucket ---")

  await test("starts at full capacity", () => {
    const bucket = new TokenBucket(10, 10)
    assert.equal(bucket.remaining(), 10)
  })

  await test("tryConsume decrements tokens", () => {
    const bucket = new TokenBucket(5, 5)
    assert.equal(bucket.tryConsume(), true)
    assert.equal(bucket.remaining(), 4)
  })

  await test("tryConsume returns false when exhausted", () => {
    const bucket = new TokenBucket(2, 100)
    assert.equal(bucket.tryConsume(), true)
    assert.equal(bucket.tryConsume(), true)
    assert.equal(bucket.tryConsume(), false)
  })

  await test("refills tokens over time", () => {
    let now = 0
    const clock = () => now
    // 3600 tokens/hour = 1 token/second
    const bucket = new TokenBucket(10, 3600, clock)

    // Drain all tokens
    for (let i = 0; i < 10; i++) bucket.tryConsume()
    assert.equal(bucket.remaining(), 0)

    // Advance 5 seconds — should refill 5 tokens
    now += 5000
    assert.equal(bucket.remaining(), 5)
  })

  await test("refill is capped at capacity", () => {
    let now = 0
    const clock = () => now
    const bucket = new TokenBucket(10, 3600, clock)

    // Consume 2 tokens
    bucket.tryConsume()
    bucket.tryConsume()
    assert.equal(bucket.remaining(), 8)

    // Advance way more than needed to refill
    now += 60 * 60 * 1000 // 1 hour
    assert.equal(bucket.remaining(), 10) // capped at capacity
  })

  await test("no refill if no time elapsed", () => {
    let now = 1000
    const clock = () => now
    const bucket = new TokenBucket(5, 3600, clock)
    bucket.tryConsume()
    // Don't advance clock
    assert.equal(bucket.remaining(), 4)
  })

  await test("refill is proportional to elapsed time (partial hour)", () => {
    let now = 0
    const clock = () => now
    // 100 tokens/hour capacity, 100 refill/hour
    const bucket = new TokenBucket(100, 100, clock)

    // Drain all
    for (let i = 0; i < 100; i++) bucket.tryConsume()
    assert.equal(bucket.remaining(), 0)

    // Advance 30 minutes — should refill 50 tokens (100/hr * 0.5hr)
    now += 1_800_000
    assert.equal(bucket.remaining(), 50)
  })

  await test("capacity and refillPerHour are exposed as readonly", () => {
    const bucket = new TokenBucket(42, 17)
    assert.equal(bucket.capacity, 42)
    assert.equal(bucket.refillPerHour, 17)
  })

  // ── 2. classifyRateLimit ──────────────────────────────────

  console.log("\n--- classifyRateLimit ---")

  await test("429 is classified as primary", () => {
    assert.equal(classifyRateLimit(429, {}), "primary")
  })

  await test("403 with Retry-After is classified as secondary", () => {
    assert.equal(
      classifyRateLimit(403, { "retry-after": "60" }),
      "secondary",
    )
  })

  await test("403 with capitalized Retry-After is classified as secondary", () => {
    assert.equal(
      classifyRateLimit(403, { "Retry-After": "30" }),
      "secondary",
    )
  })

  await test("403 without Retry-After is classified as none", () => {
    assert.equal(classifyRateLimit(403, {}), "none")
  })

  await test("200 is classified as none", () => {
    assert.equal(classifyRateLimit(200, {}), "none")
  })

  await test("500 is classified as none", () => {
    assert.equal(classifyRateLimit(500, {}), "none")
  })

  // ── 3. getBackoffMs ───────────────────────────────────────

  console.log("\n--- getBackoffMs ---")

  await test("backoff increases with attempt number", () => {
    // Run several times to account for jitter
    const attempt0Values: number[] = []
    const attempt3Values: number[] = []
    for (let i = 0; i < 20; i++) {
      attempt0Values.push(getBackoffMs(0, "primary"))
      attempt3Values.push(getBackoffMs(3, "primary"))
    }
    const avg0 = attempt0Values.reduce((a, b) => a + b) / attempt0Values.length
    const avg3 = attempt3Values.reduce((a, b) => a + b) / attempt3Values.length
    assert.ok(avg3 > avg0, `avg attempt 3 (${avg3}) should be > avg attempt 0 (${avg0})`)
  })

  await test("secondary classification uses higher multiplier", () => {
    const primaryValues: number[] = []
    const secondaryValues: number[] = []
    for (let i = 0; i < 20; i++) {
      primaryValues.push(getBackoffMs(1, "primary"))
      secondaryValues.push(getBackoffMs(1, "secondary"))
    }
    const avgPrimary = primaryValues.reduce((a, b) => a + b) / primaryValues.length
    const avgSecondary = secondaryValues.reduce((a, b) => a + b) / secondaryValues.length
    assert.ok(avgSecondary > avgPrimary, `secondary avg (${avgSecondary}) > primary avg (${avgPrimary})`)
  })

  await test("backoff is capped at 60 seconds", () => {
    for (let i = 0; i < 20; i++) {
      const ms = getBackoffMs(20, "secondary") // Very high attempt
      assert.ok(ms <= 75000, `backoff ${ms} should be <= 75000 (60s * 1.25 jitter)`)
    }
  })

  await test("backoff has jitter (not all identical)", () => {
    const values = Array.from({ length: 10 }, () => getBackoffMs(2, "primary"))
    const unique = new Set(values)
    assert.ok(unique.size > 1, "Expected jitter to produce varied values")
  })

  // ── 4. RateLimiter ────────────────────────────────────────

  console.log("\n--- RateLimiter ---")

  await test("tryConsume succeeds when tokens available", () => {
    const limiter = new RateLimiter({ globalCapacity: 10 })
    assert.equal(limiter.tryConsume("get_issue"), true)
  })

  await test("tryConsume fails when global bucket exhausted", () => {
    const limiter = new RateLimiter({ globalCapacity: 2, globalRefillPerHour: 0 })
    assert.equal(limiter.tryConsume("tool_a"), true)
    assert.equal(limiter.tryConsume("tool_b"), true)
    assert.equal(limiter.tryConsume("tool_c"), false) // exhausted
  })

  await test("tryConsume checks per-job bucket when jobId provided", () => {
    const limiter = new RateLimiter({
      globalCapacity: 1000,
      jobCapacity: 2,
      jobRefillPerHour: 0,
    })
    assert.equal(limiter.tryConsume("tool", "job-1"), true)
    assert.equal(limiter.tryConsume("tool", "job-1"), true)
    assert.equal(limiter.tryConsume("tool", "job-1"), false) // job bucket exhausted
    assert.equal(limiter.tryConsume("tool", "job-2"), true) // different job is fine
  })

  await test("getRemainingTokens returns correct global count", () => {
    const limiter = new RateLimiter({ globalCapacity: 100 })
    limiter.tryConsume("tool")
    const remaining = limiter.getRemainingTokens()
    assert.equal(remaining.global, 99)
    assert.equal(remaining.job, undefined)
  })

  await test("getRemainingTokens returns job count when requested", () => {
    const limiter = new RateLimiter({ globalCapacity: 100, jobCapacity: 50 })
    limiter.tryConsume("tool", "job-1")
    const remaining = limiter.getRemainingTokens("job-1")
    assert.equal(remaining.global, 99)
    assert.equal(remaining.job, 49)
  })

  await test("getRemainingTokens returns capacity for unknown job", () => {
    const limiter = new RateLimiter({ jobCapacity: 50 })
    const remaining = limiter.getRemainingTokens("never-seen")
    assert.equal(remaining.job, 50) // returns config capacity for unknown
  })

  await test("default config values are 500 global, 100 per-job", () => {
    const limiter = new RateLimiter()
    const tokens = limiter.getRemainingTokens("some-job")
    assert.equal(tokens.global, 500)
    assert.equal(tokens.job, 100)
  })

  await test("per-job buckets are isolated (exhausting job-1 does not affect job-2)", () => {
    let now = 1000
    const limiter = new RateLimiter(
      { globalCapacity: 500, globalRefillPerHour: 500, jobCapacity: 3, jobRefillPerHour: 100 },
      () => now,
    )

    // Exhaust job-1
    assert.equal(limiter.tryConsume("tool_a", "job-1"), true)
    assert.equal(limiter.tryConsume("tool_a", "job-1"), true)
    assert.equal(limiter.tryConsume("tool_a", "job-1"), true)
    assert.equal(limiter.tryConsume("tool_a", "job-1"), false)

    // job-2 should still have full per-job capacity
    assert.equal(limiter.tryConsume("tool_a", "job-2"), true)
    assert.equal(limiter.tryConsume("tool_a", "job-2"), true)
    assert.equal(limiter.tryConsume("tool_a", "job-2"), true)
    assert.equal(limiter.tryConsume("tool_a", "job-2"), false)
  })

  await test("global exhaustion blocks all jobs", () => {
    let now = 1000
    const limiter = new RateLimiter(
      { globalCapacity: 2, globalRefillPerHour: 100, jobCapacity: 100, jobRefillPerHour: 100 },
      () => now,
    )

    assert.equal(limiter.tryConsume("tool_a", "job-1"), true)
    assert.equal(limiter.tryConsume("tool_a", "job-2"), true)
    // Global exhausted — all jobs blocked
    assert.equal(limiter.tryConsume("tool_a", "job-1"), false)
    assert.equal(limiter.tryConsume("tool_a", "job-2"), false)
    assert.equal(limiter.tryConsume("tool_a", "job-3"), false)
  })

  await test("tokens refill after time passes (global recovery)", () => {
    let now = 0
    const limiter = new RateLimiter(
      { globalCapacity: 5, globalRefillPerHour: 10, jobCapacity: 100, jobRefillPerHour: 100 },
      () => now,
    )

    // Exhaust global
    for (let i = 0; i < 5; i++) limiter.tryConsume("tool_a")
    assert.equal(limiter.tryConsume("tool_a"), false)

    // Advance 30 minutes — should refill 5 tokens (10/hr * 0.5hr)
    now += 1_800_000
    assert.equal(limiter.tryConsume("tool_a"), true)
    assert.equal(limiter.getRemainingTokens().global, 4)
  })

  // ── 5. handleRateLimitResponse ────────────────────────────

  console.log("\n--- handleRateLimitResponse ---")

  await test("emits ratelimit:primary event on 429", () => {
    const limiter = new RateLimiter()
    let emitted: RateLimitEvent | null = null
    limiter.on("ratelimit:primary", (evt: RateLimitEvent) => { emitted = evt })

    const result = limiter.handleRateLimitResponse(429, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1700000000",
    }, 0)

    assert.equal(result.classification, "primary")
    assert.ok(result.backoffMs > 0)
    assert.ok(emitted)
    assert.equal(emitted!.type, "ratelimit:primary")
    assert.equal(emitted!.remaining, 0)
  })

  await test("emits ratelimit:secondary event on 403 + Retry-After", () => {
    const limiter = new RateLimiter()
    let emitted: RateLimitEvent | null = null
    limiter.on("ratelimit:secondary", (evt: RateLimitEvent) => { emitted = evt })

    const result = limiter.handleRateLimitResponse(403, {
      "retry-after": "30",
    }, 1)

    assert.equal(result.classification, "secondary")
    assert.equal(result.backoffMs, 30000) // Retry-After: 30s
    assert.ok(emitted)
    assert.equal(emitted!.type, "ratelimit:secondary")
  })

  await test("returns none classification for 200", () => {
    const limiter = new RateLimiter()
    const result = limiter.handleRateLimitResponse(200, {}, 0)
    assert.equal(result.classification, "none")
    assert.equal(result.backoffMs, 0)
  })

  await test("respects Retry-After header over computed backoff", () => {
    const limiter = new RateLimiter()
    const result = limiter.handleRateLimitResponse(429, {
      "retry-after": "120",
    }, 0)
    assert.equal(result.backoffMs, 120000)
  })

  await test("no event emitted for non-rate-limited responses", () => {
    const limiter = new RateLimiter()
    let eventCount = 0
    limiter.on("ratelimit:primary", () => eventCount++)
    limiter.on("ratelimit:secondary", () => eventCount++)

    limiter.handleRateLimitResponse(200, {}, 0)
    limiter.handleRateLimitResponse(500, {}, 0)
    limiter.handleRateLimitResponse(403, {}, 0) // 403 without Retry-After = none

    assert.equal(eventCount, 0)
  })

  await test("event includes resetAt from x-ratelimit-reset header", () => {
    const limiter = new RateLimiter()
    const events: Array<{ resetAt?: string }> = []
    limiter.on("ratelimit:primary", (evt: RateLimitEvent) => events.push(evt))

    const resetEpoch = Math.floor(Date.now() / 1000) + 3600
    limiter.handleRateLimitResponse(429, {
      "x-ratelimit-reset": String(resetEpoch),
    }, 0)

    assert.equal(events.length, 1)
    assert.ok(events[0].resetAt !== undefined, "Expected resetAt to be set")
    const parsed = new Date(events[0].resetAt!)
    assert.ok(!isNaN(parsed.getTime()), "Expected resetAt to be a valid ISO date")
  })

  // ── 6. Backoff jitter range verification ────────────────────

  console.log("\n--- Backoff Jitter Range ---")

  await test("backoff jitter stays within +/-25% range", () => {
    // For attempt=0, primary: base=1000, raw=1000
    // With jitter [0.75, 1.25]: expected range [750, 1250]
    const results: number[] = []
    for (let i = 0; i < 200; i++) {
      results.push(getBackoffMs(0, "primary"))
    }

    const min = Math.min(...results)
    const max = Math.max(...results)

    assert.ok(min >= 750, `Min backoff ${min}ms is below jitter floor (750ms)`)
    assert.ok(max <= 1250, `Max backoff ${max}ms exceeds jitter ceil (1250ms)`)
  })

  console.log("\nDone.")
}

main()
