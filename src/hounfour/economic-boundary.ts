// src/hounfour/economic-boundary.ts — Economic Boundary Adapter (Sprint 3, Tasks 3.1 + 3.2 + 3.5)
//
// Bridges loa-finn's internal JWT claims + budget state to the protocol's
// EconomicBoundary evaluation (SDD §6.3, step 2 in the enforcement choreography).
//
// Chain position: JWT Auth → **Economic Boundary** → Budget Reserve → Provider → Conservation → Finalize
//
// Rollout modes (ECONOMIC_BOUNDARY_MODE env var):
//   - "bypass"  — skip evaluation entirely (emergency kill-switch)
//   - "shadow"  — evaluate + log, but always allow (default for safe rollout)
//   - "enforce" — evaluate + enforce (403 on denial)
//
// Env interaction matrix:
//   ECONOMIC_BOUNDARY_MODE × ECONOMIC_BOUNDARY_ACCESS_POLICY_ENFORCEMENT
//   ┌──────────┬───────────┬─────────────┬──────────┐
//   │ EB\AP    │ observe   │ asymmetric  │ enforce  │
//   ├──────────┼───────────┼─────────────┼──────────┤
//   │ bypass   │ AP only   │ AP only     │ AP only  │
//   │ shadow   │ log both  │ AP enforced │ AP+EB log│
//   │ enforce  │ EB enforc │ both enforc │ both enf │
//   └──────────┴───────────┴─────────────┴──────────┘

import { createHash } from "node:crypto"
import type { Context, Next } from "hono"
import type { JWTClaims } from "./jwt-auth.js"
import type { BudgetSnapshot, ReputationProvider } from "./types.js"
import type { PeerFeatures } from "./protocol-handshake.js"
import {
  evaluateEconomicBoundary,
  type TrustLayerSnapshot,
  type CapitalLayerSnapshot,
  type QualificationCriteria,
  type EconomicBoundaryEvaluationResult,
  type ReputationStateName,
  REPUTATION_STATES,
} from "./protocol-types.js"
import type { TaskType, ScoringPath } from "./protocol-types.js"
// BB-009: Removed unused imports computeScoringPathHash, SCORING_PATH_GENESIS_HASH
// from "@0xhoneyjar/loa-hounfour/governance" — re-add when governance scoring is wired.

// --- Types ---

export type EconomicBoundaryMode = "enforce" | "shadow" | "bypass"

// v7.11.0: denial_codes now included in upstream EconomicBoundaryEvaluationResult.
// Local EvaluationResultWithDenials patch removed (loa-hounfour#35 resolved).

// --- Constants ---

const VALID_MODES = new Set<string>(["enforce", "shadow", "bypass"])

/**
 * Tier → reputation mapping for trust snapshot construction.
 * Validated at boot time against protocol's REPUTATION_STATES.
 */
export const TIER_TRUST_MAP: Readonly<Record<string, { reputation_state: ReputationStateName; blended_score: number }>> = {
  free:          { reputation_state: "cold",          blended_score: 10 },
  pro:           { reputation_state: "warming",       blended_score: 50 },
  enterprise:    { reputation_state: "established",   blended_score: 80 },
  authoritative: { reputation_state: "authoritative", blended_score: 95 },
} as const

/**
 * Default qualification criteria when none provided.
 * Minimal bar: any non-cold tenant with any budget passes.
 */
export const DEFAULT_CRITERIA: QualificationCriteria = {
  min_trust_score: 5,
  min_reputation_state: "cold",
  min_available_budget: "0",
}

// --- Boot-time validation ---

/** Validates TIER_TRUST_MAP against protocol reputation states. Throws on mismatch. */
export function validateTierTrustMap(): void {
  const validStates = new Set<string>(REPUTATION_STATES)
  for (const [tier, mapping] of Object.entries(TIER_TRUST_MAP)) {
    if (!validStates.has(mapping.reputation_state)) {
      throw new Error(
        `[economic-boundary] FATAL: TIER_TRUST_MAP["${tier}"].reputation_state ` +
        `"${mapping.reputation_state}" is not a valid protocol state. ` +
        `Valid: ${REPUTATION_STATES.join(", ")}`,
      )
    }
  }
}

// Validate at module load
validateTierTrustMap()

// --- Environment ---

