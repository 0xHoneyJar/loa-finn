// src/substrate/__tests__/e2e.integration.test.ts — Sprint-7 real-worker e2e.
//
// Cycle-032 Sprint-7. The full-pipeline integration test deferred at sprint-5
// for build-step coupling reasons. This test:
//
//   1. Compiles substrate sources to a temp dist (tsc one-shot, ~3-5s)
//   2. Creates a synthetic substrate-construct fixture in tmpdir (pure .mjs;
//      uses Effect + Context.Tag("ModelRunner"))
//   3. Spawns a REAL Node worker_thread pointing at the compiled
//      worker-entry.js
//   4. Exercises the full bridge protocol end-to-end:
//        bridge.invoke()
//          → worker substrate-invoke
//          → worker dynamic-imports construct
//          → worker composes Layer with bridge proxy
//          → worker runs Effect.gen
//          → ModelRunner.complete inside Effect → modelrunner.req posted
//          → parent receives modelrunner.req → calls mock cheval
//          → parent posts modelrunner.res back
//          → worker resolves the Promise → Effect resumes
//          → Effect resolves → worker posts result envelope
//          → bridge.invoke() resolves
//
// This is the test sprint-5 said was "deferred for build-step coupling" —
// landing it now to close cycle-032.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { makeSandboxBridge } from "../sandbox-bridge.js"
import type { ModelInvoker } from "../model-runner-layer.js"
import type { CompletionRequest, CompletionResult } from "../../hounfour/types.js"
import type { EventWriter as EventStoreWriter } from "../../events/writer.js"
import type { EventEnvelope, EventStream } from "../../events/types.js"
import type { LoadedConstruct, ValidatedLicense } from "../types.js"

// ── Build-then-test setup ───────────────────────────────────────────

let tmpDist: string
let workerScript: string
let constructDir: string
let constructEntry: string

