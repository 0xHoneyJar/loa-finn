// src/marketplace/types.ts — Order, OrderBook, and Match types (Sprint 23, Task 23.1)
//
// Credit marketplace primitives. Orders are placed in lots (default 100 CU).
// Bids (buy) sorted price desc; Asks (sell) sorted price asc. Both use
// price-time priority. TTL-based expiry defaults to 7 days.

// ── Constants ────────────────────────────────────────────────

/** Standard lot size in Credit Units */
export const DEFAULT_LOT_SIZE = 100

/** Default order TTL in milliseconds (7 days) */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Marketplace fee as a fraction (10%) */
export const FEE_RATE = 0.10

// ── Order Types ──────────────────────────────────────────────

export type OrderSide = "bid" | "ask"

export type OrderStatus =
  | "open"
  | "partial"
  | "filled"
  | "cancelled"
  | "expired"

export interface Order {
  /** Unique order identifier (ULID or UUID) */
  id: string
  /** Wallet address of the order creator */
  wallet: string
  /** Buy or sell */
  side: OrderSide
  /** Price per lot in USDC micro-units (1 USDC = 1_000_000) */
  priceMicro: number
  /** Total lots in this order */
  lots: number
  /** Lots remaining to be filled */
  lotsRemaining: number
  /** Current order status */
  status: OrderStatus
  /** Timestamp when the order was placed (ms since epoch) */
  createdAt: number
  /** Timestamp when the order expires (ms since epoch) */
  expiresAt: number
  /** Timestamp of last update (ms since epoch) */
  updatedAt: number
}

// ── OrderBook ────────────────────────────────────────────────

export interface OrderBook {
  /** All bids sorted by price descending, then by createdAt ascending */
  bids: Order[]
  /** All asks sorted by price ascending, then by createdAt ascending */
  asks: Order[]
}

// ── Match Types ──────────────────────────────────────────────

export interface Match {
  /** Unique match identifier */
  id: string
  /** The bid order id */
  bidOrderId: string
  /** The ask order id */
  askOrderId: string
  /** Buyer wallet */
  buyerWallet: string
  /** Seller wallet */
  sellerWallet: string
  /** Execution price in USDC micro-units (taker price) */
  priceMicro: number
  /** Number of lots matched */
  lots: number
  /** Total USDC micro-units (priceMicro * lots) */
  totalMicro: number
  /** Fee in USDC micro-units (totalMicro * FEE_RATE) */
  feeMicro: number
  /** Net proceeds to seller (totalMicro - feeMicro) */
  sellerProceedsMicro: number
  /** Settlement instructions */
  settlement: SettlementInstruction
  /** Timestamp of the match */
  matchedAt: number
}

export interface SettlementInstruction {
  /** Credits to transfer from seller escrow to buyer */
  creditsToTransfer: number
  /** USDC micro-units to transfer from buyer to seller (net of fee) */
  usdcToSeller: number
  /** USDC micro-units to collect as fee */
  usdcFee: number
  /** Source escrow id (from ask placement) */
  escrowId: string
}

// ── Escrow Types ─────────────────────────────────────────────

export type EscrowStatus = "locked" | "released" | "settled"

export interface EscrowRecord {
  /** Unique escrow identifier */
  id: string
  /** The ask order that created this escrow */
  orderId: string
  /** Wallet that locked the credits */
  wallet: string
  /** Number of credit units locked */
  creditsLocked: number
  /** Credits remaining in escrow (decreases as lots fill) */
  creditsRemaining: number
  /** Current status */
  status: EscrowStatus
  /** Timestamp of creation */
  createdAt: number
  /** Timestamp of last update */
  updatedAt: number
}

// ── Settlement Result ────────────────────────────────────────

export type SettlementStatus = "success" | "failed" | "rolled_back"

export interface SettlementResult {
  matchId: string
  status: SettlementStatus
  /** Credits transferred to buyer */
  creditsTransferred: number
  /** USDC transferred to seller */
  usdcTransferred: number
  /** Fee collected */
  feeCollected: number
  /** Error message if failed */
  error?: string
  /** Timestamp */
  settledAt: number
}

// ── Wallet Balance (in-memory) ───────────────────────────────

export interface WalletBalance {
  /** Available credit units */
  credits: number
  /** Available USDC in micro-units */
  usdcMicro: number
}
