// tests/finn/orchestrator.test.ts — Orchestrator tool-call loop tests (T-1.5)

import assert from "node:assert/strict"
import { Orchestrator } from "../../src/hounfour/orchestrator.js"
import type { OrchestratorEvent, ToolExecutor, BudgetChecker } from "../../src/hounfour/orchestrator.js"
import type { IdempotencyPort, ToolResult } from "../../src/hounfour/idempotency.js"
import type {
  CompletionRequest,
  CompletionResult,
  ModelPortBase,
  ModelCapabilities,
  HealthStatus,
  CanonicalMessage,
  ToolDefinition,
  RequestMetadata,
} from "../../src/hounfour/types.js"

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

// --- Mock Helpers ---

function makeMeta(traceId = "trace-1"): RequestMetadata {
  return { agent: "test", tenant_id: "local", nft_id: "", trace_id: traceId }
}

const TOOLS: ToolDefinition[] = [{
  type: "function",
  function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
}]

/** Model that returns content on first call (no tool calls) */
function simpleModel(content: string): ModelPortBase {
  return {
    async complete(): Promise<CompletionResult> {
      return {
        content,
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
        metadata: { model: "test", latency_ms: 50, trace_id: "" },
      }
    },
    capabilities(): ModelCapabilities {
      return { tool_calling: true, thinking_traces: false, vision: false, streaming: false }
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true, latency_ms: 0 }
    },
  }
}

/** Model that makes N tool calls then returns content */
function toolCallingModel(toolCalls: number, finalContent: string): ModelPortBase {
  let callIndex = 0
  return {
    async complete(): Promise<CompletionResult> {
      callIndex++
      if (callIndex <= toolCalls) {
        return {
          content: "",
          thinking: null,
          tool_calls: [{
            id: `call_${callIndex}`,
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ path: `/tmp/file${callIndex}.txt` }) },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
          metadata: { model: "test", latency_ms: 50, trace_id: "" },
        }
      }
      return {
        content: finalContent,
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 0 },
        metadata: { model: "test", latency_ms: 50, trace_id: "" },
      }
    },
    capabilities(): ModelCapabilities {
      return { tool_calling: true, thinking_traces: false, vision: false, streaming: false }
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true, latency_ms: 0 }
    },
  }
}

/** Simple tool executor */
function simpleExecutor(results: Record<string, string> = {}): ToolExecutor {
  return {
    async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
      const key = `${toolName}:${JSON.stringify(args)}`
      return { output: results[key] ?? `result for ${toolName}`, is_error: false }
    },
  }
}

/** Error-throwing executor */
function errorExecutor(): ToolExecutor {
  return {
    async execute(): Promise<ToolResult> {
      return { output: "permission denied", is_error: true }
    },
  }
}

