// tests/gateway/time-provider.test.ts — TimeProvider Tests (Sprint 120 T3.1)

import { describe, it, expect, beforeEach } from "vitest"
import {
  SystemTimeProvider,
  MockTimeProvider,
  measureClockDrift,
  defaultTimeProvider,
} from "../../src/gateway/time-provider.js"

describe("SystemTimeProvider", () => {
  it("now() returns current time in milliseconds", () => {
    const provider = new SystemTimeProvider()
    const before = Date.now()
    const result = provider.now()
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })

  it("nowSeconds() returns current time in seconds", () => {
    const provider = new SystemTimeProvider()
    const result = provider.nowSeconds()
    const expected = Math.floor(Date.now() / 1000)
    expect(result).toBeGreaterThanOrEqual(expected - 1)
    expect(result).toBeLessThanOrEqual(expected + 1)
  })
})

describe("MockTimeProvider", () => {
  let mock: MockTimeProvider

  beforeEach(() => {
    mock = new MockTimeProvider(1_000_000)
  })

  it("returns the fixed time from constructor", () => {
    expect(mock.now()).toBe(1_000_000)
  })

  it("nowSeconds() returns milliseconds / 1000 floored", () => {
    expect(mock.nowSeconds()).toBe(1000)
  })

  it("advance() moves time forward", () => {
    mock.advance(5000)
    expect(mock.now()).toBe(1_005_000)
  })

  it("set() overwrites current time", () => {
    mock.set(2_000_000)
    expect(mock.now()).toBe(2_000_000)
  })

  it("multiple advance calls accumulate", () => {
    mock.advance(100)
    mock.advance(200)
    mock.advance(300)
    expect(mock.now()).toBe(1_000_600)
  })

  it("defaults to Date.now() if no initial value", () => {
    const before = Date.now()
    const defaultMock = new MockTimeProvider()
    const after = Date.now()
    expect(defaultMock.now()).toBeGreaterThanOrEqual(before)
    expect(defaultMock.now()).toBeLessThanOrEqual(after)
  })
})

describe("measureClockDrift", () => {
  it("reports zero drift when reference matches system", () => {
    const result = measureClockDrift(Date.now())
    expect(result.driftMs).toBeLessThan(50) // allow small execution delay
    expect(result.withinTolerance).toBe(true)
  })

  it("detects drift beyond threshold", () => {
    const referenceMs = Date.now() - 5000 // 5 seconds behind
    const result = measureClockDrift(referenceMs, { maxDriftMs: 1000 })
    expect(result.driftMs).toBeGreaterThanOrEqual(4900)
    expect(result.withinTolerance).toBe(false)
  })

  it("calls onDrift callback when drift exceeds threshold", () => {
    let driftValue = 0
    const referenceMs = Date.now() - 3000
    measureClockDrift(referenceMs, {
      maxDriftMs: 1000,
      onDrift: (drift) => {
        driftValue = drift
      },
    })
    expect(driftValue).toBeGreaterThan(2900)
  })

  it("does not call onDrift when within tolerance", () => {
    let called = false
    measureClockDrift(Date.now(), {
      maxDriftMs: 5000,
      onDrift: () => {
        called = true
      },
    })
    expect(called).toBe(false)
  })

  it("returns reference and system timestamps", () => {
    const ref = 1_700_000_000_000
    const result = measureClockDrift(ref)
    expect(result.referenceMs).toBe(ref)
    expect(result.systemMs).toBeGreaterThan(0)
  })
})

// #246 — deterministic drift measurement via injected TimeProvider: exact
// systemMs/driftMs/callback assertions instead of loose wall-clock bounds.
describe("measureClockDrift with injected TimeProvider", () => {
  const T0 = 1_750_000_000_000

  it("reports exact systemMs and driftMs from the provider", () => {
    const clock = new MockTimeProvider(T0 + 250)
    const result = measureClockDrift(T0, { timeProvider: clock })
    expect(result.systemMs).toBe(T0 + 250)
    expect(result.referenceMs).toBe(T0)
    expect(result.driftMs).toBe(250)
    expect(result.withinTolerance).toBe(true) // default 1000ms tolerance
  })

  it("flags drift beyond maxDriftMs and fires onDrift with the exact value", () => {
    const clock = new MockTimeProvider(T0 + 1500)
    let driftValue = -1
    const result = measureClockDrift(T0, {
      timeProvider: clock,
      maxDriftMs: 1000,
      onDrift: (drift) => {
        driftValue = drift
      },
    })
    expect(result.withinTolerance).toBe(false)
    expect(result.driftMs).toBe(1500)
    expect(driftValue).toBe(1500)
  })

  it("measures behind-reference drift as an exact absolute value", () => {
    const clock = new MockTimeProvider(T0 - 2000)
    const result = measureClockDrift(T0, { timeProvider: clock, maxDriftMs: 1000 })
    expect(result.driftMs).toBe(2000)
    expect(result.withinTolerance).toBe(false)
  })

  it("advancing the mock clock changes subsequent measurements deterministically", () => {
    const clock = new MockTimeProvider(T0)
    expect(measureClockDrift(T0, { timeProvider: clock }).driftMs).toBe(0)
    clock.advance(750)
    expect(measureClockDrift(T0, { timeProvider: clock }).driftMs).toBe(750)
  })
})

describe("defaultTimeProvider", () => {
  it("is a SystemTimeProvider instance", () => {
    expect(defaultTimeProvider).toBeInstanceOf(SystemTimeProvider)
  })

  it("returns current time", () => {
    const before = Date.now()
    const result = defaultTimeProvider.now()
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })
})