export const ECONOMIC_BOUNDARY_MODE: EconomicBoundaryMode = (() => {
  const raw = process.env.ECONOMIC_BOUNDARY_MODE ?? "shadow"
  if (VALID_MODES.has(raw)) return raw as EconomicBoundaryMode
  console.error(
    `[economic-boundary] FATAL: Invalid ECONOMIC_BOUNDARY_MODE="${raw}". ` +
    `Valid values: ${[...VALID_MODES].join(", ")}. Defaulting to "shadow".`,
  )
  return "shadow"
})()

// --- v7.11.0 Feature Flags (SDD §2.2) ---

/** When true, cohort queries in economic boundary prefer task-dimensional reputation. Default: false. */
export const TASK_DIMENSIONAL_REPUTATION_ENABLED = process.env.TASK_DIMENSIONAL_REPUTATION_ENABLED === "true"

/** When true, open task type routing and unknown type denial gate activate. Default: false. */
export const OPEN_TASK_TYPES_ENABLED = process.env.OPEN_TASK_TYPES_ENABLED === "true"

// --- Blended Score Weighting (Task 5.4: dynamic reputation foundation) ---

/**
 * Default timeout in milliseconds for ReputationProvider queries.
 * The 5ms ceiling is designed for in-memory or Redis-backed lookups.
 * Increase for providers that perform computation or cross-service queries.
 * Providers that exceed this deadline are silently bypassed (fail-closed to static mapping).
 */
export const DEFAULT_REPUTATION_TIMEOUT_MS = 5

/** Default weights for blended score computation: tier-dominant, behavioral supplementary. */
export const DEFAULT_BLENDING_WEIGHTS = { alpha: 0.7, beta: 0.3 } as const

/**
 * Compute blended trust score from tier base and behavioral boost.
 * Result is an integer in [0, 100]. Weights must sum to 1.0 (IEEE-754 epsilon tolerance).
 */
export function computeBlendedScore(
  tierBase: number,
  behavioralBoost: number,
  weights?: { alpha: number; beta: number },
): number {
  const { alpha, beta } = weights ?? DEFAULT_BLENDING_WEIGHTS
  if (Math.abs(alpha + beta - 1) >= 1e-9) {
    throw new Error(
      `[economic-boundary] Blending weights must sum to 1.0 (got ${alpha} + ${beta} = ${alpha + beta})`,
    )
  }
  const raw = alpha * tierBase + beta * behavioralBoost
  return Math.round(Math.min(100, Math.max(0, raw)))
}

// --- Circuit Breaker (Task 4.1: instance-per-middleware, not module singleton) ---

export interface CircuitBreakerOptions {
  /** Consecutive failures to open the circuit. Default: 5 */
  threshold?: number
  /** Window in ms for counting consecutive failures. Default: 30000 */
  windowMs?: number
  /** Cooldown in ms before half-open transition. Default: 60000 */
  resetMs?: number
}

/**
 * Per-instance circuit breaker (Hystrix bulkheading pattern).
 * Each economicBoundaryMiddleware() call owns its own CircuitBreaker instance,
 * preventing cross-route state contamination in multi-route gateways.
 */
export class CircuitBreaker {
  failureCount = 0
  lastFailure = 0
  open = false
  private halfOpen = false

  readonly threshold: number
  readonly windowMs: number
  readonly resetMs: number

  constructor(opts?: CircuitBreakerOptions) {
    this.threshold = opts?.threshold ?? 5
    this.windowMs = opts?.windowMs ?? 30_000
    this.resetMs = opts?.resetMs ?? 60_000
  }

  recordSuccess(): void {
    this.failureCount = 0
    this.open = false
    this.halfOpen = false
  }

  recordFailure(): boolean {
    const now = Date.now()

    // In half-open state, a single failure immediately re-opens the circuit
    if (this.halfOpen) {
      this.open = true
      this.halfOpen = false
      this.lastFailure = now
      this.failureCount = this.threshold
      console.error(
        `[economic-boundary] Circuit RE-OPENED — failure during half-open probe`,
      )
      return true
    }

    if (now - this.lastFailure > this.windowMs) {
      this.failureCount = 0
    }
    this.failureCount++
    this.lastFailure = now

    if (this.failureCount >= this.threshold) {
      this.open = true
      console.error(
        `[economic-boundary] Circuit OPEN after ${this.failureCount} consecutive snapshot failures in ${this.windowMs}ms — bypassing economic boundary`,
      )
      return true
    }
    return false
  }

