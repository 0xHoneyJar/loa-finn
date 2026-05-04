// src/substrate/__tests__/event-writer-layer.test.ts — EventWriter Layer tests.
//
// Cycle-032 Sprint-4 Task 4.3.

import { describe, it, expect, vi } from "vitest"
import { Effect } from "effect"
import {
  EventWriter,
  EventWriterError,
  buildEventWriterLayer,
  validateSubject,
} from "../event-writer-layer.js"
import type { EventWriter as EventStoreWriter } from "../../events/writer.js"
import type { EventEnvelope, EventStream } from "../../events/types.js"

// ── Test helpers ────────────────────────────────────────────────────

interface AppendCall {
  stream: string
  event_type: string
  payload: unknown
  correlation_id: string
}

function makeMockWriter(opts: { fail?: boolean } = {}): EventStoreWriter & { calls: AppendCall[] } {
  const calls: AppendCall[] = []
  let sequence = 0
  const writer: EventStoreWriter & { calls: AppendCall[] } = {
    calls,
    async append<T>(
      stream: EventStream,
      event_type: string,
      payload: T,
      correlation_id: string,
    ): Promise<EventEnvelope<T>> {
      if (opts.fail) throw new Error("simulated append failure")
      calls.push({ stream: String(stream), event_type, payload, correlation_id })
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
  return writer
}

// ── validateSubject ─────────────────────────────────────────────────

describe("validateSubject", () => {
  it("accepts well-formed three-segment dotted subjects", () => {
    expect(validateSubject("agent.lore-essay.verdict").ok).toBe(true)
    expect(validateSubject("pool.payment.captured").ok).toBe(true)
    expect(validateSubject("a.b.c").ok).toBe(true)
    expect(validateSubject("substrate.invocation.result").ok).toBe(true)
  })

  it("rejects fewer than three segments", () => {
    const r = validateSubject("agent.x")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.subject).toBe("agent.x")
  })

  it("rejects more than three segments", () => {
    expect(validateSubject("a.b.c.d").ok).toBe(false)
  })

  it("rejects uppercase characters", () => {
    expect(validateSubject("Agent.X.Y").ok).toBe(false)
  })

  it("rejects leading digits in segments", () => {
    expect(validateSubject("1agent.x.y").ok).toBe(false)
    expect(validateSubject("agent.1x.y").ok).toBe(false)
  })

  it("rejects empty segments", () => {
    expect(validateSubject("agent..verdict").ok).toBe(false)
    expect(validateSubject(".x.y").ok).toBe(false)
    expect(validateSubject("x.y.").ok).toBe(false)
  })

  it("rejects empty / non-string input", () => {
    expect(validateSubject("").ok).toBe(false)
    expect(validateSubject(null as unknown as string).ok).toBe(false)
    expect(validateSubject(undefined as unknown as string).ok).toBe(false)
  })

  it("accepts hyphens in segment", () => {
    expect(validateSubject("multi-word.long-noun.verb-here").ok).toBe(true)
  })
})

// ── buildEventWriterLayer ───────────────────────────────────────────

describe("buildEventWriterLayer", () => {
  it("publishes a well-formed event: dotted subject → event_type, default stream substrate_invocations", async () => {
    const writer = makeMockWriter()
    const layer = buildEventWriterLayer({ writer, correlationIdGen: () => "fixed-corr-id" })

    await Effect.runPromise(
      Effect.gen(function* () {
        const ew = yield* EventWriter
        return yield* ew.publish("agent.lore-essay.verdict", { status: "APPROVED" })
      }).pipe(Effect.provide(layer)),
    )

    expect(writer.calls).toHaveLength(1)
    const call = writer.calls[0]!
    expect(call.stream).toBe("substrate_invocations")
    expect(call.event_type).toBe("agent.lore-essay.verdict")
    expect(call.payload).toEqual({ status: "APPROVED" })
    expect(call.correlation_id).toBe("fixed-corr-id")
  })

  it("uses caller-overridable streamName", async () => {
    const writer = makeMockWriter()
    const layer = buildEventWriterLayer({
      writer,
      streamName: "substrate_lore_essay",
      correlationIdGen: () => "x",
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const ew = yield* EventWriter
        return yield* ew.publish("a.b.c", { foo: 1 })
      }).pipe(Effect.provide(layer)),
    )

    expect(writer.calls[0]!.stream).toBe("substrate_lore_essay")
    expect(writer.calls[0]!.event_type).toBe("a.b.c")
  })

  it("rejects malformed subjects with EventWriterError(invalid-subject)", async () => {
    const writer = makeMockWriter()
    const layer = buildEventWriterLayer({ writer })

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const ew = yield* EventWriter
        return yield* ew.publish("only.two", { x: 1 })
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("EventWriterError")
      expect(causeStr).toContain("invalid-subject")
    }
    expect(writer.calls).toHaveLength(0) // never appended
  })

  it("propagates writer failures as EventWriterError(append-failed)", async () => {
    const writer = makeMockWriter({ fail: true })
    const layer = buildEventWriterLayer({ writer })

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const ew = yield* EventWriter
        return yield* ew.publish("a.b.c", { x: 1 })
      }).pipe(Effect.provide(layer)),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("EventWriterError")
      expect(causeStr).toContain("append-failed")
    }
  })

  it("registers stream lazily — repeated publishes reuse registered EventStream brand", async () => {
    const writer = makeMockWriter()
    const layer = buildEventWriterLayer({ writer })

    await Effect.runPromise(
      Effect.gen(function* () {
        const ew = yield* EventWriter
        yield* ew.publish("a.b.c", { i: 1 })
        yield* ew.publish("d.e.f", { i: 2 })
        yield* ew.publish("a.b.c", { i: 3 })
        return null
      }).pipe(Effect.provide(layer)),
    )

    expect(writer.calls).toHaveLength(3)
    // All three go to the default substrate_invocations stream regardless of subject
    expect(writer.calls.every((c) => c.stream === "substrate_invocations")).toBe(true)
    // Distinct event_types preserve the subject
    expect(writer.calls.map((c) => c.event_type)).toEqual(["a.b.c", "d.e.f", "a.b.c"])
  })

  it("default correlationIdGen produces UUIDs (different per publish)", async () => {
    const writer = makeMockWriter()
    const layer = buildEventWriterLayer({ writer })

    await Effect.runPromise(
      Effect.gen(function* () {
        const ew = yield* EventWriter
        yield* ew.publish("a.b.c", { i: 1 })
        yield* ew.publish("a.b.c", { i: 2 })
        return null
      }).pipe(Effect.provide(layer)),
    )

    expect(writer.calls[0]!.correlation_id).not.toBe(writer.calls[1]!.correlation_id)
    // Both should be valid UUIDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(writer.calls[0]!.correlation_id).toMatch(uuidRegex)
  })

  it("Tag identity: EventWriter.key === 'EventWriter'", () => {
    expect(EventWriter.key).toBe("EventWriter")
  })
})
