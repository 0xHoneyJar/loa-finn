// src/substrate/__tests__/sandbox-bridge.test.ts — Bridge protocol unit tests.
//
// Cycle-032 Sprint-5. Tests the parent-side bridge dispatcher with a mock
// Worker (EventEmitter standin) — exercises the protocol end-to-end without
// spawning real worker_threads. Real-worker integration belongs in sprint-7's
// e2e (where the full pipeline runs once).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { EventEmitter } from "node:events"
import { makeSandboxBridge } from "../sandbox-bridge.js"
import type { ModelInvoker } from "../model-runner-layer.js"
import type { CompletionRequest, CompletionResult } from "../../hounfour/types.js"
import type { EventWriter as EventStoreWriter } from "../../events/writer.js"
import type { EventEnvelope, EventStream } from "../../events/types.js"
import type { LoadedConstruct, ValidatedLicense } from "../types.js"

// ── Mock Worker ─────────────────────────────────────────────────────

class MockWorker extends EventEmitter {
  posted: Array<Record<string, unknown>> = []
  terminated = false

  postMessage(msg: Record<string, unknown>): void {
    this.posted.push(msg)
    // Simulate worker echoing — tests will override behavior by listening to posted
  }

  async terminate(): Promise<void> {
    this.terminated = true
  }
}

// Patch Worker constructor for the duration of each test
let mockWorker: MockWorker

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    Worker: class {
      constructor(_script: string, _opts?: unknown) {
        return mockWorker
      }
    },
  }
})

// ── Test fixtures ───────────────────────────────────────────────────

const fakeLicense: ValidatedLicense = {
  fingerprint: "deadbeef",
  kid: "test-kid",
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  graceUntil: new Date(Date.now() + 7_200_000),
  tier: "pro",
  status: "valid",
}

function fakeLoaded(slug: string, exportName = "default", entryPath = "/fake/path/index.js"): LoadedConstruct {
  return {
    slug,
    entryPath,
    license: fakeLicense,
    loadModule: async () => ({}),
    manifest: {
      name: slug,
      slug,
      version: "1.0.0",
      type: "substrate-construct",
      license: "MIT",
      schema_version: 1,
      executable: { entry: "index.js", export: exportName, protocol: { input: "in", output: "out" } },
      runtime: { engine: "effect-ts" },
      requirements: [],
    } as unknown as LoadedConstruct["manifest"],
  }
}

const passthroughInvoker: ModelInvoker = {
  complete: async (_req: CompletionRequest): Promise<CompletionResult> => ({
    content: "mock-text",
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 0 },
    metadata: { model: "test", latency_ms: 1, trace_id: "t" },
  }),
}

const passthroughEventWriter: EventStoreWriter & { calls: Array<{ stream: string; event_type: string; payload: unknown }> } = {
  calls: [],
  async append<T>(stream: EventStream, event_type: string, payload: T, correlation_id: string): Promise<EventEnvelope<T>> {
    this.calls.push({ stream: String(stream), event_type, payload })
    return {
      event_id: "e",
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

beforeEach(() => {
  mockWorker = new MockWorker()
  passthroughEventWriter.calls = []
})

// ── Tests ───────────────────────────────────────────────────────────

describe("sandbox-bridge invoke protocol", () => {
  it("posts substrate-invoke envelope with correct shape and resolves on result", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })

    const loaded = fakeLoaded("my-construct", "myExport", "/abs/my-construct/dist/index.js")
    const invokePromise = bridge.invoke(loaded, { agentId: "a", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" }, { hello: "world" })

    // First message posted should be substrate-invoke
    expect(mockWorker.posted).toHaveLength(1)
    const sent = mockWorker.posted[0]!
    expect(sent.type).toBe("substrate-invoke")
    expect(sent.slug).toBe("my-construct") // Bridgebuilder fix: canonical slug in envelope
    expect(sent.modPath).toBe("/abs/my-construct/dist/index.js")
    expect(sent.exportName).toBe("myExport")
    expect(sent.input).toEqual({ hello: "world" })
    expect(sent.runtimeOpts).toEqual({ agentId: "a", tenantId: "t", poolId: "p", modelId: "m", tier: "pro" })
    expect(typeof sent.jobId).toBe("string")

    // Simulate worker → parent: result envelope with same jobId
    mockWorker.emit("message", { type: "result", jobId: sent.jobId, result: { ok: true } })
    const result = await invokePromise
    expect(result).toEqual({ ok: true })
    expect(bridge.inFlightCount()).toBe(0)
  })

  it("rejects on error envelope from worker", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    const loaded = fakeLoaded("c1")
    const invokePromise = bridge.invoke(loaded, { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }, null)
    const sent = mockWorker.posted[0]!
    mockWorker.emit("message", { type: "error", jobId: sent.jobId, error: { _tag: "InvokeError", message: "boom" } })
    await expect(invokePromise).rejects.toMatchObject({ _tag: "InvokeError", message: "boom" })
  })

  it("rejects when construct lacks executable.export", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    const loaded = fakeLoaded("c1")
    // Strip executable
    ;(loaded.manifest as { executable?: unknown }).executable = undefined
    await expect(
      bridge.invoke(loaded, { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }, null),
    ).rejects.toThrow(/no executable\.export/)
  })

  it("ignores stray messages without matching jobId", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    // Emit a result with no in-flight invoke — should be safely ignored
    mockWorker.emit("message", { type: "result", jobId: "no-such-job", result: "x" })
    expect(bridge.inFlightCount()).toBe(0)
  })
})

