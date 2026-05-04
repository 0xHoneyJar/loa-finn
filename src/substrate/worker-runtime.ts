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

import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { resolve, sep } from "node:path"
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
 *
 * INVARIANT (Bridgebuilder iter-2 #3): the `port` reference baked into the
 * runtime's bridge proxy Layers is the worker's `parentPort` — stable for
 * the worker's lifetime. If a future architecture rotates ports, the cache
 * must be invalidated (e.g., on port-change message). Currently we assume
 * single-port-per-worker; an assertion would catch any drift.
 */
const runtimeCache = new Map<string, ManagedRuntime.ManagedRuntime<unknown, never>>()

/**
 * Per-worker per-modPath module cache. Memoizes dynamic-import.
 *
 * BOUNDED LRU (Bridgebuilder iter-2 HIGH fix): without an eviction policy,
 * a parent posting many distinct modPath values would grow worker heap
 * without bound. Cap at MODULE_CACHE_MAX_ENTRIES; evict least-recently-used
 * on overflow. Also cleared per-slug on dispose-runtime — see
 * handleDisposeRuntime.
 */
const MODULE_CACHE_MAX_ENTRIES = 64
const moduleCache = new Map<string, Record<string, unknown>>()

/**
 * Per-worker per-modPath → slug reverse index. Used by handleDisposeRuntime
 * to evict module-cache entries that belong to a disposed slug. Populated
 * alongside moduleCache writes (keyed by modPath, value is the slug from
 * the substrate-invoke payload).
 */
const modulePathToSlug = new Map<string, string>()

/**
 * Per-worker allowlist of trusted prefix roots. modPath must start with
 * one of these to be admitted. Populated EXPLICITLY at worker startup via
 * `registerTrustedPacksDir()` — typically called from worker-entry.ts
 * reading `workerData.trustedPacksDirs` passed by the parent's
 * `makeSandboxBridge({ trustedPacksDirs: [...] })`.
 *
 * Bridgebuilder iter-3 HIGH fix: the previous lazy-trust-on-first-use
 * fallback (`if (size === 0) return true`) was a TOCTOU bypass — the
 * first attacker-controlled modPath would always be admitted AND
 * permanently registered. Default-deny is the only safe shape.
 */
const trustedModPathPrefixes = new Set<string>()

/**
 * Whether the worker has had any trusted prefixes registered. If false,
 * `isModPathTrusted` returns false for ALL paths — a startup misconfiguration
 * that the parent forgot to set `trustedPacksDirs` will now fail loud and
 * fast on the first invoke instead of silently admitting any path.
 */
function isModPathTrusted(modPath: string): boolean {
  if (trustedModPathPrefixes.size === 0) return false // default-deny
  for (const prefix of trustedModPathPrefixes) {
    if (modPath.startsWith(prefix)) return true
  }
  return false
}

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

/**
 * F17 (Bridgebuilder iter-1, MEDIUM): per-slug in-flight invoke counter.
 *
 * Closes the dispose-vs-invoke race: if `handleDisposeRuntime(slug)` is
 * called while a `handleSubstrateInvoke({slug, ...})` is mid-await on
 * `runtime.runPromiseExit`, the runtime would be disposed under the
 * in-flight Effect. Worker is single-threaded JS but async — there's a
 * microtask gap between cache lookup and runPromiseExit's settle.
 *
 * Pattern: increment before runPromiseExit, decrement in finally.
 * handleDisposeRuntime checks the counter; if > 0, defers dispose into
 * `pendingDispose` and the invoke's finally block triggers dispose when
 * the counter reaches 0. This is the "ref-count + drain" answer to the
 * "what happens when someone is using this resource right now?" question.
 */
const invokeInFlightCount = new Map<string, number>()
const pendingDispose = new Set<string>()

/**
 * AsyncLocalStorage threading the top-level invoke jobId through the
 * Effect program's bridge proxy calls (Bridgebuilder iter-2 #4).
 *
 * Without this, when a top-level `bridge.invoke` times out and the parent
 * cleans up its inFlight entry, any in-flight `modelrunner.req` from the
 * (now-dead-from-parent's-perspective) worker still triggers a real cheval
 * call — wasted resources. Threading the jobId lets the parent skip the
 * call when the originating invoke is no longer tracked.
 *
 * AsyncLocalStorage is the right primitive: it propagates context through
 * Effect's promise chains transparently, so the bridge proxy Layer factories
 * can read the active topLevelJobId at proxy-call time without explicit
 * plumbing through the Layer constructor.
 *
 * F1 (Bridgebuilder iter-1, HIGH) invariant — proven by
 * als-context-cached-runtime.test.ts: even though the bridge proxy Layers
 * are CACHED in runtimeCache (built ONCE per slug, reused across many
 * invokes), the Promise chain from each invoke's
 * `invocationContext.run({ topLevelJobId }, async () => ... runPromiseExit)`
 * propagates the active ALS frame through Effect's internals to the
 * `invocationContext.getStore()` read inside the cached Layer's
 * `Effect.tryPromise`. Two sequential invokes with different topLevelJobIds
 * against the same cached runtime correctly read distinct topLevelJobIds.
 *
 * The invariant relies on:
 *  1. Effect's runPromiseExit returning a Promise that resolves through the
 *     invoking ALS frame (true in effect@3.10.x — verified by the test).
 *  2. The bridge proxy reading getStore() AT proxy-call time (true: the
 *     getStore() call is inside the `try` block of Effect.tryPromise, which
 *     runs only when the proxy is invoked, NOT at Layer construction time).
 *
 * If either invariant breaks (e.g., effect rev that schedules tryPromise
 * outside the originating ALS frame, OR refactor that hoists getStore()
 * into the Layer factory), the regression test will fail loud.
 */
const invocationContext = new AsyncLocalStorage<{ topLevelJobId: string }>()

// ── Public API for sandbox-worker.ts to delegate to ─────────────────

export interface SubstrateInvokePayload {
  /**
   * Top-level invoke jobId from the parent. Threaded via AsyncLocalStorage
   * into bridge proxy requests so the parent can skip stale modelrunner.req
   * / eventwriter.req calls when the originating invoke has already settled
   * (Bridgebuilder iter-2 #4).
   */
  jobId: string
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
  // Wrap the entire invocation in AsyncLocalStorage so bridge proxy Layers
  // can read the top-level jobId at proxy-call time (Bridgebuilder iter-2 #4).
  return await invocationContext.run({ topLevelJobId: payload.jobId }, async () => {
  try {
    const slug = payload.slug

    // Worker-side path containment (Bridgebuilder iter-2 #2 + iter-3 HIGH +
    // iter-6 MEDIUM canonicalization fix). Default-deny: trustedPacksDirs MUST
    // be pre-registered via worker-entry's setup-from-workerData.
    //
    // Canonicalize BEFORE trust check (iter-6 MEDIUM): otherwise
    // `/trusted/packs/../../../etc/evil.mjs` could survive the prefix check
    // (raw path starts with /trusted/packs/ but resolves to /etc/evil.mjs).
    // pathToFileURL doesn't normalize; Node's module loader resolves at
    // import time. resolve() collapses .. segments. Realpath would catch
    // symlinks too, but we accept its file-must-exist requirement only when
    // the file actually exists (otherwise resolve()-only check is fine).
    let canonicalModPath: string
    try {
      canonicalModPath = realpathSync(resolve(payload.modPath))
    } catch {
      // File doesn't exist — fall back to logical resolution. Trust check
      // still runs against the resolved (.. collapsed) path.
      canonicalModPath = resolve(payload.modPath)
    }
    if (!isModPathTrusted(canonicalModPath)) {
      return {
        ok: false,
        error: {
          _tag: "ModPathTrustError",
          message: trustedModPathPrefixes.size === 0
            ? `worker has no trustedPacksDirs registered — pass via workerData.trustedPacksDirs at Worker construction`
            : `worker rejected modPath outside trusted prefixes: ${payload.modPath} (resolved: ${canonicalModPath})`,
        },
      }
    }

    // Get or create runtime for this slug
    let runtime = runtimeCache.get(slug)
    if (!runtime) {
      runtime = createRuntimeForSlug(payload, port)
      runtimeCache.set(slug, runtime)
    }

    // Resolve program (memoized via bounded LRU moduleCache).
    // KEY by canonicalModPath (NOT raw payload.modPath) so the trust check
    // and the cache key + import use the same path identity. Without this
    // alignment the iter-6 canonicalization fix would have a TOCTOU gap.
    let mod = moduleCache.get(canonicalModPath)
    if (mod) {
      // LRU touch: re-insert moves to end of Map iteration order (most-recent)
      moduleCache.delete(canonicalModPath)
      moduleCache.set(canonicalModPath, mod)
    } else {
      mod = (await import(pathToFileURL(canonicalModPath).href)) as Record<string, unknown>
      // Evict LRU if at capacity (Bridgebuilder iter-2 HIGH fix).
      // SAFETY: worker_threads are single-threaded JavaScript runtimes — no
      // concurrent handleSubstrateInvoke calls can interleave between the
      // delete + set below (Bridgebuilder iter-5 HIGH documentation fix).
      // If this code is ever lifted into a multi-thread/process pool, the
      // delete+set sequence MUST be guarded by an async mutex.
      if (moduleCache.size >= MODULE_CACHE_MAX_ENTRIES) {
        const oldestKey = moduleCache.keys().next().value
        if (oldestKey !== undefined) {
          moduleCache.delete(oldestKey)
          modulePathToSlug.delete(oldestKey)
        }
      }
      moduleCache.set(canonicalModPath, mod)
      modulePathToSlug.set(canonicalModPath, slug)
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
    //
    // F17 (Bridgebuilder iter-1, MEDIUM): bracket runPromiseExit with
    // in-flight counter increment/decrement so handleDisposeRuntime can
    // see if invokes are in progress for this slug. Decrement happens in
    // the finally block AFTER runPromiseExit settles; if a dispose was
    // deferred for this slug, drain it now.
    invokeInFlightCount.set(slug, (invokeInFlightCount.get(slug) ?? 0) + 1)
    const effect = (program as (input: unknown) => Effect.Effect<unknown, unknown, unknown>)(payload.input)
    let exit
    try {
      exit = await runtime.runPromiseExit(effect as Effect.Effect<unknown, unknown, never>)
    } finally {
      const after = (invokeInFlightCount.get(slug) ?? 1) - 1
      if (after <= 0) {
        invokeInFlightCount.delete(slug)
        if (pendingDispose.has(slug)) {
          pendingDispose.delete(slug)
          await disposeRuntimeNow(slug)
        }
      } else {
        invokeInFlightCount.set(slug, after)
      }
    }

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
  })
}

/**
 * Drop a cached runtime. Called from `dispose-runtime` envelope handler in
 * sandbox-worker.ts. Idempotent; missing slug is a no-op.
 *
 * Bridgebuilder iter-2 HIGH fix: also evicts module-cache entries belonging
 * to this slug (the modulePathToSlug reverse index lets us find them).
 * Without this, a long-running worker that disposed/reloaded a construct
 * many times would still hold every old module instance forever.
 *
 * F17 (Bridgebuilder iter-1, MEDIUM): if invokes are in flight for this
 * slug, defer the dispose. The invoke's finally block will trigger
 * disposeRuntimeNow when the counter reaches zero. Dispose-runtime is
 * fire-and-forget from the parent (sandbox-bridge.ts:357 worker.postMessage
 * with no return path), so callers don't observe deferral — they just get
 * eventual consistency. Without this, the invoke could run against a
 * disposed runtime, with confusing failure modes (e.g. "stove turned off
 * mid-recipe").
 */
export async function handleDisposeRuntime(slug: string): Promise<void> {
  if ((invokeInFlightCount.get(slug) ?? 0) > 0) {
    pendingDispose.add(slug)
    return
  }
  await disposeRuntimeNow(slug)
}

async function disposeRuntimeNow(slug: string): Promise<void> {
  const runtime = runtimeCache.get(slug)
  if (runtime) {
    await runtime.dispose()
    runtimeCache.delete(slug)
  }
  // Bridgebuilder iter-4 HIGH fix: collect keys to delete in a separate
  // pass before mutating. Avoids iterator-mutation interaction with any
  // concurrent handleSubstrateInvoke that might be writing to
  // modulePathToSlug between iteration steps. (Map.delete during for...of
  // is spec-safe per ECMA-262 but the concurrent-write case is subtler.)
  const keysToEvict: string[] = []
  for (const [modPath, mappedSlug] of modulePathToSlug) {
    if (mappedSlug === slug) keysToEvict.push(modPath)
  }
  for (const modPath of keysToEvict) {
    moduleCache.delete(modPath)
    modulePathToSlug.delete(modPath)
  }
}

/**
 * Pre-register a trusted packs directory at worker startup for stricter
 * modPath containment than the lazy-on-first-use registration. Called by
 * operators wiring up the worker via a setup message before the first
 * substrate-invoke.
 *
 * Canonicalizes via realpath if the dir exists (resolves /tmp →
 * /private/tmp on macOS, follows symlinks, etc.) so the trust check
 * comparison operates on the same path identity as the canonicalized
 * modPath at invoke time. Iter-6 fix completion: without this, the
 * canonicalization in handleSubstrateInvoke would silently bypass any
 * raw-path trust prefix.
 */
export function registerTrustedPacksDir(dir: string): void {
  let canonical: string
  try {
    canonical = realpathSync(resolve(dir))
  } catch {
    canonical = resolve(dir)
  }
  trustedModPathPrefixes.add(canonical.endsWith(sep) ? canonical : canonical + sep)
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
  // F17: also reset in-flight counters and pending-dispose set.
  invokeInFlightCount.clear()
  pendingDispose.clear()
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
          // Thread top-level jobId via AsyncLocalStorage so parent can skip
          // stale modelrunner.req calls (Bridgebuilder iter-2 #4).
          const ctx = invocationContext.getStore()
          const topLevelJobId = ctx?.topLevelJobId
          const response = await new Promise<unknown>((resolve, reject) => {
            pendingBridgeRequests.set(subJobId, { resolve, reject })
            port.postMessage({
              type: "modelrunner.req",
              jobId: subJobId,
              topLevelJobId,
              completionRequest,
            })
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
          // Thread top-level jobId for parent-side stale-invoke skip (Bridgebuilder iter-2 #4).
          const ctx = invocationContext.getStore()
          const topLevelJobId = ctx?.topLevelJobId
          await new Promise<unknown>((resolve, reject) => {
            pendingBridgeRequests.set(subJobId, { resolve, reject })
            port.postMessage({
              type: "eventwriter.req",
              jobId: subJobId,
              topLevelJobId,
              envelope,
            })
          })
        },
        catch: (cause) =>
          cause instanceof EventWriterErrorWire
            ? cause
            : new EventWriterErrorWire("unknown", cause instanceof Error ? cause.message : String(cause)),
      }),
  })
}

// (Removed `deriveSlugFromModPath` per Bridgebuilder iter-2 LOW finding —
//  the canonical manifest slug is now carried in `SubstrateInvokePayload.slug`
//  and the fallback heuristic was unreachable dead code.)
