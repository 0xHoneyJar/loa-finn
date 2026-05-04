// src/substrate/__tests__/model-runner-layer.test.ts — ModelRunner Layer unit tests.
//
// Cycle-032 Sprint-3 Task 3.4. See PRD FR-3 + SDD §4.5.

import { describe, it, expect, vi } from "vitest"
import { Effect, Layer } from "effect"
import {
  ModelRunner,
  ModelRunnerError,
  buildModelRunnerLayer,
  mapErrorToModelRunnerError,
  type ModelInvoker,
} from "../model-runner-layer.js"
import type { CompletionRequest, CompletionResult } from "../../hounfour/types.js"

// ── Test helpers ────────────────────────────────────────────────────

function makeMockInvoker(impl: (req: CompletionRequest) => Promise<CompletionResult>): ModelInvoker {
  return { complete: impl }
}

function makeCannedResult(content: string): CompletionResult {
  return {
    content,
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 0 },
    metadata: { model: "test-model", latency_ms: 100, trace_id: "test-trace" },
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe("buildModelRunnerLayer", () => {
  it("composes ModelRunner Tag with the canned response", async () => {
    const invoker = makeMockInvoker(async () => makeCannedResult("hello world"))
    const layer = buildModelRunnerLayer({
      invoker,
      modelId: "test-model",
      agentId: "test-agent",
      tenantId: "test-tenant",
    })

    const program = Effect.gen(function* () {
      const runner = yield* ModelRunner
      return yield* runner.complete({ systemPrompt: "sys", userMessage: "hi" })
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
    expect(result).toBe("hello world")
  })

  it("translates {systemPrompt, userMessage} into a CompletionRequest", async () => {
    const spy = vi.fn(async () => makeCannedResult("ok"))
    const invoker = makeMockInvoker(spy)
    const layer = buildModelRunnerLayer({
      invoker,
      modelId: "test-model",
      agentId: "agent-1",
      tenantId: "tenant-1",
      maxTokens: 1024,
      temperature: 0.5,
      traceIdGen: () => "fixed-trace-id",
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ModelRunner
        return yield* runner.complete({ systemPrompt: "S", userMessage: "U" })
      }).pipe(Effect.provide(layer)),
    )

    expect(spy).toHaveBeenCalledOnce()
    const req = spy.mock.calls[0]![0]
    expect(req.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ])
    expect(req.options.temperature).toBe(0.5)
    expect(req.options.max_tokens).toBe(1024)
    expect(req.metadata).toEqual({
      agent: "agent-1",
      tenant_id: "tenant-1",
      nft_id: "",
      trace_id: "fixed-trace-id",
    })
  })

  it("invoker throw → Effect fails with ModelRunnerError shape", async () => {
    const invoker = makeMockInvoker(async () => {
      throw new Error("cheval crashed")
    })
    const layer = buildModelRunnerLayer({
      invoker,
      modelId: "test-model",
      agentId: "a",
      tenantId: "t",
    })

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const runner = yield* ModelRunner
        return yield* runner.complete({ systemPrompt: "s", userMessage: "u" })
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      // Effect wraps the error; we check that ModelRunnerError surfaced
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("ModelRunnerError")
      expect(causeStr).toContain("cheval crashed")
    }
  })

  it("uses default max_tokens=4096 and temperature=0.2 when not provided", async () => {
    const spy = vi.fn(async () => makeCannedResult("x"))
    const layer = buildModelRunnerLayer({
      invoker: { complete: spy },
      modelId: "m",
      agentId: "a",
      tenantId: "t",
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ModelRunner
        return yield* runner.complete({ systemPrompt: "", userMessage: "" })
      }).pipe(Effect.provide(layer)),
    )
    const req = spy.mock.calls[0]![0]
    expect(req.options.max_tokens).toBe(4096)
    expect(req.options.temperature).toBe(0.2)
  })
})

describe("mapErrorToModelRunnerError", () => {
  it("maps timeout-shaped errors → reason=timeout", () => {
    const err = mapErrorToModelRunnerError(new Error("operation timed out after 30s"))
    expect(err._tag).toBe("ModelRunnerError")
    expect(err.reason).toBe("timeout")
    expect(err.message).toContain("timed out")
  })

  it("maps Hounfour TOOL_CALL_WALL_TIME_EXCEEDED → reason=timeout", () => {
    const e = Object.assign(new Error("wall-time blown"), { code: "TOOL_CALL_WALL_TIME_EXCEEDED" })
    const err = mapErrorToModelRunnerError(e)
    expect(err.reason).toBe("timeout")
  })

  it("maps rate-limit-shaped errors → reason=rate-limit", () => {
    expect(mapErrorToModelRunnerError(new Error("HTTP 429 too many requests")).reason).toBe("rate-limit")
    expect(mapErrorToModelRunnerError(new Error("rate-limit hit")).reason).toBe("rate-limit")
  })

  it("maps Hounfour BUDGET_EXCEEDED → reason=rate-limit", () => {
    const e = Object.assign(new Error("budget gone"), { code: "BUDGET_EXCEEDED" })
    expect(mapErrorToModelRunnerError(e).reason).toBe("rate-limit")
  })

  it("maps validation-shaped errors → reason=invalid-input", () => {
    expect(mapErrorToModelRunnerError(new Error("invalid completion request")).reason).toBe("invalid-input")
    const e = Object.assign(new Error("config"), { code: "CONFIG_INVALID" })
    expect(mapErrorToModelRunnerError(e).reason).toBe("invalid-input")
  })

  it("maps everything else → reason=unknown", () => {
    expect(mapErrorToModelRunnerError(new Error("something weird")).reason).toBe("unknown")
    expect(mapErrorToModelRunnerError("string thrown").reason).toBe("unknown")
    expect(mapErrorToModelRunnerError(null).reason).toBe("unknown")
  })

  it("ModelRunnerError shape matches construct grader.ts", () => {
    const e = new ModelRunnerError("timeout", "test")
    expect(e._tag).toBe("ModelRunnerError")
    expect(e.reason).toBe("timeout")
    expect(e.message).toBe("test")
  })
})

describe("ModelRunner Tag identity", () => {
  it("Tag string identifier is exactly 'ModelRunner' (cross-pack contract)", () => {
    // Effect Tag's identifier is encoded in its key; runtime equality is by string.
    // Two declarations with the same string ("ModelRunner") resolve to the same Tag.
    // Verified more rigorously in model-runner-layer.integration.test.ts which
    // imports the construct's actual Tag declaration.
    expect(ModelRunner.key).toBe("ModelRunner")
  })

  it("Layer composes via Layer.provideMerge (compatible with construct's Layer.provide pattern)", async () => {
    const layer = buildModelRunnerLayer({
      invoker: makeMockInvoker(async () => makeCannedResult("test")),
      modelId: "m",
      agentId: "a",
      tenantId: "t",
    })
    // Should be a Layer<ModelRunner>
    expect(Layer.isLayer(layer)).toBe(true)
  })
})
