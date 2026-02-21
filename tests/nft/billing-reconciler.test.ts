// tests/nft/billing-reconciler.test.ts — Billing Reconciler Tests (Sprint 5 T5.5)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { BillingReconciler } from "../../src/nft/billing-reconciler.js"
import type { ReconcilerPg, BillingEvent, ReconcilerLogger } from "../../src/nft/billing-reconciler.js"
import type { OnChainReader } from "../../src/nft/on-chain-reader.js"

// ---------------------------------------------------------------------------
// Mock OnChainReader
// ---------------------------------------------------------------------------

function createMockReader(opts: {
  ownerOf?: Record<string, string>
  failTokens?: Set<string>
} = {}): OnChainReader {
  return {
    readOwner: vi.fn().mockImplementation(async (tokenId: string) => {
      if (opts.failTokens?.has(tokenId)) {
        throw new Error(`Token ${tokenId} not found`)
      }
      return opts.ownerOf?.[tokenId] ?? "0xowner"
    }),
  } as unknown as OnChainReader
}

// ---------------------------------------------------------------------------
// Mock Postgres
// ---------------------------------------------------------------------------

function createMockPg(events: BillingEvent[]): ReconcilerPg & { flaggedIds: string[] } {
  const flaggedIds: string[] = []
  return {
    flaggedIds,
    async getRecentBillingEvents() {
      return events
    },
    async flagEventAsReorged(eventId: string) {
      flaggedIds.push(eventId)
    },
  }
}

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------

function createMockLogger(): ReconcilerLogger & {
  infos: string[]
  warns: string[]
  errors: string[]
} {
  const infos: string[] = []
  const warns: string[] = []
  const errors: string[] = []
  return {
    infos,
    warns,
    errors,
    info: (msg: string) => infos.push(msg),
    warn: (msg: string) => warns.push(msg),
    error: (msg: string) => errors.push(msg),
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<BillingEvent> = {}): BillingEvent {
  return {
    id: overrides.id ?? "evt-001",
    apiKeyId: "key-001",
    requestId: "req-001",
    amountMicro: 1000,
    eventType: "debit",
    metadata: overrides.metadata ?? { token_id: "42", tx_hash: "0xabc" },
    createdAt: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T5.5: BillingReconciler — reconcile pass", () => {
  it("checks recent billing events", async () => {
    const events = [makeEvent()]
    const pg = createMockPg(events)
    const logger = createMockLogger()
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader(),
      pg,
      logger,
    })

    const result = await reconciler.reconcile()

    expect(result.checked).toBe(1)
    expect(result.reorged).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.skipped).toBe(false)
  })

  it("handles empty billing events", async () => {
    const pg = createMockPg([])
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader(),
      pg,
      logger: createMockLogger(),
    })

    const result = await reconciler.reconcile()
    expect(result.checked).toBe(0)
    expect(result.reorged).toBe(0)
  })
})