describe("modelrunner bridge proxy", () => {
  it("worker emits modelrunner.req → bridge calls invoker → parent posts modelrunner.res with text", async () => {
    const invokerSpy = vi.fn(passthroughInvoker.complete)
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: { complete: invokerSpy },
      eventWriter: passthroughEventWriter,
    })

    // Simulate worker requesting model invocation
    const completionRequest: CompletionRequest = {
      messages: [{ role: "user", content: "hi" }],
      options: {},
      metadata: { agent: "a", tenant_id: "t", nft_id: "", trace_id: "tr" },
    }
    mockWorker.emit("message", { type: "modelrunner.req", jobId: "sub-1", completionRequest })

    // Wait microtask cycle for async handler to run
    await new Promise((r) => setImmediate(r))

    expect(invokerSpy).toHaveBeenCalledWith(completionRequest)
    // Bridge should have posted modelrunner.res back
    const posted = mockWorker.posted.find((p) => p.type === "modelrunner.res")
    expect(posted).toBeDefined()
    expect(posted!.jobId).toBe("sub-1")
    expect(posted!.result).toEqual({ text: "mock-text" })

    // Suppress unused bridge variable
    expect(bridge.inFlightCount()).toBe(0)
  })

  it("invoker throws → bridge posts modelrunner.res with mapped error shape", async () => {
    const failingInvoker: ModelInvoker = {
      complete: async () => {
        throw new Error("HTTP 429 too many requests")
      },
    }
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: failingInvoker,
      eventWriter: passthroughEventWriter,
    })
    mockWorker.emit("message", {
      type: "modelrunner.req",
      jobId: "sub-2",
      completionRequest: { messages: [], options: {}, metadata: { agent: "a", tenant_id: "t", nft_id: "", trace_id: "x" } },
    })
    await new Promise((r) => setImmediate(r))

    const posted = mockWorker.posted.find((p) => p.type === "modelrunner.res")
    expect(posted).toBeDefined()
    expect(posted!.error).toMatchObject({
      _tag: "ModelRunnerError",
      reason: "rate-limit",
    })
  })
})

describe("eventwriter bridge proxy", () => {
  it("worker emits eventwriter.req → bridge calls writer.append → posts eventwriter.res ok", async () => {
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    mockWorker.emit("message", {
      type: "eventwriter.req",
      jobId: "ew-1",
      envelope: { subject: "agent.lore-essay.verdict", payload: { x: 1 } },
    })
    await new Promise((r) => setImmediate(r))

    expect(passthroughEventWriter.calls).toHaveLength(1)
    expect(passthroughEventWriter.calls[0]).toMatchObject({
      stream: "substrate_invocations",
      event_type: "agent.lore-essay.verdict",
      payload: { x: 1 },
    })
    const posted = mockWorker.posted.find((p) => p.type === "eventwriter.res")
    expect(posted).toBeDefined()
    expect(posted!.result).toEqual({ ok: true })
  })

  it("writer throws → bridge posts eventwriter.res with EventWriterError(append-failed)", async () => {
    const failingWriter: EventStoreWriter = {
      async append() {
        throw new Error("WAL flush failed")
      },
      async close() {},
    }
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: failingWriter,
    })
    mockWorker.emit("message", {
      type: "eventwriter.req",
      jobId: "ew-2",
      envelope: { subject: "a.b.c", payload: null },
    })
    await new Promise((r) => setImmediate(r))

    const posted = mockWorker.posted.find((p) => p.type === "eventwriter.res")
    expect(posted!.error).toMatchObject({ _tag: "EventWriterError", reason: "append-failed" })
  })

  it("invalid envelope → eventwriter.res with EventWriterError(invalid-subject)", async () => {
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    mockWorker.emit("message", { type: "eventwriter.req", jobId: "ew-3", envelope: { subject: 123, payload: null } })
    await new Promise((r) => setImmediate(r))
    const posted = mockWorker.posted.find((p) => p.type === "eventwriter.res")
    expect(posted!.error).toMatchObject({ _tag: "EventWriterError", reason: "invalid-subject" })
  })
})

