// tests/finn/circuit-breaker.test.ts — Upstream circuit breaker tests (T-7.2)

import assert from "node:assert/strict"
import { CircuitBreaker, PersistenceError } from "../../src/persistence/upstream.js"

async function test(name: string, fn: () => Promise<void>) {
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

  let now = 0
  function clock() { return now }

  function createCB(config?: { maxFailures?: number; resetTimeMs?: number }) {
    now = 1000 // Start at a positive time
    const transitions: string[] = []
    const cb = new CircuitBreaker(
      { maxFailures: config?.maxFailures ?? 3, resetTimeMs: config?.resetTimeMs ?? 300_000, halfOpenRetries: 1 },
      {
        now: clock,
        onStateChange: (from, to) => transitions.push(`${from}->${to}`),
      },
    )
    return { cb, transitions }
  }

  await test("starts in CLOSED state", async () => {
    const { cb } = createCB()
    assert.equal(cb.getState(), "CLOSED")
    assert.equal(cb.getFailureCount(), 0)
  })

  await test("CLOSED -> OPEN after 3 failures", async () => {
    const { cb, transitions } = createCB({ maxFailures: 3, resetTimeMs: 100 })

    for (let i = 0; i < 3; i++) {
      now += 100
      try {
        await cb.execute(async () => { throw new Error("fail") })
      } catch { /* expected */ }
    }

    assert.equal(cb.getState(), "OPEN")
    assert.equal(cb.getFailureCount(), 3)
    assert.ok(transitions.includes("CLOSED->OPEN"))
  })

  await test("OPEN rejects immediately", async () => {
    const { cb } = createCB({ maxFailures: 1, resetTimeMs: 60_000 })

    // Trip the breaker
    now += 100
    try {
      await cb.execute(async () => { throw new Error("fail") })
    } catch { /* expected */ }

    assert.equal(cb.getState(), "OPEN")

    // Attempt should be rejected without calling handler
    let handlerCalled = false
    now += 100
    try {
      await cb.execute(async () => { handlerCalled = true })
      assert.fail("should have thrown")
    } catch (err) {
      assert.ok(err instanceof PersistenceError)
      assert.equal(handlerCalled, false, "handler should NOT be called when OPEN")
    }
  })

  await test("OPEN -> HALF_OPEN after cooldown", async () => {
    const { cb } = createCB({ maxFailures: 1, resetTimeMs: 1000 })

    // Trip the breaker
    now += 100
    try {
      await cb.execute(async () => { throw new Error("fail") })
    } catch { /* expected */ }

    assert.equal(cb.getState(), "OPEN")

    // Advance past cooldown
    now += 1001
    assert.equal(cb.getState(), "HALF_OPEN")
  })

  await test("HALF_OPEN -> CLOSED on success", async () => {
    const { cb, transitions } = createCB({ maxFailures: 1, resetTimeMs: 1000 })

    // Trip
    now += 100
    try {
      await cb.execute(async () => { throw new Error("fail") })
    } catch { /* expected */ }

    // Advance past cooldown
    now += 1001

    // Succeed in half-open
    const result = await cb.execute(async () => "recovered")
    assert.equal(result, "recovered")
    assert.equal(cb.getState(), "CLOSED")
    assert.equal(cb.getFailureCount(), 0)
    assert.ok(transitions.includes("HALF_OPEN->CLOSED"))
  })

  await test("HALF_OPEN -> OPEN on failure", async () => {
    const { cb } = createCB({ maxFailures: 1, resetTimeMs: 1000 })

    // Trip
    now += 100
    try {
      await cb.execute(async () => { throw new Error("fail") })
    } catch { /* expected */ }

    // Advance past cooldown
    now += 1001
    assert.equal(cb.getState(), "HALF_OPEN")

    // Fail in half-open
    now += 100
    try {
      await cb.execute(async () => { throw new Error("fail again") })
    } catch { /* expected */ }

    assert.equal(cb.getState(), "OPEN")
  })

  await test("manual reset returns to CLOSED", async () => {
    const { cb } = createCB({ maxFailures: 1, resetTimeMs: 60_000 })

    // Trip
    now += 100
    try {
      await cb.execute(async () => { throw new Error("fail") })
    } catch { /* expected */ }

    assert.equal(cb.getState(), "OPEN")

    cb.reset()
    assert.equal(cb.getState(), "CLOSED")
    assert.equal(cb.getFailureCount(), 0)
  })

  await test("success in CLOSED resets nothing but increments count", async () => {
    const { cb } = createCB()

    now += 100
    await cb.execute(async () => "ok")
    now += 100
    await cb.execute(async () => "ok")

    assert.equal(cb.getState(), "CLOSED")
    assert.equal(cb.getFailureCount(), 0)
  })

  console.log("\nDone.")
}

main()
