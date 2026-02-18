// src/hounfour/billing-conservation-guard.ts — BillingConservationGuard (SDD §4.2, §7.2, §7.6)
// Fail-closed evaluator wrapper for billing invariants.
// Wraps (does not replace) existing ad-hoc checks in budget.ts / billing-finalize-client.ts.

import { performance } from "node:perf_hooks"
import {
  evaluateConstraintDetailed,
  type EvaluationResult,
} from "@0xhoneyjar/loa-hounfour"
import { assertMicroUSDFormat } from "./wire-boundary.js"
import { noopMetrics, type GuardMetrics, type HardFailDetail } from "./metrics.js"
import type { WAL } from "../persistence/wal.js"
import type { AlertService } from "../safety/alert-service.js"

// --- Types ---

export interface InvariantResult {
  ok: boolean
  invariant_id: string
  evaluator_result: "pass" | "fail" | "error" | "bypassed"
  adhoc_result: "pass" | "fail"
  /** Strict lattice: PASS only if evaluator=pass AND adhoc=pass.
   *  FAIL if evaluator=fail|error OR adhoc=fail.
   *  When bypassed: effective follows adhoc_result only. */
  effective: "pass" | "fail"
}

export interface GuardHealth {
  billing: "ready" | "degraded" | "unavailable"
  evaluator_compiled: boolean
  state: GuardState
}

export type GuardState = "uninitialized" | "ready" | "degraded" | "bypassed"

/** Audit WAL entry payload for evaluator lifecycle events (SDD §7.6). */
export interface AuditWALPayload {
  subtype: "evaluator_bypass" | "evaluator_recovery" | "evaluator_degraded"
  pod_id: string
  build_sha: string
  timestamp: string
}

/** Optional dependencies for bypass security (SDD §7.2) and observability (SDD §NFR-5). */
export interface GuardDeps {
  wal?: WAL
  alertService?: AlertService
  metrics?: GuardMetrics
  podId?: string
  buildSha?: string
}

// --- Constraint Expressions ---

const CONSTRAINT_EXPRESSIONS = {
  budget_conservation: "bigint_gte(limit, spent)",
  cost_non_negative: "bigint_gte(cost, zero)",
  reserve_within_allocation: "bigint_gte(allocation, reserve)",
  // MicroUSD format is ad-hoc-only: constraint language lacks string pattern matching.
  // Evaluator returns "bypassed" for this invariant; ad-hoc assertMicroUSDFormat() does real validation.
  // The lattice still enforces fail-closed via the ad-hoc result.
  micro_usd_format: null,
  // Sprint 3: Entitlement state check — ad-hoc only (state enum, not numeric expression)
  entitlement_valid: null,
  // Sprint 3: Rate consistency — ad-hoc only (floating-point comparison not in constraint language)
  rate_consistency: null,
} as const

type InvariantId = keyof typeof CONSTRAINT_EXPRESSIONS

// --- Billing Entrypoints (SDD §4.2 — exhaustive inventory) ---

/** All HTTP routes that write billing side-effects. Guard middleware must gate each. */
export const BILLING_ENTRYPOINTS = [
  { path: "/api/v1/invoke", method: "POST", description: "Model invocation — triggers billing reserve + finalize" },
  { path: "/api/v1/oracle", method: "POST", description: "Oracle query — triggers model invocation → billing" },
] as const

export type BillingEntrypoint = (typeof BILLING_ENTRYPOINTS)[number]

// --- Retry Config ---

const INIT_RETRY_DELAYS_MS = [1000, 2000, 4000]
const DEFAULT_RECOVERY_INTERVAL_MS = 60_000

// --- Guard ---

