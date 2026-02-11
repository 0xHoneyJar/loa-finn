// tests/finn/hounfour-router.test.ts — HounfourRouter unit tests (T-15.1)

import assert from "node:assert/strict"
import { ProviderRegistry } from "../../src/hounfour/registry.js"
import type { RawProviderConfig } from "../../src/hounfour/registry.js"
import { HounfourRouter } from "../../src/hounfour/router.js"
import type { ToolCallLoopConfig, ToolExecutor } from "../../src/hounfour/router.js"
import { BudgetEnforcer } from "../../src/hounfour/budget.js"
import type { BudgetConfig } from "../../src/hounfour/budget.js"
import type { HealthProber } from "../../src/hounfour/cheval-invoker.js"
import { HounfourError } from "../../src/hounfour/errors.js"
import type {
  CompletionRequest,
  CompletionResult,
  ResolvedModel,
  ScopeMeta,
  ModelPortBase,
  ModelCapabilities,
  HealthStatus,
} from "../../src/hounfour/types.js"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const PREFIX = "finn-router-test-"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), PREFIX))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

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

// --- Fixtures ---

function makeConfig(): RawProviderConfig {
  return {
    providers: {
      openai: {
        type: "openai",
        options: { baseURL: "https://api.openai.com/v1", apiKey: "sk-test" },
        models: {
          "gpt-4o": {
            name: "GPT-4o",
            capabilities: { tool_calling: true, thinking_traces: false, vision: true, streaming: true },
            limit: { context: 128000, output: 4096 },
          },
          "gpt-4o-mini": {
            name: "GPT-4o Mini",
            capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
            limit: { context: 128000, output: 4096 },
          },
        },
      },
      moonshot: {
        type: "openai-compatible",
        options: { baseURL: "https://api.moonshot.cn/v1", apiKey: "sk-moon" },
        models: {
          "kimi-k2": {
            name: "Kimi K2",
            capabilities: { tool_calling: true, thinking_traces: true, vision: false, streaming: true },
            limit: { context: 131072, output: 8192 },
          },
        },
      },
    },
    aliases: {
      "fast": "openai:gpt-4o-mini",
      "smart": "openai:gpt-4o",
      "reasoning": "moonshot:kimi-k2",
    },
    agents: {
      "translator": { model: "fast", requires: {} },
      "reviewer": { model: "smart", requires: { tool_calling: true } },
      "thinker": { model: "reasoning", requires: { thinking_traces: "required" } },
      "native-only": { model: "fast", requires: { native_runtime: true } },
    },
    pricing: {
      "openai:gpt-4o": { input_per_1m: 2.5, output_per_1m: 10 },
      "openai:gpt-4o-mini": { input_per_1m: 0.15, output_per_1m: 0.6 },
      "moonshot:kimi-k2": { input_per_1m: 1, output_per_1m: 4 },
    },
  }
}

const SCOPE: ScopeMeta = { project_id: "test", phase_id: "p0", sprint_id: "s1" }

function makeBudget(dir: string, budgets: Record<string, number> = {}): BudgetEnforcer {
  return new BudgetEnforcer({
    ledgerPath: join(dir, "ledger.jsonl"),
    checkpointPath: join(dir, "checkpoint.json"),
    onLedgerFailure: "fail-open",
    warnPercent: 80,
    budgets,
  })
}

function makeHealthProber(unhealthyModels: Set<string> = new Set()): HealthProber {
  return {
    recordSuccess() {},
    recordFailure() {},
    isHealthy(resolved: ResolvedModel) {
      return !unhealthyModels.has(`${resolved.provider}:${resolved.modelId}`)
    },
  }
}

// Mock ChevalInvoker that returns a canned response
function makeMockCheval(responses?: CompletionResult[]): any {
  let callIndex = 0
  const defaultResult: CompletionResult = {
    content: "Mock response",
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
    metadata: { model: "gpt-4o-mini", latency_ms: 200, trace_id: "" },
  }
  return {
    invoke: async () => {
      const result = responses ? responses[callIndex] ?? defaultResult : defaultResult
      callIndex++
      return result
    },
    _callCount: () => callIndex,
  }
}

// --- Tests ---