beforeAll(() => {
  // 1. Compile substrate sources to a temp dist
  tmpDist = mkdtempSync(join(tmpdir(), "substrate-e2e-dist-"))
  const projectRoot = resolve(__dirname, "../../..")
  const substrateFiles = [
    "src/substrate/types.ts",
    "src/substrate/manifest-schema.ts",
    "src/substrate/jwt-validator.ts",
    "src/substrate/loader.ts",
    "src/substrate/runtime.ts",
    "src/substrate/model-runner-layer.ts",
    "src/substrate/event-writer-layer.ts",
    "src/substrate/sandbox-bridge.ts",
    "src/substrate/worker-runtime.ts",
    "src/substrate/worker-entry.ts",
    "src/substrate/cli.ts",
    "src/substrate/index.ts",
  ]

  // Bridgebuilder iter-5 MEDIUM fix: use execFileSync with explicit args
  // array instead of execSync with concatenated shell string. Avoids the
  // confused-deputy/command-injection class of issue when path strings
  // contain shell metacharacters (e.g., spaces in temp dir on some OS
  // configurations). npx + flat args is safer.
  try {
    execFileSync(
      "npx",
      [
        "tsc",
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--target", "ES2024",
        "--strict",
        "--esModuleInterop",
        "--skipLibCheck",
        "--resolveJsonModule",
        "--outDir", tmpDist,
        "--rootDir", "src",
        ...substrateFiles,
      ],
      { cwd: projectRoot, stdio: ["pipe", "pipe", "inherit"] },
    )
  } catch (cause) {
    throw new Error(
      `e2e setup: tsc compilation failed (see stderr above). ` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  // Compiled worker-entry.js imports `effect` (and chains into hounfour types
  // via type-only imports — runtime imports stay within substrate/). Node
  // resolves bare-specifier imports by walking up the directory tree looking
  // for node_modules. Symlink the project's node_modules into tmpDist root so
  // the compiled workers can resolve their deps.
  // Bridgebuilder LOW fix: use fs.symlinkSync (portable) instead of `ln -s`
  // shell call (Windows-incompatible).
  const projectNodeModulesAbs = join(projectRoot, "node_modules")
  symlinkSync(projectNodeModulesAbs, join(tmpDist, "node_modules"), "dir")

  workerScript = join(tmpDist, "substrate", "worker-entry.js")

  // 2. Create a synthetic substrate-construct fixture (pure .mjs, uses Effect)
  constructDir = mkdtempSync(join(tmpdir(), "substrate-e2e-construct-"))
  constructEntry = join(constructDir, "index.mjs")

  // Synthetic construct: declares Context.Tag("ModelRunner"), uses runner.complete()
  // inside an Effect.gen. Exports a `gradeText` function that takes an input
  // and returns { ok: true, text, echoedInput }.
  writeFileSync(
    constructEntry,
    `
import { Context, Effect } from "effect"

class ModelRunner extends Context.Tag("ModelRunner")() {}

export const gradeText = (input) =>
  Effect.gen(function* () {
    const runner = yield* ModelRunner
    const text = yield* runner.complete({
      systemPrompt: "synthetic e2e fixture",
      userMessage: JSON.stringify(input),
    })
    return { ok: true, text, echoedInput: input }
  })
`,
  )

  // node_modules must be reachable from constructDir so that dynamic-import "effect" works
  // — symlink the project's node_modules into the construct dir
  // Bridgebuilder LOW fix: portable symlinkSync (was `ln -s` shell call).
  const projectNodeModules = join(projectRoot, "node_modules")
  symlinkSync(projectNodeModules, join(constructDir, "node_modules"), "dir")
}, 30_000)

afterAll(() => {
  if (tmpDist) rmSync(tmpDist, { recursive: true, force: true })
  if (constructDir) rmSync(constructDir, { recursive: true, force: true })
})

// ── Test fixtures (parent-side mocks) ───────────────────────────────

const fakeLicense: ValidatedLicense = {
  fingerprint: "f",
  kid: "k",
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  graceUntil: new Date(Date.now() + 7_200_000),
  tier: "pro",
  status: "valid",
}

function loadedFor(slug: string, exportName: string): LoadedConstruct {
  return {
    slug,
    entryPath: constructEntry,
    license: fakeLicense,
    loadModule: async () => ({}),
    manifest: {
      name: slug,
      slug,
      version: "1.0.0",
      type: "substrate-construct",
      license: "MIT",
      schema_version: 1,
      executable: { entry: "index.mjs", export: exportName, protocol: { input: "in", output: "out" } },
      runtime: { engine: "effect-ts" },
      requirements: [{ tag: "ModelRunner" }],
    } as unknown as LoadedConstruct["manifest"],
  }
}

function makeMockInvoker(textFn: (req: CompletionRequest) => string): ModelInvoker {
  return {
    complete: async (req: CompletionRequest): Promise<CompletionResult> => ({
      content: textFn(req),
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 5, completion_tokens: 10, reasoning_tokens: 0 },
      metadata: { model: "test-model", latency_ms: 1, trace_id: req.metadata.trace_id },
    }),
  }
}

const noopEventWriter: EventStoreWriter = {
  async append<T>(stream: EventStream, event_type: string, payload: T, correlation_id: string): Promise<EventEnvelope<T>> {
    return {
      event_id: "ev",
      stream,
      event_type,
      timestamp: Date.now(),
      correlation_id,
      sequence: 1,
      checksum: 0,
      schema_version: 1,
      payload,
    } as unknown as EventEnvelope<T>
  },
  async close() {},
}

// ── Tests ───────────────────────────────────────────────────────────

describe("e2e — real worker_threads + bridge protocol + Effect program", () => {
  it("invoke roundtrip: parent → worker → construct → bridge proxy → parent → result", async () => {
    const bridge = makeSandboxBridge({
      workerScript,
      trustedPacksDirs: [constructDir],
      modelInvoker: makeMockInvoker(() => "synthetic-llm-response"),
      eventWriter: noopEventWriter,
    })

    try {
      const loaded = loadedFor("e2e-test-construct", "gradeText")
      const result = (await bridge.invoke(
        loaded,
        { agentId: "test", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" },
        { hello: "world", n: 42 },
      )) as { ok: boolean; text: string; echoedInput: { hello: string; n: number } }

      expect(result.ok).toBe(true)
      expect(result.text).toBe("synthetic-llm-response")
      expect(result.echoedInput).toEqual({ hello: "world", n: 42 })
    } finally {
      await bridge.shutdown()
    }
  }, 30_000)

  it("multiple invocations reuse cached ManagedRuntime in worker (no Layer reconstruction overhead)", async () => {
    let invocations = 0
    const bridge = makeSandboxBridge({
      workerScript,
      trustedPacksDirs: [constructDir],
      modelInvoker: makeMockInvoker(() => {
        invocations++
        return `response-${invocations}`
      }),
      eventWriter: noopEventWriter,
    })

    try {
      const loaded = loadedFor("e2e-test-construct", "gradeText")
      const opts = { agentId: "a", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" }
      const r1 = (await bridge.invoke(loaded, opts, { i: 1 })) as { text: string }
      const r2 = (await bridge.invoke(loaded, opts, { i: 2 })) as { text: string }
      const r3 = (await bridge.invoke(loaded, opts, { i: 3 })) as { text: string }

      expect(r1.text).toBe("response-1")
      expect(r2.text).toBe("response-2")
      expect(r3.text).toBe("response-3")
      expect(invocations).toBe(3) // cheval was called 3 times (Layer cache only avoids re-COMPOSITION, not re-CALL)
    } finally {
      await bridge.shutdown()
    }
  }, 30_000)

  it("invoker error propagates back as TYPED Effect failure (runPromiseExit Bridgebuilder fix)", async () => {
    const bridge = makeSandboxBridge({
      workerScript,
      trustedPacksDirs: [constructDir],
      modelInvoker: {
        complete: async () => {
          throw new Error("simulated cheval crash")
        },
      },
      eventWriter: noopEventWriter,
    })

    try {
      const loaded = loadedFor("e2e-test-construct", "gradeText")
      const captured = await bridge
        .invoke(loaded, { agentId: "a", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" }, null)
        .then(
          () => null,
          (e: unknown) => e,
        )
      // Bridgebuilder Medium fix: handleSubstrateInvoke uses runPromiseExit
      // and serializes the construct's typed error shape via Cause.failureOption.
      // The rejection should be a structured error envelope (NOT a generic
      // InvokeError) preserving the construct-side ModelRunnerError shape.
      expect(captured).toBeTruthy()
      expect(captured).toMatchObject({ _tag: "ModelRunnerError" })
    } finally {
      await bridge.shutdown()
    }
  }, 30_000)

  it("dispose(slug) posts dispose-runtime; subsequent invoke rebuilds the runtime", async () => {
    const bridge = makeSandboxBridge({
      workerScript,
      trustedPacksDirs: [constructDir],
      modelInvoker: makeMockInvoker(() => "ok"),
      eventWriter: noopEventWriter,
    })

    try {
      const loaded = loadedFor("e2e-test-construct", "gradeText")
      const opts = { agentId: "a", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" }

      const r1 = (await bridge.invoke(loaded, opts, { round: 1 })) as { text: string }
      expect(r1.text).toBe("ok")

      // Dispose then re-invoke — both should succeed; the worker rebuilds the runtime on second call
      bridge.dispose(loaded.slug)
      // Give the dispose message time to land
      await new Promise((r) => setTimeout(r, 50))

      const r2 = (await bridge.invoke(loaded, opts, { round: 2 })) as { text: string }
      expect(r2.text).toBe("ok")
    } finally {
      await bridge.shutdown()
    }
  }, 30_000)

  it("default-deny: bridge with empty trustedPacksDirs rejects modPath outside trust (Bridgebuilder iter-3 HIGH fix)", async () => {
    // Construct a bridge with NO trustedPacksDirs — worker should default-deny
    // every substrate-invoke modPath.
    const bridge = makeSandboxBridge({
      workerScript,
      trustedPacksDirs: [], // explicit empty — production omission is the hazard this defends against
      modelInvoker: makeMockInvoker(() => "ok"),
      eventWriter: noopEventWriter,
    })
    try {
      const loaded = loadedFor("e2e-test-construct", "gradeText")
      const captured = await bridge
        .invoke(loaded, { agentId: "a", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" }, null)
        .then(
          () => null,
          (e: unknown) => e,
        )
      expect(captured).toBeTruthy()
      expect(captured).toMatchObject({ _tag: "ModPathTrustError" })
      expect(JSON.stringify(captured)).toMatch(/no trustedPacksDirs registered/)
    } finally {
      await bridge.shutdown()
    }
  }, 30_000)

  it("shutdown() terminates the worker cleanly + rejects in-flight invocations", async () => {
    const bridge = makeSandboxBridge({
      workerScript,
      trustedPacksDirs: [constructDir],
      // Mock invoker that hangs forever — simulates an in-flight invocation when shutdown hits
      modelInvoker: {
        complete: () => new Promise(() => {}),
      },
      eventWriter: noopEventWriter,
    })

    const loaded = loadedFor("e2e-test-construct", "gradeText")
    const invokePromise = bridge.invoke(loaded, { agentId: "a", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" }, null)
    // Pre-attach a swallowing handler so vitest's unhandled-rejection guard
    // doesn't fire before the explicit assertion below consumes the rejection.
    const rejectionCapture = invokePromise.catch((e: unknown) => e)

    // Give the worker time to spawn + dispatch the modelrunner.req before we shut down
    await new Promise((r) => setTimeout(r, 100))

    await bridge.shutdown()
    const captured = await rejectionCapture
    expect(captured).toBeInstanceOf(Error)
    expect(String(captured)).toMatch(/shutdown/i)
  }, 30_000)
})
