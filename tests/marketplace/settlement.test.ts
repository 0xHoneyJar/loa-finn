// tests/marketplace/settlement.test.ts — Happy path, failure rollback, idempotency (Sprint 24, Task 24.1)

import { describe, it, expect, beforeEach } from "vitest"
import { MarketplaceStorage } from "../../src/marketplace/storage.js"
import { SettlementEngine, SettlementError } from "../../src/marketplace/settlement.js"
import type { Order, Match, SettlementInstruction } from "../../src/marketplace/types.js"
import { DEFAULT_LOT_SIZE, DEFAULT_TTL_MS, FEE_RATE } from "../../src/marketplace/types.js"

// ── Helpers ──────────────────────────────────────────────────

let now = 1_000_000_000_000
const clock = () => now

let storage: MarketplaceStorage
let settlement: SettlementEngine

beforeEach(() => {
  now = 1_000_000_000_000
  storage = new MarketplaceStorage(clock)
  settlement = new SettlementEngine(storage, clock)
})

function makeAskOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: overrides.id ?? `ask-${Math.random().toString(36).slice(2, 8)}`,
    wallet: overrides.wallet ?? "0xSeller",
    side: "ask",
    priceMicro: overrides.priceMicro ?? 5_000_000,
    lots: overrides.lots ?? 10,
    lotsRemaining: overrides.lotsRemaining ?? overrides.lots ?? 10,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? now + DEFAULT_TTL_MS,
    updatedAt: overrides.updatedAt ?? now,
  }
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  const lots = overrides.lots ?? 5
  const priceMicro = overrides.priceMicro ?? 5_000_000
  const totalMicro = priceMicro * lots
  const feeMicro = Math.floor(totalMicro * FEE_RATE)
  const sellerProceedsMicro = totalMicro - feeMicro

  return {
    id: overrides.id ?? `match-${Math.random().toString(36).slice(2, 8)}`,
    bidOrderId: overrides.bidOrderId ?? "bid-1",
    askOrderId: overrides.askOrderId ?? "ask-1",
    buyerWallet: overrides.buyerWallet ?? "0xBuyer",
    sellerWallet: overrides.sellerWallet ?? "0xSeller",
    priceMicro,
    lots,
    totalMicro,
    feeMicro,
    sellerProceedsMicro,
    settlement: overrides.settlement ?? {
      creditsToTransfer: lots * DEFAULT_LOT_SIZE,
      usdcToSeller: sellerProceedsMicro,
      usdcFee: feeMicro,
      escrowId: "escrow-1",
    },
    matchedAt: overrides.matchedAt ?? now,
  }
}

// ── Escrow Locking ───────────────────────────────────────────

describe("Escrow Locking", () => {
  it("locks credits from seller balance on ask placement", () => {
    storage.setBalance("0xSeller", { credits: 5000, usdcMicro: 0 })

    const askOrder = makeAskOrder({ lots: 10 }) // 10 lots * 100 CU = 1000 CU
    const escrow = settlement.lockCredits(askOrder)

    expect(escrow.creditsLocked).toBe(1000)
    expect(escrow.creditsRemaining).toBe(1000)
    expect(escrow.status).toBe("locked")
    expect(escrow.orderId).toBe(askOrder.id)

    // Seller balance should be reduced
    const balance = storage.getBalance("0xSeller")
    expect(balance.credits).toBe(4000)
  })

  it("throws on insufficient credits", () => {
    storage.setBalance("0xSeller", { credits: 500, usdcMicro: 0 })

    const askOrder = makeAskOrder({ lots: 10 }) // needs 1000 CU

    expect(() => settlement.lockCredits(askOrder)).toThrow(SettlementError)
    expect(() => settlement.lockCredits(askOrder)).toThrow("Insufficient credits")

    // Balance should be unchanged
    expect(storage.getBalance("0xSeller").credits).toBe(500)
  })

  it("throws when trying to lock credits for a bid order", () => {
    const bidOrder: Order = {
      ...makeAskOrder(),
      side: "bid",
    }

    expect(() => settlement.lockCredits(bidOrder)).toThrow("Only ask orders require escrow")
  })
})

// ── Happy Path Settlement ────────────────────────────────────

