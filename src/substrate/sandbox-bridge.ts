// src/substrate/sandbox-bridge.ts — Parent-side substrate-construct dispatcher.
//
// Cycle-032 Sprint-5. See PRD FR-5 + SDD §4.7.
//
// PARENT-side. NO Effect imports (parent stays Promise-based per PRD §4 BARTH cut).
// Owns:
//   - Worker(s) running sandbox-worker.ts (or a substrate-specific entry)
//   - Bridge response handlers: when worker sends modelrunner.req → call cheval
//     adapter → post modelrunner.res back. Same for eventwriter.req.
//   - bridgeInvoke(loaded, runtimeOpts, input) public API
//   - dispose-runtime broadcast (called when JWT TTL expires or config reload)
//
// Architecture note — divergence from existing WorkerPool:
// Sprint-5 ships a SEPARATE substrate worker pool (not modifying existing
// `src/agent/worker-pool.ts`). The PRD FR-5 acceptance test mentions running
// in the "interactive lane (worker 1 or 2 occupied)" — that integration with
// the existing pool's lane scheduling is a follow-up sprint. For sprint-5,
// the bridge mechanism + worker-runtime.ts are the load-bearing primitives;
// pool integration is purely a lifecycle-management concern that doesn't
// change the API.

import { randomUUID } from "node:crypto"
import { Worker, type WorkerOptions } from "node:worker_threads"
import type { LoadedConstruct } from "./types.js"
import type { ModelInvoker } from "./model-runner-layer.js"
import { mapErrorToModelRunnerError } from "./model-runner-layer.js"
import type { EventWriter as EventStoreWriter } from "../events/writer.js"
import { registerEventStream, type EventStream } from "../events/types.js"

// ── Public surface ──────────────────────────────────────────────────

export interface RuntimeOpts {
  agentId: string
  tenantId: string
  poolId: string
  modelId: string
  tier: string
}

export interface BridgeLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void
  warn: (msg: string, ctx?: Record<string, unknown>) => void
  error: (msg: string, ctx?: Record<string, unknown>) => void
}

const NOOP_LOGGER: BridgeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface SandboxBridgeOptions {
  /** Path to the worker entry script (compiled .js or .mjs). */
  workerScript: string
  /** Worker options (env, resourceLimits, etc.) to pass through. */
  workerOptions?: WorkerOptions
  /** Bridge handler for ModelRunner proxy requests. Wraps cheval-invoker in production. */
  modelInvoker: ModelInvoker
  /** Bridge handler for EventWriter proxy requests. Wraps EventStore in production. */
  eventWriter: EventStoreWriter
  /** Stream name for substrate-emitted events. Default: "substrate_invocations". */
  streamName?: string
  /**
   * Per-invocation timeout in milliseconds. If `bridge.invoke()` doesn't see
   * a `result` envelope from the worker within this window, the Promise
   * rejects and the inFlight entry is freed. Defaults to 60_000 (60s).
   * Set to 0 to disable (NOT recommended for production — see Bridgebuilder
   * review HIGH finding on cycle-032).
   */
  invokeTimeoutMs?: number
  /**
   * Optional structured logger. Defaults to a no-op. Production wires up
   * pi-coding-agent's logger or similar. Used for: invoke start/end with
   * jobId+slug, bridge errors, worker exits, dispose calls, stray messages.
   */
  logger?: BridgeLogger
}

export interface SandboxBridge {
  /** Run a construct's program inside a worker_thread sandbox via the bridge. */
  invoke(loaded: LoadedConstruct, runtimeOpts: RuntimeOpts, input: unknown): Promise<unknown>
  /** Broadcast dispose-runtime to all workers; drops the cached ManagedRuntime for this slug. */
  dispose(slug: string): void
  /** Tear down all workers + reject pending invocations. */
  shutdown(): Promise<void>
  /** Visible-for-tests: number of in-flight invocations. */
  inFlightCount(): number
}

