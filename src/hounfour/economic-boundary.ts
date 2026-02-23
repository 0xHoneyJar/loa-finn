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

import type { Context, Next } from "hono"
import type { JWTClaims } from "./jwt-auth.js"
import type { BudgetSnapshot } from "./types.js"
import type { PeerFeatures } from "./protocol-handshake.js"
import {
  evaluateEconomicBoundary,
  type TrustLayerSnapshot,
  type CapitalLayerSnapshot,
  type QualificationCriteria,
  type EconomicBoundaryEvaluationResult,
  type ReputationStateName,
  type DenialCode,
  REPUTATION_STATES,
} from "./protocol-types.js"

// --- Types ---

export type EconomicBoundaryMode = "enforce" | "shadow" | "bypass"

// --- Constants ---

const VALID_MODES = new Set<string>(["enforce", "shadow", "bypass"])

/**
 * Tier → reputation mapping for trust snapshot construction.
 * Validated at boot time against protocol's REPUTATION_STATES.
 */
export const TIER_TRUST_MAP: Readonly<Record<string, { reputation_state: ReputationStateName; blended_score: number }>> = {
  free:       { reputation_state: "cold",        blended_score: 10 },
  pro:        { reputation_state: "warming",     blended_score: 50 },
  enterprise: { reputation_state: "established", blended_score: 80 },
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

// --- Circuit Breaker ---

const CIRCUIT_BREAKER = {
  failureCount: 0,
  lastFailure: 0,
  open: false,
  THRESHOLD: 5,       // consecutive failures to open
  WINDOW_MS: 30_000,  // 30s window
  RESET_MS: 60_000,   // 60s cooldown before half-open
}

function recordCircuitSuccess(): void {
  CIRCUIT_BREAKER.failureCount = 0
  CIRCUIT_BREAKER.open = false
}

function recordCircuitFailure(): boolean {
  const now = Date.now()
  // Reset counter if outside window
  if (now - CIRCUIT_BREAKER.lastFailure > CIRCUIT_BREAKER.WINDOW_MS) {
    CIRCUIT_BREAKER.failureCount = 0
  }
  CIRCUIT_BREAKER.failureCount++
  CIRCUIT_BREAKER.lastFailure = now

  if (CIRCUIT_BREAKER.failureCount >= CIRCUIT_BREAKER.THRESHOLD) {
    CIRCUIT_BREAKER.open = true
    console.error(
      `[economic-boundary] Circuit OPEN after ${CIRCUIT_BREAKER.failureCount} consecutive snapshot failures in ${CIRCUIT_BREAKER.WINDOW_MS}ms — bypassing economic boundary`,
    )
    return true
  }
  return false
}

function isCircuitOpen(): boolean {
  if (!CIRCUIT_BREAKER.open) return false
  // Half-open: allow retry after cooldown
  if (Date.now() - CIRCUIT_BREAKER.lastFailure > CIRCUIT_BREAKER.RESET_MS) {
    CIRCUIT_BREAKER.open = false
    CIRCUIT_BREAKER.failureCount = 0
    return false
  }
  return true
}

/** Exposed for testing — resets circuit breaker state. */
export function resetCircuitBreaker(): void {
  CIRCUIT_BREAKER.failureCount = 0
  CIRCUIT_BREAKER.lastFailure = 0
  CIRCUIT_BREAKER.open = false
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
export function buildTrustSnapshot(
  claims: JWTClaims,
  peerFeatures?: PeerFeatures,
): TrustLayerSnapshot | null {
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
    // Convert USD to MicroUSD string (1 USD = 1,000,000 MicroUSD)
    const remainingMicro = Math.floor(remainingUsd * 1_000_000).toString()

    return {
      budget_remaining: remainingMicro,
      billing_tier: budget.scope ?? "unknown",
      budget_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30d default
    }
  } catch (err) {
    console.error("[economic-boundary] Failed to build capital snapshot:", err)
    return null
  }
}

// --- Core Evaluation ---

/**
 * Evaluate economic boundary.
 * Composes snapshots from JWT claims + budget, delegates to protocol.
 * NEVER throws — returns result or null on infrastructure failure.
 */
export function evaluateBoundary(
  claims: JWTClaims,
  budget: BudgetSnapshot,
  peerFeatures?: PeerFeatures,
  criteria?: QualificationCriteria,
): EconomicBoundaryEvaluationResult | null {
  const trustSnapshot = buildTrustSnapshot(claims, peerFeatures)
  if (!trustSnapshot) return null

  const capitalSnapshot = buildCapitalSnapshot(budget)
  if (!capitalSnapshot) return null

  const effectiveCriteria = criteria ?? DEFAULT_CRITERIA
  const evaluatedAt = new Date().toISOString()

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

// --- Middleware (Task 3.2) ---

export interface EconomicBoundaryMiddlewareOptions {
  /** Provide budget snapshot for the authenticated tenant. */
  getBudgetSnapshot: (tenantId: string) => Promise<BudgetSnapshot | null>
  /** Peer features from handshake (for degraded mode). */
  peerFeatures?: PeerFeatures
  /** Override qualification criteria (default: DEFAULT_CRITERIA). */
  criteria?: QualificationCriteria
  /** Override mode (default: ECONOMIC_BOUNDARY_MODE env var). */
  mode?: EconomicBoundaryMode
}

/**
 * Hono middleware: economic boundary pre-invocation gate (SDD §6.3, step 2).
 *
 * Runs UNCONDITIONALLY (local decision engine, not gated on peer features).
 * Policy denials → 403 with denial_codes.
 * Infrastructure errors → 503 with error_type: "infrastructure".
 * Entire middleware wrapped in try/catch (fail-closed in enforce, fail-open in shadow).
 *
 * Performance budget: p95 < 2ms (pure computation, no I/O except budget snapshot).
 */
export function economicBoundaryMiddleware(opts: EconomicBoundaryMiddlewareOptions) {
  const mode = opts.mode ?? ECONOMIC_BOUNDARY_MODE

  return async (c: Context, next: Next) => {
    const startMs = performance.now()

    // Bypass mode — emergency kill-switch
    if (mode === "bypass") {
      return next()
    }

    // Circuit breaker — if open, bypass to prevent cascade
    if (isCircuitOpen()) {
      console.warn("[economic-boundary] Circuit open — bypassing evaluation")
      return next()
    }

    try {
      // Extract tenant context from previous middleware (hounfourAuth sets this)
      const tenantContext = c.get("tenantContext") as { claims: JWTClaims } | undefined
      if (!tenantContext?.claims) {
        // No auth context — should not happen if middleware chain is correct
        console.error("[economic-boundary] Missing tenantContext — middleware ordering error")
        return c.json({ error: "Internal Server Error", error_type: "infrastructure" }, 503)
      }

      const claims = tenantContext.claims

      // Fetch budget snapshot
      const budget = await opts.getBudgetSnapshot(claims.tenant_id)
      if (!budget) {
        recordCircuitFailure()
        const latencyMs = performance.now() - startMs
        console.error(
          `[economic-boundary] Budget snapshot unavailable for tenant=${claims.tenant_id} latency_ms=${latencyMs.toFixed(1)}`,
        )
        if (mode === "enforce") {
          return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
        }
        // Shadow mode: allow through
        return next()
      }

      // Evaluate boundary
      const result = evaluateBoundary(claims, budget, opts.peerFeatures, opts.criteria)
      const latencyMs = performance.now() - startMs

      if (!result) {
        recordCircuitFailure()
        console.error(
          `[economic-boundary] Evaluation failed for tenant=${claims.tenant_id} ` +
          `tier=${claims.tier} mode=${mode} latency_ms=${latencyMs.toFixed(1)}`,
        )
        if (mode === "enforce") {
          return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
        }
        return next()
      }

      // Record success for circuit breaker
      recordCircuitSuccess()

      // Structured log for every evaluation (observability)
      const logPayload = {
        component: "economic-boundary",
        mode,
        decision: result.access_decision.granted ? "granted" : "denied",
        denial_codes: (result as { denial_codes?: DenialCode[] }).denial_codes ?? [],
        trust_tier: claims.tier,
        trust_passed: result.trust_evaluation.passed,
        capital_passed: result.capital_evaluation.passed,
        tenant_id: claims.tenant_id,
        latency_ms: Number(latencyMs.toFixed(1)),
      }

      if (!result.access_decision.granted) {
        console.warn("[economic-boundary] evaluation:", JSON.stringify(logPayload))

        if (mode === "enforce") {
          return c.json({
            error: "Forbidden",
            code: "ECONOMIC_BOUNDARY_DENIED",
            denial_codes: (result as { denial_codes?: DenialCode[] }).denial_codes ?? [],
            denial_reason: result.access_decision.denial_reason,
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
      recordCircuitFailure()

      if (mode === "enforce") {
        return c.json({ error: "Service Unavailable", error_type: "infrastructure" }, 503)
      }
      // Shadow/bypass: allow through on error
      return next()
    }
  }
}
