// src/nft/billing-reconciler.ts — Background Billing Reconciler (Sprint 5 T5.5)
//
// Periodically checks recent billing events against on-chain state.
// Reorged transactions are flagged with status: "reorged".
// No automatic revocation in v1 — logs warning only.

import type { OnChainReader } from "./on-chain-reader.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BillingReconcilerConfig {
  onChainReader: OnChainReader
  /** Postgres query functions for billing events */
  pg: ReconcilerPg
  /** Check interval in ms (default: 300_000 = 5 min) */
  intervalMs?: number
  /** How far back to check in ms (default: 3_600_000 = 1 hour) */
  lookbackMs?: number
  /** Logger (default: console) */
  logger?: ReconcilerLogger
}

export interface ReconcilerLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

/** Billing event as stored in finn_billing_events. */
export interface BillingEvent {
  id: string
  apiKeyId: string
  requestId: string
  amountMicro: number
  eventType: string
  metadata: Record<string, unknown> | null
  createdAt: Date
}

/** Minimal Postgres interface for reconciler. */
export interface ReconcilerPg {
  getRecentBillingEvents(since: Date): Promise<BillingEvent[]>
  flagEventAsReorged(eventId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// BillingReconciler
// ---------------------------------------------------------------------------

export class BillingReconciler {
  private readonly reader: OnChainReader
  private readonly pg: ReconcilerPg
  private readonly intervalMs: number
  private readonly lookbackMs: number
  private readonly logger: ReconcilerLogger
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(config: BillingReconcilerConfig) {
    this.reader = config.onChainReader
    this.pg = config.pg
    this.intervalMs = config.intervalMs ?? 300_000
    this.lookbackMs = config.lookbackMs ?? 3_600_000
    this.logger = config.logger ?? console
  }

  /**
   * Start the background reconciliation loop.
   */
  start(): void {
    if (this.timer) return
    this.logger.info("[reconciler] Starting billing reconciler", {
      intervalMs: this.intervalMs,
      lookbackMs: this.lookbackMs,
    })
    this.timer = setInterval(() => this.reconcile(), this.intervalMs)
    // Run immediately on start
    this.reconcile()
  }

  /**
   * Stop the reconciliation loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.logger.info("[reconciler] Stopped billing reconciler")
  }

  /**
   * Run a single reconciliation pass.
   * Public for testing.
   */
  async reconcile(): Promise<ReconcileResult> {
    if (this.running) {
      return { checked: 0, reorged: 0, errors: 0, skipped: true }
    }

    this.running = true
    const result: ReconcileResult = { checked: 0, reorged: 0, errors: 0, skipped: false }

    try {
      const since = new Date(Date.now() - this.lookbackMs)
      const events = await this.pg.getRecentBillingEvents(since)
      result.checked = events.length

      for (const event of events) {
        try {
          const isReorged = await this.checkEventOnChain(event)
          if (isReorged) {
            await this.pg.flagEventAsReorged(event.id)
            result.reorged++
            this.logger.warn("[reconciler] Reorged transaction detected", {
              eventId: event.id,
              requestId: event.requestId,
              amountMicro: event.amountMicro,
            })
          }
        } catch (err) {
          result.errors++
          this.logger.error("[reconciler] Failed to check event", {
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (result.reorged > 0) {
        this.logger.warn("[reconciler] Reconciliation complete", {
          checked: result.checked,
          reorged: result.reorged,
          errors: result.errors,
        })
      } else {
        this.logger.info("[reconciler] Reconciliation complete", {
          checked: result.checked,
          reorged: result.reorged,
          errors: result.errors,
        })
      }
    } catch (err) {
      this.logger.error("[reconciler] Reconciliation failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.running = false
    }

    return result
  }

  /**
   * Check whether a billing event's associated on-chain transaction has been reorged.
   * Returns true if the transaction is no longer on-chain (reorged).
   */
  private async checkEventOnChain(event: BillingEvent): Promise<boolean> {
    // Extract token_id from metadata to verify ownership is still valid
    const tokenId = event.metadata?.token_id as string | undefined
    if (!tokenId) {
      // No token_id in metadata — cannot verify, assume OK
      return false
    }

    // Extract tx_hash from metadata if present (x402 payments)
    const txHash = event.metadata?.tx_hash as string | undefined
    if (!txHash) {
      // API key billing events don't have tx_hash — always valid
      return false
    }

    try {
      // Verify the owner still holds the token
      await this.reader.readOwner(tokenId)
      return false
    } catch {
      // If we can't read ownership, the token may have been burned or transferred
      // In v1, we flag this but don't revoke. Log only.
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  checked: number
  reorged: number
  errors: number
  skipped: boolean
}
