// tests/marketplace/anti-abuse.test.ts — Rate limit, cooldown, self-trade rejection (Sprint 24, Task 24.2)

import { describe, it, expect, beforeEach } from "vitest"
import { MarketplaceStorage } from "../../src/marketplace/storage.js"
import {
  AntiAbuseEngine,
  MAX_ORDERS_PER_HOUR,
  RATE_LIMIT_WINDOW_MS,
  RELIST_COOLDOWN_MS,
  MIN_ORDER_LOTS,
} from "../../src/marketplace/anti-abuse.js"
import type { Order } from "../../src/marketplace/types.js"
import { DEFAULT_LOT_SIZE, DEFAULT_TTL_MS } from "../../src/marketplace/types.js"

// ── Helpers ──────────────────────────────────────────────────

let now = 1_000_000_000_000
const clock = () => now

let storage: MarketplaceStorage
let antiAbuse: AntiAbuseEngine

beforeEach(() => {
  now = 1_000_000_000_000
  storage = new MarketplaceStorage(clock)
  antiAbuse = new AntiAbuseEngine(storage, clock)
})

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: overrides.id ?? `order-${Math.random().toString(36).slice(2, 8)}`,
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

// ── Basic Validation ─────────────────────────────────────────

describe("Basic Validation", () => {
  it("allows valid order", () => {
    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000, 5)
    expect(result.allowed).toBe(true)
  })

  it("rejects zero price", () => {
    const result = antiAbuse.validateOrder("0xAlice", "bid", 0, 5)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("INVALID_PRICE")
  })

  it("rejects negative price", () => {
    const result = antiAbuse.validateOrder("0xAlice", "bid", -100, 5)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("INVALID_PRICE")
  })

  it("rejects non-integer price", () => {
    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000.5, 5)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("INVALID_PRICE")
  })

  it("rejects zero lots", () => {
    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000, 0)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("ORDER_TOO_SMALL")
  })

  it("rejects fractional lots", () => {
    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000, 2.5)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("ORDER_TOO_SMALL")
  })

  it("allows minimum lot size", () => {
    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000, MIN_ORDER_LOTS)
    expect(result.allowed).toBe(true)
  })
})

// ── Rate Limiting ────────────────────────────────────────────