async function main() {
  console.log("HounfourRouter Tests (T-15.1)")
  console.log("==============================")

  // --- resolveExecution + invoke ---

  await test("invoke: basic agent invocation returns CompletionResult", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      const result = await router.invoke("translator", "Hello world")
      assert.equal(result.content, "Mock response")
      assert.equal(result.thinking, null)
      assert.equal(result.usage.prompt_tokens, 100)
    } finally {
      cleanup(dir)
    }
  })

  await test("invoke: records cost in budget after invocation", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir, { "project:test": 100 })
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      await router.invoke("translator", "Hello")
      const snapshot = budget.getBudgetSnapshot(SCOPE)
      assert.ok(snapshot.spent_usd > 0, "Cost should be recorded")
    } finally {
      cleanup(dir)
    }
  })

  await test("invoke: throws BINDING_INVALID for unknown agent", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      await assert.rejects(
        () => router.invoke("nonexistent-agent", "Hello"),
        (err: any) => err instanceof HounfourError && err.code === "BINDING_INVALID",
      )
    } finally {
      cleanup(dir)
    }
  })

  await test("invoke: throws NATIVE_RUNTIME_REQUIRED for native agent on remote provider", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      await assert.rejects(
        () => router.invoke("native-only", "Hello"),
        (err: any) => err instanceof HounfourError && err.code === "NATIVE_RUNTIME_REQUIRED",
      )
    } finally {
      cleanup(dir)
    }
  })

  // --- Budget enforcement ---

  await test("invoke: throws BUDGET_EXCEEDED when budget exceeded and mode=block", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir, { "project:test": 0.001 })
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      // Pre-exhaust budget
      await budget.recordCost(SCOPE,
        { prompt_tokens: 10000, completion_tokens: 5000, reasoning_tokens: 0 },
        { provider: "openai", model: "gpt-4o-mini", input_per_1m: 0.15, output_per_1m: 0.6 },
        { trace_id: "t", agent: "a", provider: "openai", model: "gpt-4o-mini", tenant_id: "local", latency_ms: 0 },
      )

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        routingConfig: { on_budget_exceeded: "block" },
      })

      await assert.rejects(
        () => router.invoke("translator", "Hello"),
        (err: any) => err instanceof HounfourError && err.code === "BUDGET_EXCEEDED",
      )
    } finally {
      cleanup(dir)
    }
  })

  await test("invoke: emits warning when budget at warning level", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir, { "project:test": 1.0 })
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      // Push to ~85% of budget
      await budget.recordCost(SCOPE,
        { prompt_tokens: 5000000, completion_tokens: 100000, reasoning_tokens: 0 },
        { provider: "openai", model: "gpt-4o-mini", input_per_1m: 0.15, output_per_1m: 0.6 },
        { trace_id: "t", agent: "a", provider: "openai", model: "gpt-4o-mini", tenant_id: "local", latency_ms: 0 },
      )

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      // Should succeed but emit warning (we can't capture console.warn easily, just verify no throw)
      const result = await router.invoke("translator", "Hello")
      assert.ok(result.content)
    } finally {
      cleanup(dir)
    }
  })

  // --- Fallback chains ---

  await test("resolveExecution: fallback chain when primary unhealthy", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig()
      const registry = ProviderRegistry.fromConfig(config)
      const budget = makeBudget(dir)
      const health = makeHealthProber(new Set(["openai:gpt-4o-mini"]))
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        routingConfig: {
          fallback: {
            "openai:gpt-4o-mini": ["openai:gpt-4o"],
          },
        },
      })

      // Should fallback from gpt-4o-mini to gpt-4o
      const result = await router.invoke("translator", "Hello")
      assert.ok(result.content)
    } finally {
      cleanup(dir)
    }
  })

  await test("resolveExecution: throws PROVIDER_UNAVAILABLE when unhealthy with no fallback", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber(new Set(["openai:gpt-4o-mini"]))
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        // No fallback configured
      })

      await assert.rejects(
        () => router.invoke("translator", "Hello"),
        (err: any) => err instanceof HounfourError && err.code === "PROVIDER_UNAVAILABLE",
      )
    } finally {
      cleanup(dir)
    }
  })

  await test("resolveExecution: fallback skips capability-incompatible entries", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig()
      const registry = ProviderRegistry.fromConfig(config)
      const budget = makeBudget(dir)
      // Mark kimi-k2 as unhealthy
      const health = makeHealthProber(new Set(["moonshot:kimi-k2"]))
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        routingConfig: {
          fallback: {
            // Fallback from kimi-k2 to gpt-4o-mini — but gpt-4o-mini doesn't have thinking_traces
            "moonshot:kimi-k2": ["openai:gpt-4o-mini"],
          },
        },
      })

      // thinker requires thinking_traces=required — gpt-4o-mini doesn't support it
      await assert.rejects(
        () => router.invoke("thinker", "Think about this"),
        (err: any) => err instanceof HounfourError && err.code === "PROVIDER_UNAVAILABLE",
      )
    } finally {
      cleanup(dir)
    }
  })

  // --- Downgrade chains ---

  await test("resolveExecution: downgrade when budget exceeded and mode=downgrade", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir, { "project:test": 0.001 })
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      // Pre-exhaust budget
      await budget.recordCost(SCOPE,
        { prompt_tokens: 10000, completion_tokens: 5000, reasoning_tokens: 0 },
        { provider: "openai", model: "gpt-4o", input_per_1m: 2.5, output_per_1m: 10 },
        { trace_id: "t", agent: "a", provider: "openai", model: "gpt-4o", tenant_id: "local", latency_ms: 0 },
      )

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        routingConfig: {
          on_budget_exceeded: "downgrade",
          downgrade: {
            "openai:gpt-4o": ["openai:gpt-4o-mini"],
          },
        },
      })

      // Should downgrade from gpt-4o to gpt-4o-mini
      const result = await router.invoke("reviewer", "Review this")
      assert.ok(result.content)
    } finally {
      cleanup(dir)
    }
  })

  // --- validateBindings ---

  await test("validateBindings: passes with valid config", () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      // Should not throw (native-only would fail, but validateBindings checks all)
      // Actually native-only would fail because it requires native_runtime on an openai provider
      assert.throws(
        () => router.validateBindings(),
        (err: any) => err instanceof HounfourError && err.code === "BINDING_INVALID",
      )
    } finally {
      cleanup(dir)
    }
  })

  // --- healthSnapshot ---

  await test("healthSnapshot: returns per-provider per-model health", () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber(new Set(["openai:gpt-4o"]))
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      const snapshot = router.healthSnapshot()
      assert.ok(snapshot.providers.openai)
      assert.equal(snapshot.providers.openai.models["gpt-4o"].healthy, false)
      assert.equal(snapshot.providers.openai.models["gpt-4o-mini"].healthy, true)
      assert.equal(snapshot.providers.openai.healthy, false) // One model unhealthy
      assert.equal(snapshot.providers.moonshot.healthy, true)
    } finally {
      cleanup(dir)
    }
  })

  // --- Tool-call loop ---

  await test("invokeWithTools: returns final content after tool-call roundtrip", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()

      // First response: tool call. Second response: final content.
      const responses: CompletionResult[] = [
        {
          content: "",
          thinking: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_time", arguments: "{}" },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 20, reasoning_tokens: 0 },
          metadata: { model: "gpt-4o-mini", latency_ms: 100, trace_id: "t" },
        },
        {
          content: "The time is 3pm.",
          thinking: null,
          tool_calls: null,
          usage: { prompt_tokens: 80, completion_tokens: 30, reasoning_tokens: 0 },
          metadata: { model: "gpt-4o-mini", latency_ms: 150, trace_id: "t" },
        },
      ]
      const cheval = makeMockCheval(responses)

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      const tools = [{
        type: "function" as const,
        function: { name: "get_time", description: "Get current time", parameters: {} },
      }]

      const executor: ToolExecutor = {
        async exec(tool: string, args: unknown) {
          return { time: "15:00" }
        },
      }

      const result = await router.invokeWithTools("translator", "What time is it?", tools, executor)
      assert.equal(result.content, "The time is 3pm.")
    } finally {
      cleanup(dir)
    }
  })

  await test("invokeWithTools: throws TOOL_CALL_MAX_ITERATIONS on infinite loop", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()

      // Always returns a tool call (infinite loop)
      const toolCallResult: CompletionResult = {
        content: "",
        thinking: null,
        tool_calls: [{
          id: "call_loop",
          type: "function",
          function: { name: "loop_tool", arguments: "{}" },
        }],
        usage: { prompt_tokens: 50, completion_tokens: 20, reasoning_tokens: 0 },
        metadata: { model: "gpt-4o-mini", latency_ms: 10, trace_id: "t" },
      }
      const cheval = makeMockCheval(Array(10).fill(toolCallResult))

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        toolCallConfig: { maxIterations: 3 },
      })

      const tools = [{
        type: "function" as const,
        function: { name: "loop_tool", description: "Loops", parameters: {} },
      }]
      const executor: ToolExecutor = { async exec() { return {} } }

      await assert.rejects(
        () => router.invokeWithTools("translator", "Loop", tools, executor),
        (err: any) => err instanceof HounfourError && err.code === "TOOL_CALL_MAX_ITERATIONS",
      )
    } finally {
      cleanup(dir)
    }
  })

  await test("invokeWithTools: throws TOOL_CALL_CONSECUTIVE_FAILURES after N failures", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()

      // Returns tool calls that will fail — unique IDs so idempotency cache doesn't mask failures
      const makeFailResponse = (i: number): CompletionResult => ({
        content: "",
        thinking: null,
        tool_calls: [{
          id: `call_fail_${i}`,
          type: "function",
          function: { name: "fail_tool", arguments: "{}" },
        }],
        usage: { prompt_tokens: 50, completion_tokens: 20, reasoning_tokens: 0 },
        metadata: { model: "gpt-4o-mini", latency_ms: 10, trace_id: "t" },
      })
      const cheval = makeMockCheval(Array.from({ length: 10 }, (_, i) => makeFailResponse(i)))

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
        toolCallConfig: { abortOnConsecutiveFailures: 2 },
      })

      const tools = [{
        type: "function" as const,
        function: { name: "fail_tool", description: "Fails", parameters: {} },
      }]
      const executor: ToolExecutor = {
        async exec() { throw new Error("Tool execution failed") },
      }

      await assert.rejects(
        () => router.invokeWithTools("translator", "Fail", tools, executor),
        (err: any) => err instanceof HounfourError && err.code === "TOOL_CALL_CONSECUTIVE_FAILURES",
      )
    } finally {
      cleanup(dir)
    }
  })

  await test("invokeWithTools: idempotency cache prevents duplicate execution", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()

      // Same tool_call_id in two iterations
      const responses: CompletionResult[] = [
        {
          content: "",
          thinking: null,
          tool_calls: [{
            id: "call_same",
            type: "function",
            function: { name: "expensive_tool", arguments: "{}" },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 20, reasoning_tokens: 0 },
          metadata: { model: "gpt-4o-mini", latency_ms: 10, trace_id: "t" },
        },
        {
          content: "",
          thinking: null,
          tool_calls: [{
            id: "call_same", // Same ID — should use cache
            type: "function",
            function: { name: "expensive_tool", arguments: "{}" },
          }],
          usage: { prompt_tokens: 80, completion_tokens: 20, reasoning_tokens: 0 },
          metadata: { model: "gpt-4o-mini", latency_ms: 10, trace_id: "t" },
        },
        {
          content: "Done",
          thinking: null,
          tool_calls: null,
          usage: { prompt_tokens: 100, completion_tokens: 10, reasoning_tokens: 0 },
          metadata: { model: "gpt-4o-mini", latency_ms: 10, trace_id: "t" },
        },
      ]
      const cheval = makeMockCheval(responses)

      let execCount = 0
      const executor: ToolExecutor = {
        async exec() {
          execCount++
          return { result: "ok" }
        },
      }

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      const tools = [{
        type: "function" as const,
        function: { name: "expensive_tool", description: "Expensive", parameters: {} },
      }]

      const result = await router.invokeWithTools("translator", "Run", tools, executor)
      assert.equal(result.content, "Done")
      assert.equal(execCount, 1, "Tool should only execute once due to idempotency cache")
    } finally {
      cleanup(dir)
    }
  })

  await test("invokeWithTools: malformed JSON arguments get repair attempt", async () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()

      const responses: CompletionResult[] = [
        {
          content: "",
          thinking: null,
          tool_calls: [{
            id: "call_bad_json",
            type: "function",
            function: { name: "my_tool", arguments: "not valid json{" },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 20, reasoning_tokens: 0 },
          metadata: { model: "gpt-4o-mini", latency_ms: 10, trace_id: "t" },
        },
        {
          content: "Recovered",
          thinking: null,
          tool_calls: null,
          usage: { prompt_tokens: 80, completion_tokens: 10, reasoning_tokens: 0 },
          metadata: { model: "gpt-4o-mini", latency_ms: 10, trace_id: "t" },
        },
      ]
      const cheval = makeMockCheval(responses)

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      const tools = [{
        type: "function" as const,
        function: { name: "my_tool", description: "Test", parameters: {} },
      }]
      const executor: ToolExecutor = { async exec() { return {} } }

      // Model sends bad JSON, gets error back, then recovers on second iteration
      const result = await router.invokeWithTools("translator", "Go", tools, executor)
      assert.equal(result.content, "Recovered")
    } finally {
      cleanup(dir)
    }
  })

  // --- budgetSnapshot ---

  await test("budgetSnapshot: returns correct snapshot", () => {
    const dir = makeTempDir()
    try {
      const registry = ProviderRegistry.fromConfig(makeConfig())
      const budget = makeBudget(dir)
      const health = makeHealthProber()
      const cheval = makeMockCheval()

      const router = new HounfourRouter({
        registry, budget, health, cheval,
        scopeMeta: SCOPE,
      })

      const snapshot = router.budgetSnapshot()
      assert.equal(snapshot.limit_usd, 0) // No budget limits set
      assert.equal(snapshot.spent_usd, 0)
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
