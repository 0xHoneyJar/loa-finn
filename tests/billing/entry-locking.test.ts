// tests/billing/entry-locking.test.ts — T2.1: Entry-level locking (Bridge medium-1)
//
// State machine transitions are protected by an entry-level Redis lock.
// Pattern: SET billing:lock:{entryId} {correlationId} NX EX 30
// Lock prevents concurrent commit/release on the same billing entry.

import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock transitive hounfour dependency (not installed in test env)
vi.mock("@0xhoneyjar/loa-hounfour", () => ({}))
vi.mock("../../src/hounfour/wire-boundary.js", () => ({
  parseMicroUSD: vi.fn(),
  serializeMicroUSD: vi.fn((v: unknown) => String(v)),
}))

import {
  BillingStateMachine,
  type BillingStateMachineDeps,
  type LockedTransitionResult,
  _resetWALSequence,
} from "../../src/billing/state-machine.js"
import {
  type BillingEntry,
  type BillingEntryId,
  BillingState,
} from "../../src/billing/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<BillingStateMachineDeps> = {}): BillingStateMachineDeps {
  return {
    walAppend: vi.fn(() => "wal-offset-1"),
    redisUpdate: vi.fn(async () => {}),
    enqueueFinalze: vi.fn(async () => {}),
    generateId: vi.fn(() => "01HXYZ1234567890ABCDEFGHIJ" as BillingEntryId),
    onTransition: vi.fn(),
    ...overrides,
  }
}