describe("Happy Path Settlement", () => {
  it("transfers credits and USDC correctly on match", () => {
    // Setup: seller has credits in escrow, buyer has USDC
    storage.setBalance("0xSeller", { credits: 4000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 5,
      priceMicro: 5_000_000,
      settlement: {
        creditsToTransfer: 500, // 5 lots * 100 CU
        usdcToSeller: 22_500_000, // 25M - 2.5M fee
        usdcFee: 2_500_000,
        escrowId: escrow.id,
      },
    })

    const result = settlement.settle(match)

    expect(result.status).toBe("success")
    expect(result.creditsTransferred).toBe(500)
    expect(result.usdcTransferred).toBe(22_500_000)
    expect(result.feeCollected).toBe(2_500_000)

    // Check buyer balance: got credits, lost USDC
    const buyerBal = storage.getBalance("0xBuyer")
    expect(buyerBal.credits).toBe(500)
    expect(buyerBal.usdcMicro).toBe(75_000_000) // 100M - 25M

    // Check seller balance: got USDC (minus fee)
    const sellerBal = storage.getBalance("0xSeller")
    expect(sellerBal.usdcMicro).toBe(22_500_000)
    expect(sellerBal.credits).toBe(3500) // remaining after escrow lock (4000 - 500)
  })

  it("escrow status updated to settled when fully consumed", () => {
    storage.setBalance("0xSeller", { credits: 1000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 5,
      settlement: {
        creditsToTransfer: 500,
        usdcToSeller: 22_500_000,
        usdcFee: 2_500_000,
        escrowId: escrow.id,
      },
    })

    settlement.settle(match)

    const updatedEscrow = storage.getEscrow(escrow.id)!
    expect(updatedEscrow.creditsRemaining).toBe(0)
    expect(updatedEscrow.status).toBe("settled")
  })

  it("partial settlement leaves escrow in locked state with reduced credits", () => {
    storage.setBalance("0xSeller", { credits: 2000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 10 }) // 1000 CU
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    // Only settle 3 lots out of 10
    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 3,
      priceMicro: 5_000_000,
      settlement: {
        creditsToTransfer: 300, // 3 lots * 100 CU
        usdcToSeller: 13_500_000, // 15M - 1.5M fee
        usdcFee: 1_500_000,
        escrowId: escrow.id,
      },
    })

    settlement.settle(match)

    const updatedEscrow = storage.getEscrow(escrow.id)!
    expect(updatedEscrow.creditsRemaining).toBe(700) // 1000 - 300
    expect(updatedEscrow.status).toBe("locked") // Still locked, not fully settled
  })
})

// ── Failure and Error Cases ──────────────────────────────────

describe("Failure Cases", () => {
  it("throws when escrow not found", () => {
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const match = makeMatch({
      settlement: {
        creditsToTransfer: 500,
        usdcToSeller: 22_500_000,
        usdcFee: 2_500_000,
        escrowId: "nonexistent-escrow",
      },
    })

    expect(() => settlement.settle(match)).toThrow(SettlementError)
    expect(() => settlement.settle(match)).toThrow("Escrow not found")
  })

  it("throws when buyer has insufficient USDC", () => {
    storage.setBalance("0xSeller", { credits: 2000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 1_000 }) // Not enough

    const askOrder = makeAskOrder({ id: "ask-1", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 5,
      settlement: {
        creditsToTransfer: 500,
        usdcToSeller: 22_500_000,
        usdcFee: 2_500_000,
        escrowId: escrow.id,
      },
    })

    expect(() => settlement.settle(match)).toThrow("Buyer insufficient USDC")
  })

  it("throws when escrow has insufficient credits", () => {
    storage.setBalance("0xSeller", { credits: 500, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 2 }) // Only 200 CU
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 5,
      settlement: {
        creditsToTransfer: 500, // Wants 500 but escrow only has 200
        usdcToSeller: 22_500_000,
        usdcFee: 2_500_000,
        escrowId: escrow.id,
      },
    })

    expect(() => settlement.settle(match)).toThrow("Escrow insufficient")
  })
})

// ── Rollback ─────────────────────────────────────────────────

describe("Rollback", () => {
  it("rollback restores buyer and seller balances after successful settlement", () => {
    storage.setBalance("0xSeller", { credits: 2000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 5,
      settlement: {
        creditsToTransfer: 500,
        usdcToSeller: 22_500_000,
        usdcFee: 2_500_000,
        escrowId: escrow.id,
      },
    })

    // Settle then rollback
    settlement.settle(match)
    const rollbackResult = settlement.rollback(match)

    expect(rollbackResult.status).toBe("rolled_back")

    // Buyer should have original USDC back and no credits
    const buyerBal = storage.getBalance("0xBuyer")
    expect(buyerBal.usdcMicro).toBe(100_000_000)
    expect(buyerBal.credits).toBe(0)

    // Seller should have no USDC and credits back in escrow
    const sellerBal = storage.getBalance("0xSeller")
    expect(sellerBal.usdcMicro).toBe(0)

    // Escrow should be restored
    const restoredEscrow = storage.getEscrow(escrow.id)!
    expect(restoredEscrow.creditsRemaining).toBe(500)
    expect(restoredEscrow.status).toBe("locked")
  })

  it("rollback on unsettled match returns rolled_back with zero transfers", () => {
    const match = makeMatch()

    const result = settlement.rollback(match)

    expect(result.status).toBe("rolled_back")
    expect(result.creditsTransferred).toBe(0)
    expect(result.usdcTransferred).toBe(0)
    expect(result.feeCollected).toBe(0)
  })
})

// ── Escrow Release ───────────────────────────────────────────

