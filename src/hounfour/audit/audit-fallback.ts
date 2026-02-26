// src/hounfour/audit/audit-fallback.ts — CloudWatch Fallback (SDD §4.6.3, T-4.6)
//
// When DynamoDB is unavailable, structured JSON logs go to CloudWatch.
// No hash chain — just structured events for forensic reconstruction.
// Routing is NEVER blocked by audit infrastructure failures.

import type { AuditChainState, DynamoAuditChain } from "./dynamo-audit.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditFallbackEntry {
  source: "cloudwatch_fallback"
  action: string
  payload: Record<string, unknown>
  timestamp: string
  reason: string
}

// ---------------------------------------------------------------------------
// ResilientAuditLogger (T-4.6)
// ---------------------------------------------------------------------------

/**
 * Wraps DynamoAuditChain with CloudWatch fallback.
 *
 * - Primary: DynamoAuditChain.append() with hash chain integrity
 * - Fallback: Structured JSON to console (CloudWatch Logs agent picks it up)
 * - Routing is NEVER blocked by audit failures
 *
 * Warning emitted at first fallback and every 5 minutes thereafter.
 */
export class ResilientAuditLogger {
  private readonly chain: DynamoAuditChain
  private fallbackCount = 0
  private lastWarningTime = 0
  private readonly warningIntervalMs: number

  constructor(chain: DynamoAuditChain, warningIntervalMs: number = 5 * 60 * 1000) {
    this.chain = chain
    this.warningIntervalMs = warningIntervalMs
  }

  /**
   * Log an audit event. Tries DynamoDB chain first, falls back to CloudWatch.
   * NEVER throws — audit failures must not block routing.
   */
  async log(action: string, payload: Record<string, unknown>): Promise<{ method: "chain" | "fallback"; hash?: string }> {
    // Check if chain is ready
    if (this.chain.currentState === "uninitialized") {
      // Try init — if it fails, use fallback
      try {
        await this.chain.init()
      } catch {
        this.emitFallback(action, payload, "chain_init_failed")
        return { method: "fallback" }
      }
    }

    // Try primary (DynamoDB chain)
    if (this.chain.currentState === "ready") {
      try {
        const hash = await this.chain.append(action, payload)
        if (hash) {
          this.fallbackCount = 0 // Reset on success
          return { method: "chain", hash }
        }
        // null return means chain is degraded — use fallback
      } catch {
        // DynamoDB error — fall through to fallback
      }
    }

    // Fallback: structured JSON to CloudWatch
    this.emitFallback(action, payload, this.chain.currentState === "degraded" ? "chain_degraded" : "chain_error")
    return { method: "fallback" }
  }

  private emitFallback(action: string, payload: Record<string, unknown>, reason: string): void {
    this.fallbackCount++

    const entry: AuditFallbackEntry = {
      source: "cloudwatch_fallback",
      action,
      payload,
      timestamp: new Date().toISOString(),
      reason,
    }

    // Always emit the entry
    console.log(JSON.stringify(entry))

    // Emit warning at first fallback and every warningIntervalMs
    const now = Date.now()
    if (this.fallbackCount === 1 || now - this.lastWarningTime >= this.warningIntervalMs) {
      this.lastWarningTime = now
      console.warn(JSON.stringify({
        metric: "audit.fallback.warning",
        fallback_count: this.fallbackCount,
        reason,
        chain_state: this.chain.currentState,
        partition_id: this.chain.currentPartitionId,
        timestamp: now,
      }))
    }
  }

  // === ACCESSORS ===

  get chainState(): AuditChainState { return this.chain.currentState }
  get totalFallbacks(): number { return this.fallbackCount }
}
