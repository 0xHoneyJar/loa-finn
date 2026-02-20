// tests/gateway/redis-health.test.ts — T2.3: Redis Health + Circuit Breaker (Bridge medium-3)
//
// Circuit breaker pattern: CLOSED → OPEN → HALF_OPEN → CLOSED
// Subsystem degradation: x402 → 503, SIWE → 401, rate limit → in-memory, API key → DB

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  RedisHealthMonitor,
  CircuitState,
  DegradationMode,
  SUBSYSTEM_DEGRADATION,
  withRedisGuard,
} from "../../src/gateway/redis-health.js"

// ---------------------------------------------------------------------------
// Circuit Breaker State Machine
// ---------------------------------------------------------------------------

describe("RedisHealthMonitor — Circuit Breaker", () => {
  let monitor: RedisHealthMonitor

  beforeEach(() => {
    monitor = new RedisHealthMonitor({ failureThreshold: 3, resetTimeoutMs: 1000 })
  })

  it("starts in CLOSED state", () => {
    expect(monitor.getState()).toBe(CircuitState.CLOSED)
    expect(monitor.isAvailable()).toBe(true)
  })

  it("stays CLOSED under threshold failures", () => {
    monitor.recordFailure()
    monitor.recordFailure()
    expect(monitor.getState()).toBe(CircuitState.CLOSED)
    expect(monitor.isAvailable()).toBe(true)
  })

  it("transitions CLOSED → OPEN after failureThreshold consecutive failures", () => {
    monitor.recordFailure()
    monitor.recordFailure()
    monitor.recordFailure()
    expect(monitor.getState()).toBe(CircuitState.OPEN)
    expect(monitor.isAvailable()).toBe(false)
  })

  it("resets failure count on success", () => {
    monitor.recordFailure()
    monitor.recordFailure()
    monitor.recordSuccess() // Reset
    monitor.recordFailure() // Only 1 failure now
    expect(monitor.getState()).toBe(CircuitState.CLOSED)
  })

  it("transitions OPEN → HALF_OPEN after resetTimeout", async () => {
    // Use very short timeout for testing
    const fastMonitor = new RedisHealthMonitor({ failureThreshold: 1, resetTimeoutMs: 50 })
    fastMonitor.recordFailure() // → OPEN
    expect(fastMonitor.getState()).toBe(CircuitState.OPEN)

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 60))
    expect(fastMonitor.getState()).toBe(CircuitState.HALF_OPEN)
    expect(fastMonitor.isAvailable()).toBe(true) // Allow probe
  })

  it("transitions HALF_OPEN → CLOSED on success (probe passed)", async () => {
    const fastMonitor = new RedisHealthMonitor({ failureThreshold: 1, resetTimeoutMs: 50 })
    fastMonitor.recordFailure() // → OPEN

    await new Promise((r) => setTimeout(r, 60))
    expect(fastMonitor.getState()).toBe(CircuitState.HALF_OPEN)

    fastMonitor.recordSuccess() // Probe succeeded → CLOSED
    expect(fastMonitor.getState()).toBe(CircuitState.CLOSED)
  })

  it("transitions HALF_OPEN → OPEN on failure (probe failed)", async () => {
    const fastMonitor = new RedisHealthMonitor({ failureThreshold: 1, resetTimeoutMs: 50 })
    fastMonitor.recordFailure() // → OPEN

    await new Promise((r) => setTimeout(r, 60))
    expect(fastMonitor.getState()).toBe(CircuitState.HALF_OPEN)

    fastMonitor.recordFailure() // Probe failed → OPEN
    expect(fastMonitor.getState()).toBe(CircuitState.OPEN)
  })

  it("calls onStateChange callback on transitions", () => {
    const transitions: Array<{ from: string; to: string }> = []
    const tracked = new RedisHealthMonitor({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      onStateChange: (from, to) => transitions.push({ from, to }),
    })

    tracked.recordFailure()
    tracked.recordFailure() // → OPEN
    expect(transitions).toHaveLength(1)
    expect(transitions[0]).toEqual({ from: "CLOSED", to: "OPEN" })
  })

  it("reset() returns to CLOSED state", () => {
    monitor.recordFailure()
    monitor.recordFailure()
    monitor.recordFailure() // → OPEN
    expect(monitor.getState()).toBe(CircuitState.OPEN)

    monitor.reset()
    expect(monitor.getState()).toBe(CircuitState.CLOSED)
    expect(monitor.isAvailable()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Subsystem Degradation Configuration
// ---------------------------------------------------------------------------

describe("Subsystem Degradation Config", () => {
  it("x402 nonces fail-closed with 503", () => {
    expect(SUBSYSTEM_DEGRADATION.x402_nonce.mode).toBe(DegradationMode.FAIL_CLOSED)
    expect(SUBSYSTEM_DEGRADATION.x402_nonce.httpStatus).toBe(503)
  })

  it("SIWE nonces fail-closed with 401", () => {
    expect(SUBSYSTEM_DEGRADATION.siwe_nonce.mode).toBe(DegradationMode.FAIL_CLOSED)
    expect(SUBSYSTEM_DEGRADATION.siwe_nonce.httpStatus).toBe(401)
  })

  it("rate limiting degrades to in-memory", () => {
    expect(SUBSYSTEM_DEGRADATION.rate_limit.mode).toBe(DegradationMode.IN_MEMORY_FALLBACK)
  })

  it("API key cache falls through to DB", () => {
    expect(SUBSYSTEM_DEGRADATION.api_key_cache.mode).toBe(DegradationMode.DB_FALLBACK)
  })
})

// ---------------------------------------------------------------------------
// withRedisGuard Helper
// ---------------------------------------------------------------------------

describe("withRedisGuard", () => {
  it("executes operation and records success when circuit is closed", async () => {
    const monitor = new RedisHealthMonitor()
    const result = await withRedisGuard(monitor, "api_key_cache", async () => "cached-value")

    expect(result.ok).toBe(true)
    expect(result.value).toBe("cached-value")
    expect(result.degraded).toBe(false)
  })

  it("returns degraded result when circuit is open", async () => {
    const monitor = new RedisHealthMonitor({ failureThreshold: 1 })
    monitor.recordFailure() // → OPEN

    const fn = vi.fn(async () => "should-not-run")
    const result = await withRedisGuard(monitor, "x402_nonce", fn)

    expect(result.ok).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.mode).toBe(DegradationMode.FAIL_CLOSED)
    expect(fn).not.toHaveBeenCalled()
  })

  it("returns degraded result on Redis operation failure", async () => {
    const monitor = new RedisHealthMonitor()
    const result = await withRedisGuard(monitor, "rate_limit", async () => {
      throw new Error("ECONNREFUSED")
    })

    expect(result.ok).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.mode).toBe(DegradationMode.IN_MEMORY_FALLBACK)
  })

  it("opens circuit after repeated failures through withRedisGuard", async () => {
    const monitor = new RedisHealthMonitor({ failureThreshold: 2 })

    // Two failures → opens circuit
    await withRedisGuard(monitor, "api_key_cache", async () => { throw new Error("fail") })
    await withRedisGuard(monitor, "api_key_cache", async () => { throw new Error("fail") })

    expect(monitor.getState()).toBe(CircuitState.OPEN)

    // Next call should not even attempt the operation
    const fn = vi.fn(async () => "data")
    const result = await withRedisGuard(monitor, "api_key_cache", fn)
    expect(fn).not.toHaveBeenCalled()
    expect(result.degraded).toBe(true)
  })
})
