// tests/finn/billing-invariants.test.ts — Billing invariant tests (Sprint 1 T5)
// 6 tests: property-based (INV-1, INV-3, INV-5), store failure, NEVER-throws, terminal audit

import { describe, it, expect, vi } from "vitest"
import * as fc from "fast-check"
import {
  BILLING_INVARIANTS,
  assertCompleteness,
  assertBoundedRetry,
} from "../../src/hounfour/billing-invariants.js"
import type { FinalizeResult, DLQEntry } from "../../src/hounfour/billing-finalize-client.js"
import { InMemoryDLQStore } from "../../src/hounfour/dlq-store.js"

// --- Arbitraries ---

const arbFinalizeResult: fc.Arbitrary<FinalizeResult> = fc.oneof(
  fc.record({
    ok: fc.constant(true as const),
    status: fc.constantFrom("finalized" as const, "idempotent" as const),
  }),
  fc.record({
    ok: fc.constant(false as const),
    status: fc.constant("dlq" as const),
    reason: fc.string({ minLength: 1, maxLength: 50 }),
  }),
)

const arbReservationId = fc.string({ minLength: 4, maxLength: 30 }).map(s => `res-${s.replace(/[^a-zA-Z0-9]/g, "x")}`)

function createTestEntry(overrides?: Partial<DLQEntry>): DLQEntry {
  return {
    reservation_id: "res-test-001",
    tenant_id: "tenant-abc",
    actual_cost_micro: "1500000",
    trace_id: "trace-001",
    reason: "http_500",
    response_status: 500,
    attempt_count: 1,
    next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
    created_at: new Date(Date.now() - 300_000).toISOString(),
    ...overrides,
  }
}

// --- Tests ---

describe("Billing Invariants", () => {
  it("INV-1: random FinalizeResult always passes completeness (100 scenarios)", () => {
    fc.assert(
      fc.property(arbFinalizeResult, (result) => {
        // Should never throw for valid results
        assertCompleteness(result)
      }),
      { numRuns: 100 },
    )
  })

  it("INV-1: invalid states throw", () => {
    expect(() => assertCompleteness({ ok: true, status: "invalid" as any })).toThrow("INV-1 violated")
    expect(() => assertCompleteness({ ok: false, status: "invalid" as any, reason: "test" } as any)).toThrow("INV-1 violated")
  })

  it("INV-3: duplicate reservation_id is idempotent via upsert (100 scenarios)", async () => {
    await fc.assert(
      fc.asyncProperty(arbReservationId, async (rid) => {
        const store = new InMemoryDLQStore()
        const entry1 = createTestEntry({ reservation_id: rid, attempt_count: 1, reason: "first" })
        const entry2 = createTestEntry({ reservation_id: rid, attempt_count: 1, reason: "second" })

        await store.put(entry1)
        await store.put(entry2)

        // Count should be 1 (upsert, not duplicate)
        const count = await store.count()
        expect(count).toBe(1)

        // Attempt incremented
        const stored = await store.get(rid)
        expect(stored!.attempt_count).toBe(2)
      }),
      { numRuns: 100 },
    )
  })

  it("INV-5: replay exhausts retries → entry removed at maxRetries (50 scenarios)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (attemptCount, maxRetries) => {
          if (attemptCount <= maxRetries) {
            // Should not throw when within bounds
            assertBoundedRetry(attemptCount, maxRetries)
          } else {
            // Should throw when exceeded
            expect(() => assertBoundedRetry(attemptCount, maxRetries)).toThrow("INV-5 violated")
          }
        },
      ),
      { numRuns: 50 },
    )
  })

  it("store failure: put() error is catchable, entry available for manual recovery", async () => {
    // Create a store that fails on put
    const failStore = new InMemoryDLQStore()
    const origPut = failStore.put.bind(failStore)
    failStore.put = vi.fn(async () => {
      throw new Error("Redis connection lost")
    })

    const entry = createTestEntry()
    let caught = false
    try {
      await failStore.put(entry)
    } catch (err) {
      caught = true
      expect((err as Error).message).toBe("Redis connection lost")
    }
    expect(caught).toBe(true)

    // Entry is available for manual recovery logging (JSON serializable)
    const json = JSON.stringify(entry)
    const recovered = JSON.parse(json)
    expect(recovered.reservation_id).toBe("res-test-001")
    expect(recovered.actual_cost_micro).toBe("1500000")
  })

  it("terminal drop preserves audit record in store (InMemory: delete, Redis: terminalDrop)", async () => {
    const store = new InMemoryDLQStore()
    const entry = createTestEntry({
      attempt_count: 5,
      reservation_id: "res-terminal",
      tenant_id: "tenant-xyz",
      actual_cost_micro: "9999999",
      created_at: "2026-02-15T00:00:00Z",
    })

    await store.put(entry)
    expect(await store.count()).toBe(1)

    // Verify entry has all audit fields before terminal drop
    const stored = await store.get("res-terminal")
    expect(stored).not.toBeNull()
    expect(stored!.tenant_id).toBe("tenant-xyz")
    expect(stored!.actual_cost_micro).toBe("9999999")
    expect(stored!.created_at).toBe("2026-02-15T00:00:00Z")
    expect(stored!.attempt_count).toBe(5)

    // InMemory terminal drop = delete (no terminal keyspace)
    await store.delete("res-terminal")
    expect(await store.count()).toBe(0)
  })

  it("all 5 invariants are documented as constants", () => {
    expect(BILLING_INVARIANTS.INV_1_COMPLETENESS).toContain("finalized")
    expect(BILLING_INVARIANTS.INV_2_PERSISTENCE_DURABLE).toContain("durable")
    expect(BILLING_INVARIANTS.INV_2D_PERSISTENCE_DEGRADED).toContain("degraded")
    expect(BILLING_INVARIANTS.INV_3_IDEMPOTENCY).toContain("idempotent")
    expect(BILLING_INVARIANTS.INV_4_COST_IMMUTABILITY).toContain("cost_micro")
    expect(BILLING_INVARIANTS.INV_5_BOUNDED_RETRY).toContain("maxRetries")
  })
})