describe("dispose / shutdown", () => {
  it("dispose(slug) posts dispose-runtime envelope", () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    bridge.dispose("my-slug")
    const posted = mockWorker.posted.find((p) => p.type === "dispose-runtime")
    expect(posted).toBeDefined()
    expect(posted!.slug).toBe("my-slug")
  })

  it("shutdown() rejects in-flight invocations + terminates worker", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    const loaded = fakeLoaded("x")
    const invokePromise = bridge.invoke(loaded, { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }, null)
    expect(bridge.inFlightCount()).toBe(1)
    await bridge.shutdown()
    await expect(invokePromise).rejects.toThrow(/shutdown/i)
    expect(mockWorker.terminated).toBe(true)
  })

  it("invoke after shutdown rejects synchronously", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    await bridge.shutdown()
    await expect(
      bridge.invoke(fakeLoaded("y"), { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }, null),
    ).rejects.toThrow(/shutting down/)
  })
})

// ── Bridgebuilder review fixes (cycle-032 hardening) ────────────────

describe("invoke timeout (Bridgebuilder HIGH fix)", () => {
  it("rejects with timeout error if worker never sends result envelope", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
      invokeTimeoutMs: 50, // 50ms timeout for fast test
    })
    const loaded = fakeLoaded("hangy")
    const invokePromise = bridge.invoke(
      loaded,
      { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" },
      null,
    )
    expect(bridge.inFlightCount()).toBe(1)

    // Don't emit a result. Wait for timeout to fire.
    await expect(invokePromise).rejects.toThrow(/timed out after 50ms/)
    expect(bridge.inFlightCount()).toBe(0) // inFlight cleaned up
  })

  it("does NOT timeout when result arrives before deadline", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
      invokeTimeoutMs: 5_000,
    })
    const loaded = fakeLoaded("fast")
    const invokePromise = bridge.invoke(
      loaded,
      { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" },
      null,
    )
    const sent = mockWorker.posted[0]!
    mockWorker.emit("message", { type: "result", jobId: sent.jobId, result: { fast: true } })
    const result = await invokePromise
    expect(result).toEqual({ fast: true })
    expect(bridge.inFlightCount()).toBe(0)
  })

  it("invokeTimeoutMs=0 disables the timeout", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
      invokeTimeoutMs: 0,
    })
    const loaded = fakeLoaded("notimer")
    const invokePromise = bridge.invoke(
      loaded,
      { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" },
      null,
    )
    // Pre-attach handler so vitest doesn't flag the eventual shutdown rejection
    const captureShutdownRejection = invokePromise.catch((e: unknown) => e)
    // Wait longer than any reasonable timeout would have fired
    await new Promise((r) => setTimeout(r, 100))
    expect(bridge.inFlightCount()).toBe(1) // still in-flight; no timeout fired
    await bridge.shutdown()
    const captured = await captureShutdownRejection
    expect(captured).toBeInstanceOf(Error)
  })
})

describe("isHealthy + onWorkerDeath (Bridgebuilder iter-5 MEDIUM fix)", () => {
  it("isHealthy() reports true initially", () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    expect(bridge.isHealthy()).toBe(true)
  })

  it("isHealthy() reports false after shutdown()", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    expect(bridge.isHealthy()).toBe(true)
    await bridge.shutdown()
    expect(bridge.isHealthy()).toBe(false)
  })

  it("onWorkerDeath callback fires on unexpected worker exit", () => {
    const deaths: number[] = []
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
      onWorkerDeath: (code) => deaths.push(code),
    })
    expect(bridge.isHealthy()).toBe(true)
    // Simulate unexpected worker exit (non-zero code, not during shutdown)
    mockWorker.emit("exit", 137)
    expect(deaths).toEqual([137])
    expect(bridge.isHealthy()).toBe(false) // bridge marked unusable
  })

  it("onWorkerDeath callback errors are caught (don't break the worker-exit handler)", () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
      onWorkerDeath: () => {
        throw new Error("buggy callback")
      },
    })
    // Should NOT throw out of the exit handler
    expect(() => mockWorker.emit("exit", 1)).not.toThrow()
    expect(bridge.isHealthy()).toBe(false)
  })
})