export class BillingConservationGuard {
  private compiled = false
  private state: GuardState = "uninitialized"
  private bypassed = false
  private recoveryStopped = false // BB-026-iter2-002: state-based recovery control
  private readonly deps: GuardDeps
  private readonly metrics: GuardMetrics
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps?: GuardDeps) {
    this.deps = deps ?? {}
    this.metrics = deps?.metrics ?? noopMetrics
  }

  // === LIFECYCLE ===

  /**
   * Initialize the guard. Checks EVALUATOR_BYPASS env, compiles constraint
   * expressions with retry.
   *
   * Bypass is startup-only — cannot be toggled at runtime (SDD §7.2).
   * Idempotent: calling init() when ready is a no-op.
   */
  async init(): Promise<void> {
    if (this.state === "ready" || this.state === "bypassed") return

    // Check EVALUATOR_BYPASS env — break-glass only (SDD §7.2)
    if (process.env.EVALUATOR_BYPASS === "true") {
      this.state = "bypassed"
      this.bypassed = true
      console.warn("[billing-conservation-guard] EVALUATOR_BYPASS=true — running ad-hoc only. This is a break-glass mode.")

      // WAL audit entry: immutable audit trail on bypass (SDD §7.2)
      this.writeAuditEntry("evaluator_bypass")

      // Critical alert: evaluator bypass active (SDD §7.2)
      await this.fireBypassAlert()

      return
    }

    // Attempt compilation with retry
    let lastError: unknown
    for (let attempt = 0; attempt < INIT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const compileStart = performance.now()
        this.compileConstraints()
        const compileDuration = performance.now() - compileStart
        this.compiled = true
        this.state = "ready"
        this.metrics.recordCompileDuration(compileDuration)
        this.metrics.recordConstraintCount(Object.keys(CONSTRAINT_EXPRESSIONS).length)
        this.metrics.recordCircuitState("closed")
        console.log(`[billing-conservation-guard] Compiled ${Object.keys(CONSTRAINT_EXPRESSIONS).length} constraint expressions (attempt ${attempt + 1})`)
        return
      } catch (err) {
        lastError = err
        if (attempt < INIT_RETRY_DELAYS_MS.length - 1) {
          await sleep(INIT_RETRY_DELAYS_MS[attempt])
        }
      }
    }

    // All retries exhausted — degraded state (circuit-open)
    this.state = "degraded"
    this.metrics.recordCircuitState("open")
    this.writeAuditEntry("evaluator_degraded")
    await this.fireCircuitOpenAlert()
    console.error(`[billing-conservation-guard] Compilation failed after ${INIT_RETRY_DELAYS_MS.length} attempts:`, lastError)
  }

  /**
   * Health response for /health endpoint.
   * Maps state to billing health status.
   */
  getHealth(): GuardHealth {
    const healthMap: Record<GuardState, GuardHealth["billing"]> = {
      uninitialized: "unavailable",
      ready: "ready",
      degraded: "degraded",
      bypassed: "ready",
    }

    return {
      billing: healthMap[this.state],
      evaluator_compiled: this.compiled,
      state: this.state,
    }
  }

  /**
   * Whether billing operations can proceed.
   * True when evaluator is ready (compiled) or bypassed (ad-hoc only).
   */
  isBillingReady(): boolean {
    return this.state === "ready" || this.state === "bypassed"
  }

  // === RECOVERY ===

  /**
   * Start background recovery timer. Retries compilation every intervalMs
   * while in degraded state. On success: transitions to ready, writes
   * recovery WAL entry. Idempotent — only runs if degraded.
   */
  startRecoveryTimer(intervalMs: number = DEFAULT_RECOVERY_INTERVAL_MS): void {
    if (this.recoveryTimer) return
    if (this.state !== "degraded") return
    if (this.recoveryStopped) return // BB-026-iter2-002: no retry after explicit stop

    let currentInterval = intervalMs
    const maxInterval = intervalMs * 10 // Cap at 10x base (e.g., 10 min if base is 60s)

    const scheduleNext = () => {
      this.recoveryTimer = setTimeout(() => {
        if (this.state !== "degraded") {
          this.stopRecoveryTimer()
          return
        }
        try {
          this.compileConstraints()
          this.compiled = true
          this.state = "ready"
          this.metrics.recordCircuitState("closed")
          this.metrics.recordConstraintCount(Object.keys(CONSTRAINT_EXPRESSIONS).length)
          this.writeAuditEntry("evaluator_recovery")
          console.log("[billing-conservation-guard] Recovery: evaluator recompiled successfully, state=ready")
          this.stopRecoveryTimer()
        } catch (err) {
          console.warn("[billing-conservation-guard] Recovery attempt failed:", err instanceof Error ? err.message : String(err))
          // Exponential backoff with 25% jitter, capped at maxInterval
          currentInterval = Math.min(currentInterval * 2, maxInterval)
          scheduleNext()
        }
      }, currentInterval + Math.floor(currentInterval * 0.25 * (Math.random() - 0.5)))

      if (this.recoveryTimer?.unref) {
        this.recoveryTimer.unref()
      }
    }

    scheduleNext()
  }

  /**
   * Stop the recovery timer. Called on recovery success or shutdown.
   */
  stopRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
    this.recoveryStopped = true // BB-026-iter2-002: prevent re-start after explicit stop
  }

  // === INVARIANT CHECKS ===

  /**
   * Check that spent does not exceed limit (budget conservation).
   * Both values as bigint for evaluator context.
   */
  checkBudgetConservation(spent: bigint, limit: bigint): InvariantResult {
    const adhoc = spent <= limit ? "pass" : "fail" as const
    return this.runCheck("budget_conservation", { spent: String(spent), limit: String(limit), zero: "0" }, adhoc)
  }

  /**
   * Check that cost is non-negative.
   */
  checkCostNonNegative(cost: bigint): InvariantResult {
    const adhoc = cost >= 0n ? "pass" : "fail" as const
    return this.runCheck("cost_non_negative", { cost: String(cost), zero: "0" }, adhoc)
  }

  /**
   * Check that reserve does not exceed allocation.
   */
  checkReserveWithinAllocation(reserve: bigint, allocation: bigint): InvariantResult {
    const adhoc = reserve <= allocation ? "pass" : "fail" as const
    return this.runCheck("reserve_within_allocation", { reserve: String(reserve), allocation: String(allocation), zero: "0" }, adhoc)
  }

  /**
   * Check that a string value conforms to canonical MicroUSD wire format.
   */
  checkMicroUSDFormat(value: string): InvariantResult {
    let adhoc: "pass" | "fail" = "fail"
    try {
      assertMicroUSDFormat(value)
      adhoc = "pass"
    } catch {
      adhoc = "fail"
    }
    return this.runCheck("micro_usd_format", { value }, adhoc)
  }

  /**
   * Check that BYOK entitlement state is valid for inference (Sprint 3 Task 3.3).
   * Valid states: ACTIVE, PAST_DUE. Invalid: GRACE_EXPIRED, CANCELLED.
   */
  checkEntitlementValid(state: string): InvariantResult {
    const validStates = new Set(["ACTIVE", "PAST_DUE"])
    const adhoc = validStates.has(state) ? "pass" : "fail" as const
    return this.runCheck("entitlement_valid", { state }, adhoc)
  }

  /**
   * Check that COMMIT uses the frozen rate from RESERVE, not a different rate (Sprint 3 Task 3.3).
   * Verifies rate consistency per billing_entry_id across the Reserve→Commit lifecycle.
   */
  checkRateConsistency(commitRate: number, reserveRate: number): InvariantResult {
    const adhoc = commitRate === reserveRate ? "pass" : "fail" as const
    return this.runCheck("rate_consistency", {
      commit_rate: String(commitRate),
      reserve_rate: String(reserveRate),
    }, adhoc)
  }

  // === PRIVATE ===

  /**
   * Compile all constraint expressions at startup.
   * Validates that the evaluator can parse each expression.
   */
  private compileConstraints(): void {
    for (const [id, expr] of Object.entries(CONSTRAINT_EXPRESSIONS)) {
      // Null expressions are ad-hoc only; skip evaluator compilation
      if (expr === null) continue

      // Dry-run evaluation to verify expression compiles
      const result = evaluateConstraintDetailed(expr, { spent: "0", limit: "0", cost: "0", zero: "0", reserve: "0", allocation: "0", value: "0" })
      if (!result.valid) {
        throw new Error(`Constraint "${id}" failed to compile: ${result.error ?? "unknown evaluator error"}`)
      }
    }
  }

  /**
   * Run a check through both evaluator and ad-hoc, apply strict fail-closed lattice.
   *
   * Strict lattice:
   * - PASS: evaluator=pass AND adhoc=pass
   * - FAIL: evaluator=fail|error OR adhoc=fail
   * - Bypassed: effective follows adhoc_result only
   */
  private runCheck(
    invariantId: InvariantId,
    context: Record<string, unknown>,
    adhocResult: "pass" | "fail",
  ): InvariantResult {
    const checkStart = performance.now()

    // Bypass mode: ad-hoc only + structured logging (SDD §7.2)
    if (this.bypassed) {
      this.metrics.recordCheckDuration(invariantId, performance.now() - checkStart)
      console.warn(`[billing-conservation-guard] ${invariantId}: evaluator_bypassed=true pod_id=${this.deps.podId ?? "unknown"} build_sha=${this.deps.buildSha ?? "unknown"}`)
      const result: InvariantResult = {
        ok: adhocResult === "pass",
        invariant_id: invariantId,
        evaluator_result: "bypassed",
        adhoc_result: adhocResult,
        effective: adhocResult,
      }
      if (adhocResult === "fail") {
        this.emitHardFail(invariantId, context, "bypassed", adhocResult)
      }
      return result
    }

    // Degraded: evaluator unavailable → treat as FAIL (fail-closed)
    if (this.state === "degraded" || !this.compiled) {
      this.metrics.recordCheckDuration(invariantId, performance.now() - checkStart)
      console.error(`[billing-conservation-guard] ${invariantId}: evaluator unavailable (state=${this.state}), effective=FAIL`)
      this.emitHardFail(invariantId, context, "error", adhocResult)
      return {
        ok: false,
        invariant_id: invariantId,
        evaluator_result: "error",
        adhoc_result: adhocResult,
        effective: "fail",
      }
    }

    // Run evaluator
    let evaluatorResult: "pass" | "fail" | "error" | "bypassed"
    const expression = CONSTRAINT_EXPRESSIONS[invariantId]

    if (expression === null) {
      // Ad-hoc only constraint — evaluator bypassed for this invariant
      evaluatorResult = "bypassed"
    } else {
      try {
        const evalResult: EvaluationResult = evaluateConstraintDetailed(expression, context)

        if (!evalResult.valid) {
          evaluatorResult = "error"
          console.error(`[billing-conservation-guard] ${invariantId}: evaluator error: ${evalResult.error}`)
        } else {
          evaluatorResult = evalResult.value ? "pass" : "fail"
        }
      } catch (err) {
        // Evaluator runtime error → FAIL (not fallback)
        evaluatorResult = "error"
        console.error(`[billing-conservation-guard] ${invariantId}: evaluator threw:`, err instanceof Error ? err.message : String(err))
      }
    }

    // Record check duration
    this.metrics.recordCheckDuration(invariantId, performance.now() - checkStart)

    // Strict fail-closed lattice
    // Bypassed evaluator: effective follows ad-hoc result only
    // Active evaluator: both must pass (conjunction)
    const effective: "pass" | "fail" =
      evaluatorResult === "bypassed"
        ? adhocResult
        : evaluatorResult === "pass" && adhocResult === "pass"
          ? "pass"
          : "fail"

    // Divergence monitoring: only when both evaluator and ad-hoc produce definitive results
    if ((evaluatorResult === "pass" || evaluatorResult === "fail") && evaluatorResult !== adhocResult) {
      this.metrics.recordDivergence(invariantId, evaluatorResult, adhocResult)
      console.warn(`[billing-conservation-guard] DIVERGENCE: ${invariantId} evaluator=${evaluatorResult} adhoc=${adhocResult}`)
    }

    // Emit HARD-FAIL metric + structured log on failure
    if (effective === "fail") {
      this.emitHardFail(invariantId, context, evaluatorResult, adhocResult)
    }

    return {
      ok: effective === "pass",
      invariant_id: invariantId,
      evaluator_result: evaluatorResult,
      adhoc_result: adhocResult,
      effective,
    }
  }

  /**
   * Write an audit entry to the WAL (SDD §7.6).
   * Best-effort: never throws. If WAL is unavailable, logs to stderr.
   */
  private writeAuditEntry(subtype: AuditWALPayload["subtype"]): void {
    const payload: AuditWALPayload = {
      subtype,
      pod_id: this.deps.podId ?? process.env.POD_ID ?? "unknown",
      build_sha: this.deps.buildSha ?? process.env.BUILD_SHA ?? "unknown",
      timestamp: new Date().toISOString(),
    }

    if (this.deps.wal) {
      try {
        this.deps.wal.append("audit", "create", `billing-conservation-guard/${subtype}`, payload)
      } catch (err) {
        console.error(`[billing-conservation-guard] WAL audit write failed (${subtype}):`, err instanceof Error ? err.message : String(err))
      }
    } else {
      console.warn(`[billing-conservation-guard] WAL unavailable, audit entry logged only: ${JSON.stringify(payload)}`)
    }
  }

  /**
   * Emit HARD-FAIL metric and structured log entry (SDD §NFR-5).
   * Sanitizes context to numeric billing fields only — no PII.
   */
  private emitHardFail(
    invariantId: InvariantId,
    context: Record<string, unknown>,
    evaluatorResult: "pass" | "fail" | "error" | "bypassed",
    adhocResult: "pass" | "fail",
  ): void {
    // Sanitize input to numeric billing fields only (no PII)
    const allowedKeys = new Set(["spent", "limit", "cost", "zero", "reserve", "allocation", "value", "state", "commit_rate", "reserve_rate"])
    // Safe enum values that are allowed through (non-numeric but not PII)
    const safeEnumValues = new Set(["ACTIVE", "PAST_DUE", "GRACE_EXPIRED", "CANCELLED"])
    const inputSummary: Record<string, string> = {}
    for (const [k, v] of Object.entries(context)) {
      if (!allowedKeys.has(k)) continue
      const s = String(v)
      if (/^-?\d+(\.\d+)?$/.test(s) || safeEnumValues.has(s)) {
        inputSummary[k] = s
      }
    }

    const detail: HardFailDetail = {
      invariant_id: invariantId,
      input_summary: inputSummary,
      evaluator_result: evaluatorResult,
      adhoc_result: adhocResult,
      effective: "fail",
      timestamp: new Date().toISOString(),
    }

    // Structured hard-fail log (no PII; numeric billing fields only)
    console.error("[billing-conservation-guard] HARD_FAIL", JSON.stringify(detail))

    this.metrics.recordHardFail(detail)
  }

  /**
   * Fire a critical alert when circuit opens (evaluator enters degraded state).
   * Best-effort: never throws.
   */
  private async fireCircuitOpenAlert(): Promise<void> {
    if (!this.deps.alertService) return
    try {
      await this.deps.alertService.fire("critical", "evaluator_circuit_open", {
        message: "BillingConservationGuard circuit OPEN — evaluator compilation failed, billing blocked (fail-closed)",
        details: {
          pod_id: this.deps.podId ?? process.env.POD_ID ?? "unknown",
          build_sha: this.deps.buildSha ?? process.env.BUILD_SHA ?? "unknown",
          state: this.state,
        },
      })
    } catch (err) {
      console.error("[billing-conservation-guard] Circuit-open alert failed:", err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Fire a critical alert when bypass is active (SDD §7.2).
   * Best-effort: never throws.
   */
  private async fireBypassAlert(): Promise<void> {
    if (!this.deps.alertService) return
    try {
      await this.deps.alertService.fire("critical", "evaluator_bypass_active", {
        message: "BillingConservationGuard EVALUATOR_BYPASS=true — evaluator checks disabled, running ad-hoc only",
        details: {
          pod_id: this.deps.podId ?? process.env.POD_ID ?? "unknown",
          build_sha: this.deps.buildSha ?? process.env.BUILD_SHA ?? "unknown",
        },
      })
    } catch (err) {
      console.error("[billing-conservation-guard] Alert fire failed:", err instanceof Error ? err.message : String(err))
    }
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