describe("Escrow Release", () => {
  it("releases credits back to seller on order cancellation", () => {
    storage.setBalance("0xSeller", { credits: 2000, usdcMicro: 0 })

    const askOrder = makeAskOrder({ id: "ask-cancel", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    // Seller should have 1500 credits (2000 - 500 locked)
    expect(storage.getBalance("0xSeller").credits).toBe(1500)

    const released = settlement.releaseEscrow("ask-cancel")
    expect(released).toBe(500)

    // Credits should be returned
    expect(storage.getBalance("0xSeller").credits).toBe(2000)

    // Escrow should be released
    const updatedEscrow = storage.getEscrow(escrow.id)!
    expect(updatedEscrow.status).toBe("released")
    expect(updatedEscrow.creditsRemaining).toBe(0)
  })

  it("releaseEscrow returns 0 for unknown order", () => {
    expect(settlement.releaseEscrow("nonexistent")).toBe(0)
  })

  it("releaseEscrow returns 0 for already-released escrow", () => {
    storage.setBalance("0xSeller", { credits: 2000, usdcMicro: 0 })

    const askOrder = makeAskOrder({ id: "ask-double", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    settlement.releaseEscrow("ask-double")
    // Second release should be a no-op
    const secondRelease = settlement.releaseEscrow("ask-double")
    expect(secondRelease).toBe(0)
    expect(storage.getBalance("0xSeller").credits).toBe(2000)
  })
})

// ── Idempotency ──────────────────────────────────────────────

describe("Idempotency", () => {
  it("settling the same match twice returns cached result", () => {
    storage.setBalance("0xSeller", { credits: 2000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      id: "match-idempotent",
      askOrderId: "ask-1",
      lots: 5,
      settlement: {
        creditsToTransfer: 500,
        usdcToSeller: 22_500_000,
        usdcFee: 2_500_000,
        escrowId: escrow.id,
      },
    })

    const result1 = settlement.settle(match)
    const result2 = settlement.settle(match)

    // Same result object
    expect(result2).toEqual(result1)

    // Balances should not be double-debited
    const buyerBal = storage.getBalance("0xBuyer")
    expect(buyerBal.usdcMicro).toBe(75_000_000) // Only deducted once
    expect(buyerBal.credits).toBe(500) // Only credited once
  })

  it("isSettled returns correct status", () => {
    storage.setBalance("0xSeller", { credits: 2000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 0, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 5 })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      id: "check-settled",
      askOrderId: "ask-1",
      lots: 5,
      settlement: {
        creditsToTransfer: 500,
        usdcToSeller: 22_500_000,
        usdcFee: 2_500_000,
        escrowId: escrow.id,
      },
    })

    expect(settlement.isSettled("check-settled")).toBe(false)
    settlement.settle(match)
    expect(settlement.isSettled("check-settled")).toBe(true)
  })
})

// ── Conservation Invariant ───────────────────────────────────

describe("Conservation Invariant", () => {
  it("total credits remain constant after lock + settle", () => {
    const totalSupply = 10_000
    storage.setBalance("0xSeller", { credits: 6000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 4000, usdcMicro: 100_000_000 })

    // Lock 1000 credits in escrow
    const askOrder = makeAskOrder({ id: "ask-1", lots: 10, wallet: "0xSeller" })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    // Verify conservation after lock
    let conservation = settlement.verifyConservation(totalSupply)
    expect(conservation.valid).toBe(true)
    expect(conservation.totalAvailable).toBe(9000) // 5000 + 4000
    expect(conservation.totalEscrowed).toBe(1000)

    // Settle the match
    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 10,
      priceMicro: 5_000_000,
      buyerWallet: "0xBuyer",
      sellerWallet: "0xSeller",
      settlement: {
        creditsToTransfer: 1000,
        usdcToSeller: 45_000_000,
        usdcFee: 5_000_000,
        escrowId: escrow.id,
      },
    })

    settlement.settle(match)

    // Verify conservation after settlement
    conservation = settlement.verifyConservation(totalSupply)
    expect(conservation.valid).toBe(true)
    expect(conservation.totalAvailable).toBe(10_000) // 5000 + 5000
    expect(conservation.totalEscrowed).toBe(0)
  })

  it("conservation holds after rollback", () => {
    const totalSupply = 10_000
    storage.setBalance("0xSeller", { credits: 6000, usdcMicro: 0 })
    storage.setBalance("0xBuyer", { credits: 4000, usdcMicro: 100_000_000 })

    const askOrder = makeAskOrder({ id: "ask-1", lots: 10, wallet: "0xSeller" })
    const escrow = settlement.lockCredits(askOrder)
    storage.putEscrow(escrow)

    const match = makeMatch({
      askOrderId: "ask-1",
      lots: 10,
      buyerWallet: "0xBuyer",
      sellerWallet: "0xSeller",
      settlement: {
        creditsToTransfer: 1000,
        usdcToSeller: 45_000_000,
        usdcFee: 5_000_000,
        escrowId: escrow.id,
      },
    })

    settlement.settle(match)
    settlement.rollback(match)

    const conservation = settlement.verifyConservation(totalSupply)
    expect(conservation.valid).toBe(true)
  })
})
