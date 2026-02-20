// tests/marketplace/matching.test.ts — Full/partial fill, no-match, self-trade prevention (Sprint 23, Task 23.2)

import { describe, it, expect, beforeEach } from "vitest"
import { MarketplaceStorage } from "../../src/marketplace/storage.js"
import { MatchingEngine } from "../../src/marketplace/matching.js"
import type { Order } from "../../src/marketplace/types.js"
import { DEFAULT_LOT_SIZE, DEFAULT_TTL_MS, FEE_RATE } from "../../src/marketplace/types.js"

// ── Helpers ──────────────────────────────────────────────────

let now = 1_000_000_000_000
const clock = () => now

let storage: MarketplaceStorage
let engine: MatchingEngine
let orderId = 0

beforeEach(() => {
  now = 1_000_000_000_000
  orderId = 0
  storage = new MarketplaceStorage(clock)
  engine = new MatchingEngine(storage, clock)
})

function makeOrder(overrides: Partial<Order> = {}): Order {
  orderId++
  const id = overrides.id ?? `order-${orderId}`
  return {
    id,
    wallet: overrides.wallet ?? "0xAlice",
    side: overrides.side ?? "bid",
    priceMicro: overrides.priceMicro ?? 5_000_000,
    lots: overrides.lots ?? 10,
    lotsRemaining: overrides.lotsRemaining ?? overrides.lots ?? 10,
    status: overrides.status ?? "open",
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? now + DEFAULT_TTL_MS,
    updatedAt: overrides.updatedAt ?? now,
  }
}

function placeRestingOrder(overrides: Partial<Order> = {}): Order {
  const order = makeOrder(overrides)
  storage.putOrder(order)
  return order
}

// ── Full Fill Tests ──────────────────────────────────────────

describe("Full Fill", () => {
  it("exact match: bid meets ask at same price and quantity", () => {
    // Resting ask from Bob
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 5_000_000,
      lots: 10,
    })

    // Incoming bid from Alice
    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 10,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(1)
    expect(result.order.status).toBe("filled")
    expect(result.order.lotsRemaining).toBe(0)

    const match = result.matches[0]
    expect(match.lots).toBe(10)
    expect(match.priceMicro).toBe(5_000_000)
    expect(match.buyerWallet).toBe("0xAlice")
    expect(match.sellerWallet).toBe("0xBob")
    expect(match.totalMicro).toBe(50_000_000) // 5M * 10 lots
    expect(match.feeMicro).toBe(5_000_000) // 10% fee
    expect(match.sellerProceedsMicro).toBe(45_000_000) // total - fee
  })

  it("bid price above ask price: executes at resting order price", () => {
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 3_000_000,
      lots: 5,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 7_000_000,
      lots: 5,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(1)
    // Execution price is the resting order's price
    expect(result.matches[0].priceMicro).toBe(3_000_000)
    expect(result.order.status).toBe("filled")
  })

  it("ask meets higher bid: executes at resting bid price", () => {
    placeRestingOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 8_000_000,
      lots: 5,
    })

    const ask = makeOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 4_000_000,
      lots: 5,
    })

    const result = engine.match(ask)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].priceMicro).toBe(8_000_000)
    expect(result.order.status).toBe("filled")
  })
})

// ── Partial Fill Tests ───────────────────────────────────────

describe("Partial Fill", () => {
  it("incoming order larger than resting: partial fill", () => {
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 5_000_000,
      lots: 3,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 10,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].lots).toBe(3)
    expect(result.order.status).toBe("partial")
    expect(result.order.lotsRemaining).toBe(7)
  })

  it("incoming order smaller than resting: resting order becomes partial", () => {
    const restingAsk = placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 5_000_000,
      lots: 10,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 3,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].lots).toBe(3)
    expect(result.order.status).toBe("filled")
    expect(result.order.lotsRemaining).toBe(0)

    // The resting order should be partially filled and still in the book
    const updatedAsk = storage.getOrder(restingAsk.id)!
    expect(updatedAsk.lotsRemaining).toBe(7)
    expect(updatedAsk.status).toBe("partial")
  })

  it("multiple resting orders fill one incoming order", () => {
    // Three resting asks at different prices
    now = 1_000_000_000_000
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 3_000_000,
      lots: 2,
      createdAt: now,
    })
    now += 1
    placeRestingOrder({
      side: "ask",
      wallet: "0xCharlie",
      priceMicro: 4_000_000,
      lots: 3,
      createdAt: now,
    })
    now += 1
    placeRestingOrder({
      side: "ask",
      wallet: "0xDave",
      priceMicro: 5_000_000,
      lots: 5,
      createdAt: now,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 7,
    })

    const result = engine.match(bid)

    // Should match asks in price order: 3M (2 lots), 4M (3 lots), 5M (2 lots)
    expect(result.matches).toHaveLength(3)
    expect(result.matches[0].lots).toBe(2)
    expect(result.matches[0].priceMicro).toBe(3_000_000)
    expect(result.matches[1].lots).toBe(3)
    expect(result.matches[1].priceMicro).toBe(4_000_000)
    expect(result.matches[2].lots).toBe(2)
    expect(result.matches[2].priceMicro).toBe(5_000_000)

    expect(result.order.status).toBe("filled")
    expect(result.order.lotsRemaining).toBe(0)
  })
})

