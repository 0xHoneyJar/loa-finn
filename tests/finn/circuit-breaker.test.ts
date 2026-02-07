// tests/finn/circuit-breaker.test.ts — Circuit breaker state machine tests (SDD §4.12, TASK-2.6)

import assert from "node:assert/strict"
import {
  CircuitBreaker,
  classifyGitHubFailure,
  type FailureClass,
} from "../../src/cron/circuit-breaker.js"

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
  console.log("Circuit Breaker Tests")
  console.log("=====================")

  // ── 1. Starts in closed state, canExecute returns true ────

  await test("starts in closed state, canExecute returns true", () => {
    const cb = new CircuitBreaker()
    assert.equal(cb.state.state, "closed")
    assert.equal(cb.state.failures, 0)
    assert.equal(cb.state.successes, 0)
    assert.equal(cb.canExecute(), true)
  })

  // ── 2. recordSuccess resets failure count when closed ─────

  await test("recordSuccess resets failure count when closed", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 5 }, () => now)

    // Record some failures (not enough to trip)
    cb.recordFailure("transient")
    cb.recordFailure("transient")
    assert.equal(cb.state.failures, 2)

    // Success should reset failure count
    cb.recordSuccess()
    assert.equal(cb.state.failures, 0)
    assert.equal(cb.state.state, "closed")
  })

  // ── 3. Threshold failures -> transitions to open ──────────

  await test("threshold failures transitions to open, canExecute returns false", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 60_000 }, () => now)

    for (let i = 0; i < 3; i++) {
      now += 100
      cb.recordFailure("transient")
    }

    assert.equal(cb.state.state, "open")
    assert.equal(cb.canExecute(), false)
  })

  // ── 4. Open -> half_open after timeout elapsed ────────────

  await test("open -> half_open after timeout elapsed", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 2, openDurationMs: 5000 }, () => now)

    cb.recordFailure("transient")
    cb.recordFailure("transient")
    assert.equal(cb.state.state, "open")
    assert.equal(cb.canExecute(), false)

    // Advance clock past openDurationMs
    now += 5000
    assert.equal(cb.canExecute(), true)
    assert.equal(cb.state.state, "half_open")
  })

  // ── 5. Half-open: probe success -> closed ─────────────────

  await test("half-open: probe successes reaching probeCount transitions to closed", () => {
    let now = 1000
    const cb = new CircuitBreaker(
      { failureThreshold: 2, openDurationMs: 1000, halfOpenProbeCount: 2 },
      () => now,
    )

    // Trip to open
    cb.recordFailure("transient")
    cb.recordFailure("transient")
    assert.equal(cb.state.state, "open")

    // Advance to half_open
    now += 1000
    cb.canExecute()
    assert.equal(cb.state.state, "half_open")

    // First success — still half_open
    cb.recordSuccess()
    assert.equal(cb.state.state, "half_open")
    assert.equal(cb.state.successes, 1)

    // Second success — transitions to closed
    cb.recordSuccess()
    assert.equal(cb.state.state, "closed")
    assert.equal(cb.state.failures, 0)
    assert.equal(cb.state.successes, 0)
  })

  // ── 6. Half-open: any failure -> back to open ─────────────

  await test("half-open: any failure transitions back to open", () => {
    let now = 1000
    const cb = new CircuitBreaker(
      { failureThreshold: 2, openDurationMs: 1000 },
      () => now,
    )

    // Trip to open
    cb.recordFailure("transient")
    cb.recordFailure("transient")

    // Advance to half_open
    now += 1000
    cb.canExecute()
    assert.equal(cb.state.state, "half_open")

    // Failure in half_open -> back to open
    cb.recordFailure("transient")
    assert.equal(cb.state.state, "open")
  })

  // ── 7. Expected failures don't count toward threshold ─────

  await test("expected failures don't count toward threshold", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 3 }, () => now)

    // Record expected failures — should not count
    cb.recordFailure("expected")
    cb.recordFailure("expected")
    cb.recordFailure("expected")
    cb.recordFailure("expected")
    assert.equal(cb.state.failures, 0)
    assert.equal(cb.state.state, "closed")

    // Mix expected with real failures
    cb.recordFailure("transient")
    cb.recordFailure("expected")
    cb.recordFailure("transient")
    assert.equal(cb.state.failures, 2)
    assert.equal(cb.state.state, "closed")
  })

  // ── 8. rate_limited failures count toward threshold ───────

  await test("rate_limited failures count toward threshold", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 3 }, () => now)

    now += 100
    cb.recordFailure("rate_limited")
    now += 100
    cb.recordFailure("rate_limited")
    assert.equal(cb.state.failures, 2)
    assert.equal(cb.state.state, "closed")

    now += 100
    cb.recordFailure("rate_limited")
    assert.equal(cb.state.state, "open")
  })

  // ── 8b. Rolling window evicts stale failures (H-3) ──────────

  await test("rolling window evicts failures outside rollingWindowMs", () => {
    let now = 0
    const cb = new CircuitBreaker(
      { failureThreshold: 3, rollingWindowMs: 5000 },
      () => now,
    )

    // Record 2 failures at t=0 and t=1000
    now = 0
    cb.recordFailure("transient")
    now = 1000
    cb.recordFailure("transient")
    assert.equal(cb.state.failures, 2)

    // Advance clock past rolling window for the first 2 failures
    // At t=6000, windowStart = 6000 - 5000 = 1000. Filter keeps ts > 1000.
    // t=0 is evicted (0 <= 1000), t=1000 is evicted (1000 <= 1000), only new one remains.
    now = 6000
    cb.recordFailure("transient")
    assert.equal(cb.state.failures, 1, "stale failures should be evicted from rolling window")
    assert.equal(cb.state.state, "closed", "should NOT trip because only 1 in-window failure")

    // Add more failures within the window to trip it
    now = 7000
    cb.recordFailure("transient")
    now = 8000
    cb.recordFailure("transient")
    assert.equal(cb.state.state, "open", "should now be open with 3 in-window failures")
  })

  await test("rolling window: all failures within window counts correctly", () => {
    let now = 1000
    const cb = new CircuitBreaker(
      { failureThreshold: 3, rollingWindowMs: 10_000 },
      () => now,
    )

    now = 1000
    cb.recordFailure("transient")
    now = 2000
    cb.recordFailure("transient")
    now = 3000
    cb.recordFailure("transient")

    // All 3 within 10s window — should trip
    assert.equal(cb.state.state, "open")
    assert.equal(cb.state.failures, 3)
  })

  // ── 9. classifyGitHubFailure ──────────────────────────────

  await test("classifyGitHubFailure: 429 = rate_limited", () => {
    assert.equal(classifyGitHubFailure(429), "rate_limited")
  })

  await test("classifyGitHubFailure: 403 + Retry-After = rate_limited", () => {
    assert.equal(
      classifyGitHubFailure(403, { "retry-after": "60" }),
      "rate_limited",
    )
    assert.equal(
      classifyGitHubFailure(403, { "Retry-After": "120" }),
      "rate_limited",
    )
  })

  await test("classifyGitHubFailure: 403 without Retry-After = external", () => {
    assert.equal(classifyGitHubFailure(403), "external")
    assert.equal(classifyGitHubFailure(403, {}), "external")
  })

  await test("classifyGitHubFailure: 5xx = transient", () => {
    assert.equal(classifyGitHubFailure(500), "transient")
    assert.equal(classifyGitHubFailure(502), "transient")
    assert.equal(classifyGitHubFailure(503), "transient")
  })

  await test("classifyGitHubFailure: 422 = permanent", () => {
    assert.equal(classifyGitHubFailure(422), "permanent")
  })

  await test("classifyGitHubFailure: 404 = expected", () => {
    assert.equal(classifyGitHubFailure(404), "expected")
  })

  await test("classifyGitHubFailure: other codes = external", () => {
    assert.equal(classifyGitHubFailure(400), "external")
    assert.equal(classifyGitHubFailure(401), "external")
    assert.equal(classifyGitHubFailure(418), "external")
  })

  // ── 10. Manual reset from open -> closed ──────────────────

  await test("manual reset from open transitions to closed", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 2, openDurationMs: 60_000 }, () => now)

    cb.recordFailure("transient")
    cb.recordFailure("transient")
    assert.equal(cb.state.state, "open")

    cb.reset()
    assert.equal(cb.state.state, "closed")
    assert.equal(cb.state.failures, 0)
    assert.equal(cb.state.successes, 0)
    assert.equal(cb.canExecute(), true)
  })

  // ── 11. Events emitted: circuit:opened, circuit:closed ────

  await test("emits circuit:opened event on transition to open", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 2 }, () => now)
    const events: Array<{ from: string }> = []
    cb.on("circuit:opened", (e) => events.push(e))

    cb.recordFailure("transient")
    cb.recordFailure("transient")

    assert.equal(events.length, 1)
    assert.equal(events[0].from, "closed")
  })

  await test("emits circuit:closed event on transition to closed", () => {
    let now = 1000
    const cb = new CircuitBreaker(
      { failureThreshold: 2, openDurationMs: 1000, halfOpenProbeCount: 1 },
      () => now,
    )
    const events: Array<{ from: string }> = []
    cb.on("circuit:closed", (e) => events.push(e))

    // Trip to open
    cb.recordFailure("transient")
    cb.recordFailure("transient")

    // Advance to half_open
    now += 1000
    cb.canExecute()

    // Succeed to close
    cb.recordSuccess()

    assert.equal(events.length, 1)
    assert.equal(events[0].from, "half_open")
  })

  await test("emits circuit:closed event on manual reset", () => {
    let now = 1000
    const cb = new CircuitBreaker({ failureThreshold: 2 }, () => now)
    const events: Array<{ from: string }> = []
    cb.on("circuit:closed", (e) => events.push(e))

    cb.recordFailure("transient")
    cb.recordFailure("transient")

    cb.reset()
    assert.equal(events.length, 1)
    assert.equal(events[0].from, "open")
  })

  // ── 12. restoreState restores from persisted data ─────────

  await test("restoreState restores from persisted data", () => {
    const cb = new CircuitBreaker()
    assert.equal(cb.state.state, "closed")

    cb.restoreState({
      state: "open",
      failures: 4,
      successes: 0,
      openedAt: 5000,
      lastFailureAt: 4500,
    })

    assert.equal(cb.state.state, "open")
    assert.equal(cb.state.failures, 4)
    assert.equal(cb.state.openedAt, 5000)
    assert.equal(cb.state.lastFailureAt, 4500)
  })

  await test("restoreState to half_open allows probing", () => {
    let now = 10_000
    const cb = new CircuitBreaker({ halfOpenProbeCount: 1 }, () => now)

    cb.restoreState({
      state: "half_open",
      failures: 3,
      successes: 0,
      halfOpenAt: 9000,
    })

    assert.equal(cb.canExecute(), true)
    assert.equal(cb.state.state, "half_open")

    cb.recordSuccess()
    assert.equal(cb.state.state, "closed")
  })

  console.log("\nDone.")
}

main()
