// src/hounfour/billing-invariants.ts — Conservation invariants (SDD §3.6, Sprint 1 T3)
//
// Five billing conservation invariants as documented constants + helper assertions.
// Zero runtime dependencies — pure assertions for property-based tests and inline checks.

import type { FinalizeResult } from "./billing-finalize-client.js"

// --- Invariant Constants ---

export const BILLING_INVARIANTS = {
  /** Every finalize() returns one of: finalized, idempotent, dlq */
  INV_1_COMPLETENESS: "Every finalize() returns one of: finalized, idempotent, dlq",
  /** In durable mode, outcome=dlq implies entry persisted in DLQStore */
  INV_2_PERSISTENCE_DURABLE: "In durable mode, outcome=dlq implies entry persisted in DLQStore",
  /** In degraded mode, outcome=dlq implies entry in memory + ERROR log */
  INV_2D_PERSISTENCE_DEGRADED: "In degraded mode, outcome=dlq implies entry in memory + ERROR log",
  /** Duplicate finalize for same reservation_id returns idempotent (via 409) */
  INV_3_IDEMPOTENCY: "Duplicate finalize for same reservation_id returns idempotent (via 409)",
  /** actual_cost_micro is never modified after initial computation */
  INV_4_COST_IMMUTABILITY: "actual_cost_micro is never modified after initial computation",
  /** Every DLQ entry replayed at most maxRetries times with backoff */
  INV_5_BOUNDED_RETRY: "Every DLQ entry replayed at most maxRetries times with backoff",
} as const

// --- Assertion Helpers ---

/** Assert INV-1: outcome is always one of the three valid states */
export function assertCompleteness(result: FinalizeResult): void {
  if (result.ok) {
    if (result.status !== "finalized" && result.status !== "idempotent") {
      throw new Error(`INV-1 violated: ok=true but status=${(result as any).status}`)
    }
  } else {
    if (result.status !== "dlq") {
      throw new Error(`INV-1 violated: ok=false but status=${(result as any).status}`)
    }
  }
}

/** Assert INV-5: attempt_count never exceeds maxRetries */
export function assertBoundedRetry(attemptCount: number, maxRetries: number): void {
  if (attemptCount > maxRetries) {
    throw new Error(`INV-5 violated: attempt_count=${attemptCount} exceeds maxRetries=${maxRetries}`)
  }
}

/** Valid FinalizeResult statuses for completeness checks */
export const VALID_OK_STATUSES = ["finalized", "idempotent"] as const
export const VALID_FAIL_STATUSES = ["dlq"] as const
