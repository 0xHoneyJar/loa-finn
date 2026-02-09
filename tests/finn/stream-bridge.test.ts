// tests/finn/stream-bridge.test.ts — StreamBridge tests (T-2.6)

import { describe, it, expect, vi } from "vitest"
import { StreamBridge } from "../../src/gateway/stream-bridge.js"
import type { WsFrame } from "../../src/gateway/stream-bridge.js"
import type { OrchestratorEvent, OrchestratorResult } from "../../src/hounfour/orchestrator.js"
import type { WebSocket as WsWebSocket } from "ws"

// --- Mock WebSocket ---

function mockWs(overrides?: Partial<WsWebSocket>): WsWebSocket {
  const listeners = new Map<string, Function[]>()
  return {
    readyState: 1, // OPEN
    bufferedAmount: 0,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: Function, opts?: any) => {
      const existing = listeners.get(event) ?? []
      existing.push(handler)
      listeners.set(event, existing)
    }),
    removeEventListener: vi.fn(),
    close: vi.fn(),
    // Helper to simulate close
    _simulateClose: () => {
      const handlers = listeners.get("close") ?? []
      for (const h of handlers) h()
    },
    ...overrides,
  } as any
}

/** Get sent frames from mock WS */
function getSentFrames(ws: WsWebSocket): WsFrame[] {
  return (ws.send as any).mock.calls.map((call: any[]) => JSON.parse(call[0]))
}

// --- Helpers ---

function makeEvent(type: string, data: Record<string, unknown> = {}, iteration = 0): OrchestratorEvent {
  return {
    type: type as any,
    trace_id: "trace-001",
    iteration,
    timestamp: new Date().toISOString(),
    data,
  }
}

function makeResult(overrides?: Partial<OrchestratorResult>): OrchestratorResult {
  return {
    result: {
      content: "done",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 0 },
      metadata: { model: "test", latency_ms: 100, trace_id: "trace-001" },
    },
    iterations: 1,
    totalToolCalls: 0,
    wallTimeMs: 500,
    ...overrides,
  }
}

/** Create an async generator from events + result */
async function* eventGenerator(
  events: OrchestratorEvent[],
  result: OrchestratorResult,
): AsyncGenerator<OrchestratorEvent, OrchestratorResult> {
  for (const event of events) {
    yield event
  }
  return result
}

// --- Tests ---

