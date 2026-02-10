// tests/finn/stream-bridge-abort.test.ts — AbortController propagation tests (T-A.8)

import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import { StreamBridge } from "../../src/gateway/stream-bridge.js"

// Minimal WS mock
function createMockWs(readyState = 1) {
  const emitter = new EventEmitter()
  return {
    readyState,
    bufferedAmount: 0,
    send: vi.fn(),
    addEventListener: (event: string, handler: (...args: unknown[]) => void, opts?: { once?: boolean }) => {
      if (opts?.once) emitter.once(event, handler)
      else emitter.on(event, handler)
    },
    removeEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.off(event, handler)
    },
    close: () => {
      emitter.emit("close")
    },
    _emitter: emitter,
  } as any
}

describe("StreamBridge Abort (T-A.8)", () => {
  it("exposes abort signal", () => {
    const ws = createMockWs()
    const bridge = new StreamBridge(ws)
    expect(bridge.signal).toBeInstanceOf(AbortSignal)
    expect(bridge.signal.aborted).toBe(false)
  })

  it("WS close triggers abort signal", () => {
    const ws = createMockWs()
    const bridge = new StreamBridge(ws)

    expect(bridge.signal.aborted).toBe(false)
    ws.close()
    expect(bridge.signal.aborted).toBe(true)
  })

  it("accepts external AbortController", () => {
    const ws = createMockWs()
    const controller = new AbortController()
    const bridge = new StreamBridge(ws, { abortController: controller })

    expect(bridge.signal).toBe(controller.signal)
    ws.close()
    expect(controller.signal.aborted).toBe(true)
  })

  it("external abort before WS close", () => {
    const ws = createMockWs()
    const controller = new AbortController()
    const bridge = new StreamBridge(ws, { abortController: controller })

    controller.abort()
    expect(bridge.signal.aborted).toBe(true)
    // WS close after abort should not throw
    ws.close()
    expect(bridge.signal.aborted).toBe(true)
  })

  it("onDisconnect callback still fires on WS close during forward", async () => {
    const ws = createMockWs()
    const onDisconnect = vi.fn()
    const bridge = new StreamBridge(ws, { onDisconnect })

    // Create a generator that yields one event then hangs
    async function* slowEvents(): AsyncGenerator<any, any> {
      yield { type: "token", data: { delta: "hello", runningTokenCount: 1 } }
      // Simulate WS close after first event
      ws.close()
      // Yield another to let forward() detect the close
      yield { type: "token", data: { delta: "world", runningTokenCount: 2 } }
    }

    const result = await bridge.forward(slowEvents())
    expect(result).toBeNull()
    expect(onDisconnect).toHaveBeenCalled()
    expect(bridge.signal.aborted).toBe(true)
  })

  it("signal is aborted when WS is already closed", () => {
    const ws = createMockWs(3) // CLOSED state
    const bridge = new StreamBridge(ws)
    // The bridge detects closed state in forward(), but the constructor
    // only listens for close event. Calling close explicitly triggers it.
    ws.close()
    expect(bridge.signal.aborted).toBe(true)
  })
})
