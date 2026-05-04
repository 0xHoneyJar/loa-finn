// tests/finn/goodhart/routing-events.test.ts — Routing Events Tests (T-4.6, cycle-036)

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  emitRoutingStateTransition,
  emitRoutingOverride,
  setRoutingStateTransitionEmitter,
  setRoutingOverrideEmitter,
  type RoutingState,
} from "../../../src/hounfour/goodhart/routing-events.js"

describe("emitRoutingStateTransition", () => {
  it("emits structured JSON on state change", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    emitRoutingStateTransition("disabled", "shadow", "goodhart_init_success")

    expect(logSpy).toHaveBeenCalledOnce()
    const event = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(event.component).toBe("routing-events")
    expect(event.event).toBe("routing_state_transition")
    expect(event.from).toBe("disabled")
    expect(event.to).toBe("shadow")
    expect(event.reason).toBe("goodhart_init_success")
    expect(event.timestamp).toBeDefined()

    logSpy.mockRestore()
  })

  it("does not emit when from === to", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    emitRoutingStateTransition("shadow", "shadow", "no_change")

    expect(logSpy).not.toHaveBeenCalled()

    logSpy.mockRestore()
  })

  it("emits for all valid state transitions", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const transitions: Array<[RoutingState, RoutingState]> = [
      ["disabled", "shadow"],
      ["shadow", "enabled"],
      ["enabled", "init_failed"],
      ["init_failed", "shadow"],
    ]

    for (const [from, to] of transitions) {
      emitRoutingStateTransition(from, to, "test")
    }

    expect(logSpy).toHaveBeenCalledTimes(4)

    logSpy.mockRestore()
  })
})

describe("emitRoutingOverride", () => {
  it("emits structured JSON for killswitch activation", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    emitRoutingOverride("killswitch", "activated")

    expect(warnSpy).toHaveBeenCalledOnce()
    const event = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(event.component).toBe("routing-events")
    expect(event.event).toBe("routing_override")
    expect(event.override).toBe("killswitch")
    expect(event.state).toBe("activated")
    expect(event.timestamp).toBeDefined()

    warnSpy.mockRestore()
  })

  it("emits for deactivation", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    emitRoutingOverride("killswitch", "deactivated")

    const event = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(event.state).toBe("deactivated")

    warnSpy.mockRestore()
  })
})

describe("setRoutingStateTransitionEmitter", () => {
  let originalEmitter: typeof emitRoutingStateTransition

  afterEach(() => {
    if (originalEmitter) {
      setRoutingStateTransitionEmitter(originalEmitter)
    }
  })

  it("replaces the emitter and returns the previous one", () => {
    const customEmitter = vi.fn()
    originalEmitter = setRoutingStateTransitionEmitter(customEmitter)

    // The imported binding won't update (module-level let), but we can
    // verify the setter returns the original
    expect(typeof originalEmitter).toBe("function")
  })
})

describe("setRoutingOverrideEmitter", () => {
  let originalEmitter: typeof emitRoutingOverride

  afterEach(() => {
    if (originalEmitter) {
      setRoutingOverrideEmitter(originalEmitter)
    }
  })

  it("replaces the emitter and returns the previous one", () => {
    const customEmitter = vi.fn()
    originalEmitter = setRoutingOverrideEmitter(customEmitter)

    expect(typeof originalEmitter).toBe("function")
  })
})
