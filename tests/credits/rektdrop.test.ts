// tests/credits/rektdrop.test.ts — Rektdrop Allocation Engine Tests (Sprint 21 Task 21.2)
//
// Batch allocation, tiered allocation, idempotency, invalid inputs,
// summary reporting, and conservation invariant across batches.

import { describe, it, expect, beforeEach } from "vitest"
import { CreditSubLedger } from "../../src/credits/rektdrop-ledger.js"
import { RektdropEngine } from "../../src/credits/rektdrop.js"
import {
  CreditState,
  AllocationTier,
  TIER_AMOUNTS,
  _resetTxCounter,
} from "../../src/credits/rektdrop-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WALLETS = {
  alice: "0x1111111111111111111111111111111111111111",
  bob: "0x2222222222222222222222222222222222222222",
  carol: "0x3333333333333333333333333333333333333333",
  dave: "0x4444444444444444444444444444444444444444",
  eve: "0x5555555555555555555555555555555555555555",
}

function freshEngine(): RektdropEngine {
  _resetTxCounter()
  return new RektdropEngine(new CreditSubLedger())
}

// ---------------------------------------------------------------------------
// Single Allocation
// ---------------------------------------------------------------------------

describe("RektdropEngine — Single Allocation", () => {
  let engine: RektdropEngine

  beforeEach(() => {
    engine = freshEngine()
  })

  it("allocates OG tier with default amount", () => {
    const result = engine.allocate(WALLETS.alice, AllocationTier.OG)
    expect(result.status).toBe("allocated")
    expect(result.account).toBeDefined()
    expect(result.account!.initial_allocation).toBe(TIER_AMOUNTS.OG)
    expect(result.account!.tier).toBe(AllocationTier.OG)
    expect(result.account!.balances[CreditState.ALLOCATED]).toBe(TIER_AMOUNTS.OG)
  })

  it("allocates each tier with correct default amount", () => {
    const tiers: [string, AllocationTier, bigint][] = [
      [WALLETS.alice, AllocationTier.OG, 10_000n],
      [WALLETS.bob, AllocationTier.CONTRIBUTOR, 5_000n],
      [WALLETS.carol, AllocationTier.COMMUNITY, 1_000n],
      [WALLETS.dave, AllocationTier.PARTNER, 25_000n],
    ]

    for (const [wallet, tier, expected] of tiers) {
      const result = engine.allocate(wallet, tier)
      expect(result.status).toBe("allocated")
      expect(result.account!.initial_allocation).toBe(expected)
    }
  })

  it("allocates with custom amount override", () => {
    const result = engine.allocate(WALLETS.alice, AllocationTier.OG, 50_000n)
    expect(result.status).toBe("allocated")
    expect(result.account!.initial_allocation).toBe(50_000n)
  })

  it("returns already_exists for duplicate wallet", () => {
    const first = engine.allocate(WALLETS.alice, AllocationTier.OG)
    expect(first.status).toBe("allocated")

    const second = engine.allocate(WALLETS.alice, AllocationTier.OG)
    expect(second.status).toBe("already_exists")
    expect(second.account).toBeDefined()
    expect(second.account!.initial_allocation).toBe(TIER_AMOUNTS.OG)
  })

  it("returns failed for invalid wallet address", () => {
    const result = engine.allocate("not-a-wallet", AllocationTier.OG)
    expect(result.status).toBe("failed")
    expect(result.error).toBeDefined()
    expect(result.error).toContain("Invalid wallet")
  })

  it("returns failed for zero amount", () => {
    const result = engine.allocate(WALLETS.alice, AllocationTier.OG, 0n)
    expect(result.status).toBe("failed")
    expect(result.error).toContain("Invalid amount")
  })
})

// ---------------------------------------------------------------------------
// Batch Allocation
// ---------------------------------------------------------------------------