describe("T5.5: BillingReconciler — reorg detection", () => {
  it("flags event when on-chain ownership check fails", async () => {
    const events = [makeEvent({ metadata: { token_id: "42", tx_hash: "0xabc" } })]
    const pg = createMockPg(events)
    const logger = createMockLogger()
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader({ failTokens: new Set(["42"]) }),
      pg,
      logger,
    })

    const result = await reconciler.reconcile()

    expect(result.reorged).toBe(1)
    expect(pg.flaggedIds).toContain("evt-001")
    expect(logger.warns.some((w) => w.includes("Reorged"))).toBe(true)
  })

  it("does not flag event when ownership is valid", async () => {
    const events = [makeEvent({ metadata: { token_id: "42", tx_hash: "0xabc" } })]
    const pg = createMockPg(events)
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader({ ownerOf: { "42": "0xholder" } }),
      pg,
      logger: createMockLogger(),
    })

    const result = await reconciler.reconcile()
    expect(result.reorged).toBe(0)
    expect(pg.flaggedIds).toHaveLength(0)
  })

  it("skips events without token_id in metadata", async () => {
    const events = [makeEvent({ metadata: { some_field: "value" } })]
    const pg = createMockPg(events)
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader(),
      pg,
      logger: createMockLogger(),
    })

    const result = await reconciler.reconcile()
    expect(result.reorged).toBe(0)
  })

  it("skips events without tx_hash (API key billing)", async () => {
    const events = [makeEvent({ metadata: { token_id: "42" } })]
    const pg = createMockPg(events)
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader(),
      pg,
      logger: createMockLogger(),
    })

    const result = await reconciler.reconcile()
    expect(result.reorged).toBe(0)
  })

  it("flags multiple reorged events", async () => {
    const events = [
      makeEvent({ id: "evt-001", metadata: { token_id: "42", tx_hash: "0xa" } }),
      makeEvent({ id: "evt-002", metadata: { token_id: "43", tx_hash: "0xb" } }),
      makeEvent({ id: "evt-003", metadata: { token_id: "44", tx_hash: "0xc" } }),
    ]
    const pg = createMockPg(events)
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader({ failTokens: new Set(["42", "44"]) }),
      pg,
      logger: createMockLogger(),
    })

    const result = await reconciler.reconcile()
    expect(result.checked).toBe(3)
    expect(result.reorged).toBe(2)
    expect(pg.flaggedIds).toEqual(["evt-001", "evt-003"])
  })
})

describe("T5.5: BillingReconciler — error handling", () => {
  it("counts errors for individual events without stopping", async () => {
    const events = [
      makeEvent({ id: "evt-001", metadata: { token_id: "42", tx_hash: "0xa" } }),
      makeEvent({ id: "evt-002", metadata: { token_id: "43", tx_hash: "0xb" } }),
    ]
    // pg.flagEventAsReorged throws for evt-002
    const pg: ReconcilerPg = {
      async getRecentBillingEvents() { return events },
      async flagEventAsReorged(eventId: string) {
        if (eventId === "evt-002") throw new Error("DB error")
      },
    }
    const logger = createMockLogger()
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader({ failTokens: new Set(["42", "43"]) }),
      pg,
      logger,
    })

    const result = await reconciler.reconcile()
    // evt-001 reorged successfully, evt-002 errored during flagging
    expect(result.reorged).toBe(1)
    expect(result.errors).toBe(1)
  })
})

describe("T5.5: BillingReconciler — concurrent guard", () => {
  it("skips if already running", async () => {
    const events = [makeEvent()]
    const pg = createMockPg(events)
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader(),
      pg,
      logger: createMockLogger(),
    })

    // Start two reconciles in parallel
    const [r1, r2] = await Promise.all([
      reconciler.reconcile(),
      reconciler.reconcile(),
    ])

    // One should run, one should be skipped
    const skipped = [r1.skipped, r2.skipped]
    expect(skipped).toContain(true)
    expect(skipped).toContain(false)
  })
})

describe("T5.5: BillingReconciler — start/stop", () => {
  it("starts and stops the interval", () => {
    vi.useFakeTimers()
    const pg = createMockPg([])
    const logger = createMockLogger()
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader(),
      pg,
      intervalMs: 1000,
      logger,
    })

    reconciler.start()
    expect(logger.infos.some((i) => i.includes("Starting"))).toBe(true)

    reconciler.stop()
    expect(logger.infos.some((i) => i.includes("Stopped"))).toBe(true)

    vi.useRealTimers()
  })

  it("start is idempotent", () => {
    vi.useFakeTimers()
    const pg = createMockPg([])
    const reconciler = new BillingReconciler({
      onChainReader: createMockReader(),
      pg,
      intervalMs: 1000,
      logger: createMockLogger(),
    })

    reconciler.start()
    reconciler.start() // Should not create a second interval
    reconciler.stop()

    vi.useRealTimers()
  })
})
