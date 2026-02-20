// src/marketplace/storage.ts — Redis-like in-memory storage with sorted sets (Sprint 23, Task 23.1)
//
// In-memory storage backend for the credit marketplace. Provides:
// - Key-value store for orders, escrows, balances
// - Sorted sets for order book (bids by price desc, asks by price asc)
// - TTL-based expiry with lazy eviction
// - Atomic get/set semantics (single-threaded JS)

import type {
  Order,
  OrderSide,
  EscrowRecord,
  WalletBalance,
} from "./types.js"

// ── SortedSet ────────────────────────────────────────────────
// Maintains elements sorted by a score. Supports range queries
// and removal. Backed by a plain array with binary-search insert.

export interface SortedSetEntry<T> {
  score: number
  /** Secondary sort key (timestamp for price-time priority) */
  tiebreaker: number
  value: T
}

export class SortedSet<T> {
  private entries: SortedSetEntry<T>[] = []
  private readonly ascending: boolean

  /**
   * @param ascending — true for ascending score order (asks),
   *                     false for descending (bids)
   */
  constructor(ascending: boolean) {
    this.ascending = ascending
  }

  /** Insert a value with the given score and tiebreaker. */
  insert(value: T, score: number, tiebreaker: number): void {
    const entry: SortedSetEntry<T> = { score, tiebreaker, value }
    const idx = this.findInsertIndex(score, tiebreaker)
    this.entries.splice(idx, 0, entry)
  }

  /** Remove the first entry whose value satisfies the predicate. */
  remove(predicate: (v: T) => boolean): T | undefined {
    const idx = this.entries.findIndex((e) => predicate(e.value))
    if (idx === -1) return undefined
    return this.entries.splice(idx, 1)[0].value
  }

  /** Remove all entries matching the predicate. Returns removed values. */
  removeAll(predicate: (v: T) => boolean): T[] {
    const removed: T[] = []
    this.entries = this.entries.filter((e) => {
      if (predicate(e.value)) {
        removed.push(e.value)
        return false
      }
      return true
    })
    return removed
  }

  /** Return the top entry (best price) without removing it. */
  peek(): T | undefined {
    return this.entries[0]?.value
  }

  /** Return all entries in order. */
  toArray(): T[] {
    return this.entries.map((e) => e.value)
  }

  /** Number of entries in the set. */
  get size(): number {
    return this.entries.length
  }

  /** Binary search for the correct insertion index respecting sort order. */
  private findInsertIndex(score: number, tiebreaker: number): number {
    let lo = 0
    let hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const cmp = this.compare(this.entries[mid], score, tiebreaker)
      if (cmp <= 0) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  /**
   * Compare an existing entry against the target score/tiebreaker.
   * Returns negative if entry should come before target, positive if after.
   * For ascending: lower scores first. For descending: higher scores first.
   * Tiebreaker is always ascending (earlier time first = price-time priority).
   */
  private compare(
    entry: SortedSetEntry<T>,
    targetScore: number,
    targetTiebreaker: number,
  ): number {
    const scoreDiff = this.ascending
      ? entry.score - targetScore
      : targetScore - entry.score
    if (scoreDiff !== 0) return scoreDiff
    // Same score: earlier tiebreaker comes first (time priority)
    return entry.tiebreaker - targetTiebreaker
  }
}

// ── TTL Entry ────────────────────────────────────────────────

interface TTLEntry<T> {
  value: T
  expiresAt: number | null // null = no expiry
}

// ── MarketplaceStorage ──────────────────────────────────────

export class MarketplaceStorage {
  /** Order storage keyed by order ID */
  private orders: Map<string, TTLEntry<Order>> = new Map()

  /** Escrow records keyed by escrow ID */
  private escrows: Map<string, EscrowRecord> = new Map()

  /** Wallet balances keyed by wallet address */
  private balances: Map<string, WalletBalance> = new Map()

  /** Sorted set for bids (price descending, time ascending) */
  private bidSet: SortedSet<string> = new SortedSet<string>(false)

  /** Sorted set for asks (price ascending, time ascending) */
  private askSet: SortedSet<string> = new SortedSet<string>(true)

  /** Clock function for testability */
  private readonly clock: () => number

  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }

  // ── Order CRUD ───────────────────────────────────────────

  /** Store an order and insert into the appropriate sorted set. */
  putOrder(order: Order): void {
    this.orders.set(order.id, {
      value: order,
      expiresAt: order.expiresAt,
    })

    const set = order.side === "bid" ? this.bidSet : this.askSet
    set.insert(order.id, order.priceMicro, order.createdAt)
  }

  /** Retrieve an order by ID. Returns undefined if expired or not found. */
  getOrder(id: string): Order | undefined {
    const entry = this.orders.get(id)
    if (!entry) return undefined

    // Lazy expiry check
    if (entry.expiresAt !== null && this.clock() >= entry.expiresAt) {
      this.expireOrder(id, entry.value)
      return undefined
    }

    return entry.value
  }

  /** Update an existing order in place. Does NOT re-sort the sorted set. */
  updateOrder(order: Order): void {
    const entry = this.orders.get(order.id)
    if (!entry) return
    entry.value = order
  }

