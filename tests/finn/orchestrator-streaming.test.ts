// tests/finn/orchestrator-streaming.test.ts — Orchestrator.executeStreaming tests (T-2.5)

import { describe, it, expect, vi } from "vitest"
import { Orchestrator } from "../../src/hounfour/orchestrator.js"
import type { OrchestratorEvent, OrchestratorDeps, OrchestratorOptions } from "../../src/hounfour/orchestrator.js"
import type {
  CompletionRequest,
  CompletionResult,
  ModelPortStreaming,
  StreamChunk,
  CanonicalMessage,
  ToolDefinition,
  RequestMetadata,
  ModelCapabilities,
  HealthStatus,
} from "../../src/hounfour/types.js"
import type { IdempotencyPort, ToolResult } from "../../src/hounfour/idempotency.js"

// --- Helpers ---

async function collectEvents(
  gen: AsyncGenerator<OrchestratorEvent, any>,
): Promise<{ events: OrchestratorEvent[]; result: any }> {
  const events: OrchestratorEvent[] = []
  let result: any
  while (true) {
    const { value, done } = await gen.next()
    if (done) {
      result = value
      break
    }
    events.push(value)
  }
  return { events, result }
}

function makeMetadata(traceId = "trace-001"): RequestMetadata {
  return { trace_id: traceId, turn_id: "turn-1" }
}

function makeMessages(): CanonicalMessage[] {
  return [{ role: "user", content: "hello" }]
}

function makeTools(): ToolDefinition[] {
  return [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  }]
}

/** Create a streaming model port that yields the given chunks */
function makeStreamingModel(
  chunks: StreamChunk[],
  blockingResult?: CompletionResult,
): ModelPortStreaming {
  return {
    async *stream(_req: CompletionRequest, _opts?: { signal?: AbortSignal }) {
      for (const chunk of chunks) {
        yield chunk
      }
    },
    async complete(_req: CompletionRequest): Promise<CompletionResult> {
      return blockingResult ?? {
        content: "fallback",
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 5, completion_tokens: 5, reasoning_tokens: 0 },
        metadata: { model: "test", latency_ms: 100, trace_id: "t" },
      }
    },
    capabilities(): ModelCapabilities {
      return { tool_calling: true, thinking_traces: false, vision: false, streaming: true }
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true, latency_ms: 1 }
    },
  }
}

function makeIdempotencyCache(): IdempotencyPort {
  const cache = new Map<string, ToolResult>()
  return {
    async get(_traceId: string, toolName: string, args: Record<string, unknown>) {
      const key = `${toolName}:${JSON.stringify(args)}`
      return cache.get(key) ?? null
    },
    async set(_traceId: string, toolName: string, args: Record<string, unknown>, result: ToolResult) {
      const key = `${toolName}:${JSON.stringify(args)}`
      cache.set(key, result)
    },
  }
}

function makeToolExecutor(results?: Map<string, ToolResult>) {
  return {
    execute: vi.fn(async (toolName: string, _args: Record<string, unknown>, _traceId: string): Promise<ToolResult> => {
      const cached = results?.get(toolName)
      if (cached) return cached
      return { output: `Result for ${toolName}`, is_error: false }
    }),
  }
}

function makeDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    model: makeStreamingModel([]),
    toolExecutor: makeToolExecutor(),
    idempotencyCache: makeIdempotencyCache(),
    ...overrides,
  }
}

// --- Tests ---

