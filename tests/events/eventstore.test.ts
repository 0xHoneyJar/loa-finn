/**
 * EventStore Test Suite — Sprint 1 (GID 121), Task T1.7
 *
 * Covers: stream registry, EventEnvelope construction, JSONL writer/reader roundtrip,
 * cross-stream replay, cursor-based resume, CRC32 validation, torn-write recovery,
 * credit adapter emission, and billing adapter emission.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import {
  registerEventStream,
  isRegisteredStream,
  assertRegisteredStream,
  getRegisteredStreams,
  STREAM_BILLING,
  STREAM_CREDIT,
  STREAM_RECONCILIATION,
  STREAM_PERSONALITY,
  STREAM_ROUTING_QUALITY,
  EVENT_ENVELOPE_SCHEMA_VERSION,
  computePayloadChecksum,
  crc32,
  fromBillingEnvelope,
  toBillingEnvelope,
  type EventStream,
  type EventEnvelope,
} from "../../src/events/types.js"

import { JsonlEventWriter } from "../../src/events/jsonl-writer.js"
import { JsonlEventReader } from "../../src/events/jsonl-reader.js"

// =========================================================================
// 1. Stream Registry
// =========================================================================

describe("EventStream Registry", () => {
  it("pre-registers 5 known streams", () => {
    const streams = getRegisteredStreams()
    expect(streams.has("billing")).toBe(true)
    expect(streams.has("credit")).toBe(true)
    expect(streams.has("reconciliation")).toBe(true)
    expect(streams.has("personality")).toBe(true)
    expect(streams.has("routing_quality")).toBe(true)
  })

  it("isRegisteredStream returns true for registered, false for unknown", () => {
    expect(isRegisteredStream("billing")).toBe(true)
    expect(isRegisteredStream("unknown_stream")).toBe(false)
  })

  it("assertRegisteredStream throws for unknown streams", () => {
    expect(() => assertRegisteredStream("nonexistent")).toThrow(
      /Unknown event stream/,
    )
  })

  it("assertRegisteredStream returns EventStream for known streams", () => {
    const result = assertRegisteredStream("billing")
    expect(result).toBe("billing")
  })

  it("registerEventStream adds new streams", () => {
    const name = `test_stream_${Date.now()}`
    const stream = registerEventStream(name)
    expect(isRegisteredStream(name)).toBe(true)
    expect(stream).toBe(name)
  })

  it("registerEventStream rejects invalid names", () => {
    expect(() => registerEventStream("")).toThrow(/Invalid stream name/)
    expect(() => registerEventStream("Invalid-Name")).toThrow(/must match/)
    expect(() => registerEventStream("123starts_with_number")).toThrow(/must match/)
  })

  it("STREAM constants are branded EventStream type values", () => {
    // Type assertion — these compile because they are EventStream-branded
    const _b: EventStream = STREAM_BILLING
    const _c: EventStream = STREAM_CREDIT
    const _r: EventStream = STREAM_RECONCILIATION
    const _p: EventStream = STREAM_PERSONALITY
    const _q: EventStream = STREAM_ROUTING_QUALITY
    expect(_b).toBe("billing")
    expect(_c).toBe("credit")
  })
})

// =========================================================================
// 2. CRC32 & Checksum
// =========================================================================

describe("CRC32 / computePayloadChecksum", () => {
  it("crc32 produces 8-char hex string", () => {
    const result = crc32("hello world")
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it("crc32 is deterministic", () => {
    expect(crc32("test payload")).toBe(crc32("test payload"))
  })

  it("crc32 differs for different inputs", () => {
    expect(crc32("input_a")).not.toBe(crc32("input_b"))
  })

  it("computePayloadChecksum serializes via JSON.stringify", () => {
    const payload = { foo: "bar", num: 42 }
    const expected = crc32(JSON.stringify(payload))
    expect(computePayloadChecksum(payload)).toBe(expected)
  })
})

// =========================================================================
// 3. BillingWALEnvelope ↔ EventEnvelope mapping
// =========================================================================

describe("fromBillingEnvelope / toBillingEnvelope", () => {
  it("round-trips billing envelope through EventEnvelope and back", () => {
    const billingEnvelope = {
      schema_version: 1,
      event_type: "billing_reserve" as const,
      timestamp: 1700000000000,
      billing_entry_id: "01ABCDEFGHIJKLMNOPQRSTUVWX" as any,
      correlation_id: "corr-123",
      checksum: "deadbeef",
      wal_sequence: 42,
      payload: { account_id: "0x1111111111111111111111111111111111111111", estimated_cost: "1000" },
    }

    const eventEnvelope = fromBillingEnvelope(billingEnvelope)

    expect(eventEnvelope.event_id).toBe(billingEnvelope.billing_entry_id)
    expect(eventEnvelope.stream).toBe(STREAM_BILLING)
    expect(eventEnvelope.event_type).toBe("billing_reserve")
    expect(eventEnvelope.timestamp).toBe(1700000000000)
    expect(eventEnvelope.correlation_id).toBe("corr-123")
    expect(eventEnvelope.sequence).toBe(42)
    expect(eventEnvelope.checksum).toBe("deadbeef")
    expect(eventEnvelope.schema_version).toBe(1)
    expect(eventEnvelope.payload).toEqual(billingEnvelope.payload)

    // Round-trip back
    const roundTripped = toBillingEnvelope(eventEnvelope)
    expect(roundTripped.billing_entry_id).toBe(billingEnvelope.billing_entry_id)
    expect(roundTripped.event_type).toBe(billingEnvelope.event_type)
    expect(roundTripped.wal_sequence).toBe(42)
    expect(roundTripped.payload).toEqual(billingEnvelope.payload)
  })

  it("handles missing wal_sequence (defaults to 0)", () => {
    const billingEnvelope = {
      schema_version: 1,
      event_type: "billing_commit" as const,
      timestamp: 1700000000000,
      billing_entry_id: "01ABCDEFGHIJKLMNOPQRSTUVWX" as any,
      correlation_id: "corr-456",
      checksum: "cafebabe",
      payload: { actual_cost: "500" },
    }

    const eventEnvelope = fromBillingEnvelope(billingEnvelope)
    expect(eventEnvelope.sequence).toBe(0)
  })
})

// =========================================================================
// 4. JSONL Writer / Reader roundtrip
// =========================================================================

describe("JsonlEventWriter + JsonlEventReader", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "eventstore-test-"))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("writes and reads back events on a single stream", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    const e1 = await writer.append(STREAM_CREDIT, "credit_reserve", { amount: "100" }, "corr-1")
    const e2 = await writer.append(STREAM_CREDIT, "credit_consume", { amount: "50" }, "corr-2")
    await writer.close()

    expect(e1.sequence).toBe(1)
    expect(e2.sequence).toBe(2)
    expect(e1.stream).toBe(STREAM_CREDIT)
    expect(e1.schema_version).toBe(EVENT_ENVELOPE_SCHEMA_VERSION)
    expect(e1.event_id).toBeDefined()
    expect(e1.checksum).toMatch(/^[0-9a-f]{8}$/)

    // Read back
    const reader = new JsonlEventReader({ dir: testDir })
    const events: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_CREDIT)) {
      events.push(evt)
    }
    await reader.close()

    expect(events).toHaveLength(2)
    expect(events[0].sequence).toBe(1)
    expect(events[0].event_type).toBe("credit_reserve")
    expect(events[0].payload).toEqual({ amount: "100" })
    expect(events[1].sequence).toBe(2)
    expect(events[1].event_type).toBe("credit_consume")
  })

  it("assigns monotonically increasing sequences", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    const envelopes: EventEnvelope[] = []
    for (let i = 0; i < 10; i++) {
      envelopes.push(
        await writer.append(STREAM_BILLING, `event_${i}`, { i }, `corr-${i}`),
      )
    }
    await writer.close()

    for (let i = 1; i < envelopes.length; i++) {
      expect(envelopes[i].sequence).toBe(envelopes[i - 1].sequence + 1)
    }
    expect(envelopes[0].sequence).toBe(1)
    expect(envelopes[9].sequence).toBe(10)
  })

  it("maintains per-stream independent sequences", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    const b1 = await writer.append(STREAM_BILLING, "billing_reserve", {}, "c1")
    const c1 = await writer.append(STREAM_CREDIT, "credit_allocate", {}, "c2")
    const b2 = await writer.append(STREAM_BILLING, "billing_commit", {}, "c3")
    const c2 = await writer.append(STREAM_CREDIT, "credit_unlock", {}, "c4")
    await writer.close()

    // Billing stream: 1, 2
    expect(b1.sequence).toBe(1)
    expect(b2.sequence).toBe(2)
    // Credit stream: 1, 2
    expect(c1.sequence).toBe(1)
    expect(c2.sequence).toBe(2)
  })

  it("cross-stream replay isolates events by stream", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    await writer.append(STREAM_BILLING, "billing_reserve", { b: 1 }, "c1")
    await writer.append(STREAM_CREDIT, "credit_allocate", { c: 1 }, "c2")
    await writer.append(STREAM_BILLING, "billing_commit", { b: 2 }, "c3")
    await writer.append(STREAM_PERSONALITY, "personality_update", { p: 1 }, "c4")
    await writer.close()

    const reader = new JsonlEventReader({ dir: testDir })

    // Billing stream — 2 events
    const billingEvents: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_BILLING)) {
      billingEvents.push(evt)
    }
    expect(billingEvents).toHaveLength(2)
    expect(billingEvents[0].payload).toEqual({ b: 1 })
    expect(billingEvents[1].payload).toEqual({ b: 2 })

    // Credit stream — 1 event
    const creditEvents: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_CREDIT)) {
      creditEvents.push(evt)
    }
    expect(creditEvents).toHaveLength(1)

    // Personality stream — 1 event
    const personalityEvents: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_PERSONALITY)) {
      personalityEvents.push(evt)
    }
    expect(personalityEvents).toHaveLength(1)

    // Reconciliation stream — 0 events
    const reconEvents: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_RECONCILIATION)) {
      reconEvents.push(evt)
    }
    expect(reconEvents).toHaveLength(0)

    await reader.close()
  })

  it("cursor-based replay resumes after last_sequence", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    await writer.append(STREAM_CREDIT, "e1", { n: 1 }, "c1")
    await writer.append(STREAM_CREDIT, "e2", { n: 2 }, "c2")
    await writer.append(STREAM_CREDIT, "e3", { n: 3 }, "c3")
    await writer.append(STREAM_CREDIT, "e4", { n: 4 }, "c4")
    await writer.append(STREAM_CREDIT, "e5", { n: 5 }, "c5")
    await writer.close()

    const reader = new JsonlEventReader({ dir: testDir })

    // Replay from after sequence 3
    const events: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_CREDIT, {
      stream: STREAM_CREDIT,
      last_sequence: 3,
    })) {
      events.push(evt)
    }

    expect(events).toHaveLength(2)
    expect(events[0].sequence).toBe(4)
    expect(events[1].sequence).toBe(5)

    await reader.close()
  })

  it("getLatestSequence returns highest sequence for a stream", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    await writer.append(STREAM_BILLING, "e1", {}, "c1")
    await writer.append(STREAM_BILLING, "e2", {}, "c2")
    await writer.append(STREAM_BILLING, "e3", {}, "c3")
    await writer.close()

    const reader = new JsonlEventReader({ dir: testDir })
    const latest = await reader.getLatestSequence(STREAM_BILLING)
    expect(latest).toBe(3)

    // Empty stream
    const latestCredit = await reader.getLatestSequence(STREAM_CREDIT)
    expect(latestCredit).toBe(0)

    await reader.close()
  })

  it("CRC32 validation skips corrupt entries", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    const e1 = await writer.append(STREAM_CREDIT, "good1", { ok: true }, "c1")
    await writer.append(STREAM_CREDIT, "good2", { ok: true }, "c2")
    await writer.close()

    // Corrupt the checksum of the second event
    const { readdirSync } = await import("node:fs")
    const segments = readdirSync(testDir).filter((f: string) => f.endsWith(".jsonl"))
    expect(segments.length).toBeGreaterThan(0)

    const segPath = join(testDir, segments[0])
    const content = readFileSync(segPath, "utf-8")
    const lines = content.split("\n").filter((l: string) => l.trim())
    expect(lines.length).toBe(2)

    // Parse line 2 and corrupt its checksum
    const event2 = JSON.parse(lines[1])
    event2.checksum = "00000000" // invalid checksum
    const corrupted = lines[0] + "\n" + JSON.stringify(event2) + "\n"
    writeFileSync(segPath, corrupted, "utf-8")

    // Read back — should only yield 1 event (corrupt one skipped)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const reader = new JsonlEventReader({ dir: testDir })
    const events: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_CREDIT)) {
      events.push(evt)
    }
    await reader.close()

    expect(events).toHaveLength(1)
    expect(events[0].event_type).toBe("good1")
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("CRC32 mismatch"),
    )
    warnSpy.mockRestore()
  })

  it("torn-write recovery: incomplete last line is skipped", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    await writer.append(STREAM_BILLING, "complete", { ok: true }, "c1")
    await writer.close()

    // Append a torn write (incomplete JSON)
    const { readdirSync } = await import("node:fs")
    const segments = readdirSync(testDir).filter((f: string) => f.endsWith(".jsonl"))
    const segPath = join(testDir, segments[0])
    appendFileSync(segPath, '{"event_id":"torn","stream":"bill', "utf-8")

    // Reader should skip the torn line
    const reader = new JsonlEventReader({ dir: testDir })
    const events: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_BILLING)) {
      events.push(evt)
    }
    await reader.close()

    expect(events).toHaveLength(1)
    expect(events[0].event_type).toBe("complete")
  })

  it("sequence recovery: new writer resumes from previous max", async () => {
    // Write some events
    const writer1 = new JsonlEventWriter({ dir: testDir })
    await writer1.append(STREAM_CREDIT, "e1", {}, "c1")
    await writer1.append(STREAM_CREDIT, "e2", {}, "c2")
    await writer1.append(STREAM_CREDIT, "e3", {}, "c3")
    await writer1.close()

    // Create new writer — should resume from seq 3
    const writer2 = new JsonlEventWriter({ dir: testDir })
    const e4 = await writer2.append(STREAM_CREDIT, "e4", {}, "c4")
    await writer2.close()

    expect(e4.sequence).toBe(4)

    // Verify full replay
    const reader = new JsonlEventReader({ dir: testDir })
    const events: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_CREDIT)) {
      events.push(evt)
    }
    await reader.close()

    expect(events).toHaveLength(4)
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4])
  })

  it("segment rotation creates new file when max size exceeded", async () => {
    const writer = new JsonlEventWriter({
      dir: testDir,
      maxSegmentBytes: 100, // tiny max to force rotation
    })

    // Write enough events to exceed 100 bytes per segment
    const envelopes: EventEnvelope[] = []
    for (let i = 0; i < 5; i++) {
      envelopes.push(
        await writer.append(
          STREAM_BILLING,
          `event_${i}`,
          { data: "some payload data to exceed segment limit" },
          `corr-${i}`,
        ),
      )
    }
    await writer.close()

    // Verify multiple segment files were created
    const { readdirSync } = await import("node:fs")
    const segments = readdirSync(testDir).filter(
      (f: string) => f.startsWith("events-billing-") && f.endsWith(".jsonl"),
    )
    expect(segments.length).toBeGreaterThan(1)

    // Verify all events readable — collect and sort by sequence
    // (segment ULID filenames may not sort in creation order within same ms)
    const reader = new JsonlEventReader({ dir: testDir })
    const events: EventEnvelope[] = []
    for await (const evt of reader.replay(STREAM_BILLING)) {
      events.push(evt)
    }
    await reader.close()

    expect(events).toHaveLength(5)

    // All 5 sequences present (1-5)
    const seqs = events.map((e) => e.sequence).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })

  it("throws on append after close", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })
    await writer.close()

    await expect(
      writer.append(STREAM_BILLING, "event", {}, "corr"),
    ).rejects.toThrow(/closed/)
  })

  it("throws on replay after close", async () => {
    const reader = new JsonlEventReader({ dir: testDir })
    await reader.close()

    await expect(async () => {
      for await (const _ of reader.replay(STREAM_BILLING)) {
        // should not reach here
      }
    }).rejects.toThrow(/closed/)
  })

  it("rejects unregistered streams", async () => {
    const writer = new JsonlEventWriter({ dir: testDir })

    await expect(
      writer.append("not_a_stream" as EventStream, "event", {}, "corr"),
    ).rejects.toThrow(/Unknown event stream/)

    await writer.close()
  })
})

// =========================================================================
// 5. Credit adapter — EventWriter emission
// =========================================================================

describe("CreditSubLedger EventWriter emission (T1.5)", () => {
  it("emits credit transactions to EventWriter when set", async () => {
    // Dynamic import to avoid pulling in all credit deps at module scope
    const { CreditSubLedger } = await import("../../src/credits/rektdrop-ledger.js")

    const appendCalls: Array<{ stream: string; event_type: string; payload: any; correlation_id: string }> = []
    const mockWriter = {
      append: vi.fn(async (stream: any, event_type: string, payload: any, correlation_id: string) => {
        appendCalls.push({ stream, event_type, payload, correlation_id })
        return {
          event_id: "mock-id",
          stream,
          event_type,
          timestamp: Date.now(),
          correlation_id,
          sequence: appendCalls.length,
          checksum: "mock",
          schema_version: 1,
          payload,
        }
      }),
      close: vi.fn(async () => {}),
    }

    const ledger = new CreditSubLedger()
    ledger.setEventWriter(mockWriter)

    // Create an account (triggers an allocation transaction)
    ledger.createAccount("0x1111111111111111111111111111111111111111", "OG" as any)

    // Wait for fire-and-forget promises to settle
    await new Promise((r) => setTimeout(r, 50))

    expect(appendCalls.length).toBeGreaterThanOrEqual(1)
    expect(appendCalls[0].stream).toBe("credit")
    expect(appendCalls[0].event_type).toBe("rektdrop_allocate")
    expect(appendCalls[0].payload.amount).toBeDefined()
  })

  it("does not emit when eventWriter is null", async () => {
    const { CreditSubLedger } = await import("../../src/credits/rektdrop-ledger.js")

    const ledger = new CreditSubLedger()
    // No writer set — should not throw or emit

    const account = ledger.createAccount("0x2222222222222222222222222222222222222222", "COMMUNITY" as any)
    expect(account).toBeDefined()
    expect(account.balances.ALLOCATED).toBeGreaterThan(0n)
  })

  it("emission failure does not block credit operations", async () => {
    const { CreditSubLedger } = await import("../../src/credits/rektdrop-ledger.js")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const failingWriter = {
      append: vi.fn(async () => {
        throw new Error("EventStore unavailable")
      }),
      close: vi.fn(async () => {}),
    }

    const ledger = new CreditSubLedger()
    ledger.setEventWriter(failingWriter)

    // This should NOT throw despite EventWriter failure
    const account = ledger.createAccount("0x3333333333333333333333333333333333333333", "CONTRIBUTOR" as any)
    expect(account).toBeDefined()

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50))

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EventStore emission failed"),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })
})

// =========================================================================
// 6. Billing adapter — EventWriter emission
// =========================================================================

// Mock the hounfour dependency since we don't have it in test
vi.mock("@0xhoneyjar/loa-hounfour", () => ({}))
vi.mock("../../src/hounfour/wire-boundary.js", () => ({
  parseMicroUSD: vi.fn((v: unknown) => v),
  serializeMicroUSD: vi.fn((v: unknown) => String(v)),
}))

describe("BillingStateMachine EventWriter emission (T1.6)", () => {
  it("emits billing events to EventWriter when provided in deps", async () => {
    const { BillingStateMachine, _resetWALSequence } = await import(
      "../../src/billing/state-machine.js"
    )
    _resetWALSequence()

    const appendCalls: Array<{ stream: string; event_type: string; payload: any }> = []
    const mockEventWriter = {
      append: vi.fn(async (stream: any, event_type: string, payload: any, _corr: string) => {
        appendCalls.push({ stream, event_type, payload })
        return {
          event_id: "mock-id",
          stream,
          event_type,
          timestamp: Date.now(),
          correlation_id: _corr,
          sequence: appendCalls.length,
          checksum: "mock",
          schema_version: 1,
          payload,
        }
      }),
      close: vi.fn(async () => {}),
    }

    const sm = new BillingStateMachine({
      walAppend: vi.fn(() => "wal-offset-1"),
      redisUpdate: vi.fn(async () => {}),
      enqueueFinalze: vi.fn(async () => {}),
      generateId: vi.fn(() => "01HTEST00000000000000000001" as any),
      eventWriter: mockEventWriter,
    })

    await sm.reserve("account-1", "1000" as any, "corr-reserve", null as any)

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50))

    expect(appendCalls.length).toBeGreaterThanOrEqual(1)
    expect(appendCalls[0].stream).toBe("billing")
    expect(appendCalls[0].event_type).toBe("billing_reserve")
  })

  it("does not emit when eventWriter is not provided", async () => {
    const { BillingStateMachine, _resetWALSequence } = await import(
      "../../src/billing/state-machine.js"
    )
    _resetWALSequence()

    const walAppend = vi.fn(() => "wal-offset-1")

    const sm = new BillingStateMachine({
      walAppend,
      redisUpdate: vi.fn(async () => {}),
      enqueueFinalze: vi.fn(async () => {}),
      generateId: vi.fn(() => "01HTEST00000000000000000002" as any),
      // No eventWriter
    })

    // Should work fine without eventWriter
    const entry = await sm.reserve("account-2", "2000" as any, "corr-no-emit", null as any)
    expect(entry).toBeDefined()
    expect(entry.state).toBe("RESERVE_HELD")
    expect(walAppend).toHaveBeenCalledOnce()
  })

  it("emission failure does not block billing state transitions", async () => {
    const { BillingStateMachine, _resetWALSequence } = await import(
      "../../src/billing/state-machine.js"
    )
    _resetWALSequence()

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const failingEventWriter = {
      append: vi.fn(async () => {
        throw new Error("EventStore unavailable")
      }),
      close: vi.fn(async () => {}),
    }

    const sm = new BillingStateMachine({
      walAppend: vi.fn(() => "wal-offset-1"),
      redisUpdate: vi.fn(async () => {}),
      enqueueFinalze: vi.fn(async () => {}),
      generateId: vi.fn(() => "01HTEST00000000000000000003" as any),
      eventWriter: failingEventWriter,
    })

    // Reserve should succeed despite EventWriter failure
    const entry = await sm.reserve("account-3", "3000" as any, "corr-fail", null as any)
    expect(entry).toBeDefined()
    expect(entry.state).toBe("RESERVE_HELD")

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50))

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EventStore emission failed"),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it("emits for all state transitions in a billing lifecycle", async () => {
    const { BillingStateMachine, _resetWALSequence } = await import(
      "../../src/billing/state-machine.js"
    )
    _resetWALSequence()

    const emittedTypes: string[] = []
    const mockEventWriter = {
      append: vi.fn(async (_stream: any, event_type: string, _payload: any, _corr: string) => {
        emittedTypes.push(event_type)
        return {
          event_id: "mock-id",
          stream: _stream,
          event_type,
          timestamp: Date.now(),
          correlation_id: _corr,
          sequence: emittedTypes.length,
          checksum: "mock",
          schema_version: 1,
          payload: _payload,
        }
      }),
      close: vi.fn(async () => {}),
    }

    const sm = new BillingStateMachine({
      walAppend: vi.fn(() => "wal-offset"),
      redisUpdate: vi.fn(async () => {}),
      enqueueFinalze: vi.fn(async () => {}),
      generateId: vi.fn(() => "01HTEST00000000000000000004" as any),
      eventWriter: mockEventWriter,
    })

    // Full lifecycle: reserve → commit → finalizeAck
    const reserved = await sm.reserve("acct", "1000" as any, "corr-lifecycle", null as any)
    const committed = await sm.commit(reserved, "800" as any)
    await sm.finalizeAck(committed, 200)

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50))

    expect(emittedTypes).toEqual([
      "billing_reserve",
      "billing_commit",
      "billing_finalize_ack",
    ])
  })
})

// =========================================================================
// 7. Backward compatibility — WAL format unchanged
// =========================================================================

describe("Backward compatibility", () => {
  it("billing WAL format is unchanged (walAppend called with same envelope shape)", async () => {
    const { BillingStateMachine, _resetWALSequence } = await import(
      "../../src/billing/state-machine.js"
    )
    _resetWALSequence()

    const walEnvelopes: any[] = []
    const walAppend = vi.fn((envelope: any) => {
      walEnvelopes.push(JSON.parse(JSON.stringify(envelope, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )))
      return "wal-offset-compat"
    })

    const sm = new BillingStateMachine({
      walAppend,
      redisUpdate: vi.fn(async () => {}),
      enqueueFinalze: vi.fn(async () => {}),
      generateId: vi.fn(() => "01HTEST00000000000000000005" as any),
      eventWriter: {
        append: vi.fn(async () => ({}) as any),
        close: vi.fn(async () => {}),
      },
    })

    await sm.reserve("acct-compat", "5000" as any, "corr-compat", null as any)

    expect(walAppend).toHaveBeenCalledOnce()
    const envelope = walEnvelopes[0]

    // Verify WAL envelope shape is preserved
    expect(envelope).toHaveProperty("schema_version", 1)
    expect(envelope).toHaveProperty("event_type", "billing_reserve")
    expect(envelope).toHaveProperty("timestamp")
    expect(envelope).toHaveProperty("billing_entry_id")
    expect(envelope).toHaveProperty("correlation_id", "corr-compat")
    expect(envelope).toHaveProperty("checksum")
    expect(envelope).toHaveProperty("wal_sequence")
    expect(envelope).toHaveProperty("payload")
    expect(envelope.payload).toHaveProperty("account_id", "acct-compat")
  })

  it("credit conservation invariant preserved after EventWriter integration", async () => {
    const { CreditSubLedger } = await import("../../src/credits/rektdrop-ledger.js")

    const mockWriter = {
      append: vi.fn(async () => ({}) as any),
      close: vi.fn(async () => {}),
    }

    const ledger = new CreditSubLedger()
    ledger.setEventWriter(mockWriter)

    // Full credit lifecycle
    ledger.createAccount("0x4444444444444444444444444444444444444444", "OG" as any)
    ledger.unlock("0x4444444444444444444444444444444444444444", 5000n, "corr-unlock", "idem-unlock-1")
    ledger.reserve("0x4444444444444444444444444444444444444444", 2000n, "corr-reserve", "idem-reserve-1")
    ledger.consume("0x4444444444444444444444444444444444444444", 1000n, "corr-consume", "idem-consume-1")
    ledger.release("0x4444444444444444444444444444444444444444", 1000n, "corr-release", "idem-release-1")

    // Verify conservation invariant
    expect(ledger.verifyConservation("0x4444444444444444444444444444444444444444")).toBe(true)

    const account = ledger.getAccount("0x4444444444444444444444444444444444444444")!
    const total =
      account.balances.ALLOCATED +
      account.balances.UNLOCKED +
      account.balances.RESERVED +
      account.balances.CONSUMED +
      account.balances.EXPIRED
    expect(total).toBe(account.initial_allocation)
  })
})