  isOpen(): boolean {
    if (!this.open) return false
    // Half-open: allow retry after cooldown
    if (Date.now() - this.lastFailure > this.resetMs) {
      this.open = false
      this.halfOpen = true
      this.failureCount = 0
      return false
    }
    return true
  }

  reset(): void {
    this.failureCount = 0
    this.lastFailure = 0
    this.open = false
    this.halfOpen = false
  }
}

/**
 * @deprecated Use the CircuitBreaker instance from the middleware handler instead.
 * Kept for backwards compatibility — creates a fresh default instance reset.
 */
export function resetCircuitBreaker(): void {
  // No-op: circuit breakers are now per-instance.
  // Tests should use handler.circuitBreaker.reset() instead.
}

// --- Snapshot Builders ---

/**
 * Build a TrustLayerSnapshot from JWT claims.
 *
 * When peerFeatures.economicBoundary is false (pre-v7.7 peer), uses
 * flat tier-based trust mapping (graceful degradation — Task 3.5).
 *
 * Returns null on missing pool_id or unknown tier (fail-closed).
 */
export async function buildTrustSnapshot(
  claims: JWTClaims,
  peerFeatures?: PeerFeatures,
  opts?: { reputationProvider?: ReputationProvider; reputationTimeoutMs?: number },
): Promise<TrustLayerSnapshot | null> {
  const tierMapping = TIER_TRUST_MAP[claims.tier]
  if (!tierMapping) {
    console.warn(`[economic-boundary] Unknown tier "${claims.tier}" — trust snapshot unavailable`)
    return null
  }

  // Task 3.5: Graceful degradation for pre-v7.9 peers
  // When economicBoundary feature not available, use flat tier-based trust only
  if (peerFeatures && !peerFeatures.economicBoundary) {
    console.warn(
      `[economic-boundary] Degraded trust mode: peerFeatures.economicBoundary=false ` +
      `(requires v7.7.0+). Using flat tier-based trust for tier="${claims.tier}"`,
    )
  }

  // Task 5.3: Dynamic reputation — try to upgrade enterprise → authoritative
  if (opts?.reputationProvider && claims.tier === "enterprise") {
    try {
      const timeoutMs = opts?.reputationTimeoutMs ?? DEFAULT_REPUTATION_TIMEOUT_MS
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const rejectAfter = (ms: number) =>
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("ReputationProvider timeout")), ms)
        })
      let result: { boost: number; source: string } | null
      try {
        result = await Promise.race([
          opts.reputationProvider.getReputationBoost(claims.tenant_id),
          rejectAfter(timeoutMs),
        ])
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      }
      if (result && result.boost >= 15) {
        return {
          reputation_state: "authoritative",
          blended_score: computeBlendedScore(tierMapping.blended_score, result.boost),
          snapshot_at: new Date().toISOString(),
        }
      }
    } catch (err) {
      console.warn("[economic-boundary] ReputationProvider failed — using static mapping:", err)
    }
  }

  return {
    reputation_state: tierMapping.reputation_state,
    blended_score: tierMapping.blended_score,
    snapshot_at: new Date().toISOString(),
  }
}

/**
 * Build a CapitalLayerSnapshot from BudgetSnapshot.
 *
 * Capital snapshot is a coarse pre-check — budget reserve (step 4) is
 * the authoritative contention point for actual spend.
 *
 * Returns null on any failure (fail-closed).
 */
export function buildCapitalSnapshot(
  budget: BudgetSnapshot,
): CapitalLayerSnapshot | null {
  try {
    // remaining = limit - spent, expressed in MicroUSD (string integer)
    const remainingUsd = budget.limit_usd - budget.spent_usd
    if (remainingUsd < 0 || !Number.isFinite(remainingUsd)) {
      console.warn("[economic-boundary] Budget remaining is negative or non-finite — capital snapshot unavailable")
      return null
    }
    // Convert USD to MicroUSD string (1 USD = 1,000,000 MicroUSD).
    // Math.round minimizes IEEE-754 directional bias (e.g., 0.1+0.2-0.3 artifacts).
    const remainingMicro = Math.round(remainingUsd * 1_000_000).toString()

    // Task 4.2: Use upstream-provided budget period when available,
    // fall back to 30-day default only when absent. This opens the path
    // for DAOs and upstream providers to supply their own budget cycles.
    const periodEnd = budget.budget_period_end
      ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    if (!budget.budget_period_end) {
      console.debug("[economic-boundary] No budget_period_end provided — using 30-day default")
    }

    // Task 6.2: Log epoch metadata when present (log-only — does NOT mutate protocol snapshot)
    if (budget.budget_epoch) {
      console.debug(
        `[economic-boundary] budget_epoch_type=${budget.budget_epoch.epoch_type} community_epoch_id=${budget.budget_epoch.epoch_id}`,
      )
    }

    return {
      budget_remaining: remainingMicro,
      billing_tier: budget.scope ?? "unknown",
      budget_period_end: periodEnd,
    }
  } catch (err) {
    console.error("[economic-boundary] Failed to build capital snapshot:", err)
    return null
  }
}