describe("worker error event propagation (Bridgebuilder LOW fix)", () => {
  it("worker.emit('error') rejects all in-flight invocations", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    const loaded = fakeLoaded("z")
    const invokePromise = bridge.invoke(
      loaded,
      { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" },
      null,
    )
    expect(bridge.inFlightCount()).toBe(1)
    mockWorker.emit("error", new Error("simulated worker segfault"))
    await expect(invokePromise).rejects.toThrow(/segfault/)
    expect(bridge.inFlightCount()).toBe(0)
  })
})

describe("concurrent invocations (Bridgebuilder iter-4 #5 fix)", () => {
  it("3 concurrent invokes resolve independently with their respective results", async () => {
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
    })
    const loaded = fakeLoaded("c1")
    const opts = { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }

    // Fire 3 concurrent invokes
    const p1 = bridge.invoke(loaded, opts, { i: 1 })
    const p2 = bridge.invoke(loaded, opts, { i: 2 })
    const p3 = bridge.invoke(loaded, opts, { i: 3 })

    expect(bridge.inFlightCount()).toBe(3)
    expect(mockWorker.posted).toHaveLength(3)
    const sent = mockWorker.posted as Array<Record<string, unknown>>
    const jobIds = sent.map((s) => String(s.jobId))
    expect(new Set(jobIds).size).toBe(3) // unique jobIds

    // Resolve out of order: 3 first, then 1, then 2
    mockWorker.emit("message", { type: "result", jobId: jobIds[2], result: { id: 3 } })
    mockWorker.emit("message", { type: "result", jobId: jobIds[0], result: { id: 1 } })
    mockWorker.emit("message", { type: "result", jobId: jobIds[1], result: { id: 2 } })

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toEqual({ id: 1 })
    expect(r2).toEqual({ id: 2 })
    expect(r3).toEqual({ id: 3 })
    expect(bridge.inFlightCount()).toBe(0)
  })
})

describe("completionRequest shape validation (Bridgebuilder iter-4 HIGH #2 fix)", () => {
  it("rejects modelrunner.req with missing messages array", async () => {
    const invokerSpy = vi.fn(passthroughInvoker.complete)
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: { complete: invokerSpy },
      eventWriter: passthroughEventWriter,
    })
    mockWorker.emit("message", {
      type: "modelrunner.req",
      jobId: "bad-1",
      completionRequest: { metadata: { agent: "a", tenant_id: "t", trace_id: "x" } }, // no messages
    })
    await new Promise((r) => setImmediate(r))
    expect(invokerSpy).not.toHaveBeenCalled() // shape check rejected before forwarding
    const posted = mockWorker.posted.find((p) => p.type === "modelrunner.res")
    expect(posted!.error).toMatchObject({ _tag: "ModelRunnerError", reason: "invalid-input" })
  })

  it("rejects modelrunner.req with malformed metadata", async () => {
    const invokerSpy = vi.fn(passthroughInvoker.complete)
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: { complete: invokerSpy },
      eventWriter: passthroughEventWriter,
    })
    mockWorker.emit("message", {
      type: "modelrunner.req",
      jobId: "bad-2",
      completionRequest: { messages: [], metadata: { agent: "a" } }, // missing tenant_id, trace_id
    })
    await new Promise((r) => setImmediate(r))
    expect(invokerSpy).not.toHaveBeenCalled()
  })

  it("rejects modelrunner.req with non-object completionRequest", async () => {
    const invokerSpy = vi.fn(passthroughInvoker.complete)
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: { complete: invokerSpy },
      eventWriter: passthroughEventWriter,
    })
    mockWorker.emit("message", { type: "modelrunner.req", jobId: "bad-3", completionRequest: "not-an-object" })
    await new Promise((r) => setImmediate(r))
    expect(invokerSpy).not.toHaveBeenCalled()
  })
})