/** In-memory idempotency cache */
function memoryCache(): IdempotencyPort {
  const store = new Map<string, ToolResult>()
  return {
    async get(traceId: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult | null> {
      const key = `${traceId}:${toolName}:${JSON.stringify(args)}`
      return store.get(key) ?? null
    },
    async set(traceId: string, toolName: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
      const key = `${traceId}:${toolName}:${JSON.stringify(args)}`
      store.set(key, result)
    },
    async has(traceId: string, toolName: string, args: Record<string, unknown>): Promise<boolean> {
      const key = `${traceId}:${toolName}:${JSON.stringify(args)}`
      return store.has(key)
    },
  }
}

// --- Tests ---

async function main() {
  console.log("Orchestrator Tests (T-1.5)")
  console.log("==========================")

  // --- Simple execution (no tool calls) ---

  await test("simple completion without tool calls", async () => {
    const orch = new Orchestrator({
      model: simpleModel("Hello world"),
      toolExecutor: simpleExecutor(),
      idempotencyCache: memoryCache(),
    })

    const result = await orch.execute(
      [{ role: "user", content: "Say hello" }],
      [],
      makeMeta(),
    )

    assert.equal(result.result.content, "Hello world")
    assert.equal(result.iterations, 1)
    assert.equal(result.totalToolCalls, 0)
  })

  // --- Tool-call loop ---

  await test("tool-call loop with single tool call", async () => {
    const orch = new Orchestrator({
      model: toolCallingModel(1, "Done reading"),
      toolExecutor: simpleExecutor(),
      idempotencyCache: memoryCache(),
    })

    const result = await orch.execute(
      [{ role: "user", content: "Read a file" }],
      TOOLS,
      makeMeta(),
    )

    assert.equal(result.result.content, "Done reading")
    assert.equal(result.iterations, 2) // 1 tool-call iteration + 1 final
    assert.equal(result.totalToolCalls, 1)
  })

  await test("tool-call loop with multiple iterations", async () => {
    const orch = new Orchestrator({
      model: toolCallingModel(3, "All done"),
      toolExecutor: simpleExecutor(),
      idempotencyCache: memoryCache(),
    })

    const result = await orch.execute(
      [{ role: "user", content: "Read three files" }],
      TOOLS,
      makeMeta(),
    )

    assert.equal(result.result.content, "All done")
    assert.equal(result.iterations, 4)
    assert.equal(result.totalToolCalls, 3)
  })

  // --- Idempotency ---

  await test("idempotency cache prevents duplicate execution", async () => {
    const cache = memoryCache()
    let executionCount = 0

    const executor: ToolExecutor = {
      async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
        executionCount++
        return { output: `executed ${executionCount}`, is_error: false }
      },
    }

    // Pre-populate cache
    await cache.set("trace-1", "read_file", { path: "/tmp/file1.txt" }, { output: "cached result", is_error: false })

    // Model calls read_file with same args
    let callIndex = 0
    const model: ModelPortBase = {
      async complete(): Promise<CompletionResult> {
        callIndex++
        if (callIndex === 1) {
          return {
            content: "",
            thinking: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/file1.txt" }) },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
            metadata: { model: "test", latency_ms: 50, trace_id: "" },
          }
        }
        return {
          content: "Done",
          thinking: null,
          tool_calls: null,
          usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
          metadata: { model: "test", latency_ms: 50, trace_id: "" },
        }
      },
      capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: false } },
      async healthCheck() { return { healthy: true, latency_ms: 0 } },
    }

    const orch = new Orchestrator({ model, toolExecutor: executor, idempotencyCache: cache })
    await orch.execute([{ role: "user", content: "Read" }], TOOLS, makeMeta())

    assert.equal(executionCount, 0, "executor should not be called for cached result")
  })

  // --- Max iterations ---

  await test("aborts at max iterations", async () => {
    // Model always returns tool calls — never completes
    const infiniteModel: ModelPortBase = {
      async complete(): Promise<CompletionResult> {
        return {
          content: "",
          thinking: null,
          tool_calls: [{
            id: `call_${Date.now()}`,
            type: "function",
            function: { name: "read_file", arguments: '{"path":"/tmp/x"}' },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
          metadata: { model: "test", latency_ms: 50, trace_id: "" },
        }
      },
      capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: false } },
      async healthCheck() { return { healthy: true, latency_ms: 0 } },
    }

    const orch = new Orchestrator(
      { model: infiniteModel, toolExecutor: simpleExecutor(), idempotencyCache: memoryCache() },
      { maxIterations: 3, maxTotalToolCalls: 100, abortOnConsecutiveFailures: 10, maxWallTimeMs: 60_000 },
    )

    await assert.rejects(
      () => orch.execute([{ role: "user", content: "Loop forever" }], TOOLS, makeMeta()),
      (err: Error) => err.message.includes("max iterations"),
    )
  })

  // --- Max total tool calls ---

  await test("aborts at max total tool calls", async () => {
    // Model returns 5 tool calls per iteration
    const bulkModel: ModelPortBase = {
      async complete(): Promise<CompletionResult> {
        return {
          content: "",
          thinking: null,
          tool_calls: Array.from({ length: 5 }, (_, i) => ({
            id: `call_${Date.now()}_${i}`,
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ path: `/tmp/${Date.now()}_${i}` }) },
          })),
          usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
          metadata: { model: "test", latency_ms: 50, trace_id: "" },
        }
      },
      capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: false } },
      async healthCheck() { return { healthy: true, latency_ms: 0 } },
    }

    const orch = new Orchestrator(
      { model: bulkModel, toolExecutor: simpleExecutor(), idempotencyCache: memoryCache() },
      { maxIterations: 100, maxTotalToolCalls: 8, abortOnConsecutiveFailures: 100, maxWallTimeMs: 60_000 },
    )

    await assert.rejects(
      () => orch.execute([{ role: "user", content: "Bulk calls" }], TOOLS, makeMeta()),
      (err: Error) => err.message.includes("tool calls") && err.message.includes("exceeds"),
    )
  })

  // --- Consecutive failures ---

  await test("aborts after consecutive failures", async () => {
    const orch = new Orchestrator(
      {
        model: toolCallingModel(5, "Never reached"),
        toolExecutor: errorExecutor(),
        idempotencyCache: memoryCache(),
      },
      { maxIterations: 20, maxTotalToolCalls: 50, abortOnConsecutiveFailures: 3, maxWallTimeMs: 60_000 },
    )

    await assert.rejects(
      () => orch.execute([{ role: "user", content: "Fail" }], TOOLS, makeMeta()),
      (err: Error) => err.message.includes("consecutive failures"),
    )
  })

  await test("consecutive failures reset on success", async () => {
    let callIndex = 0
    const mixedExecutor: ToolExecutor = {
      async execute(): Promise<ToolResult> {
        callIndex++
        // Fail on calls 1, 2 but succeed on 3
        if (callIndex <= 2) return { output: "error", is_error: true }
        return { output: "ok", is_error: false }
      },
    }

    const orch = new Orchestrator(
      {
        model: toolCallingModel(4, "Done"),
        toolExecutor: mixedExecutor,
        idempotencyCache: memoryCache(),
      },
      { maxIterations: 20, maxTotalToolCalls: 50, abortOnConsecutiveFailures: 3, maxWallTimeMs: 60_000 },
    )

    // Should NOT throw — consecutive failures reset after success on call 3
    const result = await orch.execute([{ role: "user", content: "Mixed" }], TOOLS, makeMeta())
    assert.equal(result.result.content, "Done")
  })

  // --- Malformed JSON arguments ---

  await test("malformed JSON arguments fed back as error", async () => {
    let callIndex = 0
    const badJsonModel: ModelPortBase = {
      async complete(): Promise<CompletionResult> {
        callIndex++
        if (callIndex === 1) {
          return {
            content: "",
            thinking: null,
            tool_calls: [{
              id: "call_bad",
              type: "function",
              function: { name: "read_file", arguments: "not valid json{" },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
            metadata: { model: "test", latency_ms: 50, trace_id: "" },
          }
        }
        return {
          content: "Recovered",
          thinking: null,
          tool_calls: null,
          usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
          metadata: { model: "test", latency_ms: 50, trace_id: "" },
        }
      },
      capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: false } },
      async healthCheck() { return { healthy: true, latency_ms: 0 } },
    }

    const orch = new Orchestrator(
      { model: badJsonModel, toolExecutor: simpleExecutor(), idempotencyCache: memoryCache() },
      { abortOnConsecutiveFailures: 5, maxIterations: 20, maxTotalToolCalls: 50, maxWallTimeMs: 60_000 },
    )

    const result = await orch.execute([{ role: "user", content: "Bad JSON" }], TOOLS, makeMeta())
    assert.equal(result.result.content, "Recovered")
  })

  // --- Budget check ---

  await test("aborts when budget exceeded", async () => {
    const budgetChecker: BudgetChecker = {
      async checkBudget() { return { exceeded: true, remainingUsd: 0 } },
    }

    const orch = new Orchestrator({
      model: simpleModel("Should not reach"),
      toolExecutor: simpleExecutor(),
      idempotencyCache: memoryCache(),
      budgetChecker,
    })

    await assert.rejects(
      () => orch.execute([{ role: "user", content: "Expensive" }], [], makeMeta()),
      (err: Error) => err.message.includes("Budget exceeded"),
    )
  })

  // --- Event emission ---

  await test("emits events during execution", async () => {
    const events: OrchestratorEvent[] = []

    const orch = new Orchestrator({
      model: toolCallingModel(1, "Done"),
      toolExecutor: simpleExecutor(),
      idempotencyCache: memoryCache(),
    })

    await orch.execute(
      [{ role: "user", content: "With events" }],
      TOOLS,
      makeMeta(),
      { onEvent: (e) => events.push(e) },
    )

    const types = events.map(e => e.type)
    assert.ok(types.includes("iteration_start"), "has iteration_start")
    assert.ok(types.includes("tool_requested"), "has tool_requested")
    assert.ok(types.includes("tool_executed"), "has tool_executed")
    assert.ok(types.includes("iteration_complete"), "has iteration_complete")
    assert.ok(types.includes("loop_complete"), "has loop_complete")
  })

  await test("events include trace_id", async () => {
    const events: OrchestratorEvent[] = []

    const orch = new Orchestrator({
      model: simpleModel("Hello"),
      toolExecutor: simpleExecutor(),
      idempotencyCache: memoryCache(),
    })

    await orch.execute(
      [{ role: "user", content: "Trace me" }],
      [],
      makeMeta("trace-abc"),
      { onEvent: (e) => events.push(e) },
    )

    for (const event of events) {
      assert.equal(event.trace_id, "trace-abc", `event ${event.type} has correct trace_id`)
    }
  })

  // --- Wall time ---

  await test("aborts on wall time exceeded", async () => {
    const orch = new Orchestrator(
      {
        model: toolCallingModel(100, "Never"),
        toolExecutor: {
          async execute(): Promise<ToolResult> {
            await new Promise(r => setTimeout(r, 50))
            return { output: "ok", is_error: false }
          },
        },
        idempotencyCache: memoryCache(),
      },
      { maxWallTimeMs: 100, maxIterations: 100, maxTotalToolCalls: 100, abortOnConsecutiveFailures: 100 },
    )

    await assert.rejects(
      () => orch.execute([{ role: "user", content: "Slow" }], TOOLS, makeMeta()),
      (err: Error) => err.message.includes("Wall time"),
    )
  })

  console.log("\nDone.")
}

main()
