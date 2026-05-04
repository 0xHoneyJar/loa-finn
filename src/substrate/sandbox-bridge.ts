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
  let cachedStream: EventStream | null = null

  const getStream = (): EventStream => {
    if (!cachedStream) cachedStream = registerEventStream(streamName)
    return cachedStream
  }

  // Single dedicated worker for sprint-5. Multi-worker pool is a follow-up.
  const worker = new Worker(opts.workerScript, opts.workerOptions)
  let shutdownRequested = false

  // Map of in-flight top-level invoke jobIds → resolvers
  type InvokeResolver = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  const inFlight = new Map<string, InvokeResolver>()

  worker.on("message", async (msg: unknown) => {
    if (!isObj(msg) || typeof msg.type !== "string") return

    switch (msg.type) {
      case "result": {
        const jobId = String(msg.jobId)
        const pending = inFlight.get(jobId)
        if (!pending) return
        inFlight.delete(jobId)
        pending.resolve(msg.result)
        return
      }
      case "error": {
        const jobId = String(msg.jobId)
        const pending = inFlight.get(jobId)
        if (!pending) return
        inFlight.delete(jobId)
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
          worker.postMessage({
            type: "eventwriter.res",
            jobId,
            error: {
              _tag: "EventWriterError",
              reason: "append-failed",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          })
        }
        return
      }
    }
  })

  worker.on("error", (err) => {
    // Reject all in-flight invocations
    for (const [, pending] of inFlight) pending.reject(err)
    inFlight.clear()
  })

  worker.on("exit", (code) => {
    if (!shutdownRequested && code !== 0) {
      const err = new Error(`substrate worker exited unexpectedly with code ${code}`)
      for (const [, pending] of inFlight) pending.reject(err)
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
      return new Promise((resolve, reject) => {
        inFlight.set(jobId, { resolve, reject })
        worker.postMessage({
          type: "substrate-invoke",
          jobId,
          modPath: loaded.entryPath,
          exportName,
          input,
          runtimeOpts,
        })
      })
    },

    dispose(slug): void {
      worker.postMessage({ type: "dispose-runtime", slug })
    },

    async shutdown(): Promise<void> {
      shutdownRequested = true
      for (const [, pending] of inFlight) {
        pending.reject(new Error("sandbox bridge shutdown"))
      }
      inFlight.clear()
      await worker.terminate()
    },

    inFlightCount: () => inFlight.size,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null
}