describe("StreamBridge", () => {
  it("forwards token events as WS frames", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)
    const result = makeResult()

    const events = [
      makeEvent("token", { delta: "Hello", runningTokenCount: 2 }),
      makeEvent("token", { delta: " world", runningTokenCount: 3 }),
    ]

    const gen = eventGenerator(events, result)
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    // 2 token frames + 1 complete frame
    expect(frames).toHaveLength(3)
    expect(frames[0]).toEqual({ type: "token", delta: "Hello", runningTokenCount: 2 })
    expect(frames[1]).toEqual({ type: "token", delta: " world", runningTokenCount: 3 })
    expect(frames[2].type).toBe("complete")
  })

  it("maps tool_requested to tool_call frame", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)
    const result = makeResult()

    const events = [
      makeEvent("tool_requested", { toolName: "get_weather", toolCallId: "call_1" }),
    ]

    const gen = eventGenerator(events, result)
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames[0]).toEqual({
      type: "tool_call",
      name: "get_weather",
      id: "call_1",
      status: "requested",
    })
  })

  it("maps tool_executing to tool_call frame", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    const events = [
      makeEvent("tool_executing", { toolName: "get_weather", toolCallId: "call_1" }),
    ]

    const gen = eventGenerator(events, makeResult())
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames[0].status).toBe("executing")
  })

  it("maps tool_executed to tool_call frame with metadata", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    const events = [
      makeEvent("tool_executed", { toolName: "get_weather", toolCallId: "call_1", isError: false, cached: true }),
    ]

    const gen = eventGenerator(events, makeResult())
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames[0]).toEqual({
      type: "tool_call",
      name: "get_weather",
      id: "call_1",
      status: "executed",
      isError: false,
      cached: true,
    })
  })

  it("maps budget_check to budget frame", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    const events = [
      makeEvent("budget_check", { exceeded: false, remainingUsd: 2.50 }),
    ]

    const gen = eventGenerator(events, makeResult())
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames[0]).toEqual({
      type: "budget",
      exceeded: false,
      remainingUsd: 2.50,
    })
  })

  it("maps stream_start event", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    const events = [makeEvent("stream_start", {}, 0)]

    const gen = eventGenerator(events, makeResult())
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames[0]).toEqual({ type: "stream_start", iteration: 0 })
  })

  it("maps iteration_start and iteration_complete", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    const events = [
      makeEvent("iteration_start", { totalToolCalls: 0, consecutiveFailures: 0 }, 0),
      makeEvent("iteration_complete", { usage: { prompt_tokens: 5, completion_tokens: 10 }, streamed: true }, 0),
    ]

    const gen = eventGenerator(events, makeResult())
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames[0]).toEqual({ type: "iteration", status: "start", iteration: 0, totalToolCalls: 0 })
    expect(frames[1].type).toBe("iteration")
    expect(frames[1].status).toBe("complete")
    expect(frames[1].streamed).toBe(true)
  })

  it("maps loop_error to error frame", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    const events = [
      makeEvent("loop_error", { code: "STREAM_INTERRUPTED", message: "Connection lost" }),
    ]

    const gen = eventGenerator(events, makeResult())
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames[0]).toEqual({
      type: "error",
      code: "STREAM_INTERRUPTED",
      message: "Connection lost",
    })
  })

  it("sends complete frame with result data", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    const result = makeResult({
      totalToolCalls: 3,
      wallTimeMs: 2500,
      iterations: 2,
    })
    result.result.content = "Final answer"

    const gen = eventGenerator([], result)
    await bridge.forward(gen)

    const frames = getSentFrames(ws)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({
      type: "complete",
      totalToolCalls: 3,
      wallTimeMs: 2500,
      iterations: 2,
      content: "Final answer",
      abortReason: undefined,
    })
  })

  it("calls onDisconnect when WS closes during forwarding", async () => {
    const onDisconnect = vi.fn()
    const ws = mockWs()
    const bridge = new StreamBridge(ws, { onDisconnect })

    // Create a generator that yields one event then hangs
    async function* slowGen(): AsyncGenerator<OrchestratorEvent, OrchestratorResult> {
      yield makeEvent("token", { delta: "start", runningTokenCount: 1 })
      // Simulate WS close before next event
      ;(ws as any)._simulateClose()
      // Yield another event (should be caught by close check)
      yield makeEvent("token", { delta: "ignored", runningTokenCount: 2 })
      return makeResult()
    }

    const result = await bridge.forward(slowGen())

    expect(result).toBeNull()
    expect(onDisconnect).toHaveBeenCalledOnce()
  })

  it("returns null for already-closed WebSocket", async () => {
    const onDisconnect = vi.fn()
    const ws = mockWs({ readyState: 3 }) // CLOSED
    const bridge = new StreamBridge(ws, { onDisconnect })

    const gen = eventGenerator([], makeResult())
    const result = await bridge.forward(gen)

    expect(result).toBeNull()
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(ws.send).not.toHaveBeenCalled()
  })

  it("does not send frames after WS closes", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    // Close WS after first event
    async function* closingGen(): AsyncGenerator<OrchestratorEvent, OrchestratorResult> {
      yield makeEvent("token", { delta: "first", runningTokenCount: 1 })
      ;(ws as any).readyState = 3 // CLOSED
      ;(ws as any)._simulateClose()
      yield makeEvent("token", { delta: "second", runningTokenCount: 2 })
      return makeResult()
    }

    await bridge.forward(closingGen())

    // Only first token should have been sent (complete should not be sent)
    const frames = getSentFrames(ws)
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe("token")
  })

  it("handles generator errors gracefully", async () => {
    const ws = mockWs()
    const bridge = new StreamBridge(ws)

    async function* errorGen(): AsyncGenerator<OrchestratorEvent, OrchestratorResult> {
      yield makeEvent("token", { delta: "ok", runningTokenCount: 1 })
      throw new Error("Generator exploded")
    }

    const result = await bridge.forward(errorGen())

    expect(result).toBeNull()
    const frames = getSentFrames(ws)
    // Should have: token + error
    const errorFrame = frames.find(f => f.type === "error")
    expect(errorFrame).toBeTruthy()
    expect(errorFrame!.code).toBe("BRIDGE_ERROR")
    expect(errorFrame!.message).toBe("Generator exploded")
  })
})
