// src/marketplace/matching.ts — Price-time priority matching engine (Sprint 23, Task 23.2)
//
// Matches incoming orders against the order book using price-time priority.
// Supports partial fills at lot granularity. Self-trade prevention: rejects
// matches where both sides share the same wallet address.

import { randomUUID } from "node:crypto"
import type {
  Order,
  Match,
  SettlementInstruction,
} from "./types.js"
import { DEFAULT_LOT_SIZE, FEE_RATE } from "./types.js"
import type { MarketplaceStorage } from "./storage.js"

// ── Match Result ─────────────────────────────────────────────

export interface MatchResult {
  /** Matches produced by this matching round */
  matches: Match[]
  /** The incoming order after matching (may be partially filled or fully filled) */
  order: Order
  /** Whether any potential matches were skipped due to self-trade prevention */
  selfTradesPrevented: number
}

// ── Matching Engine ──────────────────────────────────────────

export class MatchingEngine {
  private readonly storage: MarketplaceStorage
  private readonly clock: () => number

  constructor(storage: MarketplaceStorage, clock: () => number = Date.now) {
    this.storage = storage
    this.clock = clock
  }

  /**
   * Attempt to match an incoming order against the book.
   *
   * For a bid (buy): match against asks, lowest price first.
   * For an ask (sell): match against bids, highest price first.
   *
   * Price-time priority: best price wins, ties broken by earliest createdAt.
   * Partial fills: fills at lot granularity until the incoming order is
   * exhausted or no more matchable resting orders exist.
   *
   * Self-trade prevention: skips any resting order from the same wallet.
   */
  match(incomingOrder: Order): MatchResult {
    const matches: Match[] = []
    let selfTradesPrevented = 0

    // Choose the opposing side
    const isBid = incomingOrder.side === "bid"

    // Orders temporarily removed due to self-trade prevention.
    // Popped from the sorted set during matching, reinserted after the loop.
    const deferredOrders: Order[] = []

    while (incomingOrder.lotsRemaining > 0) {
      // Peek at the best opposing order
      const bestOpposing = isBid
        ? this.storage.peekBestAsk()
        : this.storage.peekBestBid()

      if (!bestOpposing) break

      // Price check: bid price must be >= ask price for a match
      if (isBid) {
        if (incomingOrder.priceMicro < bestOpposing.priceMicro) break
      } else {
        if (incomingOrder.priceMicro > bestOpposing.priceMicro) break
      }

      // Self-trade prevention
      if (incomingOrder.wallet === bestOpposing.wallet) {
        selfTradesPrevented++
        // Pop from sorted set so we can reach deeper orders.
        // The order stays in storage; we reinsert into the sorted set after matching.
        if (isBid) {
          this.storage.popBestAsk()
        } else {
          this.storage.popBestBid()
        }
        deferredOrders.push(bestOpposing)
        continue
      }

      // Remove the opposing order from the sorted set for fill
      if (isBid) {
        this.storage.popBestAsk()
      } else {
        this.storage.popBestBid()
      }

      // Calculate fill quantity
      const fillLots = Math.min(
        incomingOrder.lotsRemaining,
        bestOpposing.lotsRemaining,
      )

      // Execution price: the resting order's price (price-time priority)
      const executionPrice = bestOpposing.priceMicro
      const totalMicro = executionPrice * fillLots
      const feeMicro = Math.floor(totalMicro * FEE_RATE)
      const sellerProceedsMicro = totalMicro - feeMicro

      // Determine buyer/seller
      const buyerWallet = isBid ? incomingOrder.wallet : bestOpposing.wallet
      const sellerWallet = isBid ? bestOpposing.wallet : incomingOrder.wallet
      const bidOrderId = isBid ? incomingOrder.id : bestOpposing.id
      const askOrderId = isBid ? bestOpposing.id : incomingOrder.id

      // Find escrow for the ask order
      const askOrder = isBid ? bestOpposing : incomingOrder
      const escrow = this.storage.getEscrowByOrderId(askOrder.id)
      const escrowId = escrow?.id ?? `escrow-${askOrder.id}`

      // Build match
      const match: Match = {
        id: randomUUID(),
        bidOrderId,
        askOrderId,
        buyerWallet,
        sellerWallet,
        priceMicro: executionPrice,
        lots: fillLots,
        totalMicro,
        feeMicro,
        sellerProceedsMicro,
        settlement: {
          creditsToTransfer: fillLots * DEFAULT_LOT_SIZE,
          usdcToSeller: sellerProceedsMicro,
          usdcFee: feeMicro,
          escrowId,
        },
        matchedAt: this.clock(),
      }

      matches.push(match)

      // Update fill quantities
      const now = this.clock()

      incomingOrder.lotsRemaining -= fillLots
      incomingOrder.updatedAt = now
      if (incomingOrder.lotsRemaining === 0) {
        incomingOrder.status = "filled"
      } else {
        incomingOrder.status = "partial"
      }

      bestOpposing.lotsRemaining -= fillLots
      bestOpposing.updatedAt = now
      if (bestOpposing.lotsRemaining === 0) {
        bestOpposing.status = "filled"
      } else {
        bestOpposing.status = "partial"
        // Re-insert partially filled order back into the book
        this.reinsertOrder(bestOpposing)
      }

      // Update both orders in storage
      this.storage.updateOrder(incomingOrder)
      this.storage.updateOrder(bestOpposing)
    }

    // Reinsert self-trade-skipped orders back into the sorted set
    for (const deferred of deferredOrders) {
      this.reinsertOrder(deferred)
    }

    return { matches, order: incomingOrder, selfTradesPrevented }
  }

  /** Re-insert a still-open order into the appropriate sorted set. */
  private reinsertOrder(order: Order): void {
    const set = order.side === "bid"
      ? this.storage["bidSet"]
      : this.storage["askSet"]
    set.insert(order.id, order.priceMicro, order.createdAt)
  }
}
