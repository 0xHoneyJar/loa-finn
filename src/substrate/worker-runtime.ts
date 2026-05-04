// src/substrate/worker-runtime.ts — Worker-side substrate-construct executor.
//
// Cycle-032 Sprint-5. See PRD FR-5 + SDD §4.8.
//
// Runs INSIDE a worker_thread. Owns:
//   - per-worker per-construct ManagedRuntime cache
//   - module cache (memoized dynamic-import)
//   - bridge proxies for ModelRunner + EventWriter (postMessage to parent)
//   - jobId-correlated async response handlers for proxy responses
//
// This is the only file in the substrate module that imports Effect AND runs
// inside a worker. `src/agent/sandbox-worker.ts` (the existing worker) gets a
// thin handler that delegates substrate-invoke envelopes here.
//
// PROTOCOL (per PRD FR-5 bridge serialization contract — structured-clone-safe,
// NOT JSON):
//
//   Parent → Worker:
//     { type: "substrate-invoke", jobId, modPath, exportName, input, runtimeOpts }
//     { type: "modelrunner.res", jobId, result } | { type: "modelrunner.res", jobId, error }
//     { type: "eventwriter.res", jobId, result } | { type: "eventwriter.res", jobId, error }
//     { type: "dispose-runtime", slug }
//
//   Worker → Parent:
//     { type: "result", jobId, result } | { type: "error", jobId, error }
//     { type: "modelrunner.req", jobId, completionRequest }
//     { type: "eventwriter.req", jobId, envelope }

import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import type { MessagePort } from "node:worker_threads"
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Option } from "effect"

// Re-declare the cross-pack contract Tags here. Effect's Tag identity is by
// string ("ModelRunner" / "EventWriter") so this matches the construct's
// declarations regardless of which Tag class is imported.
class ModelRunnerTag extends Context.Tag("ModelRunner")<
  ModelRunnerTag,
  {
    readonly complete: (params: {
      systemPrompt: string
      userMessage: string
    }) => Effect.Effect<string, ModelRunnerErrorWire>
  }
>() {}

class EventWriterTag extends Context.Tag("EventWriter")<
  EventWriterTag,
  {
    readonly publish: (subject: string, payload: unknown) => Effect.Effect<void, EventWriterErrorWire>
  }
>() {}

// Wire shapes (structured-clone-safe — no class instances, no closures).
// Construct-side ModelRunnerError pattern matches via _tag === "ModelRunnerError".
class ModelRunnerErrorWire {
  readonly _tag = "ModelRunnerError"
  constructor(
    readonly reason: "timeout" | "rate-limit" | "invalid-input" | "unknown",
    readonly message: string,
  ) {}
}

class EventWriterErrorWire {
  readonly _tag = "EventWriterError"
  constructor(
    readonly reason: "invalid-subject" | "append-failed" | "unknown",
    readonly message: string,
  ) {}
}

// ── Worker-side state (per-worker singletons) ───────────────────────

/**
 * Per-worker per-slug ManagedRuntime cache. Lives for worker lifetime,
 * dropped on dispose-runtime envelope from parent.
 */
const runtimeCache = new Map<string, ManagedRuntime.ManagedRuntime<unknown, never>>()

/**
 * Per-worker per-modPath module cache. Memoizes dynamic-import.
 */
const moduleCache = new Map<string, Record<string, unknown>>()

/**
 * Pending bridge response handlers, keyed by request jobId.
 * When the worker emits modelrunner.req with sub-jobId X, it adds an entry
 * here that resolves when modelrunner.res for X arrives back from parent.
 */
type PendingResolvers = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}
const pendingBridgeRequests = new Map<string, PendingResolvers>()

// ── Public API for sandbox-worker.ts to delegate to ─────────────────

export interface SubstrateInvokePayload {
  /**
   * Canonical construct slug from the manifest (parent-side loader). Used as
   * the per-worker runtime cache key. Bridgebuilder-fix: replaces the prior
   * `deriveSlugFromModPath` heuristic which collapsed dist/src/lib path
   * segments and could collide across packs (e.g., two `grader/` dirs).
   */
  slug: string
  modPath: string
  exportName: string
  input: unknown
  runtimeOpts: { agentId: string; tenantId: string; poolId: string; modelId: string; tier: string }
}

/**
 * Maximum concurrent in-flight bridge proxy requests (modelrunner.req +
 * eventwriter.req combined). Bridgebuilder-fix: prevents a misbehaving
 * construct from flooding the parent with thousands of concurrent calls
 * (the "polite knocker" problem). When at cap, new proxy requests reject
 * with a typed rate-limit error.
 */
const MAX_CONCURRENT_BRIDGE_REQUESTS = 32

export interface SubstrateInvokeResult {
  ok: true
  result: unknown
}

export interface SubstrateInvokeFailure {
  ok: false
  error: { _tag: string; reason?: string; message: string }
}

