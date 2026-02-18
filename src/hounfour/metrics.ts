// src/hounfour/metrics.ts — Evaluator Observability Metrics (SDD §NFR-5, Sprint 2 Task 2.10)
// Structured metric collection for BillingConservationGuard.
// Default implementation logs to console; production can swap for OTLP/StatsD.

// --- Types ---

/** Structured detail for HARD-FAIL log entries (no PII). */
export interface HardFailDetail {
  invariant_id: string
  input_summary: Record<string, string>
  evaluator_result: "pass" | "fail" | "error" | "bypassed"
  adhoc_result: "pass" | "fail"
  effective: "fail"
  timestamp: string
}

// --- Interface ---

/**
 * Metrics collector for BillingConservationGuard observability.
 *
 * 6 required signals (SDD §NFR-5):
 *   evaluator.compile.duration_ms    — Gauge/Histogram
 *   evaluator.check.p95_ms           — Gauge/Histogram per invariant_id
 *   evaluator.hard_fail.count        — Counter by invariant_id
 *   evaluator.circuit.state           — Gauge (1=open, 0=closed)
 *   evaluator.registry.constraint_count — Gauge
 *   evaluator.divergence              — Counter by invariant_id
 */
export interface GuardMetrics {
  recordCompileDuration(durationMs: number): void
  recordCheckDuration(invariantId: string, durationMs: number): void
  recordHardFail(detail: HardFailDetail): void
  recordCircuitState(state: "open" | "closed"): void
  recordConstraintCount(count: number): void
  recordDivergence(invariantId: string, evaluatorResult: string, adhocResult: string): void
}

// --- Noop Implementation ---

/** No-op metrics — used when no collector is configured. */
export const noopMetrics: GuardMetrics = {
  recordCompileDuration() {},
  recordCheckDuration() {},
  recordHardFail() {},
  recordCircuitState() {},
  recordConstraintCount() {},
  recordDivergence() {},
}

// --- Console Implementation ---

/**
 * Structured console logging metrics collector.
 * Emits JSON-structured log lines compatible with log aggregation pipelines.
 */
export class ConsoleGuardMetrics implements GuardMetrics {
  recordCompileDuration(durationMs: number): void {
    console.log(JSON.stringify({
      metric: "evaluator.compile.duration_ms",
      value: durationMs,
      ts: new Date().toISOString(),
    }))
  }

  recordCheckDuration(invariantId: string, durationMs: number): void {
    console.log(JSON.stringify({
      metric: "evaluator.check.duration_ms",
      invariant_id: invariantId,
      value: durationMs,
      ts: new Date().toISOString(),
    }))
  }

  recordHardFail(detail: HardFailDetail): void {
    console.error(JSON.stringify({
      metric: "evaluator.hard_fail",
      level: "HARD_FAIL",
      ...detail,
    }))
  }

  recordCircuitState(state: "open" | "closed"): void {
    const level = state === "open" ? "error" : "info"
    const logFn = state === "open" ? console.error : console.log
    logFn(JSON.stringify({
      metric: "evaluator.circuit.state",
      value: state === "open" ? 1 : 0,
      state,
      level,
      ts: new Date().toISOString(),
    }))
  }

  recordConstraintCount(count: number): void {
    console.log(JSON.stringify({
      metric: "evaluator.registry.constraint_count",
      value: count,
      ts: new Date().toISOString(),
    }))
  }

  recordDivergence(invariantId: string, evaluatorResult: string, adhocResult: string): void {
    console.warn(JSON.stringify({
      metric: "evaluator.divergence",
      invariant_id: invariantId,
      evaluator_result: evaluatorResult,
      adhoc_result: adhocResult,
      ts: new Date().toISOString(),
    }))
  }
}
