// tests/billing/wal-sequence.test.ts — T1.4: WAL replay uses monotonic sequence
//
// Bridge high-4 fix: WAL replay uses wal_sequence (monotonic integer) instead
// of billing_entry_id (ULID) for ordering. ULIDs don't guarantee strict ordering
// across processes; sequence numbers do.

import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock transitive hounfour dependency (not installed in test env)
vi.mock("@0xhoneyjar/loa-hounfour", () => ({}))
vi.mock("../../src/hounfour/wire-boundary.js", () => ({
  parseMicroUSD: vi.fn(),
  serializeMicroUSD: vi.fn((v: unknown) => String(v)),
}))

import {
  createBillingWALEnvelope,
  _resetWALSequence,
  nextWALSequence,
  setWALSequence,
} from "../../src/billing/state-machine.js"
import { type BillingEntryId } from "../../src/billing/types.js"

// ---------------------------------------------------------------------------
// WAL Sequence Counter
// ---------------------------------------------------------------------------

describe("WAL Sequence Counter (Bridge high-4)", () => {
  beforeEach(() => {
    _resetWALSequence()
  })

  it("generates strictly monotonic sequence numbers", () => {
    const seq1 = nextWALSequence()
    const seq2 = nextWALSequence()
    const seq3 = nextWALSequence()

    expect(seq1).toBe(1)
    expect(seq2).toBe(2)
    expect(seq3).toBe(3)
    expect(seq2).toBeGreaterThan(seq1)
    expect(seq3).toBeGreaterThan(seq2)
  })

  it("can be set to a known value for startup recovery", () => {
    setWALSequence(1000)

    const next = nextWALSequence()
    expect(next).toBe(1001)
  })

  it("resets for testing", () => {
    nextWALSequence()
    nextWALSequence()
    _resetWALSequence()

    expect(nextWALSequence()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// WAL Envelope includes wal_sequence
// ---------------------------------------------------------------------------

describe("WAL Envelope — wal_sequence field (Bridge high-4)", () => {
  beforeEach(() => {
    _resetWALSequence()
  })

  it("includes wal_sequence on every envelope", () => {
    const entryId = "01HXYZ1234567890ABCDEFGHIJ" as BillingEntryId
    const envelope = createBillingWALEnvelope(
      "billing_reserve",
      entryId,
      "corr-1",
      { account_id: "test", estimated_cost: "100", exchange_rate_snapshot: null },
    )

    expect(envelope.wal_sequence).toBeDefined()
    expect(typeof envelope.wal_sequence).toBe("number")
    expect(envelope.wal_sequence).toBe(1)
  })

  it("assigns strictly increasing sequences across envelopes", () => {
    const entryId1 = "01HXYZ1234567890ABCDEFGHIJ" as BillingEntryId
    const entryId2 = "01HXYZ1234567890ABCDEFGHIK" as BillingEntryId

    const env1 = createBillingWALEnvelope("billing_reserve", entryId1, "corr-1", {})
    const env2 = createBillingWALEnvelope("billing_commit", entryId2, "corr-2", {})

    expect(env2.wal_sequence!).toBeGreaterThan(env1.wal_sequence!)
  })

  it("WAL entries from interleaved processes replay in sequence order", () => {
    // Simulate two "processes" generating entries with different timestamps
    // but sequential wal_sequence numbers
    const entries = [
      createBillingWALEnvelope("billing_reserve", "01PROC1_AAA_AAAAAAAAAAAAA" as BillingEntryId, "p1-1", {}),
      createBillingWALEnvelope("billing_reserve", "01PROC2_BBB_BBBBBBBBBBBBB" as BillingEntryId, "p2-1", {}),
      createBillingWALEnvelope("billing_commit", "01PROC1_AAA_AAAAAAAAAAAAA" as BillingEntryId, "p1-2", {}),
      createBillingWALEnvelope("billing_commit", "01PROC2_BBB_BBBBBBBBBBBBB" as BillingEntryId, "p2-2", {}),
    ]

    // Verify sequence is strictly monotonic regardless of billing_entry_id ordering
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].wal_sequence!).toBeGreaterThan(entries[i - 1].wal_sequence!)
    }

    // Even if we sort by billing_entry_id (ULID), the sequence tells us the real order
    const sortedByEntryId = [...entries].sort((a, b) =>
      a.billing_entry_id.localeCompare(b.billing_entry_id),
    )
    const sortedBySequence = [...entries].sort((a, b) =>
      a.wal_sequence! - b.wal_sequence!,
    )

    // Sequence-sorted order is the authoritative replay order
    expect(sortedBySequence.map(e => e.wal_sequence)).toEqual([1, 2, 3, 4])
  })
})
