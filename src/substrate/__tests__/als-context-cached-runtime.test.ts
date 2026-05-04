// src/substrate/__tests__/als-context-cached-runtime.test.ts —
//
// F1 (Bridgebuilder iter-1, HIGH): proves that the AsyncLocalStorage frame
// rooted in `invocationContext.run({ topLevelJobId: payload.jobId }, ...)`
// at handleSubstrateInvoke entry correctly threads the SECOND invocation's
// topLevelJobId through a CACHED ManagedRuntime to the bridge proxy's
// modelrunner.req emission — not the first invocation's snapshot, not null.
//
// This is the regression test for the "cached Layer outlives ALS frame"
// concern raised by Bridgebuilder. The test FIXES the test gap; if the
// implementation later regresses (e.g., a refactor moves the cached Layer
// construction outside the active frame), this test will catch it.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  _clearWorkerRuntimeCaches,
  handleBridgeResponse,
  handleSubstrateInvoke,
  registerTrustedPacksDir,
} from "../worker-runtime.js"

let fixtureDir: string
let fixtureModPath: string

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "substrate-f1-als-"))
  fixtureModPath = join(fixtureDir, "modelrunner-fixture.mjs")

  // Construct fixture: a single Effect program that asks ModelRunner to
  // `complete()`. The complete() call inside the worker-side Layer reads
  // invocationContext.getStore() — that's the path we're proving works.
  writeFileSync(
    fixtureModPath,
    `import { Effect, Context } from 'effect'
// Use GenericTag for direct-use Tag instance with matching string key.
// Effect Tag identity is by key string — this matches worker-runtime.ts's
// class-extension Tag (class ModelRunnerTag extends Context.Tag('ModelRunner')...)
const ModelRunner = Context.GenericTag('ModelRunner')
export const program = (_input) =>
  Effect.flatMap(ModelRunner, (mr) =>
    mr.complete({ systemPrompt: 'sys', userMessage: 'usr' })
  )
`,
  )
  registerTrustedPacksDir(fixtureDir)
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

const baseRuntimeOpts = {
  agentId: "test-agent",
  tenantId: "test-tenant",
  poolId: "test-pool",
  modelId: "test-model",
  tier: "test-tier",
}

describe("F1: ALS context propagation through cached ManagedRuntime", () => {
  it("threads distinct topLevelJobId on each invoke against the SAME cached runtime", async () => {
    _clearWorkerRuntimeCaches()
    // re-register because _clearWorkerRuntimeCaches doesn't clear trusted prefixes
    // (it's per-worker config), and beforeAll already registered fixtureDir.

    const captured: Array<{ type: string; jobId: string; topLevelJobId?: string }> = []
    const port = {
      postMessage: (msg: { type: string; jobId: string; topLevelJobId?: string }) => {
        captured.push(msg)
        // Auto-respond to modelrunner.req so the construct's Effect resolves.
        if (msg.type === "modelrunner.req") {
          // microtask gap: matches realistic parent → worker round-trip
          queueMicrotask(() => {
            handleBridgeResponse(msg.jobId, { result: { text: "ok" } })
          })
        }
      },
    }

    const slug = "f1-fixture"

    // First invoke — establishes the cached runtime. ALS frame: JOB_A.
    const r1 = await handleSubstrateInvoke(
      {
        jobId: "JOB_A",
        slug,
        modPath: fixtureModPath,
        exportName: "program",
        input: {},
        runtimeOpts: baseRuntimeOpts,
      },
      port,
    )
    expect(r1.ok).toBe(true)

    // Second invoke — REUSES the cached runtime (same slug). ALS frame: JOB_B.
    // If F1's concern were valid, the bridge proxy would read JOB_A's snapshot
    // (or null), not JOB_B. Asserting JOB_B was correctly threaded proves
    // ALS propagation works through the cached Layer's Promise chain.
    const r2 = await handleSubstrateInvoke(
      {
        jobId: "JOB_B",
        slug,
        modPath: fixtureModPath,
        exportName: "program",
        input: {},
        runtimeOpts: baseRuntimeOpts,
      },
      port,
    )
    expect(r2.ok).toBe(true)

    // Filter modelrunner.req emissions and assert correct threading.
    const reqs = captured.filter((m) => m.type === "modelrunner.req")
    expect(reqs).toHaveLength(2)
    expect(reqs[0]?.topLevelJobId).toBe("JOB_A")
    expect(reqs[1]?.topLevelJobId).toBe("JOB_B") // the F1 invariant
  })
})
