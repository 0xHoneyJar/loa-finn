// tests/finn/circuit-breaker.test.ts — Circuit breaker state transition tests (T-4.8)

import assert from "node:assert/strict"
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../../src/scheduler/circuit-breaker.js"

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

  await test("starts in CLOSED state", async () => {
    const cb = new CircuitBreaker("test")
    assert.equal(cb.getState(), "closed")
    assert.equal(cb.getStats().failureCount, 0)
  })

  await test("CLOSED -> OPEN after 3 failures", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3, cooldownMs: 100 })
    const transitions: string[] = []
    cb.onTransition((_id, from, to) => transitions.push(`${from}->${to}`))

    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(async () => {
          throw new Error("fail")
        })
      } catch {
        // Expected
      }
    }

    assert.equal(cb.getState(), "open")
    assert.equal(cb.getStats().failureCount, 3)
    assert.ok(transitions.includes("closed->open"))
  })

  await test("OPEN rejects immediately", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, cooldownMs: 60_000 })

    // Trip the breaker
    try {
      await cb.execute(async () => {
        throw new Error("fail")
      })
    } catch {}

    assert.equal(cb.getState(), "open")

    // Attempt should be rejected without calling handler
    let handlerCalled = false
    try {
      await cb.execute(async () => {
        handlerCalled = true
      })
      assert.fail("should have thrown")
    } catch (err) {
      assert.ok(err instanceof CircuitBreakerOpenError)
      assert.equal(handlerCalled, false, "handler should NOT be called when OPEN")
    }
  })

  await test("OPEN -> HALF-OPEN after cooldown", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, cooldownMs: 50 })

    // Trip the breaker
    try {
      await cb.execute(async () => {
        throw new Error("fail")
      })
    } catch {}

    assert.equal(cb.getState(), "open")

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 60))

    assert.equal(cb.getState(), "half-open")
  })

  await test("HALF-OPEN -> CLOSED on success", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, cooldownMs: 50 })
    const transitions: string[] = []
    cb.onTransition((_id, from, to) => transitions.push(`${from}->${to}`))

    // Trip
    try {
      await cb.execute(async () => {
        throw new Error("fail")
      })
    } catch {}

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 60))

    // Succeed in half-open
    const result = await cb.execute(async () => "recovered")
    assert.equal(result, "recovered")
    assert.equal(cb.getState(), "closed")
    assert.equal(cb.getStats().failureCount, 0)
    assert.ok(transitions.includes("half-open->closed"))
  })

  await test("HALF-OPEN -> OPEN on failure", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, cooldownMs: 50 })

    // Trip
    try {
      await cb.execute(async () => {
        throw new Error("fail")
      })
    } catch {}

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 60))

    // Fail in half-open
    try {
      await cb.execute(async () => {
        throw new Error("fail again")
      })
    } catch {}

    assert.equal(cb.getState(), "open")
  })

  await test("manual reset returns to CLOSED", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1, cooldownMs: 60_000 })

    // Trip
    try {
      await cb.execute(async () => {
        throw new Error("fail")
      })
    } catch {}

    assert.equal(cb.getState(), "open")

    cb.reset()
    assert.equal(cb.getState(), "closed")
    assert.equal(cb.getStats().failureCount, 0)
  })

  await test("success in CLOSED resets nothing but increments count", async () => {
    const cb = new CircuitBreaker("test")

    await cb.execute(async () => "ok")
    await cb.execute(async () => "ok")

    const stats = cb.getStats()
    assert.equal(stats.successCount, 2)
    assert.equal(stats.state, "closed")
  })

  console.log("\nDone.")
}

main()
