// src/credits/billing-bridge.ts — Credit-Billing Bridge (Sprint 22 Task 22.1)
//
// Bridges the credit consumption engine with the BillingConservationGuard.
// Provides a unified billing interface: credits first, USDC fallback.

import type {
  CreditStore,
  ConsumptionResult,
  ConservationCheckpoint,
} from "./consumption.js"
import { reserveCredits, finalizeReservation, rollbackReservation } from "./consumption.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BillingResult {
  method: "credits" | "usdc" | "rejected"
  reservationId?: string
  amount?: number
  reason?: string
}

export interface UsdcBillingProvider {
  charge(wallet: string, amountCents: number): Promise<{ success: boolean; txId?: string }>
}

export interface BillingBridgeConfig {
  /** Credits to consume per invocation (default: 1) */
  creditsPerInvocation?: number
  /** USDC fallback cost in cents (default: 10) */
  usdcFallbackCents?: number
}

const DEFAULT_CONFIG: Required<BillingBridgeConfig> = {
  creditsPerInvocation: 1,
  usdcFallbackCents: 10,
}

// ---------------------------------------------------------------------------
// Billing Bridge
// ---------------------------------------------------------------------------

export class BillingBridge {
  private readonly store: CreditStore
  private readonly usdcProvider: UsdcBillingProvider | null
  private readonly conservation: ConservationCheckpoint | null
  private readonly config: Required<BillingBridgeConfig>

  constructor(
    store: CreditStore,
    usdcProvider?: UsdcBillingProvider | null,
    conservation?: ConservationCheckpoint | null,
    config?: BillingBridgeConfig,
  ) {
    this.store = store
    this.usdcProvider = usdcProvider ?? null
    this.conservation = conservation ?? null
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Authorize billing for an invocation.
   * Tries credits first, falls back to USDC if exhausted.
   * Returns 402 if credits are locked.
   */
  async authorize(wallet: string): Promise<BillingResult> {
    const result: ConsumptionResult = await reserveCredits(
      this.store,
      wallet,
      this.config.creditsPerInvocation,
      this.conservation ?? undefined,
    )

    switch (result.status) {
      case "reserved":
        return {
          method: "credits",
          reservationId: result.receipt.reservationId,
          amount: result.receipt.amount,
        }

      case "credits_locked":
        return {
          method: "rejected",
          reason: "Credits are allocated but not yet unlocked. Complete USDC unlock first.",
        }

      case "fallback_usdc":
        if (!this.usdcProvider) {
          return {
            method: "rejected",
            reason: "No credits available and USDC billing not configured.",
          }
        }
        return {
          method: "usdc",
          amount: this.config.usdcFallbackCents,
        }
    }
  }

  /**
   * Finalize billing after successful invocation.
   */
  async finalize(reservationId: string): Promise<void> {
    await finalizeReservation(this.store, reservationId, this.conservation ?? undefined)
  }

  /**
   * Rollback billing on invocation failure.
   */
  async rollback(reservationId: string): Promise<void> {
    await rollbackReservation(this.store, reservationId)
  }
}
