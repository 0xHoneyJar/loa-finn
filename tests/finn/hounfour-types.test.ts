// tests/finn/hounfour-types.test.ts — Hounfour types & errors unit tests (T-14.4)

import assert from "node:assert/strict"
import { validateExecutionContext } from "../../src/hounfour/types.js"
import type {
  ExecutionContext,
  CompletionResult,
  CanonicalMessage,
  ToolCall,
  LedgerEntry,
} from "../../src/hounfour/types.js"
import {
  HounfourError,
  ChevalError,
  chevalExitCodeToError,
} from "../../src/hounfour/errors.js"

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

async function main() {
  console.log("Hounfour Types & Errors Tests (T-14.4)")
  console.log("=======================================")

  // --- validateExecutionContext ---

  await test("validateExecutionContext accepts valid context", () => {
    const ctx: ExecutionContext = {
      resolved: { provider: "openai", modelId: "gpt-4o" },
      scopeMeta: { project_id: "proj-1", phase_id: "phase-0", sprint_id: "sprint-14" },
      binding: {
        agent: "reviewing-code",
        model: "openai:gpt-4o",
        requires: { tool_calling: true },
      },
      pricing: {
        provider: "openai",
        model: "gpt-4o",
        input_per_1m: 2.5,
        output_per_1m: 10.0,
      },
    }
    validateExecutionContext(ctx)
  })

  await test("validateExecutionContext rejects missing provider", () => {
    const ctx = {
      resolved: { provider: "", modelId: "gpt-4o" },
      scopeMeta: { project_id: "p", phase_id: "ph", sprint_id: "s" },
      binding: { agent: "a", model: "m", requires: {} },
      pricing: { provider: "p", model: "m", input_per_1m: 1, output_per_1m: 1 },
    } as ExecutionContext
    assert.throws(() => validateExecutionContext(ctx), /resolved is incomplete/)
  })

  await test("validateExecutionContext rejects missing modelId", () => {
    const ctx = {
      resolved: { provider: "openai", modelId: "" },
      scopeMeta: { project_id: "p", phase_id: "ph", sprint_id: "s" },
      binding: { agent: "a", model: "m", requires: {} },
      pricing: { provider: "p", model: "m", input_per_1m: 1, output_per_1m: 1 },
    } as ExecutionContext
    assert.throws(() => validateExecutionContext(ctx), /resolved is incomplete/)
  })

  await test("validateExecutionContext rejects missing scopeMeta.project_id", () => {
    const ctx = {
      resolved: { provider: "openai", modelId: "gpt-4o" },
      scopeMeta: { project_id: "", phase_id: "ph", sprint_id: "s" },
      binding: { agent: "a", model: "m", requires: {} },
      pricing: { provider: "p", model: "m", input_per_1m: 1, output_per_1m: 1 },
    } as ExecutionContext
    assert.throws(() => validateExecutionContext(ctx), /scopeMeta is incomplete/)
  })

  await test("validateExecutionContext rejects missing binding", () => {
    const ctx = {
      resolved: { provider: "openai", modelId: "gpt-4o" },
      scopeMeta: { project_id: "p", phase_id: "ph", sprint_id: "s" },
      binding: null,
      pricing: { provider: "p", model: "m", input_per_1m: 1, output_per_1m: 1 },
    } as unknown as ExecutionContext
    assert.throws(() => validateExecutionContext(ctx), /binding is missing/)
  })

  await test("validateExecutionContext rejects missing pricing", () => {
    const ctx = {
      resolved: { provider: "openai", modelId: "gpt-4o" },
      scopeMeta: { project_id: "p", phase_id: "ph", sprint_id: "s" },
      binding: { agent: "a", model: "m", requires: {} },
      pricing: null,
    } as unknown as ExecutionContext
    assert.throws(() => validateExecutionContext(ctx), /pricing is missing/)
  })

  // --- CanonicalMessage null content ---

  await test("CanonicalMessage supports null content on tool-call turns", () => {
    const msg: CanonicalMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_abc",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NYC"}' },
      }],
    }
    assert.equal(msg.content, null)
    assert.equal(msg.tool_calls!.length, 1)
    assert.equal(msg.tool_calls![0].function.name, "get_weather")
  })

  // --- CompletionResult thinking=null ---

  await test("CompletionResult thinking is null for non-thinking models", () => {
    const result: CompletionResult = {
      content: "Hello world",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
      metadata: { model: "gpt-4o", latency_ms: 200, trace_id: "abc-123" },
    }
    assert.equal(result.thinking, null)
    assert.equal(result.usage.reasoning_tokens, 0)
  })

  // --- HounfourError ---

  await test("HounfourError has correct name and code", () => {
    const err = new HounfourError(
      "NATIVE_RUNTIME_REQUIRED",
      "Agent requires Claude Code runtime",
      { agent: "implementing-tasks" },
    )
    assert.equal(err.name, "HounfourError")
    assert.equal(err.code, "NATIVE_RUNTIME_REQUIRED")
    assert.ok(err.message.includes("NATIVE_RUNTIME_REQUIRED"))
    assert.ok(err.message.includes("Agent requires Claude Code runtime"))
    assert.equal(err.context.agent, "implementing-tasks")
    assert.ok(err instanceof Error)
  })

  await test("HounfourError.toJSON() serializes correctly", () => {
    const err = new HounfourError("BUDGET_EXCEEDED", "Limit reached", { scope: "sprint-14" })
    const json = err.toJSON()
    assert.equal(json.error, "HounfourError")
    assert.equal(json.code, "BUDGET_EXCEEDED")
    assert.ok((json.message as string).includes("Limit reached"))
    assert.deepEqual(json.context, { scope: "sprint-14" })
  })

  // --- ChevalError ---

  await test("ChevalError has correct fields", () => {
    const err = new ChevalError({
      code: "provider_error",
      message: "429 Too Many Requests",
      statusCode: 429,
      providerCode: "rate_limit_exceeded",
      retryable: true,
    })
    assert.equal(err.name, "ChevalError")
    assert.equal(err.code, "provider_error")
    assert.equal(err.statusCode, 429)
    assert.equal(err.providerCode, "rate_limit_exceeded")
    assert.equal(err.retryable, true)
    assert.ok(err instanceof Error)
  })

  await test("ChevalError.toJSON() serializes correctly", () => {
    const err = new ChevalError({
      code: "network_error",
      message: "Connection refused",
      retryable: true,
    })
    const json = err.toJSON()
    assert.equal(json.error, "ChevalError")
    assert.equal(json.code, "network_error")
    assert.equal(json.retryable, true)
    assert.equal(json.provider_code, undefined)
    assert.equal(json.status_code, undefined)
  })

  await test("ChevalError defaults retryable to false", () => {
    const err = new ChevalError({ code: "auth_error", message: "Invalid API key" })
    assert.equal(err.retryable, false)
  })

  // --- chevalExitCodeToError ---

  await test("chevalExitCodeToError maps exit code 1 to provider_error", () => {
    const err = chevalExitCodeToError(1, "HTTP 500 Internal Server Error")
    assert.equal(err.code, "provider_error")
    assert.ok(err.message.includes("HTTP 500"))
    assert.equal(err.retryable, false)
  })

  await test("chevalExitCodeToError maps exit code 2 to network_error (retryable)", () => {
    const err = chevalExitCodeToError(2, "Connection timed out")
    assert.equal(err.code, "network_error")
    assert.equal(err.retryable, true)
  })

  await test("chevalExitCodeToError maps exit code 3 to hmac_invalid", () => {
    const err = chevalExitCodeToError(3, "HMAC mismatch")
    assert.equal(err.code, "hmac_invalid")
    assert.equal(err.retryable, false)
  })

  await test("chevalExitCodeToError maps exit code 4 to cheval_invalid_response", () => {
    const err = chevalExitCodeToError(4, "Missing required field: model")
    assert.equal(err.code, "cheval_invalid_response")
    assert.equal(err.retryable, false)
  })

  await test("chevalExitCodeToError maps exit code 5 to cheval_crash", () => {
    const err = chevalExitCodeToError(5, "Traceback: ...")
    assert.equal(err.code, "cheval_crash")
    assert.equal(err.retryable, false)
  })

  await test("chevalExitCodeToError handles unknown exit codes", () => {
    const err = chevalExitCodeToError(99, "Unknown error")
    assert.equal(err.code, "cheval_crash")
    assert.ok(err.message.includes("99"))
  })

  // --- LedgerEntry shape ---

  await test("LedgerEntry has all 16 required fields", () => {
    const entry: LedgerEntry = {
      timestamp: "2026-02-08T12:00:00Z",
      trace_id: "abc-123",
      agent: "reviewing-code",
      provider: "openai",
      model: "gpt-4o",
      project_id: "loa-finn",
      phase_id: "phase-0",
      sprint_id: "sprint-14",
      tenant_id: "local",
      prompt_tokens: 1000,
      completion_tokens: 500,
      reasoning_tokens: 0,
      input_cost_usd: 0.0025,
      output_cost_usd: 0.005,
      total_cost_usd: 0.0075,
      latency_ms: 1200,
    }
    const keys = Object.keys(entry)
    assert.equal(keys.length, 16, `Expected 16 fields, got ${keys.length}: ${keys.join(", ")}`)
  })

  console.log("\nDone.")
}

main()