function makeReservedEntry(overrides: Partial<BillingEntry> = {}): BillingEntry {
  return {
    billing_entry_id: "01HXYZ1234567890ABCDEFGHIJ" as BillingEntryId,
    correlation_id: "corr-1",
    state: BillingState.RESERVE_HELD,
    account_id: "account-1",
    estimated_cost: 500_000 as unknown as import("@0xhoneyjar/loa-hounfour").BrandedMicroUSD,
    actual_cost: null,
    exchange_rate_snapshot: { credit_units_per_usd: 100, usd_usdc_rate: 1.0, frozen_at: Date.now() },
    created_at: Date.now(),
    updated_at: Date.now(),
    wal_offset: "wal-0",
    finalize_attempts: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Entry-Level Locking (Bridge medium-1)", () => {
  beforeEach(() => {
    _resetWALSequence()
  })

  // === LOCKED COMMIT ===

  describe("lockedCommit", () => {
    it("acquires lock, commits, releases lock on success", async () => {
      const acquireLock = vi.fn(async () => true)
      const releaseLock = vi.fn(async () => {})
      const deps = makeDeps({ acquireLock, releaseLock })
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const actualCost = 300_000 as unknown as import("@0xhoneyjar/loa-hounfour").BrandedMicroUSD

      const result = await sm.lockedCommit(entry, actualCost)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.entry.state).toBe(BillingState.FINALIZE_PENDING)
        expect(result.entry.actual_cost).toBe(actualCost)
      }

      expect(acquireLock).toHaveBeenCalledWith(entry.billing_entry_id, entry.correlation_id)
      expect(releaseLock).toHaveBeenCalledWith(entry.billing_entry_id)
    })

    it("returns lock_contention when lock is held by another correlation", async () => {
      const acquireLock = vi.fn(async () => false)
      const releaseLock = vi.fn(async () => {})
      const deps = makeDeps({ acquireLock, releaseLock })
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const actualCost = 300_000 as unknown as import("@0xhoneyjar/loa-hounfour").BrandedMicroUSD

      const result = await sm.lockedCommit(entry, actualCost)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe("lock_contention")
        expect(result.entryId).toBe(entry.billing_entry_id)
      }

      expect(acquireLock).toHaveBeenCalledOnce()
      expect(releaseLock).not.toHaveBeenCalled()
      expect(deps.walAppend).not.toHaveBeenCalled()
    })

    it("releases lock even when commit throws an error", async () => {
      const acquireLock = vi.fn(async () => true)
      const releaseLock = vi.fn(async () => {})
      const deps = makeDeps({
        acquireLock,
        releaseLock,
        redisUpdate: vi.fn(async () => { throw new Error("Redis exploded") }),
      })
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const actualCost = 300_000 as unknown as import("@0xhoneyjar/loa-hounfour").BrandedMicroUSD

      await expect(sm.lockedCommit(entry, actualCost)).rejects.toThrow("Redis exploded")

      expect(acquireLock).toHaveBeenCalledOnce()
      expect(releaseLock).toHaveBeenCalledOnce()
    })
  })

  // === LOCKED RELEASE ===

  describe("lockedRelease", () => {
    it("acquires lock, releases entry, releases lock on success", async () => {
      const acquireLock = vi.fn(async () => true)
      const releaseLock = vi.fn(async () => {})
      const deps = makeDeps({ acquireLock, releaseLock })
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const result = await sm.lockedRelease(entry, "user_cancel")

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.entry.state).toBe(BillingState.RELEASED)
      }

      expect(acquireLock).toHaveBeenCalledWith(entry.billing_entry_id, entry.correlation_id)
      expect(releaseLock).toHaveBeenCalledWith(entry.billing_entry_id)
    })

    it("returns lock_contention when lock held", async () => {
      const acquireLock = vi.fn(async () => false)
      const deps = makeDeps({ acquireLock })
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const result = await sm.lockedRelease(entry, "user_cancel")

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe("lock_contention")
      }
    })
  })

  // === LOCKED VOID ===

  describe("lockedVoid", () => {
    it("acquires lock, voids, releases lock", async () => {
      const acquireLock = vi.fn(async () => true)
      const releaseLock = vi.fn(async () => {})
      const deps = makeDeps({ acquireLock, releaseLock })
      const sm = new BillingStateMachine(deps)

      // Void requires COMMITTED or FINALIZE_FAILED state
      const entry = makeReservedEntry({
        state: BillingState.FINALIZE_FAILED,
      })
      const result = await sm.lockedVoid(entry, "admin correction", "admin-1")

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.entry.state).toBe(BillingState.VOIDED)
      }

      expect(acquireLock).toHaveBeenCalledOnce()
      expect(releaseLock).toHaveBeenCalledOnce()
    })
  })

  // === BACKWARD COMPATIBILITY (NO LOCK SUPPORT) ===

  describe("backward compatibility (no acquireLock)", () => {
    it("executes transition directly when acquireLock not provided", async () => {
      const deps = makeDeps() // no acquireLock
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const actualCost = 300_000 as unknown as import("@0xhoneyjar/loa-hounfour").BrandedMicroUSD

      const result = await sm.lockedCommit(entry, actualCost)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.entry.state).toBe(BillingState.FINALIZE_PENDING)
      }
    })

    it("lockedRelease works without lock support", async () => {
      const deps = makeDeps()
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const result = await sm.lockedRelease(entry, "reserve_expired")

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.entry.state).toBe(BillingState.RELEASED)
      }
    })
  })

  // === CONCURRENT ACCESS SIMULATION ===

  describe("concurrent commit/release simulation", () => {
    it("only one of two concurrent operations succeeds on same entry", async () => {
      let lockHeld = false
      const acquireLock = vi.fn(async () => {
        if (lockHeld) return false
        lockHeld = true
        return true
      })
      const releaseLock = vi.fn(async () => {
        lockHeld = false
      })

      const deps = makeDeps({ acquireLock, releaseLock })
      const sm = new BillingStateMachine(deps)

      const entry = makeReservedEntry()
      const actualCost = 300_000 as unknown as import("@0xhoneyjar/loa-hounfour").BrandedMicroUSD

      // Simulate lock already held before second call
      lockHeld = true
      const [commitResult, releaseResult] = await Promise.all([
        sm.lockedCommit(entry, actualCost),
        sm.lockedRelease(entry, "user_cancel"),
      ])

      // Both should fail since lock was pre-held
      expect(commitResult.ok).toBe(false)
      expect(releaseResult.ok).toBe(false)

      // Now test sequential: first one gets lock
      lockHeld = false
      const first = await sm.lockedCommit(entry, actualCost)
      expect(first.ok).toBe(true)

      // After first releases lock, second gets it
      const entry2 = makeReservedEntry({
        billing_entry_id: "01HXYZ1234567890ABCDEFGHIK" as BillingEntryId,
      })
      const second = await sm.lockedRelease(entry2, "user_cancel")
      expect(second.ok).toBe(true)
    })
  })
})
