// tests/billing/reconciliation-audit.test.ts — T2.2: Reconciliation audit trail (Bridge medium-2)
//
// Before overwriting Redis with derived balance, the reconciliation service
// appends a RECONCILIATION_CORRECTION event to WAL with both old and new values.

import { describe, it, expect, vi } from "vitest"
import {
  ReconciliationService,
  type ReconciliationDeps,
} from "../../src/billing/reconciliation.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<ReconciliationDeps> = {}): ReconciliationDeps {
  return {
    getAllJournalEntries: vi.fn(async () => []),
    redisGet: vi.fn(async () => null),
    redisSet: vi.fn(async () => {}),
    walAppend: vi.fn(async () => "wal-offset"),
    alertDivergence: vi.fn(async () => {}),
    alertRoundingDrift: vi.fn(async () => {}),
    generateRunId: vi.fn(() => "recon-test-run-1"),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reconciliation Audit Trail (Bridge medium-2)", () => {
  it("appends RECONCILIATION_CORRECTION to WAL before overwriting Redis on divergence", async () => {
    const walAppendCalls: unknown[] = []
    const redisSetCalls: string[][] = []

    const deps = makeDeps({
      getAllJournalEntries: vi.fn(async () => [
        {
          id: "j1",
          postings: [
            { account: "acct:revenue", delta: 1000n, denom: "MICRO_USD", metadata: {} },
          ],
          timestamp: Date.now(),
          correlation_id: "corr-1",
        },
      ]),
      redisGet: vi.fn(async (key: string) => {
        // Redis has stale balance of 500 (derived is 1000)
        if (key === "balance:acct:revenue:value") return "500"
        return null
      }),
      walAppend: vi.fn(async (_type: string, payload: unknown) => {
        walAppendCalls.push(payload)
        return "wal-offset"
      }),
      redisSet: vi.fn(async (key: string, value: string) => {
        redisSetCalls.push([key, value])
      }),
    })

    const svc = new ReconciliationService(deps)
    const result = await svc.reconcile()

    expect(result.divergences_found).toBe(1)
    expect(result.divergences_corrected).toBe(1)

    // WAL should have been called at least twice:
    // 1. RECONCILIATION_CORRECTION for the divergent account
    // 2. Final reconciliation summary
    expect(walAppendCalls.length).toBeGreaterThanOrEqual(2)

    // First WAL append should be the correction
    const correction = walAppendCalls[0] as Record<string, unknown>
    expect(correction.correction_type).toBe("RECONCILIATION_CORRECTION")
    expect(correction.account).toBe("acct:revenue")
    expect(correction.derived_balance).toBe("1000")
    expect(correction.cached_balance).toBe("500")
    expect(correction.delta).toBe("500")
    expect(correction.reconciliation_run_id).toBe("recon-test-run-1")
    expect(correction.timestamp).toBeDefined()

    // Redis overwrite should happen after WAL append
    expect(redisSetCalls).toHaveLength(1)
    expect(redisSetCalls[0]).toEqual(["balance:acct:revenue:value", "1000"])
  })

  it("does not append correction when no divergence exists", async () => {
    const walAppend = vi.fn(async () => "wal-offset")

    const deps = makeDeps({
      getAllJournalEntries: vi.fn(async () => [
        {
          id: "j1",
          postings: [
            { account: "acct:revenue", delta: 1000n, denom: "MICRO_USD", metadata: {} },
          ],
          timestamp: Date.now(),
          correlation_id: "corr-1",
        },
      ]),
      redisGet: vi.fn(async (key: string) => {
        // Redis matches derived
        if (key === "balance:acct:revenue:value") return "1000"
        return null
      }),
      walAppend,
    })

    const svc = new ReconciliationService(deps)
    const result = await svc.reconcile()

    expect(result.divergences_found).toBe(0)

    // Only the final summary WAL entry — no corrections
    expect(walAppend).toHaveBeenCalledOnce()
    const summary = walAppend.mock.calls[0][1] as Record<string, unknown>
    expect(summary.divergences_found).toBe(0)
  })

  it("correction entry includes both old and new values for each divergent account", async () => {
    const walAppendCalls: unknown[] = []

    const deps = makeDeps({
      getAllJournalEntries: vi.fn(async () => [
        {
          id: "j1",
          postings: [
            { account: "acct:alice", delta: 500n, denom: "MICRO_USD", metadata: {} },
            { account: "acct:bob", delta: 300n, denom: "MICRO_USD", metadata: {} },
          ],
          timestamp: Date.now(),
          correlation_id: "corr-1",
        },
      ]),
      redisGet: vi.fn(async (key: string) => {
        // Both accounts diverged
        if (key === "balance:acct:alice:value") return "100" // derived 500, cached 100
        if (key === "balance:acct:bob:value") return "300" // derived 300, cached 300 — no divergence
        return null
      }),
      walAppend: vi.fn(async (_type: string, payload: unknown) => {
        walAppendCalls.push(payload)
        return "wal-offset"
      }),
    })

    const svc = new ReconciliationService(deps)
    const result = await svc.reconcile()

    expect(result.divergences_found).toBe(1) // Only alice diverged
    expect(result.divergences_corrected).toBe(1)

    // One correction + one summary
    expect(walAppendCalls).toHaveLength(2)

    const correction = walAppendCalls[0] as Record<string, unknown>
    expect(correction.correction_type).toBe("RECONCILIATION_CORRECTION")
    expect(correction.account).toBe("acct:alice")
    expect(correction.derived_balance).toBe("500")
    expect(correction.cached_balance).toBe("100")
    expect(correction.delta).toBe("400")
  })

  it("uses generateRunId when provided", async () => {
    const walAppendCalls: unknown[] = []

    const deps = makeDeps({
      getAllJournalEntries: vi.fn(async () => [
        {
          id: "j1",
          postings: [
            { account: "acct:test", delta: 100n, denom: "MICRO_USD", metadata: {} },
          ],
          timestamp: Date.now(),
          correlation_id: "corr-1",
        },
      ]),
      redisGet: vi.fn(async () => "50"), // divergence
      generateRunId: vi.fn(() => "custom-run-id-abc"),
      walAppend: vi.fn(async (_type: string, payload: unknown) => {
        walAppendCalls.push(payload)
        return "wal-offset"
      }),
    })

    const svc = new ReconciliationService(deps)
    await svc.reconcile()

    const correction = walAppendCalls[0] as Record<string, unknown>
    expect(correction.reconciliation_run_id).toBe("custom-run-id-abc")

    const summary = walAppendCalls[1] as Record<string, unknown>
    expect(summary.reconciliation_run_id).toBe("custom-run-id-abc")
  })
})