  /** Remove an order from storage and its sorted set. */
  removeOrder(id: string): Order | undefined {
    const entry = this.orders.get(id)
    if (!entry) return undefined

    const order = entry.value
    this.orders.delete(id)

    const set = order.side === "bid" ? this.bidSet : this.askSet
    set.remove((v) => v === id)

    return order
  }

  /** Get all open orders for a given wallet. */
  getOrdersByWallet(wallet: string): Order[] {
    const result: Order[] = []
    const now = this.clock()
    for (const entry of this.orders.values()) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) continue
      if (entry.value.wallet === wallet &&
          (entry.value.status === "open" || entry.value.status === "partial")) {
        result.push(entry.value)
      }
    }
    return result
  }

  // ── Order Book Queries ───────────────────────────────────

  /** Get the best bid order ID (highest price, earliest time). */
  peekBestBid(): Order | undefined {
    return this.peekBest(this.bidSet)
  }

  /** Get the best ask order ID (lowest price, earliest time). */
  peekBestAsk(): Order | undefined {
    return this.peekBest(this.askSet)
  }

  /** Get all open bids in sorted order. */
  getBids(): Order[] {
    return this.getOpenOrders(this.bidSet)
  }

  /** Get all open asks in sorted order. */
  getAsks(): Order[] {
    return this.getOpenOrders(this.askSet)
  }

  /** Remove the best bid from the sorted set (for matching). */
  popBestBid(): Order | undefined {
    return this.popBest(this.bidSet)
  }

  /** Remove the best ask from the sorted set (for matching). */
  popBestAsk(): Order | undefined {
    return this.popBest(this.askSet)
  }

  // ── Escrow ───────────────────────────────────────────────

  /** Store an escrow record. */
  putEscrow(escrow: EscrowRecord): void {
    this.escrows.set(escrow.id, escrow)
  }

  /** Retrieve an escrow record by ID. */
  getEscrow(id: string): EscrowRecord | undefined {
    return this.escrows.get(id)
  }

  /** Retrieve escrow by order ID. */
  getEscrowByOrderId(orderId: string): EscrowRecord | undefined {
    for (const escrow of this.escrows.values()) {
      if (escrow.orderId === orderId) return escrow
    }
    return undefined
  }

  /** Update an escrow record. */
  updateEscrow(escrow: EscrowRecord): void {
    this.escrows.set(escrow.id, escrow)
  }

  // ── Wallet Balances ──────────────────────────────────────

  /** Get wallet balance, creating a zero-balance entry if absent. */
  getBalance(wallet: string): WalletBalance {
    let bal = this.balances.get(wallet)
    if (!bal) {
      bal = { credits: 0, usdcMicro: 0 }
      this.balances.set(wallet, bal)
    }
    return bal
  }

  /** Set wallet balance directly. */
  setBalance(wallet: string, balance: WalletBalance): void {
    this.balances.set(wallet, balance)
  }

  // ── Expiry ───────────────────────────────────────────────

  /** Expire all orders past their TTL. Returns the number of expired orders. */
  expireStale(): number {
    const now = this.clock()
    let count = 0
    for (const [id, entry] of this.orders.entries()) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        if (entry.value.status === "open" || entry.value.status === "partial") {
          this.expireOrder(id, entry.value)
          count++
        }
      }
    }
    return count
  }

  /** Total number of orders in storage (including expired-but-not-yet-evicted). */
  get orderCount(): number {
    return this.orders.size
  }

  /** Total number of escrow records. */
  get escrowCount(): number {
    return this.escrows.size
  }

  // ── Internal ─────────────────────────────────────────────

  /** Mark an order as expired, remove from sorted set. */
  private expireOrder(id: string, order: Order): void {
    order.status = "expired"
    order.updatedAt = this.clock()
    const set = order.side === "bid" ? this.bidSet : this.askSet
    set.remove((v) => v === id)
  }

  /** Peek the best order from a sorted set, skipping expired entries. */
  private peekBest(set: SortedSet<string>): Order | undefined {
    const now = this.clock()
    for (const id of set.toArray()) {
      const entry = this.orders.get(id)
      if (!entry) continue
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.expireOrder(id, entry.value)
        continue
      }
      if (entry.value.status === "open" || entry.value.status === "partial") {
        return entry.value
      }
    }
    return undefined
  }

  /** Pop the best valid order from a sorted set. */
  private popBest(set: SortedSet<string>): Order | undefined {
    const now = this.clock()
    while (set.size > 0) {
      const id = set.peek()
      if (id === undefined) return undefined

      const entry = this.orders.get(id)
      if (!entry) {
        set.remove((v) => v === id)
        continue
      }

      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.expireOrder(id, entry.value)
        set.remove((v) => v === id)
        continue
      }

      if (entry.value.status !== "open" && entry.value.status !== "partial") {
        set.remove((v) => v === id)
        continue
      }

      set.remove((v) => v === id)
      return entry.value
    }
    return undefined
  }

  /** Get all open orders from a sorted set, filtering expired. */
  private getOpenOrders(set: SortedSet<string>): Order[] {
    const now = this.clock()
    const result: Order[] = []
    for (const id of set.toArray()) {
      const entry = this.orders.get(id)
      if (!entry) continue
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.expireOrder(id, entry.value)
        continue
      }
      if (entry.value.status === "open" || entry.value.status === "partial") {
        result.push(entry.value)
      }
    }
    return result
  }
}