// --- Scoring Path Logging (SDD §4.7, Task 3.10 — Goodhart Protection) ---

/**
 * Emit structured scoring path log for Goodhart protection.
 * Logs which scoring path was taken with tenant hash (no PII).
 * Only called when TASK_DIMENSIONAL_REPUTATION_ENABLED=true.
 */
function emitScoringPathLog(
  path: ScoringPath,
  tenantId: string,
  taskType?: string,
  reason?: string,
): void {
  const tenantHash = hashTenantId(tenantId)
  const scoredAt = new Date().toISOString()

  const logEntry = {
    component: "economic-boundary",
    event: "scoring_path",
    path,
    task_type: taskType ?? null,
    tenant_hash: tenantHash,
    reason: reason ?? null,
    scored_at: scoredAt,
  }

  console.log("[economic-boundary] scoring_path:", JSON.stringify(logEntry))
}

// --- Core Evaluation ---

/**
 * Evaluate economic boundary.
 * Composes snapshots from JWT claims + budget, delegates to protocol.
 * NEVER throws — returns result or null on infrastructure failure.
 */
export async function evaluateBoundary(
  claims: JWTClaims,
  budget: BudgetSnapshot,
  peerFeatures?: PeerFeatures,
  criteria?: QualificationCriteria,
  opts?: { reputationProvider?: ReputationProvider; reputationTimeoutMs?: number; taskType?: string },
): Promise<EconomicBoundaryEvaluationResult | null> {
  let trustSnapshot = await buildTrustSnapshot(claims, peerFeatures, opts)
  if (!trustSnapshot) return null

  const capitalSnapshot = buildCapitalSnapshot(budget)
  if (!capitalSnapshot) return null

  const effectiveCriteria = criteria ?? DEFAULT_CRITERIA
  const evaluatedAt = new Date().toISOString()

  // Task 2.5: Task-dimensional reputation (v7.11.0)
  // When enabled and a taskType is provided, attempt cohort-specific scoring
  if (TASK_DIMENSIONAL_REPUTATION_ENABLED && opts?.taskType && opts?.reputationProvider?.getTaskCohortScore) {
    try {
      const cohortScore = await opts.reputationProvider.getTaskCohortScore(claims.tenant_id, opts.taskType)
      if (cohortScore !== null) {
        // Shadow divergence: log when cohort and blended differ by > 10 points
        const blendedScore = trustSnapshot.blended_score
        const divergence = Math.abs(cohortScore - blendedScore)
        if (divergence > 10) {
          console.log(
            `[economic-boundary] Task-dimensional divergence: cohort=${cohortScore} blended=${blendedScore} delta=${divergence} taskType=${opts.taskType} tenant_hash=${hashTenantId(claims.tenant_id)}`,
          )
        }
        // Replace blended_score with cohort score
        trustSnapshot = { ...trustSnapshot, blended_score: cohortScore }
        // Task 3.10: Scoring path log — cohort score available
        emitScoringPathLog("task_cohort", claims.tenant_id, opts.taskType, "cohort score available")
      } else {
        // Task 3.10: Scoring path log — cohort unavailable, using blended
        emitScoringPathLog("aggregate", claims.tenant_id, opts.taskType, "cohort unavailable, using blended")
      }
    } catch (err) {
      console.warn("[economic-boundary] Task cohort score failed — using blended:", err)
      // Task 3.10: Scoring path log — cohort failed, falling back to blended
      emitScoringPathLog("aggregate", claims.tenant_id, opts.taskType, "cohort query failed, using blended")
    }
  } else if (TASK_DIMENSIONAL_REPUTATION_ENABLED) {
    // Task 3.10: Scoring path log — no taskType or no reputationProvider
    emitScoringPathLog("tier_default", claims.tenant_id, undefined, "task-dimensional enabled but no taskType or provider")
  }

  try {
    return evaluateEconomicBoundary(
      trustSnapshot,
      capitalSnapshot,
      effectiveCriteria,
      evaluatedAt,
    )
  } catch (err) {
    console.error("[economic-boundary] Protocol evaluation threw:", err)
    return null
  }
}