describe("stale-invoke skip on bridge proxies (Bridgebuilder iter-2 #4 fix)", () => {
  it("skips modelrunner.req invocation when topLevelJobId is no longer in-flight", async () => {
    const invokerSpy = vi.fn(passthroughInvoker.complete)
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: { complete: invokerSpy },
      eventWriter: passthroughEventWriter,
    })
    // Simulate a worker emitting modelrunner.req for a top-level jobId that
    // was never registered (analogous to a stale jobId after timeout cleanup)
    mockWorker.emit("message", {
      type: "modelrunner.req",
      jobId: "sub-stale",
      topLevelJobId: "ghost-top-level-jobid",
      completionRequest: { messages: [], options: {}, metadata: { agent: "", tenant_id: "", nft_id: "", trace_id: "x" } },
    })
    await new Promise((r) => setImmediate(r))
    // The cheval invoker should NOT have been called (no wasted LLM call)
    expect(invokerSpy).not.toHaveBeenCalled()
    // Bridge should have posted a stale-skip error response back
    const posted = mockWorker.posted.find((p) => p.type === "modelrunner.res")
    expect(posted).toBeDefined()
    expect(posted!.error).toMatchObject({
      _tag: "ModelRunnerError",
      reason: "unknown",
      message: expect.stringMatching(/already settled/i) as unknown as string,
    })
  })

  it("skips eventwriter.req invocation when topLevelJobId is no longer in-flight", async () => {
    const writer = makeMockWriter()
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: writer,
    })
    mockWorker.emit("message", {
      type: "eventwriter.req",
      jobId: "ew-stale",
      topLevelJobId: "ghost-top-level-jobid",
      envelope: { subject: "a.b.c", payload: { x: 1 } },
    })
    await new Promise((r) => setImmediate(r))
    expect(writer.calls).toHaveLength(0) // append never called
    const posted = mockWorker.posted.find((p) => p.type === "eventwriter.res")
    expect(posted).toBeDefined()
    expect(posted!.error).toMatchObject({ _tag: "EventWriterError", reason: "unknown" })
  })

  it("does NOT skip when topLevelJobId is omitted (back-compat for callers without context threading)", async () => {
    const invokerSpy = vi.fn(passthroughInvoker.complete)
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: { complete: invokerSpy },
      eventWriter: passthroughEventWriter,
    })
    mockWorker.emit("message", {
      type: "modelrunner.req",
      jobId: "sub-no-context",
      // no topLevelJobId → bridge proceeds (back-compat)
      completionRequest: { messages: [], options: {}, metadata: { agent: "", tenant_id: "", nft_id: "", trace_id: "x" } },
    })
    await new Promise((r) => setImmediate(r))
    expect(invokerSpy).toHaveBeenCalledOnce()
  })
})

// ── helper used above ──────────────────────────────────────────────────

function makeMockWriter(): EventStoreWriter & { calls: Array<{ stream: string; event_type: string; payload: unknown }> } {
  const calls: Array<{ stream: string; event_type: string; payload: unknown }> = []
  let sequence = 0
  return {
    calls,
    async append<T>(stream: EventStream, event_type: string, payload: T, correlation_id: string): Promise<EventEnvelope<T>> {
      calls.push({ stream: String(stream), event_type, payload })
      sequence++
      return {
        event_id: `evt-${sequence}`,
        stream,
        event_type,
        timestamp: Date.now(),
        correlation_id,
        sequence,
        checksum: 0,
        schema_version: 1,
        payload,
      } as unknown as EventEnvelope<T>
    },
    async close() {},
  }
}

describe("structured logging (Bridgebuilder Medium fix)", () => {
  it("invokes the injected logger on lifecycle events", async () => {
    const log: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = []
    const logger = {
      info: (msg: string, ctx?: Record<string, unknown>) => log.push({ level: "info", msg, ctx }),
      warn: (msg: string, ctx?: Record<string, unknown>) => log.push({ level: "warn", msg, ctx }),
      error: (msg: string, ctx?: Record<string, unknown>) => log.push({ level: "error", msg, ctx }),
    }
    const bridge = makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
      logger,
    })
    const loaded = fakeLoaded("logged-construct")
    const invokePromise = bridge.invoke(
      loaded,
      { agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" },
      null,
    )
    const sent = mockWorker.posted[0]!
    mockWorker.emit("message", { type: "result", jobId: sent.jobId, result: "ok" })
    await invokePromise

    // Should have logged at least: invoke start + invoke resolved
    expect(log.some((l) => l.msg.includes("invoke start"))).toBe(true)
    expect(log.some((l) => l.msg.includes("invoke resolved"))).toBe(true)
    expect(log.find((l) => l.msg.includes("invoke start"))!.ctx).toMatchObject({ slug: "logged-construct" })
  })

  it("logs warn on stray result envelope (no in-flight match)", () => {
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
    const logger = {
      info: () => {},
      warn: (msg: string, ctx?: Record<string, unknown>) => warnings.push({ msg, ctx }),
      error: () => {},
    }
    makeSandboxBridge({
      workerScript: "/fake/worker-entry.js",
      modelInvoker: passthroughInvoker,
      eventWriter: passthroughEventWriter,
      logger,
    })
    mockWorker.emit("message", { type: "result", jobId: "no-such-job", result: "x" })
    expect(warnings.some((w) => w.msg.includes("stray result"))).toBe(true)
  })
})
