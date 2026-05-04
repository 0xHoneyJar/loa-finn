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
import { Context, Effect, Layer, ManagedRuntime } from "effect"

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
  modPath: string
  exportName: string
  input: unknown
  runtimeOpts: { agentId: string; tenantId: string; poolId: string; modelId: string; tier: string }
}

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
 * the result. ManagedRuntime cached by slug derived from modPath.
 */
export async function handleSubstrateInvoke(
  payload: SubstrateInvokePayload,
  port: Pick<MessagePort, "postMessage">,
): Promise<SubstrateInvokeResult | SubstrateInvokeFailure> {
  try {
    const slug = deriveSlugFromModPath(payload.modPath)

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

    const effect = (program as (input: unknown) => Effect.Effect<unknown, unknown, unknown>)(payload.input)
    const result = await runtime.runPromise(effect as Effect.Effect<unknown, unknown, never>)
    return { ok: true, result }
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
  return ManagedRuntime.make(layer)
}

function buildBridgeModelRunnerLayer(port: Pick<MessagePort, "postMessage">): Layer.Layer<ModelRunnerTag> {
  return Layer.succeed(ModelRunnerTag, {
    complete: ({ systemPrompt, userMessage }) =>
      Effect.tryPromise({
        try: async () => {
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
 * Derive a slug from a modPath. Used as the runtime cache key. The actual slug
 * lives in the construct's manifest (loader has it), but the worker doesn't
 * have the manifest — it just knows modPath. Two constructs with the same
 * modPath share a cached runtime, which is correct.
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