// --- Tenant ID Hashing (Task 4.4: PII protection in observability logs) ---

/**
 * Hash tenant ID for structured logs using SHA-256, truncated to 16 hex chars.
 * Preserves correlation (same tenant → same hash) without PII leakage to
 * external log sinks (Datadog, Grafana Cloud).
 */
export function hashTenantId(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 16)
}

// --- Middleware (Task 3.2, updated Task 4.1 + 4.4) ---

export interface EconomicBoundaryMiddlewareOptions {
  /** Provide budget snapshot for the authenticated tenant. */
  getBudgetSnapshot: (tenantId: string) => Promise<BudgetSnapshot | null>
  /** Peer features from handshake (for degraded mode). */
  peerFeatures?: PeerFeatures
  /** Override qualification criteria (default: DEFAULT_CRITERIA). */
  criteria?: QualificationCriteria
  /** Override mode (default: ECONOMIC_BOUNDARY_MODE env var). */
  mode?: EconomicBoundaryMode
  /** Circuit breaker configuration (default: 5 failures / 30s window / 60s reset). */
  circuitBreakerOptions?: CircuitBreakerOptions
  /** Optional reputation provider for dynamic trust scoring (Task 5.3). */
  reputationProvider?: ReputationProvider
  /**
   * Timeout in milliseconds for ReputationProvider queries (Task 6.1).
   * Default: 5ms — designed for in-memory or Redis-backed lookups.
   * Increase for providers that perform computation or cross-service queries.
   * Providers exceeding this deadline are silently bypassed (fail-closed to static mapping).
   */
  reputationTimeoutMs?: number
}

/** Middleware handler with attached circuit breaker instance for testing. */
export type EconomicBoundaryHandler = ((c: Context, next: Next) => Promise<Response | void>) & {
  circuitBreaker: CircuitBreaker
}

/**
 * Hono middleware: economic boundary pre-invocation gate (SDD §6.3, step 2).
 *
 * Runs UNCONDITIONALLY (local decision engine, not gated on peer features).
 * Policy denials → 403 with denial_codes.
 * Infrastructure errors → 503 with error_type: "infrastructure".
 * Entire middleware wrapped in try/catch (fail-closed in enforce, fail-open in shadow).
 *
 * Each call creates an independent CircuitBreaker instance (Task 4.1 — Hystrix bulkheading).
 * Tenant IDs are hashed in structured logs (Task 4.4 — PII protection).
 *
 * Performance budget: p95 < 2ms (pure computation, no I/O except budget snapshot).
 */
