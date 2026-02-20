// src/billing/metrics.ts — Billing Observability Metrics (Sprint 1 Task 1.11)
//
// Prometheus-compatible metrics for the billing pipeline.
// Console implementation for initial deployment; swap for OTLP/StatsD in production.

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface BillingMetrics {
  /** billing_state_transitions_total counter by from_state, to_state */
  recordStateTransition(fromState: string, toState: string): void
  /** billing_reserve_duration_ms histogram */
  recordReserveDuration(durationMs: number): void
  /** billing_commit_duration_ms histogram */
  recordCommitDuration(durationMs: number): void
  /** billing_finalize_duration_ms histogram */
  recordFinalizeDuration(durationMs: number): void
  /** billing_pending_reconciliation_count gauge */
  recordPendingCount(count: number): void
  /** billing_circuit_breaker_state gauge: 0=CLOSED, 1=OPEN, 2=HALF_OPEN */
  recordCircuitBreakerState(state: "CLOSED" | "OPEN" | "HALF_OPEN"): void
  /** wal_replay_duration_ms histogram */
  recordWALReplayDuration(durationMs: number): void
}

// ---------------------------------------------------------------------------
// Noop Implementation
// ---------------------------------------------------------------------------

export const noopBillingMetrics: BillingMetrics = {
  recordStateTransition() {},
  recordReserveDuration() {},
  recordCommitDuration() {},
  recordFinalizeDuration() {},
  recordPendingCount() {},
  recordCircuitBreakerState() {},
  recordWALReplayDuration() {},
}

// ---------------------------------------------------------------------------
// Console Implementation
// ---------------------------------------------------------------------------

const CIRCUIT_STATE_MAP = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 } as const

export class ConsoleBillingMetrics implements BillingMetrics {
  recordStateTransition(fromState: string, toState: string): void {
    console.log(JSON.stringify({
      metric: "billing_state_transitions_total",
      from_state: fromState,
      to_state: toState,
      ts: new Date().toISOString(),
    }))
  }

  recordReserveDuration(durationMs: number): void {
    console.log(JSON.stringify({
      metric: "billing_reserve_duration_ms",
      value: durationMs,
      ts: new Date().toISOString(),
    }))
  }

  recordCommitDuration(durationMs: number): void {
    console.log(JSON.stringify({
      metric: "billing_commit_duration_ms",
      value: durationMs,
      ts: new Date().toISOString(),
    }))
  }

  recordFinalizeDuration(durationMs: number): void {
    console.log(JSON.stringify({
      metric: "billing_finalize_duration_ms",
      value: durationMs,
      ts: new Date().toISOString(),
    }))
  }

  recordPendingCount(count: number): void {
    console.log(JSON.stringify({
      metric: "billing_pending_reconciliation_count",
      value: count,
      ts: new Date().toISOString(),
    }))
  }

  recordCircuitBreakerState(state: "CLOSED" | "OPEN" | "HALF_OPEN"): void {
    console.log(JSON.stringify({
      metric: "billing_circuit_breaker_state",
      value: CIRCUIT_STATE_MAP[state],
      state,
      ts: new Date().toISOString(),
    }))
  }

  recordWALReplayDuration(durationMs: number): void {
    console.log(JSON.stringify({
      metric: "wal_replay_duration_ms",
      value: durationMs,
      ts: new Date().toISOString(),
    }))
  }
}
