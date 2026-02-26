// tests/finn/goodhart/init-recovery.test.ts — GoodhartRecoveryScheduler Tests (T-4.3, cycle-036)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { GoodhartRecoveryScheduler, type GoodhartRuntime, type RoutingState } from "../../../src/hounfour/goodhart/init.js"
import { GraduationMetrics } from "../../../src/hounfour/graduation-metrics.js"

function createMockRuntime(overrides?: Partial<GoodhartRuntime>): GoodhartRuntime {
  return {
    goodhartConfig: undefined,
    routingState: "init_failed" as RoutingState,
    goodhartMetrics: new GraduationMetrics(),
    ...overrides,
  }
}

describe("GoodhartRecoveryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("stop() prevents any recovery attempts", () => {
    const runtime = createMockRuntime()
    const scheduler = new GoodhartRecoveryScheduler(
      runtime,
      { redisClient: null, redisPrefix: "test:", redisDb: 0, requestedMode: "shadow" },
    )

    scheduler.start()
    scheduler.stop()

    // Advance well past the first backoff (60s)
    vi.advanceTimersByTime(120_000)

    // No recovery attempt — metrics should be 0
    expect(runtime.goodhartMetrics!.recoveryAttemptTotal.get()).toBe(0)
  })

  it("stop() is idempotent", () => {
    const runtime = createMockRuntime()
    const scheduler = new GoodhartRecoveryScheduler(
      runtime,
      { redisClient: null, redisPrefix: "test:", redisDb: 0, requestedMode: "shadow" },
    )

    scheduler.stop()
    scheduler.stop() // Should not throw
    expect(true).toBe(true)
  })

  it("does not start if already stopped", () => {
    const runtime = createMockRuntime()
    const scheduler = new GoodhartRecoveryScheduler(
      runtime,
      { redisClient: null, redisPrefix: "test:", redisDb: 0, requestedMode: "shadow" },
    )

    scheduler.stop()
    scheduler.start()

    vi.advanceTimersByTime(120_000)
    expect(runtime.goodhartMetrics!.recoveryAttemptTotal.get()).toBe(0)
  })

  it("constructor accepts all required parameters", () => {
    const runtime = createMockRuntime()
    const onRecovery = vi.fn()
    const scheduler = new GoodhartRecoveryScheduler(
      runtime,
      { redisClient: null, redisPrefix: "armitage:", redisDb: 1, requestedMode: "shadow" },
      onRecovery,
    )

    expect(scheduler).toBeDefined()
    scheduler.stop()
  })

  it("runtime holder is mutable", () => {
    const runtime = createMockRuntime()
    expect(runtime.routingState).toBe("init_failed")

    // Simulate what recovery does — atomic update
    runtime.routingState = "shadow"
    runtime.goodhartConfig = {} as any

    expect(runtime.routingState).toBe("shadow")
    expect(runtime.goodhartConfig).toBeDefined()
  })
})
