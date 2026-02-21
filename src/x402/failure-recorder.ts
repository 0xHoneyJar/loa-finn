// src/x402/failure-recorder.ts — Verification Failure Recording (Sprint 2 T2.7)
//
// Records failed x402 receipt verifications to finn_verification_failures table.
// Used for debugging, alerting, and fraud detection.

import { ulid } from "ulid"
import type { VerificationFailure } from "./receipt-verifier.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureRecorderDeps {
  /** Drizzle database instance (optional — degrades gracefully if DB unavailable) */
  db?: import("../drizzle/db.js").Db
}

// ---------------------------------------------------------------------------
// Failure Recorder
// ---------------------------------------------------------------------------

export class VerificationFailureRecorder {
  private readonly db: FailureRecorderDeps["db"]

  constructor(deps: FailureRecorderDeps) {
    this.db = deps.db
  }

  /**
   * Record a verification failure.
   * Best-effort: logs to console if DB insert fails.
   */
  async record(failure: VerificationFailure): Promise<void> {
    if (!this.db) {
      console.warn(
        JSON.stringify({
          metric: "x402.verification_failure",
          tx_hash: failure.tx_hash,
          reason: failure.reason,
          metadata: failure.metadata,
          timestamp: Date.now(),
          db: "unavailable",
        }),
      )
      return
    }

    try {
      const { finnVerificationFailures } = await import("../drizzle/schema.js")

      await this.db.insert(finnVerificationFailures).values({
        id: ulid(),
        txHash: failure.tx_hash,
        reason: failure.reason,
        metadata: failure.metadata,
        createdAt: new Date(),
      })
    } catch (err) {
      // Best-effort — log but don't break verification flow
      console.error(
        JSON.stringify({
          metric: "x402.verification_failure_record_error",
          tx_hash: failure.tx_hash,
          reason: failure.reason,
          error: (err as Error).message,
          timestamp: Date.now(),
        }),
      )
    }
  }

  /**
   * Create a callback suitable for X402ReceiptVerifier.onVerificationFailure.
   */
  callback(): (failure: VerificationFailure) => Promise<void> {
    return (failure) => this.record(failure)
  }
}
