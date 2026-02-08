// tests/finn/hounfour-e2e.test.ts — E2E Model Invoke Integration Test (T-14.11)
// Full path: config → registry → ChevalInvoker → cheval.py → CompletionResult → ledger entry

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { ProviderRegistry } from "../../src/hounfour/registry.js"
import type { RawProviderConfig } from "../../src/hounfour/registry.js"
import { ChevalInvoker, signRequest, generateNonce } from "../../src/hounfour/cheval-invoker.js"
import type { HealthProber } from "../../src/hounfour/cheval-invoker.js"
import { BudgetEnforcer, calculateCost, deriveScopeKey } from "../../src/hounfour/budget.js"
import type { BudgetConfig } from "../../src/hounfour/budget.js"
import { HounfourError } from "../../src/hounfour/errors.js"
import { validateExecutionContext } from "../../src/hounfour/types.js"
import type {
  ChevalRequest,
  CompletionResult,
  ScopeMeta,
  ExecutionContext,
} from "../../src/hounfour/types.js"
import { DEFAULT_RETRY_POLICY } from "../../src/hounfour/types.js"

const PREFIX = "finn-e2e-test-"

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

const HMAC_SECRET = "e2e-test-hmac-secret-32-bytes-!!"

function makeProviderConfig(): RawProviderConfig {
  return {
    providers: {
      openai: {
        type: "openai",
        options: {
          baseURL: "https://api.openai.com/v1",
          apiKey: process.env.OPENAI_API_KEY ?? "sk-test-not-real",
        },
        models: {
          "gpt-4o-mini": {
            name: "GPT-4o Mini",
            capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    },
    aliases: {
      "fast": "openai:gpt-4o-mini",
    },
    agents: {
      "translating-for-executives": {
        model: "fast",
        requires: {},
      },
    },
    pricing: {
      "openai:gpt-4o-mini": {
        input_per_1m: 0.15,
        output_per_1m: 0.6,
      },
    },
  }
}

function makeHealthProber(): HealthProber & { successes: string[]; failures: string[] } {
  const successes: string[] = []
  const failures: string[] = []
  return {
    successes,
    failures,
    recordSuccess(provider: string, modelId: string) {
      successes.push(`${provider}:${modelId}`)
    },
    recordFailure(provider: string, modelId: string) {
      failures.push(`${provider}:${modelId}`)
    },
    isHealthy() {
      return true
    },
  }
}

async function main() {
  console.log("E2E Model Invoke Integration Tests (T-14.11)")
  console.log("=============================================")

  // --- Fixture-based E2E (always runs) ---

  await test("E2E: Config → Registry → binding resolution → ExecutionContext validation", () => {
    const config = makeProviderConfig()
    const registry = ProviderRegistry.fromConfig(config)

    // Resolve agent binding
    const binding = registry.getAgentBinding("translating-for-executives")
    assert.ok(binding, "Agent binding found")
    assert.equal(binding.model, "fast")

    // Resolve alias
    const resolved = registry.resolveAlias(binding.model)
    assert.equal(resolved.provider, "openai")
    assert.equal(resolved.modelId, "gpt-4o-mini")

    // Get pricing
    const pricing = registry.getPricing(resolved.provider, resolved.modelId)
    assert.ok(pricing, "Pricing found")
    assert.equal(pricing.input_per_1m, 0.15)

    // Build ExecutionContext
    const ctx: ExecutionContext = {
      resolved,
      scopeMeta: { project_id: "loa-finn", phase_id: "phase-0", sprint_id: "sprint-14" },
      binding,
      pricing,
    }
    validateExecutionContext(ctx) // Should not throw
  })

  await test("E2E: Validate all bindings pass at startup", () => {
    const config = makeProviderConfig()
    const registry = ProviderRegistry.fromConfig(config)
    const results = registry.validateBindings()

    assert.equal(results.length, 1)
    assert.equal(results[0].valid, true)
    assert.equal(results[0].agent, "translating-for-executives")
  })

  await test("E2E: HMAC signing → verification roundtrip (TS interop)", () => {
    const body = '{"schema_version":1,"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
    const nonce = generateNonce()
    const traceId = randomUUID()
    const issuedAt = new Date().toISOString()

    const signature = signRequest(body, HMAC_SECRET, nonce, traceId, issuedAt)
    assert.equal(signature.length, 64)
    assert.match(signature, /^[a-f0-9]{64}$/)

    // Verify determinism
    const signature2 = signRequest(body, HMAC_SECRET, nonce, traceId, issuedAt)
    assert.equal(signature, signature2)
  })

  await test("E2E: ChevalRequest construction with all required fields", () => {
    const config = makeProviderConfig()
    const registry = ProviderRegistry.fromConfig(config)
    const binding = registry.getAgentBinding("translating-for-executives")!
    const resolved = registry.resolveAlias(binding.model)
    const provider = registry.getProvider(resolved.provider)!

    const traceId = randomUUID()
    const request: ChevalRequest = {
      schema_version: 1,
      provider: {
        name: provider.name,
        type: provider.type as "openai" | "openai-compatible",
        base_url: provider.options?.baseURL ?? "",
        api_key: provider.options?.apiKey ?? "",
        connect_timeout_ms: provider.options?.connectTimeoutMs ?? 5000,
        read_timeout_ms: provider.options?.readTimeoutMs ?? 60000,
        total_timeout_ms: provider.options?.totalTimeoutMs ?? 300000,
      },
      model: resolved.modelId,
      messages: [{ role: "user", content: "Summarize: This is a test." }],
      options: {},
      metadata: {
        agent: "translating-for-executives",
        tenant_id: "local",
        nft_id: "",
        trace_id: traceId,
      },
      retry: {
        max_retries: 3,
        base_delay_ms: 1000,
        max_delay_ms: 30000,
        jitter_percent: 25,
        retryable_status_codes: [429, 500, 502, 503, 504],
      },
      hmac: { signature: "", nonce: "", issued_at: "" },
    }

    assert.equal(request.schema_version, 1)
    assert.equal(request.model, "gpt-4o-mini")
    assert.equal(request.metadata.agent, "translating-for-executives")
    assert.equal(request.metadata.trace_id, traceId)
  })

  await test("E2E: Ledger entry written with all 16 fields after cost recording", async () => {
    const dir = makeTempDir()
    try {
      const scopeMeta: ScopeMeta = { project_id: "loa-finn", phase_id: "phase-0", sprint_id: "sprint-14" }
      const keys = deriveScopeKey(scopeMeta)
      const budgetConfig: BudgetConfig = {
        ledgerPath: join(dir, "cost-ledger.jsonl"),
        checkpointPath: join(dir, "budget-checkpoint.json"),
        onLedgerFailure: "fail-open",
        warnPercent: 80,
        budgets: { [keys.project]: 100 },
      }
      const budget = new BudgetEnforcer(budgetConfig)

      const traceId = randomUUID()
      const usage = { prompt_tokens: 500, completion_tokens: 200, reasoning_tokens: 0 }
      const pricing = { provider: "openai", model: "gpt-4o-mini", input_per_1m: 0.15, output_per_1m: 0.6 }

      await budget.recordCost(scopeMeta, usage, pricing, {
        trace_id: traceId,
        agent: "translating-for-executives",
        provider: "openai",
        model: "gpt-4o-mini",
        tenant_id: "local",
        latency_ms: 1500,
      })

      // Verify ledger entry
      const ledgerContent = readFileSync(budgetConfig.ledgerPath, "utf8")
      const entry = JSON.parse(ledgerContent.trim())

      // All 16 fields
      assert.equal(Object.keys(entry).length, 16, `Expected 16 fields, got ${Object.keys(entry).length}`)
      assert.equal(entry.trace_id, traceId, "trace_id correlation")
      assert.equal(entry.agent, "translating-for-executives")
      assert.equal(entry.provider, "openai")
      assert.equal(entry.model, "gpt-4o-mini")
      assert.equal(entry.project_id, "loa-finn")
      assert.equal(entry.phase_id, "phase-0")
      assert.equal(entry.sprint_id, "sprint-14")
      assert.equal(entry.tenant_id, "local")
      assert.equal(entry.prompt_tokens, 500)
      assert.equal(entry.completion_tokens, 200)
      assert.equal(entry.reasoning_tokens, 0)
      assert.ok(entry.total_cost_usd > 0, "total_cost calculated")
      assert.equal(entry.latency_ms, 1500)

      // Verify cost calculation matches
      const expectedCost = calculateCost(usage, pricing)
      assert.ok(Math.abs(entry.total_cost_usd - expectedCost) < 1e-10)
    } finally {
      cleanup(dir)
    }
  })

  await test("E2E: trace_id correlation from request metadata to ledger entry", async () => {
    const dir = makeTempDir()
    try {
      const traceId = randomUUID()
      const scopeMeta: ScopeMeta = { project_id: "test", phase_id: "p0", sprint_id: "s1" }
      const budgetConfig: BudgetConfig = {
        ledgerPath: join(dir, "ledger.jsonl"),
        checkpointPath: join(dir, "checkpoint.json"),
        onLedgerFailure: "fail-open",
        warnPercent: 80,
        budgets: {},
      }
      const budget = new BudgetEnforcer(budgetConfig)

      await budget.recordCost(scopeMeta, { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 }, { provider: "p", model: "m", input_per_1m: 1, output_per_1m: 1 }, {
        trace_id: traceId,
        agent: "test-agent",
        provider: "p",
        model: "m",
        tenant_id: "local",
        latency_ms: 100,
      })

      const entry = JSON.parse(readFileSync(budgetConfig.ledgerPath, "utf8").trim())
      assert.equal(entry.trace_id, traceId, "trace_id must correlate from request to ledger")
    } finally {
      cleanup(dir)
    }
  })

  // --- Live smoke test (runs only when OPENAI_API_KEY is set) ---

  const hasOpenAIKey = !!process.env.OPENAI_API_KEY
  if (hasOpenAIKey) {
    console.log("\n  [Live smoke test — OPENAI_API_KEY detected]")

    await test("E2E LIVE: model-invoke via ChevalInvoker → cheval.py → OpenAI → CompletionResult", async () => {
      const config = makeProviderConfig()
      const registry = ProviderRegistry.fromConfig(config)
      const binding = registry.getAgentBinding("translating-for-executives")!
      const resolved = registry.resolveAlias(binding.model)
      const provider = registry.getProvider(resolved.provider)!

      const invoker = new ChevalInvoker({
        hmac: { secret: HMAC_SECRET },
      })

      const traceId = randomUUID()
      const request: ChevalRequest = {
        schema_version: 1,
        provider: {
          name: provider.name,
          type: provider.type as "openai" | "openai-compatible",
          base_url: provider.options?.baseURL ?? "",
          api_key: provider.options?.apiKey ?? "",
          connect_timeout_ms: 5000,
          read_timeout_ms: 60000,
          total_timeout_ms: 300000,
        },
        model: resolved.modelId,
        messages: [{ role: "user", content: "Say exactly: Hello from Hounfour!" }],
        options: { temperature: 0, max_tokens: 50 },
        metadata: {
          agent: "translating-for-executives",
          tenant_id: "local",
          nft_id: "",
          trace_id: traceId,
        },
        retry: {
          max_retries: 1,
          base_delay_ms: 1000,
          max_delay_ms: 5000,
          jitter_percent: 25,
          retryable_status_codes: [429, 500, 502, 503, 504],
        },
        hmac: { signature: "", nonce: "", issued_at: "" },
      }

      const result = await invoker.invoke(request)

      assert.ok(result.content.length > 0, "Got content from provider")
      assert.equal(result.thinking, null, "No thinking for GPT-4o-mini")
      assert.ok(result.usage.prompt_tokens > 0, "Prompt tokens counted")
      assert.ok(result.usage.completion_tokens > 0, "Completion tokens counted")
      assert.ok(result.metadata.latency_ms > 0, "Latency measured")
      assert.equal(result.metadata.trace_id, traceId, "trace_id preserved")

      console.log(`    Content: "${result.content.substring(0, 50)}"`)
      console.log(`    Tokens: ${result.usage.prompt_tokens}in / ${result.usage.completion_tokens}out`)
      console.log(`    Latency: ${result.metadata.latency_ms.toFixed(0)}ms`)
    })
    await test("E2E LIVE T-15.8: tool-call roundtrip — definition → tool_call → tool_result → final content", async () => {
      const config = makeProviderConfig()
      const registry = ProviderRegistry.fromConfig(config)
      const binding = registry.getAgentBinding("translating-for-executives")!
      const resolved = registry.resolveAlias(binding.model)
      const provider = registry.getProvider(resolved.provider)!
      const scopeMeta: ScopeMeta = { project_id: "loa-finn", phase_id: "phase-0", sprint_id: "sprint-15" }
      const dir = makeTempDir()

      try {
        const budgetConfig: BudgetConfig = {
          ledgerPath: join(dir, "cost-ledger.jsonl"),
          checkpointPath: join(dir, "checkpoint.json"),
          onLedgerFailure: "fail-open",
          warnPercent: 80,
          budgets: {},
        }
        const budget = new BudgetEnforcer(budgetConfig)
        const health = makeHealthProber()

        const invoker = new ChevalInvoker({ hmac: { secret: HMAC_SECRET } })

        // Import HounfourRouter dynamically to keep this test in the existing file
        const { HounfourRouter } = await import("../../src/hounfour/router.js")
        type ToolExecutor = import("../../src/hounfour/router.js").ToolExecutor

        const router = new HounfourRouter({
          registry, budget, health, cheval: invoker,
          scopeMeta,
          projectRoot: dir,
        })

        // Define a simple tool
        const tools = [{
          type: "function" as const,
          function: {
            name: "get_weather",
            description: "Get the weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
              },
              required: ["location"],
            },
          },
        }]

        // Tool executor returns a canned weather result
        let toolCallCount = 0
        const executor: ToolExecutor = {
          async exec(tool: string, args: unknown) {
            toolCallCount++
            assert.equal(tool, "get_weather", "Correct tool called")
            const parsed = args as { location: string }
            assert.ok(parsed.location, "Location argument provided")
            return { temperature: 72, unit: "F", description: "Sunny" }
          },
        }

        const result = await router.invokeWithTools(
          "translating-for-executives",
          "What is the weather in San Francisco? Use the get_weather tool.",
          tools,
          executor,
          { temperature: 0, max_tokens: 200 },
        )

        // Verify: final content returned (not another tool call)
        assert.ok(result.content.length > 0, "Got final content")
        assert.ok(!result.tool_calls || result.tool_calls.length === 0, "No tool calls in final response")

        // Verify: tool was actually called
        assert.ok(toolCallCount >= 1, `Tool was called ${toolCallCount} time(s)`)

        // Verify: budget charged for both iterations (tool call + final response)
        const snapshot = router.budgetSnapshot()
        assert.ok(snapshot.spent_usd > 0, "Budget charged for iterations")

        // Verify: ledger has entries for both iterations
        const ledgerContent = readFileSync(budgetConfig.ledgerPath, "utf8").trim()
        const ledgerLines = ledgerContent.split("\n").filter(l => l.trim())
        assert.ok(ledgerLines.length >= 2, `Ledger has ${ledgerLines.length} entries (expected ≥2 iterations)`)

        console.log(`    Final content: "${result.content.substring(0, 80)}"`)
        console.log(`    Tool calls: ${toolCallCount}`)
        console.log(`    Ledger entries: ${ledgerLines.length}`)
        console.log(`    Budget spent: $${snapshot.spent_usd.toFixed(6)}`)
      } finally {
        cleanup(dir)
      }
    })
  } else {
    console.log("\n  [Live smoke test SKIPPED — set OPENAI_API_KEY to enable]")
  }

  console.log("\nDone.")
}

main()