describe("RektdropEngine — Batch Allocation", () => {
  let engine: RektdropEngine

  beforeEach(() => {
    engine = freshEngine()
  })

  it("allocates a batch of wallets", () => {
    const entries = [
      { wallet: WALLETS.alice, tier: AllocationTier.OG as AllocationTier },
      { wallet: WALLETS.bob, tier: AllocationTier.CONTRIBUTOR as AllocationTier },
      { wallet: WALLETS.carol, tier: AllocationTier.COMMUNITY as AllocationTier },
    ]

    const result = engine.batchAllocate(entries)
    expect(result.total_processed).toBe(3)
    expect(result.newly_allocated).toBe(3)
    expect(result.already_allocated).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.total_credits_allocated).toBe(
      TIER_AMOUNTS.OG + TIER_AMOUNTS.CONTRIBUTOR + TIER_AMOUNTS.COMMUNITY,
    )
  })

  it("handles mixed new and existing wallets", () => {
    // Pre-allocate alice
    engine.allocate(WALLETS.alice, AllocationTier.OG)

    const entries = [
      { wallet: WALLETS.alice, tier: AllocationTier.OG as AllocationTier },
      { wallet: WALLETS.bob, tier: AllocationTier.CONTRIBUTOR as AllocationTier },
    ]

    const result = engine.batchAllocate(entries)
    expect(result.total_processed).toBe(2)
    expect(result.newly_allocated).toBe(1)
    expect(result.already_allocated).toBe(1)
    expect(result.failed).toBe(0)
    // Only bob's credits count as newly allocated
    expect(result.total_credits_allocated).toBe(TIER_AMOUNTS.CONTRIBUTOR)
  })

  it("handles mixed valid and invalid wallets", () => {
    const entries = [
      { wallet: WALLETS.alice, tier: AllocationTier.OG as AllocationTier },
      { wallet: "invalid-address", tier: AllocationTier.OG as AllocationTier },
      { wallet: WALLETS.bob, tier: AllocationTier.CONTRIBUTOR as AllocationTier },
    ]

    const result = engine.batchAllocate(entries)
    expect(result.total_processed).toBe(3)
    expect(result.newly_allocated).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.results[1].status).toBe("failed")
  })

  it("per-wallet results are in order", () => {
    const entries = [
      { wallet: WALLETS.alice, tier: AllocationTier.OG as AllocationTier },
      { wallet: WALLETS.bob, tier: AllocationTier.COMMUNITY as AllocationTier },
    ]

    const result = engine.batchAllocate(entries)
    expect(result.results[0].wallet).toBe(WALLETS.alice)
    expect(result.results[1].wallet).toBe(WALLETS.bob)
  })

  it("empty batch returns zero counts", () => {
    const result = engine.batchAllocate([])
    expect(result.total_processed).toBe(0)
    expect(result.newly_allocated).toBe(0)
    expect(result.already_allocated).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.total_credits_allocated).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// Batch Allocate By Tier
// ---------------------------------------------------------------------------

describe("RektdropEngine — Batch Allocate By Tier", () => {
  let engine: RektdropEngine

  beforeEach(() => {
    engine = freshEngine()
  })

  it("allocates same tier to all wallets", () => {
    const wallets = [WALLETS.alice, WALLETS.bob, WALLETS.carol]
    const result = engine.batchAllocateByTier(wallets, AllocationTier.COMMUNITY)

    expect(result.total_processed).toBe(3)
    expect(result.newly_allocated).toBe(3)
    expect(result.total_credits_allocated).toBe(TIER_AMOUNTS.COMMUNITY * 3n)

    // Each wallet gets community tier amount
    for (const r of result.results) {
      expect(r.status).toBe("allocated")
      expect(r.account!.tier).toBe(AllocationTier.COMMUNITY)
      expect(r.account!.initial_allocation).toBe(TIER_AMOUNTS.COMMUNITY)
    }
  })
})

// ---------------------------------------------------------------------------
// Idempotency — Full Batch Re-run
// ---------------------------------------------------------------------------

describe("RektdropEngine — Idempotency", () => {
  let engine: RektdropEngine

  beforeEach(() => {
    engine = freshEngine()
  })

  it("re-running entire batch is a no-op", () => {
    const entries = [
      { wallet: WALLETS.alice, tier: AllocationTier.OG as AllocationTier },
      { wallet: WALLETS.bob, tier: AllocationTier.CONTRIBUTOR as AllocationTier },
    ]

    const first = engine.batchAllocate(entries, { batchId: "batch-1" })
    expect(first.newly_allocated).toBe(2)

    const second = engine.batchAllocate(entries, { batchId: "batch-1" })
    expect(second.newly_allocated).toBe(0)
    expect(second.already_allocated).toBe(2)
    expect(second.total_credits_allocated).toBe(0n)
  })

  it("idempotent single allocate preserves original account data", () => {
    const r1 = engine.allocate(WALLETS.alice, AllocationTier.OG)
    const r2 = engine.allocate(WALLETS.alice, AllocationTier.PARTNER) // Different tier, same wallet
    expect(r2.status).toBe("already_exists")
    // Original tier preserved
    expect(r2.account!.tier).toBe(AllocationTier.OG)
    expect(r2.account!.initial_allocation).toBe(TIER_AMOUNTS.OG)
  })

  it("ledger account count does not increase on replay", () => {
    const ledger = engine.getLedger()
    engine.allocate(WALLETS.alice, AllocationTier.OG)
    expect(ledger.accountCount).toBe(1)

    engine.allocate(WALLETS.alice, AllocationTier.OG)
    expect(ledger.accountCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Conservation Across Batches
// ---------------------------------------------------------------------------

describe("RektdropEngine — Conservation Invariant", () => {
  let engine: RektdropEngine

  beforeEach(() => {
    engine = freshEngine()
  })

  it("conservation holds for all accounts after batch allocation", () => {
    const entries = [
      { wallet: WALLETS.alice, tier: AllocationTier.OG as AllocationTier },
      { wallet: WALLETS.bob, tier: AllocationTier.CONTRIBUTOR as AllocationTier },
      { wallet: WALLETS.carol, tier: AllocationTier.COMMUNITY as AllocationTier },
      { wallet: WALLETS.dave, tier: AllocationTier.PARTNER as AllocationTier },
    ]

    engine.batchAllocate(entries)

    const conservation = engine.getLedger().verifyAllConservation()
    expect(conservation.valid).toBe(true)
    expect(conservation.violations).toHaveLength(0)
  })

  it("conservation holds after partial unlocks", () => {
    engine.allocate(WALLETS.alice, AllocationTier.OG)
    const ledger = engine.getLedger()

    // Unlock some credits
    ledger.unlock(WALLETS.alice, 3_000n, "corr-1", "unlock-1")

    expect(ledger.verifyConservation(WALLETS.alice)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe("RektdropEngine — Summary", () => {
  let engine: RektdropEngine

  beforeEach(() => {
    engine = freshEngine()
  })

  it("reports correct tier breakdown", () => {
    engine.allocate(WALLETS.alice, AllocationTier.OG)
    engine.allocate(WALLETS.bob, AllocationTier.OG)
    engine.allocate(WALLETS.carol, AllocationTier.COMMUNITY)
    engine.allocate(WALLETS.dave, AllocationTier.PARTNER)

    const summary = engine.getSummary()
    expect(summary.total_accounts).toBe(4)
    expect(summary.by_tier.OG).toBe(2)
    expect(summary.by_tier.COMMUNITY).toBe(1)
    expect(summary.by_tier.PARTNER).toBe(1)
    expect(summary.by_tier.CONTRIBUTOR).toBe(0)
    expect(summary.conservation_valid).toBe(true)
  })

  it("reports correct totals after unlock and consume", () => {
    engine.allocate(WALLETS.alice, AllocationTier.OG) // 10000
    const ledger = engine.getLedger()

    ledger.unlock(WALLETS.alice, 5_000n, "corr-1", "unlock-1")
    ledger.reserve(WALLETS.alice, 2_000n, "corr-2", "reserve-1")
    ledger.consume(WALLETS.alice, 2_000n, "corr-3", "consume-1")

    const summary = engine.getSummary()
    expect(summary.total_allocated).toBe(5_000n) // remaining allocated
    expect(summary.total_unlocked).toBe(3_000n) // 5000 unlocked - 2000 reserved
    expect(summary.total_consumed).toBe(2_000n)
    expect(summary.total_expired).toBe(0n)
    expect(summary.conservation_valid).toBe(true)
  })

  it("empty engine returns zero summary", () => {
    const summary = engine.getSummary()
    expect(summary.total_accounts).toBe(0)
    expect(summary.total_allocated).toBe(0n)
    expect(summary.conservation_valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// onAllocated Callback
// ---------------------------------------------------------------------------

describe("RektdropEngine — Callbacks", () => {
  it("calls onAllocated for each new allocation", () => {
    const engine = freshEngine()
    const allocated: string[] = []

    engine.batchAllocate(
      [
        { wallet: WALLETS.alice, tier: AllocationTier.OG },
        { wallet: WALLETS.bob, tier: AllocationTier.CONTRIBUTOR },
      ],
      {
        onAllocated: (wallet) => allocated.push(wallet),
      },
    )

    expect(allocated).toHaveLength(2)
    expect(allocated).toContain(WALLETS.alice)
    expect(allocated).toContain(WALLETS.bob)
  })

  it("does not call onAllocated for already-existing wallets", () => {
    const engine = freshEngine()
    engine.allocate(WALLETS.alice, AllocationTier.OG)

    const allocated: string[] = []
    engine.batchAllocate(
      [{ wallet: WALLETS.alice, tier: AllocationTier.OG }],
      { onAllocated: (wallet) => allocated.push(wallet) },
    )

    expect(allocated).toHaveLength(0)
  })
})
