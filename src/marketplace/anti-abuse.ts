// src/marketplace/anti-abuse.ts — Rate limiting, cooldown, self-trade prevention (Sprint 24, Task 24.2)
//
// Anti-abuse controls for the credit marketplace:
// - Minimum order size: 1 lot
// - Rate limit: max 10 orders per wallet per hour (sliding window)
// - Relist cooldown: 5 min between cancel + new order at same price
// - Self-trade rejection: cannot place order that would immediately match own order

import type { Order, OrderSide } from "./types.js"
import { DEFAULT_LOT_SIZE } from "./types.js"
import type { MarketplaceStorage } from "./storage.js"

// ── Constants ────────────────────────────────────────────────

/** Maximum orders per wallet per hour */
export const MAX_ORDERS_PER_HOUR = 10

/** Rate limit window in milliseconds (1 hour) */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

/** Relist cooldown in milliseconds (5 minutes) */
export const RELIST_COOLDOWN_MS = 5 * 60 * 1000

/** Minimum order size in lots */
export const MIN_ORDER_LOTS = 1

// ── Validation Result ────────────────────────────────────────

export interface ValidationResult {
  allowed: boolean
  reason?: string
  code?:
    | "ORDER_TOO_SMALL"
    | "RATE_LIMITED"
    | "RELIST_COOLDOWN"
    | "SELF_TRADE"
    | "INVALID_PRICE"
    | "INVALID_LOTS"
}

// ── AntiAbuse Engine ─────────────────────────────────────────

export class AntiAbuseEngine {
  private readonly storage: MarketplaceStorage
  private readonly clock: () => number

  /**
   * Sliding window: wallet -> list of order timestamps.
   * Pruned lazily when checked.
   */
  private readonly orderTimestamps: Map<string, number[]> = new Map()

  /**
   * Cancel records: wallet -> list of { price, side, cancelledAt }.
   * Used for relist cooldown enforcement.
   */
  private readonly cancelRecords: Map<
    string,
    Array<{ priceMicro: number; side: OrderSide; cancelledAt: number }>
  > = new Map()

  constructor(storage: MarketplaceStorage, clock: () => number = Date.now) {
    this.storage = storage
    this.clock = clock
  }

  // ── Pre-Order Validation ───────────────────────────────────

  /**
   * Validate an order before it is placed. Checks all anti-abuse rules
   * in sequence, returning the first failure or { allowed: true }.
   */
  validateOrder(
    wallet: string,
    side: OrderSide,
    priceMicro: number,
    lots: number,
  ): ValidationResult {
    // 1. Basic validation
    if (priceMicro <= 0) {
      return {
        allowed: false,
        reason: "Price must be positive",
        code: "INVALID_PRICE",
      }
    }

    if (!Number.isInteger(lots) || lots < MIN_ORDER_LOTS) {
      return {
        allowed: false,
        reason: `Minimum order size is ${MIN_ORDER_LOTS} lot(s) (${MIN_ORDER_LOTS * DEFAULT_LOT_SIZE} CU)`,
        code: "ORDER_TOO_SMALL",
      }
    }

    if (!Number.isInteger(priceMicro)) {
      return {
        allowed: false,
        reason: "Price must be an integer (USDC micro-units)",
        code: "INVALID_PRICE",
      }
    }

    // 2. Rate limit check
    const rateResult = this.checkRateLimit(wallet)
    if (!rateResult.allowed) return rateResult

    // 3. Relist cooldown check
    const cooldownResult = this.checkRelistCooldown(wallet, side, priceMicro)
    if (!cooldownResult.allowed) return cooldownResult

    // 4. Self-trade prevention
    const selfTradeResult = this.checkSelfTrade(wallet, side, priceMicro)
    if (!selfTradeResult.allowed) return selfTradeResult

    return { allowed: true }
  }

  // ── Rate Limiting ──────────────────────────────────────────