// ── No Match Tests ───────────────────────────────────────────

describe("No Match", () => {
  it("bid below all ask prices: no match", () => {
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 10_000_000,
      lots: 5,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 5,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(0)
    expect(result.order.status).toBe("open")
    expect(result.order.lotsRemaining).toBe(5)
  })

  it("ask above all bid prices: no match", () => {
    placeRestingOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 3_000_000,
      lots: 5,
    })

    const ask = makeOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 7_000_000,
      lots: 5,
    })

    const result = engine.match(ask)

    expect(result.matches).toHaveLength(0)
    expect(result.order.status).toBe("open")
  })

  it("empty book: no match", () => {
    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 5,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(0)
    expect(result.order.status).toBe("open")
  })
})

// ── Self-Trade Prevention ────────────────────────────────────

describe("Self-Trade Prevention", () => {
  it("skips match when both sides are same wallet", () => {
    placeRestingOrder({
      side: "ask",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 5,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 5,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(0)
    expect(result.selfTradesPrevented).toBe(1)
    expect(result.order.status).toBe("open")
    expect(result.order.lotsRemaining).toBe(5)
  })

  it("skips own order but matches next eligible order", () => {
    // Alice's ask (should be skipped for Alice's bid)
    now = 1_000_000_000_000
    placeRestingOrder({
      side: "ask",
      wallet: "0xAlice",
      priceMicro: 3_000_000,
      lots: 5,
      createdAt: now,
    })

    // Bob's ask (should be matched)
    now += 1
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 4_000_000,
      lots: 5,
      createdAt: now,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 5,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(1)
    expect(result.selfTradesPrevented).toBe(1)
    expect(result.matches[0].sellerWallet).toBe("0xBob")
    expect(result.order.status).toBe("filled")
  })

  it("self-trade prevention preserves the skipped order in the book", () => {
    const aliceAsk = placeRestingOrder({
      side: "ask",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 5,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 5,
    })

    engine.match(bid)

    // Alice's ask should still be in the book for other buyers
    const bestAsk = storage.peekBestAsk()
    expect(bestAsk?.id).toBe(aliceAsk.id)
  })
})

// ── Settlement Instruction Tests ─────────────────────────────

describe("Settlement Instructions", () => {
  it("match produces correct settlement instructions", () => {
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 2_000_000,
      lots: 5,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 2_000_000,
      lots: 5,
    })

    const result = engine.match(bid)
    const match = result.matches[0]

    expect(match.settlement.creditsToTransfer).toBe(5 * DEFAULT_LOT_SIZE) // 500 CU
    expect(match.settlement.usdcToSeller).toBe(match.sellerProceedsMicro)
    expect(match.settlement.usdcFee).toBe(match.feeMicro)
  })

  it("fee calculation is correct at 10%", () => {
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 10_000_000,
      lots: 1,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 10_000_000,
      lots: 1,
    })

    const result = engine.match(bid)
    const match = result.matches[0]

    expect(match.totalMicro).toBe(10_000_000)
    expect(match.feeMicro).toBe(1_000_000) // 10% of 10M
    expect(match.sellerProceedsMicro).toBe(9_000_000)
  })

  it("fee rounds down (floor) for non-exact amounts", () => {
    placeRestingOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 3_333_333,
      lots: 1,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 3_333_333,
      lots: 1,
    })

    const result = engine.match(bid)
    const match = result.matches[0]

    // 3_333_333 * 0.10 = 333_333.3 -> floor = 333_333
    expect(match.feeMicro).toBe(333_333)
    expect(match.sellerProceedsMicro).toBe(3_333_333 - 333_333)
  })
})

// ── Price-Time Priority ──────────────────────────────────────

describe("Price-Time Priority", () => {
  it("matches best price first among multiple resting orders", () => {
    now = 1_000_000_000_000
    placeRestingOrder({
      id: "expensive",
      side: "ask",
      wallet: "0xBob",
      priceMicro: 8_000_000,
      lots: 5,
      createdAt: now,
    })
    now += 1
    placeRestingOrder({
      id: "cheap",
      side: "ask",
      wallet: "0xCharlie",
      priceMicro: 2_000_000,
      lots: 5,
      createdAt: now,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 8_000_000,
      lots: 5,
    })

    const result = engine.match(bid)

    // Should match the cheaper ask first
    expect(result.matches[0].sellerWallet).toBe("0xCharlie")
    expect(result.matches[0].priceMicro).toBe(2_000_000)
  })

  it("same price: earlier order gets matched first", () => {
    now = 1_000_000_000_000
    placeRestingOrder({
      id: "early",
      side: "ask",
      wallet: "0xBob",
      priceMicro: 5_000_000,
      lots: 3,
      createdAt: now,
    })
    now += 100
    placeRestingOrder({
      id: "late",
      side: "ask",
      wallet: "0xCharlie",
      priceMicro: 5_000_000,
      lots: 3,
      createdAt: now,
    })

    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
      lots: 3,
    })

    const result = engine.match(bid)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].sellerWallet).toBe("0xBob") // Earlier order
  })
})