/**
 * Handle a substrate-invoke envelope. Composes the Layer with bridge proxies
 * for ModelRunner + EventWriter, runs the construct's Effect program, returns
 * the result.
 *
 * Per-worker per-slug ManagedRuntime cache: lookup by `payload.slug` (the
 * canonical manifest slug from the loader, NOT a path heuristic). Effect
 * Exit-channel inspection (Bridgebuilder-fix) preserves the construct's
 * typed error shape — `ModelRunnerError`, `EventWriterError`, or any other
 * construct-declared error class with `_tag` — back across the worker
 * boundary as a structured error envelope.
 */
export async function handleSubstrateInvoke(
  payload: SubstrateInvokePayload,
  port: Pick<MessagePort, "postMessage">,
): Promise<SubstrateInvokeResult | SubstrateInvokeFailure> {
  try {
    const slug = payload.slug

    // Get or create runtime for this slug
    let runtime = runtimeCache.get(slug)
    if (!runtime) {
      runtime = createRuntimeForSlug(payload, port)
      runtimeCache.set(slug, runtime)
    }

    // Resolve program (memoized via moduleCache)
    let mod = moduleCache.get(payload.modPath)
    if (!mod) {
      mod = (await import(pathToFileURL(payload.modPath).href)) as Record<string, unknown>
      moduleCache.set(payload.modPath, mod)
    }

    const program = mod[payload.exportName]
    if (typeof program !== "function") {
      return {
        ok: false,
        error: {
          _tag: "ProgramResolutionError",
          message: `export "${payload.exportName}" in ${payload.modPath} is not a callable function`,
        },
      }
    }

    // Use runPromiseExit (NOT runPromise) so we can inspect the Effect's
    // typed Exit channel and preserve the construct's typed error shape
    // when the Effect fails. runPromise force-casts the error channel to
    // `never` and surfaces failures as untyped rejections — Bridgebuilder
    // flagged this as a Medium quality issue at cycle-032.
    const effect = (program as (input: unknown) => Effect.Effect<unknown, unknown, unknown>)(payload.input)
    const exit = await runtime.runPromiseExit(effect as Effect.Effect<unknown, unknown, never>)

    if (Exit.isSuccess(exit)) {
      return { ok: true, result: exit.value }
    }

    // Failure: extract typed error from Cause if present
    const failureOpt = Cause.failureOption(exit.cause)
    if (Option.isSome(failureOpt)) {
      const e = failureOpt.value
      if (e !== null && typeof e === "object" && "_tag" in e) {
        const typed = e as { _tag: unknown; reason?: unknown; message?: unknown }
        return {
          ok: false,
          error: {
            _tag: String(typed._tag ?? "ConstructError"),
            reason: typeof typed.reason === "string" ? typed.reason : undefined,
            message: typeof typed.message === "string" ? typed.message : Cause.pretty(exit.cause),
          },
        }
      }
      return {
        ok: false,
        error: { _tag: "ConstructError", message: typeof e === "string" ? e : JSON.stringify(e) },
      }
    }

    // Defect path (uncaught throw inside the Effect). Use Cause.pretty for
    // best-effort diagnostic context — this is the path that wakes someone
    // at 3am, so verbose is correct.
    return {
      ok: false,
      error: { _tag: "WorkerCrash", message: Cause.pretty(exit.cause) },
    }
  } catch (cause) {
    return {
      ok: false,
      error: {
        _tag: "InvokeError",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    }
  }
}

/**
 * Drop a cached runtime. Called from `dispose-runtime` envelope handler in
 * sandbox-worker.ts. Idempotent; missing slug is a no-op.
 */
export async function handleDisposeRuntime(slug: string): Promise<void> {
  const runtime = runtimeCache.get(slug)
  if (!runtime) return
  await runtime.dispose()
  runtimeCache.delete(slug)
}

/**
 * Resolve a pending bridge response. Called from sandbox-worker.ts when
 * `modelrunner.res` or `eventwriter.res` arrives from parent.
 */
export function handleBridgeResponse(jobId: string, payload: { result?: unknown; error?: unknown }): void {
  const pending = pendingBridgeRequests.get(jobId)
  if (!pending) return // late response or already resolved; drop
  pendingBridgeRequests.delete(jobId)
  if (payload.error !== undefined) {
    pending.reject(payload.error)
  } else {
    pending.resolve(payload.result)
  }
}

/**
 * Visible for tests: clear all caches. Lets unit tests start with a clean slate.
 */
export function _clearWorkerRuntimeCaches(): void {
  runtimeCache.clear()
  moduleCache.clear()
  // Reject pending bridge requests (test cleanup)
  for (const [, pending] of pendingBridgeRequests) {
    pending.reject(new Error("worker runtime caches cleared"))
  }
  pendingBridgeRequests.clear()
}

/**
 * Visible for tests: stats on worker-side caches.
 */
export function _getWorkerRuntimeStats(): { runtimes: number; modules: number; pendingBridge: number } {
  return {
    runtimes: runtimeCache.size,
    modules: moduleCache.size,
    pendingBridge: pendingBridgeRequests.size,
  }
}

// ── Layer composition (worker-side) ─────────────────────────────────

function createRuntimeForSlug(
  payload: SubstrateInvokePayload,
  port: Pick<MessagePort, "postMessage">,
): ManagedRuntime.ManagedRuntime<unknown, never> {
  const modelRunnerLayer = buildBridgeModelRunnerLayer(port)
  const eventWriterLayer = buildBridgeEventWriterLayer(port)
  const layer = Layer.mergeAll(modelRunnerLayer, eventWriterLayer)
  // ManagedRuntime.make narrows to the layer's exact service union; the cache
  // erases that to ManagedRuntime<unknown, never> for the per-slug Map.
  return ManagedRuntime.make(layer) as unknown as ManagedRuntime.ManagedRuntime<unknown, never>
}

function buildBridgeModelRunnerLayer(port: Pick<MessagePort, "postMessage">): Layer.Layer<ModelRunnerTag> {
  return Layer.succeed(ModelRunnerTag, {
    complete: ({ systemPrompt, userMessage }) =>
      Effect.tryPromise({
        try: async () => {
          // Backpressure: cap concurrent bridge proxy requests per worker.
          // Bridgebuilder-fix prevents a runaway construct from flooding the
          // parent with thousands of cheval calls simultaneously.
          if (pendingBridgeRequests.size >= MAX_CONCURRENT_BRIDGE_REQUESTS) {
            throw new ModelRunnerErrorWire(
              "rate-limit",
              `worker bridge backpressure: ${pendingBridgeRequests.size} concurrent requests exceeds cap ${MAX_CONCURRENT_BRIDGE_REQUESTS}`,
            )
          }
          const subJobId = randomUUID()
          const completionRequest = {
            messages: [
              { role: "system" as const, content: systemPrompt },
              { role: "user" as const, content: userMessage },
            ],
            options: { temperature: 0.2, max_tokens: 4096 },
            metadata: { agent: "", tenant_id: "", nft_id: "", trace_id: subJobId },
          }
          const response = await new Promise<unknown>((resolve, reject) => {
            pendingBridgeRequests.set(subJobId, { resolve, reject })
            port.postMessage({ type: "modelrunner.req", jobId: subJobId, completionRequest })
          })
          // Response shape: { text: string }
          const r = response as { text?: string }
          if (typeof r.text !== "string") {
            throw new ModelRunnerErrorWire("invalid-input", "modelrunner.res missing text field")
          }
          return r.text
        },
        catch: (cause) =>
          cause instanceof ModelRunnerErrorWire
            ? cause
            : new ModelRunnerErrorWire("unknown", cause instanceof Error ? cause.message : String(cause)),
      }),
  })
}

function buildBridgeEventWriterLayer(port: Pick<MessagePort, "postMessage">): Layer.Layer<EventWriterTag> {
  return Layer.succeed(EventWriterTag, {
    publish: (subject, payload) =>
      Effect.tryPromise({
        try: async () => {
          // Backpressure (same shape as ModelRunner): cap concurrent bridge proxy requests.
          if (pendingBridgeRequests.size >= MAX_CONCURRENT_BRIDGE_REQUESTS) {
            throw new EventWriterErrorWire(
              "unknown",
              `worker bridge backpressure: ${pendingBridgeRequests.size} concurrent requests exceeds cap ${MAX_CONCURRENT_BRIDGE_REQUESTS}`,
            )
          }
          const subJobId = randomUUID()
          const envelope = { subject, payload }
          await new Promise<unknown>((resolve, reject) => {
            pendingBridgeRequests.set(subJobId, { resolve, reject })
            port.postMessage({ type: "eventwriter.req", jobId: subJobId, envelope })
          })
        },
        catch: (cause) =>
          cause instanceof EventWriterErrorWire
            ? cause
            : new EventWriterErrorWire("unknown", cause instanceof Error ? cause.message : String(cause)),
      }),
  })
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * @deprecated as of cycle-032 Bridgebuilder fix — payload now carries the
 * canonical manifest slug as `payload.slug`. This function is retained for
 * one cycle as a compatibility fallback only.
 */
function deriveSlugFromModPath(modPath: string): string {
  // Last directory segment before the entry file is a reasonable slug proxy
  // (e.g., "/.../packs/lore-essay-grader/dist/index.js" → "lore-essay-grader").
  const segments = modPath.split(/[/\\]/)
  for (let i = segments.length - 2; i >= 0; i--) {
    const seg = segments[i]
    if (seg && seg !== "dist" && seg !== "src" && seg !== "lib" && !seg.endsWith(".js")) {
      return seg
    }
  }
  return modPath // fallback: full path
}
