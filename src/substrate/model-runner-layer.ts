// src/substrate/model-runner-layer.ts — ModelRunner Effect Layer for substrate-constructs.
//
// Cycle-032 Sprint-3. See PRD FR-3 + SDD §4.5 + build doc §5.4.
//
// **CRITICAL — cross-pack Tag identity**:
// The construct (e.g., construct-lore-essay-grader/src/grader.ts) declares:
//   export class ModelRunner extends Context.Tag("ModelRunner")<...>()
//   export class ModelRunnerError {
//     readonly _tag = "ModelRunnerError"
//     constructor(
//       readonly reason: "timeout" | "rate-limit" | "invalid-input" | "unknown",
//       readonly message: string,
//     ) {}
//   }
//
// Effect's Tag identity matches by string ("ModelRunner") — both sides resolve to
// the same Tag at Layer composition. This file MUST keep the Tag string and the
// service interface in lockstep with the construct's declaration. If construct
// authors change the contract, this file (or the cross-pack contract layer) must
// be updated correspondingly. Sprint-3 integration test enforces this lockstep.

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import type { CompletionRequest, CompletionResult } from "../hounfour/types.js"

// ── Cross-pack Tag identity contract (matches grader.ts:24-31) ──────

/**
 * `ModelRunner` Tag — string identifier "ModelRunner" — must match the
 * construct-side declaration verbatim.
 */
export class ModelRunner extends Context.Tag("ModelRunner")<
  ModelRunner,
  {
    readonly complete: (params: {
      systemPrompt: string
      userMessage: string
    }) => Effect.Effect<string, ModelRunnerError>
  }
>() {}

/**
 * `ModelRunnerError` shape — matches grader.ts:50-58 exactly. Tagged for
 * Effect's typed error channel; constructs pattern-match on `reason`.
 */
export class ModelRunnerError {
  readonly _tag = "ModelRunnerError"
  constructor(
    readonly reason: "timeout" | "rate-limit" | "invalid-input" | "unknown",
    readonly message: string,
  ) {}
}

// ── Layer factory ───────────────────────────────────────────────────

/**
 * Minimal model invocation port. Production wires up `ChevalModelAdapter`
 * (which implements ModelPortBase from src/hounfour/types.ts). Tests inject
 * a mock that returns canned `CompletionResult`.
 *
 * Decoupled from `ChevalInvoker` (the lower-level subprocess wrapper) so
 * the Layer doesn't need HMAC config + provider config + retry config —
 * those belong to the adapter.
 */
export interface ModelInvoker {
  complete(request: CompletionRequest): Promise<CompletionResult>
}

export interface BuildModelRunnerLayerOptions {
  /** Injected invoker. Production: ChevalModelAdapter instance. Tests: mock. */
  invoker: ModelInvoker
  /** Model identifier (e.g., "claude-sonnet-4-6"). */
  modelId: string
  /** Agent identifier for billing + tracing. */
  agentId: string
  /** Tenant identifier (per-pool scoping). */
  tenantId: string
  /** Optional max_tokens override. Default 4096. */
  maxTokens?: number
  /** Optional temperature override. Default 0.2. */
  temperature?: number
  /** Trace ID generator. Default: crypto.randomUUID. */
  traceIdGen?: () => string
}

export const buildModelRunnerLayer = (opts: BuildModelRunnerLayerOptions): Layer.Layer<ModelRunner> =>
  Layer.succeed(ModelRunner, {
    complete: ({ systemPrompt, userMessage }) =>
      Effect.tryPromise({
        try: async () => {
          const traceId = (opts.traceIdGen ?? cryptoRandomUUID)()
          const request: CompletionRequest = {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
            options: {
              temperature: opts.temperature ?? 0.2,
              max_tokens: opts.maxTokens ?? 4096,
            },
            metadata: {
              agent: opts.agentId,
              tenant_id: opts.tenantId,
              nft_id: "",
              trace_id: traceId,
            },
          }
          const result = await opts.invoker.complete(request)
          return result.content
        },
        catch: (cause) => mapErrorToModelRunnerError(cause),
      }),
  })

// ── Error mapping ───────────────────────────────────────────────────

/**
 * Map an arbitrary thrown value (HounfourError, ChevalError, generic Error,
 * or anything else) into the construct-facing `ModelRunnerError` shape with
 * a reason in {"timeout", "rate-limit", "invalid-input", "unknown"}.
 */
export function mapErrorToModelRunnerError(cause: unknown): ModelRunnerError {
  if (cause instanceof Error) {
    const codeProp = (cause as Error & { code?: unknown }).code
    const code = typeof codeProp === "string" ? codeProp : ""
    const message = cause.message ?? String(cause)

    // Timeout patterns: HounfourError code prefix or message hints
    if (
      code === "TOOL_CALL_WALL_TIME_EXCEEDED" ||
      /timeout|timed out/i.test(message)
    ) {
      return new ModelRunnerError("timeout", message)
    }
    // Rate-limit patterns
    if (
      code === "BUDGET_EXCEEDED" ||
      code === "TOOL_CALL_LIMIT_EXCEEDED" ||
      /rate.?limit|too many requests|429/i.test(message)
    ) {
      return new ModelRunnerError("rate-limit", message)
    }
    // Validation patterns
    if (
      code === "CAPABILITY_MISMATCH" ||
      code === "CONFIG_INVALID" ||
      code === "BINDING_INVALID" ||
      /invalid|validation/i.test(message)
    ) {
      return new ModelRunnerError("invalid-input", message)
    }
    return new ModelRunnerError("unknown", message)
  }
  return new ModelRunnerError("unknown", String(cause))
}

// ── Helpers ─────────────────────────────────────────────────────────

const cryptoRandomUUID = (): string => randomUUID()