export function economicBoundaryMiddleware(opts: EconomicBoundaryMiddlewareOptions): EconomicBoundaryHandler {
  // R13 mitigation: warn if custom timeout is misconfigured.
  // Covers NaN/Infinity, zero, negative (Node.js clamps to 1ms), and excessively high values.
  if (opts.reputationTimeoutMs != null) {
    if (!Number.isFinite(opts.reputationTimeoutMs)) {
      console.warn(
        `[economic-boundary] reputationTimeoutMs=${opts.reputationTimeoutMs} is not a finite number. Defaulting to ${DEFAULT_REPUTATION_TIMEOUT_MS}ms.`,
      )
      opts = { ...opts, reputationTimeoutMs: undefined }
    } else if (opts.reputationTimeoutMs <= 0) {
      console.warn(
        "[economic-boundary] reputationTimeoutMs<=0 will time out all asynchronous ReputationProvider calls. Only synchronous (microtask-resolving) providers may succeed.",
      )
    } else if (opts.reputationTimeoutMs > 50) {
      console.warn(
        `[economic-boundary] reputationTimeoutMs=${opts.reputationTimeoutMs} exceeds recommended 50ms ceiling. High timeouts may block the request path.`,
      )
    }
  }

  const mode = opts.mode ?? ECONOMIC_BOUNDARY_MODE
  const cb = new CircuitBreaker(opts.circuitBreakerOptions)

  const handler = async (c: Context, next: Next) => {
    const startMs = performance.now()

    // Bypass mode — emergency kill-switch
    if (mode === "bypass") {
      return next()
    }

    // Circuit breaker — if open, degrade gracefully per mode.
    // Enforce: 503 (fail-closed — don't silently bypass authorization gate).
    // Shadow: allow through (observability-only, no security impact).
    if (cb.isOpen()) {
      console.warn("[economic-boundary] Circuit open — bypassing evaluation")
      if (mode === "enforce") {
        return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
      }
      return next()
    }

    try {
      // Extract tenant context from previous middleware (hounfourAuth sets this)
      const tenantContext = c.get("tenantContext") as { claims: JWTClaims } | undefined
      if (!tenantContext?.claims) {
        // No auth context — should not happen if middleware chain is correct
        console.error("[economic-boundary] Missing tenantContext — middleware ordering error")
        cb.recordFailure()
        if (mode === "enforce") {
          return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
        }
        // Shadow mode: fail-open
        return next()
      }

      const claims = tenantContext.claims
      const tenantHash = hashTenantId(claims.tenant_id)

      // Fetch budget snapshot
      const budget = await opts.getBudgetSnapshot(claims.tenant_id)
      if (!budget) {
        cb.recordFailure()
        const latencyMs = performance.now() - startMs
        console.error(
          `[economic-boundary] Budget snapshot unavailable for tenant_hash=${tenantHash} latency_ms=${latencyMs.toFixed(1)}`,
        )
        if (mode === "enforce") {
          return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
        }
        // Shadow mode: allow through
        return next()
      }

      // BB-005: Extract taskType from Hono context (set by hounfourAuth middleware)
      const taskType = c.get("taskType") as string | undefined

      // Evaluate boundary
      const result = await evaluateBoundary(claims, budget, opts.peerFeatures, opts.criteria, { reputationProvider: opts.reputationProvider, reputationTimeoutMs: opts.reputationTimeoutMs, taskType })
      const latencyMs = performance.now() - startMs

      if (!result) {
        cb.recordFailure()
        console.error(
          `[economic-boundary] Evaluation failed for tenant_hash=${tenantHash} ` +
          `tier=${claims.tier} mode=${mode} latency_ms=${latencyMs.toFixed(1)}`,
        )
        if (mode === "enforce") {
          return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
        }
        return next()
      }

      // Record success for circuit breaker
      cb.recordSuccess()

      // Structured log for every evaluation (observability).
      // Task 4.4: Uses tenant_hash instead of raw tenant_id for PII protection.
      const logPayload = {
        component: "economic-boundary",
        mode,
        decision: result.access_decision.granted ? "granted" : "denied",
        denial_codes: result.denial_codes ?? [],
        trust_tier: claims.tier,
        trust_passed: result.trust_evaluation.passed,
        capital_passed: result.capital_evaluation.passed,
        tenant_hash: tenantHash,
        latency_ms: Number(latencyMs.toFixed(1)),
      }

      if (!result.access_decision.granted) {
        console.warn("[economic-boundary] evaluation:", JSON.stringify(logPayload))

        if (mode === "enforce") {
          // 403 response goes to the authenticated tenant — raw tenant_id is safe here
          return c.json({
            error: "Forbidden",
            code: "ECONOMIC_BOUNDARY_DENIED",
            denial_codes: result.denial_codes ?? [],
            denial_reason: result.access_decision.denial_reason,
            tenant_id: claims.tenant_id,
          }, 403)
        }
        // Shadow mode: log but allow
        return next()
      }

      // Granted — log at debug level
      if (mode === "shadow") {
        console.log("[economic-boundary] evaluation:", JSON.stringify(logPayload))
      }

      return next()
    } catch (err) {
      const latencyMs = performance.now() - startMs
      console.error(`[economic-boundary] Unhandled error (latency_ms=${latencyMs.toFixed(1)}):`, err)
      cb.recordFailure()

      if (mode === "enforce") {
        return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
      }
      // Shadow/bypass: allow through on error
      return next()
    }
  }

  // Attach circuit breaker instance for testing and inspection
  handler.circuitBreaker = cb
  return handler as EconomicBoundaryHandler
}