  /**
   * Check if the wallet has exceeded the per-hour order rate limit.
   * Uses a sliding window approach.
   */
  checkRateLimit(wallet: string): ValidationResult {
    const now = this.clock()
    const windowStart = now - RATE_LIMIT_WINDOW_MS

    // Get existing timestamps, prune stale entries
    let timestamps = this.orderTimestamps.get(wallet) ?? []
    timestamps = timestamps.filter((ts) => ts > windowStart)
    this.orderTimestamps.set(wallet, timestamps)

    if (timestamps.length >= MAX_ORDERS_PER_HOUR) {
      const oldestInWindow = timestamps[0]
      const retryAfterMs = oldestInWindow + RATE_LIMIT_WINDOW_MS - now
      return {
        allowed: false,
        reason: `Rate limited: max ${MAX_ORDERS_PER_HOUR} orders per hour. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
        code: "RATE_LIMITED",
      }
    }

    return { allowed: true }
  }

  /**
   * Record an order placement for rate limiting.
   * Call this AFTER the order is successfully placed.
   */
  recordOrder(wallet: string): void {
    const now = this.clock()
    const timestamps = this.orderTimestamps.get(wallet) ?? []
    timestamps.push(now)
    this.orderTimestamps.set(wallet, timestamps)
  }

  /**
   * Get the number of orders remaining in the current window for a wallet.
   */
  getRemainingOrders(wallet: string): number {
    const now = this.clock()
    const windowStart = now - RATE_LIMIT_WINDOW_MS
    const timestamps = this.orderTimestamps.get(wallet) ?? []
    const recentCount = timestamps.filter((ts) => ts > windowStart).length
    return Math.max(0, MAX_ORDERS_PER_HOUR - recentCount)
  }

  // ── Relist Cooldown ────────────────────────────────────────

  /**
   * Check if the wallet is within the relist cooldown period for
   * the given price and side combination.
   */
  checkRelistCooldown(
    wallet: string,
    side: OrderSide,
    priceMicro: number,
  ): ValidationResult {
    const now = this.clock()
    const records = this.cancelRecords.get(wallet) ?? []

    const recentCancel = records.find(
      (r) =>
        r.priceMicro === priceMicro &&
        r.side === side &&
        now - r.cancelledAt < RELIST_COOLDOWN_MS,
    )

    if (recentCancel) {
      const remainingMs = RELIST_COOLDOWN_MS - (now - recentCancel.cancelledAt)
      return {
        allowed: false,
        reason: `Relist cooldown: wait ${Math.ceil(remainingMs / 1000)}s before placing a ${side} at the same price`,
        code: "RELIST_COOLDOWN",
      }
    }

    return { allowed: true }
  }

  /**
   * Record a cancellation for relist cooldown tracking.
   * Call this when an order is cancelled.
   */
  recordCancellation(order: Order): void {
    const now = this.clock()
    let records = this.cancelRecords.get(order.wallet) ?? []

    // Prune old records (older than 2x cooldown window)
    const pruneThreshold = now - RELIST_COOLDOWN_MS * 2
    records = records.filter((r) => r.cancelledAt > pruneThreshold)

    records.push({
      priceMicro: order.priceMicro,
      side: order.side,
      cancelledAt: now,
    })

    this.cancelRecords.set(order.wallet, records)
  }

  // ── Self-Trade Prevention ──────────────────────────────────

  /**
   * Check if placing this order would immediately match against
   * the wallet's own resting order at a matchable price.
   */
  checkSelfTrade(
    wallet: string,
    side: OrderSide,
    priceMicro: number,
  ): ValidationResult {
    if (side === "bid") {
      // A bid would match asks. Check if the best ask is ours and matchable.
      const bestAsk = this.storage.peekBestAsk()
      if (
        bestAsk &&
        bestAsk.wallet === wallet &&
        priceMicro >= bestAsk.priceMicro
      ) {
        return {
          allowed: false,
          reason: "Self-trade prevention: order would match your own resting order",
          code: "SELF_TRADE",
        }
      }
    } else {
      // An ask would match bids. Check if the best bid is ours and matchable.
      const bestBid = this.storage.peekBestBid()
      if (
        bestBid &&
        bestBid.wallet === wallet &&
        priceMicro <= bestBid.priceMicro
      ) {
        return {
          allowed: false,
          reason: "Self-trade prevention: order would match your own resting order",
          code: "SELF_TRADE",
        }
      }
    }

    return { allowed: true }
  }

  // ── Cleanup ────────────────────────────────────────────────

  /**
   * Prune all stale tracking data. Call periodically to free memory.
   */
  prune(): { prunedTimestamps: number; prunedCancelRecords: number } {
    const now = this.clock()
    let prunedTimestamps = 0
    let prunedCancelRecords = 0

    // Prune order timestamps
    const windowStart = now - RATE_LIMIT_WINDOW_MS
    for (const [wallet, timestamps] of this.orderTimestamps.entries()) {
      const before = timestamps.length
      const pruned = timestamps.filter((ts) => ts > windowStart)
      prunedTimestamps += before - pruned.length
      if (pruned.length === 0) {
        this.orderTimestamps.delete(wallet)
      } else {
        this.orderTimestamps.set(wallet, pruned)
      }
    }

    // Prune cancel records
    const cancelPruneThreshold = now - RELIST_COOLDOWN_MS * 2
    for (const [wallet, records] of this.cancelRecords.entries()) {
      const before = records.length
      const pruned = records.filter((r) => r.cancelledAt > cancelPruneThreshold)
      prunedCancelRecords += before - pruned.length
      if (pruned.length === 0) {
        this.cancelRecords.delete(wallet)
      } else {
        this.cancelRecords.set(wallet, pruned)
      }
    }

    return { prunedTimestamps, prunedCancelRecords }
  }
}
