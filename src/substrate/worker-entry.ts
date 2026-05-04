// src/substrate/worker-entry.ts — Worker thread bootstrap for substrate-construct execution.
//
// Cycle-032 Sprint-5. Routes parentPort messages to worker-runtime.ts handlers.
//
// Production: this file is compiled to dist/substrate/worker-entry.js and used
// as the Worker script path passed to `makeSandboxBridge({ workerScript: ... })`.
//
// Per PRD §4 BARTH cut: src/agent/sandbox-worker.ts (the existing exec worker)
// stays Effect-free. Substrate gets its own worker entry that imports Effect
// via worker-runtime.ts.

import { parentPort, workerData } from "node:worker_threads"
import {
  handleSubstrateInvoke,
  handleDisposeRuntime,
  handleBridgeResponse,
  registerTrustedPacksDir,
  type SubstrateInvokePayload,
} from "./worker-runtime.js"

if (!parentPort) {
  throw new Error("substrate worker-entry must be run as a worker thread")
}

const port = parentPort

// Bridgebuilder iter-3 HIGH fix: register trusted packs dirs at worker
// startup. Default-deny means substrate-invoke envelopes with a modPath
// outside these prefixes are rejected. Parent passes via:
//   new Worker(script, { workerData: { trustedPacksDirs: ["/abs/packs/"] } })
const wdAny = workerData as { trustedPacksDirs?: unknown } | null
if (wdAny && Array.isArray(wdAny.trustedPacksDirs)) {
  for (const dir of wdAny.trustedPacksDirs) {
    if (typeof dir === "string" && dir.length > 0) {
      registerTrustedPacksDir(dir)
    }
  }
}

port.on("message", async (msg: unknown) => {
  if (typeof msg !== "object" || msg === null) return
  const m = msg as Record<string, unknown>
  const type = String(m.type)

  switch (type) {
    case "substrate-invoke": {
      const jobId = String(m.jobId)
      try {
        const payload: SubstrateInvokePayload = {
          jobId, // threaded into AsyncLocalStorage for bridge proxy correlation
          slug: String(m.slug),
          modPath: String(m.modPath),
          exportName: String(m.exportName),
          input: m.input,
          runtimeOpts: m.runtimeOpts as SubstrateInvokePayload["runtimeOpts"],
        }
        const out = await handleSubstrateInvoke(payload, port)
        if (out.ok) {
          port.postMessage({ type: "result", jobId, result: out.result })
        } else {
          port.postMessage({ type: "error", jobId, error: out.error })
        }
      } catch (cause) {
        port.postMessage({
          type: "error",
          jobId,
          error: { _tag: "WorkerCrash", message: cause instanceof Error ? cause.message : String(cause) },
        })
      }
      return
    }

    case "dispose-runtime": {
      try {
        await handleDisposeRuntime(String(m.slug))
      } catch {
        // Swallow — dispose is best-effort
      }
      return
    }

    case "modelrunner.res":
    case "eventwriter.res": {
      const jobId = String(m.jobId)
      handleBridgeResponse(jobId, { result: m.result, error: m.error })
      return
    }
  }
})