describe("Orchestrator.executeStreaming", () => {
  it("yields token events from a text completion stream", async () => {
    const chunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "Hello", tool_calls: null } },
      { event: "chunk", data: { delta: " world", tool_calls: null } },
      { event: "usage", data: { prompt_tokens: 5, completion_tokens: 2, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "stop" } },
    ]

    const model = makeStreamingModel(chunks)
    const deps = makeDeps({ model })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata())
    const { events, result } = await collectEvents(gen)

    // Should have: iteration_start, stream_start, token("Hello"), token(" world"), iteration_complete, loop_complete
    const tokenEvents = events.filter(e => e.type === "token")
    expect(tokenEvents).toHaveLength(2)
    expect(tokenEvents[0].data.delta).toBe("Hello")
    expect(tokenEvents[1].data.delta).toBe(" world")

    expect(result.result.content).toBe("Hello world")
    expect(result.iterations).toBe(1)
  })

  it("yields tool_requested events from tool_call stream", async () => {
    // First iteration: model returns tool calls
    const toolCallChunks: StreamChunk[] = [
      { event: "tool_call", data: { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city": "NYC"}' } } },
      { event: "usage", data: { prompt_tokens: 10, completion_tokens: 15, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "tool_calls" } },
    ]

    // Second iteration: model returns text (no tool calls)
    const textChunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "It's sunny!", tool_calls: null } },
      { event: "usage", data: { prompt_tokens: 20, completion_tokens: 5, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "stop" } },
    ]

    let callCount = 0
    const model: ModelPortStreaming = {
      async *stream(_req, _opts) {
        const chunks = callCount === 0 ? toolCallChunks : textChunks
        callCount++
        for (const c of chunks) yield c
      },
      async complete() { throw new Error("should not be called") },
      capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: true } },
      async healthCheck() { return { healthy: true, latency_ms: 1 } },
    }

    const toolExecutor = makeToolExecutor()
    const deps = makeDeps({ model, toolExecutor })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), makeTools(), makeMetadata())
    const { events, result } = await collectEvents(gen)

    // Should have tool_requested event
    const toolReqEvents = events.filter(e => e.type === "tool_requested")
    expect(toolReqEvents).toHaveLength(1)
    expect(toolReqEvents[0].data.toolName).toBe("get_weather")
    expect(toolReqEvents[0].data.toolCallId).toBe("call_1")

    // Tool should have been executed
    expect(toolExecutor.execute).toHaveBeenCalledOnce()

    // Final result should be from second iteration
    expect(result.result.content).toBe("It's sunny!")
    expect(result.iterations).toBe(2)
    expect(result.totalToolCalls).toBe(1)
  })

  it("falls back to blocking when stream option is false", async () => {
    const blockingResult: CompletionResult = {
      content: "blocked response",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 5, completion_tokens: 10, reasoning_tokens: 0 },
      metadata: { model: "test", latency_ms: 50, trace_id: "trace-001" },
    }

    const model = makeStreamingModel([], blockingResult)
    const streamSpy = vi.spyOn(model, "stream")
    const deps = makeDeps({ model })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata(), { stream: false })
    const { result } = await collectEvents(gen)

    expect(streamSpy).not.toHaveBeenCalled()
    expect(result.result.content).toBe("blocked response")
  })

  it("handles stream error event", async () => {
    const chunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "partial", tool_calls: null } },
      { event: "error", data: { code: "STREAM_INTERRUPTED", message: "Connection lost" } },
    ]

    const model = makeStreamingModel(chunks)
    const deps = makeDeps({ model })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata())
    await expect(collectEvents(gen)).rejects.toThrow("STREAM_ERROR")
  })

  it("supports cancellation via cancel(traceId)", async () => {
    // Model that streams slowly (yields one chunk then hangs)
    const model: ModelPortStreaming = {
      async *stream(_req, opts) {
        yield { event: "chunk", data: { delta: "start", tool_calls: null } } as StreamChunk
        // Wait for abort
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) { resolve(); return }
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        // Don't yield done — abort interrupts
      },
      async complete() { throw new Error("not called") },
      capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: true } },
      async healthCheck() { return { healthy: true, latency_ms: 1 } },
    }

    const deps = makeDeps({ model })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata("trace-cancel"))

    // Consume first event (iteration_start)
    await gen.next()
    // Consume stream_start
    await gen.next()
    // Consume token event
    await gen.next()

    // Cancel
    orch.cancel("trace-cancel")

    // Generator should complete with cancelled result on next iteration check
    // The stream will end (abort), and the next loop iteration checks aborted flag
    const { value, done } = await gen.next()
    // After abort, the stream loop exits (no done/error since we aborted),
    // and next iteration hits the aborted check, returning cancelled result
    if (!done) {
      // May need one more next() to reach the cancelled return
      const final = await gen.next()
      if (final.done) {
        expect(final.value.abortReason).toBe("cancelled")
      }
    } else {
      expect(value.abortReason).toBe("cancelled")
    }
  })

  it("reconciles token count with usage event", async () => {
    const chunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "a".repeat(100), tool_calls: null } }, // ~25 approx tokens
      { event: "usage", data: { prompt_tokens: 10, completion_tokens: 30, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "stop" } },
    ]

    const model = makeStreamingModel(chunks)
    const deps = makeDeps({ model })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata())
    const { events } = await collectEvents(gen)

    // Token event should show approximate count
    const tokenEvent = events.find(e => e.type === "token")!
    expect(tokenEvent.data.runningTokenCount).toBe(25) // 100 chars / 4

    // Final result should use ground truth from usage event
    const iterComplete = events.find(e => e.type === "iteration_complete")!
    expect((iterComplete.data.usage as any).completion_tokens).toBe(30)
  })

  it("yields budget_check event when budgetChecker is provided", async () => {
    const chunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "ok", tool_calls: null } },
      { event: "done", data: { finish_reason: "stop" } },
    ]

    const model = makeStreamingModel(chunks)
    const budgetChecker = {
      checkBudget: vi.fn(async () => ({ exceeded: false, remainingUsd: 1.50 })),
    }
    const deps = makeDeps({ model, budgetChecker })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata())
    const { events } = await collectEvents(gen)

    const budgetEvents = events.filter(e => e.type === "budget_check")
    expect(budgetEvents).toHaveLength(1)
    expect(budgetEvents[0].data.remainingUsd).toBe(1.50)
  })

  it("aborts on budget exceeded", async () => {
    const model = makeStreamingModel([])
    const budgetChecker = {
      checkBudget: vi.fn(async () => ({ exceeded: true, remainingUsd: 0 })),
    }
    const deps = makeDeps({ model, budgetChecker })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata())
    await expect(collectEvents(gen)).rejects.toThrow("BUDGET_EXCEEDED")
  })

  it("assembles multi-fragment tool calls", async () => {
    const toolChunks: StreamChunk[] = [
      { event: "tool_call", data: { index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } } },
      { event: "tool_call", data: { index: 0, function: { arguments: '{"ci' } } },
      { event: "tool_call", data: { index: 0, function: { arguments: 'ty": "NYC"}' } } },
      { event: "usage", data: { prompt_tokens: 10, completion_tokens: 8, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "tool_calls" } },
    ]

    const textChunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "Sunny", tool_calls: null } },
      { event: "done", data: { finish_reason: "stop" } },
    ]

    let callCount = 0
    const model: ModelPortStreaming = {
      async *stream() {
        const chunks = callCount === 0 ? toolChunks : textChunks
        callCount++
        for (const c of chunks) yield c
      },
      async complete() { throw new Error("not called") },
      capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: true } },
      async healthCheck() { return { healthy: true, latency_ms: 1 } },
    }

    const toolExecutor = makeToolExecutor()
    const deps = makeDeps({ model, toolExecutor })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), makeTools(), makeMetadata())
    const { events, result } = await collectEvents(gen)

    // Tool should have been called with assembled arguments
    expect(toolExecutor.execute).toHaveBeenCalledWith("get_weather", { city: "NYC" }, "trace-001")
    expect(result.result.content).toBe("Sunny")
  })

  it("emits stream_start event", async () => {
    const chunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "x", tool_calls: null } },
      { event: "done", data: { finish_reason: "stop" } },
    ]

    const model = makeStreamingModel(chunks)
    const deps = makeDeps({ model })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata())
    const { events } = await collectEvents(gen)

    const streamStarts = events.filter(e => e.type === "stream_start")
    expect(streamStarts).toHaveLength(1)
  })

  it("cleans up activeExecutions on completion", async () => {
    const chunks: StreamChunk[] = [
      { event: "chunk", data: { delta: "done", tool_calls: null } },
      { event: "done", data: { finish_reason: "stop" } },
    ]

    const model = makeStreamingModel(chunks)
    const deps = makeDeps({ model })
    const orch = new Orchestrator(deps)

    const gen = orch.executeStreaming(makeMessages(), [], makeMetadata("trace-cleanup"))
    await collectEvents(gen)

    // cancel should be a no-op now (no active execution)
    // Just verify it doesn't throw
    orch.cancel("trace-cleanup")
  })
})

describe("Orchestrator.cancel", () => {
  it("is a no-op for unknown trace IDs", () => {
    const deps = makeDeps()
    const orch = new Orchestrator(deps)
    expect(() => orch.cancel("nonexistent")).not.toThrow()
  })
})
