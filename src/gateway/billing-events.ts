// src/gateway/billing-events.ts — Billing Events Recording (Sprint 3 T3.6)
//
// Records billing events for every paid request into finn_billing_events.
// Append-only audit trail for payment reconciliation and analytics.

import { ulid } from "ulid"
import type { Db } from "../drizzle/db.js"
import { finnBillingEvents } from "../drizzle/schema.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BillingEvent {
  requestId: string
  paymentMethod: "x402" | "api_key" | "free"
  amountMicro: number
  txHash?: string
  apiKeyId?: string
  responseStatus: number
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Billing Events Recorder
// ---------------------------------------------------------------------------

export class BillingEventsRecorder {
  private readonly db: Db | undefined

  constructor(db?: Db) {
    this.db = db
  }

  /**
   * Record a billing event. Best-effort — never breaks the request flow.
   */
  async record(event: BillingEvent): Promise<void> {
    if (!this.db) {
      console.warn(
        JSON.stringify({
          metric: "finn.billing_event",
          ...event,
          db: "unavailable",
          timestamp: Date.now(),
        }),
      )
      return
    }

    try {
      await this.db.insert(finnBillingEvents).values({
        id: ulid(),
        apiKeyId: event.apiKeyId ?? event.txHash ?? "free",
        requestId: event.requestId,
        amountMicro: event.amountMicro,
        balanceAfter: 0, // Not applicable for x402/free — balance tracking is API key only
        eventType: event.paymentMethod === "free" ? "free" : "debit",
        metadata: {
          payment_method: event.paymentMethod,
          tx_hash: event.txHash ?? null,
          api_key_id: event.apiKeyId ?? null,
          response_status: event.responseStatus,
          ...event.metadata,
        },
      })
    } catch (err) {
      // Unique constraint on requestId — idempotent replay, not an error
      if ((err as Error).message?.includes("unique")) return

      console.error(
        JSON.stringify({
          metric: "finn.billing_event_record_error",
          requestId: event.requestId,
          error: (err as Error).message,
          timestamp: Date.now(),
        }),
      )
    }
  }
}