export function makeSandboxBridge(opts: SandboxBridgeOptions): SandboxBridge {
  const streamName = opts.streamName ?? "substrate_invocations"
  const invokeTimeoutMs = opts.invokeTimeoutMs ?? 60_000
  const logger = opts.logger ?? NOOP_LOGGER
  let cachedStream: EventStream | null = null

  const getStream = (): EventStream => {
    if (!cachedStream) cachedStream = registerEventStream(streamName)
    return cachedStream
  }

  // Single dedicated worker for sprint-5. Multi-worker pool is a follow-up.
  const worker = new Worker(opts.workerScript, opts.workerOptions)
  let shutdownRequested = false

  // Map of in-flight top-level invoke jobIds → resolvers (with timeout cleanup)
  type InvokeResolver = {
    resolve: (v: unknown) => void
    reject: (e: unknown) => void
    /** Cleared on resolve/reject — prevents the timeout from firing afterward. */
    timer: ReturnType<typeof setTimeout> | null
    slug: string
  }
  const inFlight = new Map<string, InvokeResolver>()

  worker.on("message", async (msg: unknown) => {
    if (!isObj(msg) || typeof msg.type !== "string") {
      logger.warn("substrate-bridge: dropped malformed worker message", { msg })
      return
    }

    switch (msg.type) {
      case "result": {
        const jobId = String(msg.jobId)
        const pending = inFlight.get(jobId)
        if (!pending) {
          logger.warn("substrate-bridge: stray result envelope (no in-flight match)", { jobId })
          return
        }
        if (pending.timer) clearTimeout(pending.timer)
        inFlight.delete(jobId)
        logger.info("substrate-bridge: invoke resolved", { jobId, slug: pending.slug })
        pending.resolve(msg.result)
        return
      }
      case "error": {
        const jobId = String(msg.jobId)
        const pending = inFlight.get(jobId)
        if (!pending) {
          logger.warn("substrate-bridge: stray error envelope (no in-flight match)", { jobId })
          return
        }
        if (pending.timer) clearTimeout(pending.timer)
        inFlight.delete(jobId)
        logger.warn("substrate-bridge: invoke rejected by worker", { jobId, slug: pending.slug, error: msg.error })
        pending.reject(msg.error)
        return
      }
      case "modelrunner.req": {
        // Worker is asking us to invoke cheval; respond with text or error
        const jobId = String(msg.jobId)
        const completionRequest = msg.completionRequest
        try {
          const result = await opts.modelInvoker.complete(completionRequest as never)
          worker.postMessage({ type: "modelrunner.res", jobId, result: { text: result.content } })
        } catch (cause) {
          const wireError = mapErrorToModelRunnerError(cause)
          logger.warn("substrate-bridge: modelrunner proxy failed", { jobId, reason: wireError.reason, message: wireError.message })
          worker.postMessage({
            type: "modelrunner.res",
            jobId,
            error: { _tag: wireError._tag, reason: wireError.reason, message: wireError.message },
          })
        }
        return
      }
      case "eventwriter.req": {
        const jobId = String(msg.jobId)
        const envelope = msg.envelope as { subject: string; payload: unknown } | undefined
        if (!envelope || typeof envelope.subject !== "string") {
          logger.warn("substrate-bridge: eventwriter envelope invalid", { jobId, envelope })
          worker.postMessage({
            type: "eventwriter.res",
            jobId,
            error: { _tag: "EventWriterError", reason: "invalid-subject", message: "missing or invalid envelope" },
          })
          return
        }
        try {
          await opts.eventWriter.append(getStream(), envelope.subject, envelope.payload, randomUUID())
          worker.postMessage({ type: "eventwriter.res", jobId, result: { ok: true } })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          logger.warn("substrate-bridge: eventwriter append failed", { jobId, subject: envelope.subject, message })
          worker.postMessage({
            type: "eventwriter.res",
            jobId,
            error: { _tag: "EventWriterError", reason: "append-failed", message },
          })
        }
        return
      }
      default: {
        logger.warn("substrate-bridge: unrecognized worker message type", { type: msg.type })
        return
      }
    }
  })

  worker.on("error", (err) => {
    // Reject all in-flight invocations
    logger.error("substrate-bridge: worker emitted error", { error: err.message })
    for (const [, pending] of inFlight) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(err)
    }
    inFlight.clear()
  })

  worker.on("exit", (code) => {
    if (!shutdownRequested && code !== 0) {
      logger.error("substrate-bridge: worker exited unexpectedly", { code })
      const err = new Error(`substrate worker exited unexpectedly with code ${code}`)
      for (const [, pending] of inFlight) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.reject(err)
      }
      inFlight.clear()
    }
  })

  return {
    invoke(loaded, runtimeOpts, input): Promise<unknown> {
      if (shutdownRequested) {
        return Promise.reject(new Error("sandbox bridge is shutting down"))
      }
      const jobId = randomUUID()
      const exportName = loaded.manifest.executable?.export
      if (!exportName) {
        return Promise.reject(new Error(`construct ${loaded.slug} has no executable.export`))
      }
      logger.info("substrate-bridge: invoke start", { jobId, slug: loaded.slug })
      return new Promise((resolve, reject) => {
        // Per-invocation timeout (Bridgebuilder HIGH finding fix). Without
        // this, a hung worker (deadlocked Effect, lost postMessage, parent
        // crash mid-bridge-proxy) would leak the inFlight entry forever.
        const timer = invokeTimeoutMs > 0
          ? setTimeout(() => {
              if (inFlight.delete(jobId)) {
                logger.error("substrate-bridge: invoke timed out", { jobId, slug: loaded.slug, invokeTimeoutMs })
                reject(new Error(`substrate invoke ${jobId} (slug=${loaded.slug}) timed out after ${invokeTimeoutMs}ms`))
              }
            }, invokeTimeoutMs)
          : null
        inFlight.set(jobId, { resolve, reject, timer, slug: loaded.slug })
        worker.postMessage({
          type: "substrate-invoke",
          jobId,
          slug: loaded.slug, // Bridgebuilder Medium fix: pass canonical slug for cache key
          modPath: loaded.entryPath,
          exportName,
          input,
          runtimeOpts,
        })
      })
    },

    dispose(slug): void {
      logger.info("substrate-bridge: dispose-runtime", { slug })
      worker.postMessage({ type: "dispose-runtime", slug })
    },

    async shutdown(): Promise<void> {
      logger.info("substrate-bridge: shutdown initiated", { inFlight: inFlight.size })
      shutdownRequested = true
      for (const [, pending] of inFlight) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.reject(new Error("sandbox bridge shutdown"))
      }
      inFlight.clear()
      await worker.terminate()
      logger.info("substrate-bridge: shutdown complete", {})
    },

    inFlightCount: () => inFlight.size,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null
}