describe("Rate Limiting", () => {
  it("allows up to MAX_ORDERS_PER_HOUR orders", () => {
    for (let i = 0; i < MAX_ORDERS_PER_HOUR; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    // The next validation should fail
    const result = antiAbuse.checkRateLimit("0xAlice")
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("RATE_LIMITED")
  })

  it("rate limit resets after window expires", () => {
    // Fill up the rate limit
    for (let i = 0; i < MAX_ORDERS_PER_HOUR; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    expect(antiAbuse.checkRateLimit("0xAlice").allowed).toBe(false)

    // Advance past the window
    now += RATE_LIMIT_WINDOW_MS + 1

    expect(antiAbuse.checkRateLimit("0xAlice").allowed).toBe(true)
  })

  it("rate limit is per-wallet", () => {
    // Fill Alice's rate limit
    for (let i = 0; i < MAX_ORDERS_PER_HOUR; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    expect(antiAbuse.checkRateLimit("0xAlice").allowed).toBe(false)
    expect(antiAbuse.checkRateLimit("0xBob").allowed).toBe(true)
  })

  it("getRemainingOrders returns correct count", () => {
    expect(antiAbuse.getRemainingOrders("0xAlice")).toBe(MAX_ORDERS_PER_HOUR)

    antiAbuse.recordOrder("0xAlice")
    antiAbuse.recordOrder("0xAlice")
    antiAbuse.recordOrder("0xAlice")

    expect(antiAbuse.getRemainingOrders("0xAlice")).toBe(MAX_ORDERS_PER_HOUR - 3)
  })

  it("sliding window: old orders drop off", () => {
    // Place 5 orders at time T
    for (let i = 0; i < 5; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    // Advance 30 minutes
    now += RATE_LIMIT_WINDOW_MS / 2

    // Place 5 more orders
    for (let i = 0; i < 5; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    // Should be at limit now
    expect(antiAbuse.checkRateLimit("0xAlice").allowed).toBe(false)

    // Advance past the first batch's window (30 more minutes)
    now += RATE_LIMIT_WINDOW_MS / 2 + 1

    // First 5 orders should have expired, leaving room for 5 more
    expect(antiAbuse.checkRateLimit("0xAlice").allowed).toBe(true)
    expect(antiAbuse.getRemainingOrders("0xAlice")).toBe(5)
  })

  it("validateOrder integrates rate limit check", () => {
    for (let i = 0; i < MAX_ORDERS_PER_HOUR; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000, 5)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("RATE_LIMITED")
  })
})

// ── Relist Cooldown ──────────────────────────────────────────

describe("Relist Cooldown", () => {
  it("blocks relisting at same price within cooldown period", () => {
    const order = makeOrder({
      side: "ask",
      priceMicro: 5_000_000,
      wallet: "0xAlice",
    })

    antiAbuse.recordCancellation(order)

    // Try to relist immediately
    const result = antiAbuse.checkRelistCooldown("0xAlice", "ask", 5_000_000)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("RELIST_COOLDOWN")
  })

  it("allows relisting after cooldown expires", () => {
    const order = makeOrder({
      side: "ask",
      priceMicro: 5_000_000,
      wallet: "0xAlice",
    })

    antiAbuse.recordCancellation(order)

    // Advance past cooldown
    now += RELIST_COOLDOWN_MS + 1

    const result = antiAbuse.checkRelistCooldown("0xAlice", "ask", 5_000_000)
    expect(result.allowed).toBe(true)
  })

  it("allows relisting at different price during cooldown", () => {
    const order = makeOrder({
      side: "ask",
      priceMicro: 5_000_000,
      wallet: "0xAlice",
    })

    antiAbuse.recordCancellation(order)

    // Different price should be fine
    const result = antiAbuse.checkRelistCooldown("0xAlice", "ask", 6_000_000)
    expect(result.allowed).toBe(true)
  })

  it("allows relisting on different side during cooldown", () => {
    const order = makeOrder({
      side: "ask",
      priceMicro: 5_000_000,
      wallet: "0xAlice",
    })

    antiAbuse.recordCancellation(order)

    // Same price but different side
    const result = antiAbuse.checkRelistCooldown("0xAlice", "bid", 5_000_000)
    expect(result.allowed).toBe(true)
  })

  it("cooldown is per-wallet", () => {
    const order = makeOrder({
      side: "ask",
      priceMicro: 5_000_000,
      wallet: "0xAlice",
    })

    antiAbuse.recordCancellation(order)

    // Bob should not be affected by Alice's cooldown
    const result = antiAbuse.checkRelistCooldown("0xBob", "ask", 5_000_000)
    expect(result.allowed).toBe(true)
  })

  it("validateOrder integrates cooldown check", () => {
    const order = makeOrder({
      side: "ask",
      priceMicro: 5_000_000,
      wallet: "0xAlice",
    })

    antiAbuse.recordCancellation(order)

    const result = antiAbuse.validateOrder("0xAlice", "ask", 5_000_000, 5)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("RELIST_COOLDOWN")
  })
})

// ── Self-Trade Prevention ────────────────────────────────────

describe("Self-Trade Rejection", () => {
  it("rejects bid that would match own resting ask", () => {
    // Place a resting ask from Alice
    const ask = makeOrder({
      side: "ask",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
    })
    storage.putOrder(ask)

    // Alice tries to place a bid at or above her ask price
    const result = antiAbuse.checkSelfTrade("0xAlice", "bid", 5_000_000)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("SELF_TRADE")
  })

  it("rejects ask that would match own resting bid", () => {
    // Place a resting bid from Alice
    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
    })
    storage.putOrder(bid)

    // Alice tries to place an ask at or below her bid price
    const result = antiAbuse.checkSelfTrade("0xAlice", "ask", 5_000_000)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("SELF_TRADE")
  })

  it("allows bid when best ask belongs to different wallet", () => {
    const ask = makeOrder({
      side: "ask",
      wallet: "0xBob",
      priceMicro: 5_000_000,
    })
    storage.putOrder(ask)

    const result = antiAbuse.checkSelfTrade("0xAlice", "bid", 5_000_000)
    expect(result.allowed).toBe(true)
  })

  it("allows bid below own ask price (would not match)", () => {
    const ask = makeOrder({
      side: "ask",
      wallet: "0xAlice",
      priceMicro: 10_000_000,
    })
    storage.putOrder(ask)

    // Bid at 5M would not match ask at 10M
    const result = antiAbuse.checkSelfTrade("0xAlice", "bid", 5_000_000)
    expect(result.allowed).toBe(true)
  })

  it("allows ask above own bid price (would not match)", () => {
    const bid = makeOrder({
      side: "bid",
      wallet: "0xAlice",
      priceMicro: 3_000_000,
    })
    storage.putOrder(bid)

    // Ask at 5M would not match bid at 3M
    const result = antiAbuse.checkSelfTrade("0xAlice", "ask", 5_000_000)
    expect(result.allowed).toBe(true)
  })

  it("allows order on empty book", () => {
    const result = antiAbuse.checkSelfTrade("0xAlice", "bid", 5_000_000)
    expect(result.allowed).toBe(true)
  })

  it("validateOrder integrates self-trade check", () => {
    const ask = makeOrder({
      side: "ask",
      wallet: "0xAlice",
      priceMicro: 5_000_000,
    })
    storage.putOrder(ask)

    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000, 5)
    expect(result.allowed).toBe(false)
    expect(result.code).toBe("SELF_TRADE")
  })
})

// ── Validation Priority ──────────────────────────────────────

describe("Validation Priority", () => {
  it("price validation runs before rate limit", () => {
    // Even if rate-limited, bad price should be the reported error
    for (let i = 0; i < MAX_ORDERS_PER_HOUR; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    const result = antiAbuse.validateOrder("0xAlice", "bid", -1, 5)
    expect(result.code).toBe("INVALID_PRICE")
  })

  it("lot validation runs before rate limit", () => {
    for (let i = 0; i < MAX_ORDERS_PER_HOUR; i++) {
      antiAbuse.recordOrder("0xAlice")
    }

    const result = antiAbuse.validateOrder("0xAlice", "bid", 5_000_000, 0)
    expect(result.code).toBe("ORDER_TOO_SMALL")
  })
})

// ── Prune ────────────────────────────────────────────────────

describe("Prune", () => {
  it("removes stale rate limit timestamps", () => {
    antiAbuse.recordOrder("0xAlice")
    antiAbuse.recordOrder("0xAlice")

    // Advance past the window
    now += RATE_LIMIT_WINDOW_MS + 1

    const result = antiAbuse.prune()
    expect(result.prunedTimestamps).toBe(2)
  })

  it("removes stale cancel records", () => {
    const order = makeOrder({ side: "ask", wallet: "0xAlice" })
    antiAbuse.recordCancellation(order)

    // Advance past 2x cooldown (prune threshold)
    now += RELIST_COOLDOWN_MS * 2 + 1

    const result = antiAbuse.prune()
    expect(result.prunedCancelRecords).toBe(1)
  })

  it("preserves active entries during prune", () => {
    antiAbuse.recordOrder("0xAlice")
    const order = makeOrder({ side: "ask", wallet: "0xAlice" })
    antiAbuse.recordCancellation(order)

    const result = antiAbuse.prune()
    expect(result.prunedTimestamps).toBe(0)
    expect(result.prunedCancelRecords).toBe(0)

    // Rate limit and cooldown should still be active
    expect(antiAbuse.getRemainingOrders("0xAlice")).toBe(MAX_ORDERS_PER_HOUR - 1)
    expect(antiAbuse.checkRelistCooldown("0xAlice", "ask", 5_000_000).allowed).toBe(false)
  })
})
