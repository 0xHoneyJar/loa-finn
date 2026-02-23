# SDD: Protocol Convergence v7.9.2 — Full Adoption

> **Version**: 1.0.0
> **Date**: 2026-02-23
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-032
> **PRD Reference**: `grimoires/loa/prd.md` v1.1.0
> **Grounding**: `src/hounfour/wire-boundary.ts`, `src/hounfour/billing-conservation-guard.ts`, `src/hounfour/protocol-handshake.ts`, `src/hounfour/pool-enforcement.ts`, `src/hounfour/jwt-auth.ts`, `src/hounfour/budget.ts`, `src/gateway/server.ts`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Component Design](#3-component-design)
4. [Data Architecture](#4-data-architecture)
5. [Security Architecture](#5-security-architecture)
6. [Testing Strategy](#6-testing-strategy)
7. [Sprint Mapping](#7-sprint-mapping)
8. [Technical Risks & Mitigation](#8-technical-risks--mitigation)

---

## 1. Executive Summary

### 1.1 What This Cycle Does

Upgrades `@0xhoneyjar/loa-hounfour` from v7.0.0 (commit `d091a3c0`) to v7.9.2 (tag `ff8c16b8`) and fully adopts all additive protocol features introduced in v7.1.0–v7.9.2. This is pure adoption and integration — no new infrastructure, no new services, no new external dependencies.

### 1.2 What Already Exists (Grounding)

| Component | Location | Status After This Cycle |
|-----------|----------|------------------------|
| Wire boundary (parse/serialize branded types) | `src/hounfour/wire-boundary.ts` | MODIFIED — add `parseStrictMicroUSD`, migrate `MicroUSDC` to protocol import |
| Billing conservation guard | `src/hounfour/billing-conservation-guard.ts` | UNCHANGED — complementary to new economic boundary |
| Protocol handshake | `src/hounfour/protocol-handshake.ts` | MODIFIED — semver-derived feature detection, new `PeerFeatures` fields |
| JWT auth + JWKS state machine | `src/hounfour/jwt-auth.ts` | MODIFIED — validate `JTI_POLICY` consistency with protocol import |
| Pool enforcement middleware | `src/hounfour/pool-enforcement.ts` | MODIFIED — wire economic boundary evaluation into auth chain |
| Budget enforcer | `src/hounfour/budget.ts` | UNCHANGED — operates after economic boundary |
| Billing finalize client | `src/hounfour/billing-finalize-client.ts` | UNCHANGED — operates after conservation guard |
| Router (invoke/oracle) | `src/hounfour/router.ts` | MINOR MODIFY — integrate economic boundary result into routing context |
| Server middleware chain | `src/gateway/server.ts` | MODIFIED — add economic boundary middleware |
| Conformance vector tests | `tests/finn/jwt-auth.test.ts:31` | MODIFIED — self-verifying vector infrastructure |
| Postinstall patch script | `scripts/patch-hounfour-dist.sh` | DELETED |
| Hounfour code reality | `grimoires/oracle/code-reality-hounfour.md` | UPDATED to v7.9.2 |

### 1.3 Design Principles

1. **Complement, don't replace** — `evaluateEconomicBoundary()` and `BillingConservationGuard` serve different lifecycle phases. Both remain.
2. **Type provenance over casts** — every branded type import traces to a single source module. Zero `as unknown as` at protocol boundaries.
3. **Fail-closed at every gate** — economic boundary denial → no provider call. Conservation failure → no billing commit.
4. **Self-verifying conformance** — vector count assertions, category coverage assertions, zero-vector-fail guards.

### 1.4 What This SDD Does NOT Design

- New HTTP endpoints (API surface unchanged)
- New database tables or persistence changes
- New external service integrations
- Arrakis-side protocol adoption (tracked separately)

---

## 2. System Architecture

### 2.1 Modified Request Lifecycle

The only architectural change is inserting `evaluateEconomicBoundary()` as step 2 in the existing request lifecycle. All other components remain in their current positions.

```
Request Arrives
  │
  ├─ 1. JWT Auth (pool-enforcement.ts:217 — hounfourAuth middleware)
  │     ├─ validateJWT() → JWKS ES256 verification, jti replay check
  │     ├─ enforcePoolClaims() → tier/pool validation
  │     └─ Sets TenantContext on Hono context
  │
  ├─ 2. Economic Boundary Evaluation (NEW — §3.1)
  │     ├─ Build TrustLayerSnapshot from TenantContext + peer features
  │     ├─ Build CapitalLayerSnapshot from budget state
  │     ├─ evaluateEconomicBoundary() → deterministic, total, <1ms
  │     ├─ If DENIED → 403 + structured denial_codes + evaluation_gap
  │     └─ No provider call. No billing entry. Request terminates.
  │
  ├─ 3. Budget Reserve (budget.ts — checkAndHold)
  │     └─ Atomic reserve against daily budget
  │
  ├─ 4. Provider Call (router.ts:338 → cheval-invoker / native-adapter)
  │     └─ Model invocation with tool-call orchestration
  │
  ├─ 5. Conservation Guard (billing-conservation-guard.ts)
  │     ├─ checkBudgetConservation(spent, limit)
  │     ├─ checkCostNonNegative(cost)
  │     ├─ checkMicroUSDFormat(serialized)
  │     └─ If any FAIL → no billing commit, compensating WAL entry, 500
  │
  └─ 6. Billing Finalize (billing-finalize-client.ts)
        └─ Commit actual cost to arrakis. DLQ on transient failure.
```

**Invariant**: Step 6 MUST NOT execute unless step 5 passes. This is enforced by the existing control flow in `router.ts:invokeForTenant()` — the conservation guard runs before `billingFinalize.finalize()` is called.

### 2.2 Module Dependency Graph (Changes Only)

```
src/hounfour/
├── wire-boundary.ts          (MODIFY: add parseStrictMicroUSD, migrate MicroUSDC)
├── economic-boundary.ts      (NEW: §3.1 — evaluation adapter + snapshot builders)
├── protocol-handshake.ts     (MODIFY: §3.5 — semver feature detection)
├── pool-enforcement.ts       (MODIFY: §3.1 — wire economic boundary into auth chain)
├── jwt-auth.ts               (MODIFY: §3.4 — JTI_POLICY import validation)
├── billing-conservation-guard.ts  (UNCHANGED)
├── budget.ts                 (UNCHANGED)
├── router.ts                 (MINOR: pass EconomicBoundaryResult to routing context)
├── types.ts                  (MODIFY: add EconomicBoundaryResult to TenantContext)
└── metrics.ts                (UNCHANGED)

tests/finn/
├── jwt-auth.test.ts              (MODIFY: self-verifying vector loader)
├── conformance-vectors.test.ts   (NEW: §3.3 — multi-category vector runner)
├── economic-boundary.test.ts     (NEW: §3.1 — choreography failure tests)
├── wire-boundary.test.ts         (MODIFY: add parseStrictMicroUSD + negative boundary tests)
├── protocol-handshake.test.ts    (MODIFY: semver feature detection tests)
└── branded-type-migration.test.ts (NEW: §3.2 — type provenance verification)
```

### 2.3 Import Map (v7.9.2 Adoption Surface)

All new imports from `@0xhoneyjar/loa-hounfour` and their target locations:

| Import | Source Module | Target File | FR |
|--------|-------------|-------------|-----|
| `evaluateEconomicBoundary` | root | `economic-boundary.ts` | FR-4 |
| `evaluateFromBoundary` | root | `economic-boundary.ts` | FR-5 |
| `parseMicroUsd` | root | `wire-boundary.ts` | FR-7 |
| `type MicroUSD` (protocol) | root | `wire-boundary.ts` | FR-7 |
| `MicroUSDC`, `microUSDC`, `readMicroUSDC` | `economy` | `wire-boundary.ts` | FR-9 |
| `JwtClaimsSchema` | `economy` | `jwt-auth.ts` | FR-8 |
| `BillingEntrySchema` | `economy` | `billing/types.ts` | FR-8 |
| `EconomicBoundarySchema` | `economy` | `economic-boundary.ts` | FR-8 |
| `QualificationCriteria` | `economy` | `economic-boundary.ts` | FR-8 |
| `DenialCode` | `economy` | `economic-boundary.ts` | FR-8 |
| `EvaluationGap` | `economy` | `economic-boundary.ts` | FR-8 |
| `ModelEconomicProfileSchema` | `economy` | `types.ts` | FR-8 |
| `ConstraintOrigin` | root | `types.ts` | FR-8 |
| `ReputationStateName` | root | `types.ts` | FR-8 |
| `JTI_POLICY` | `economy` | `jwt-auth.ts` | FR-10 |
| `computeCostMicro`, `computeCostMicroSafe` | root | `budget.ts` | FR-11 |
| `verifyPricingConservation` | root | `pricing.ts` | FR-11 |
| `validateBillingEntry` | root | `billing/types.ts` | FR-11 |
| `isValidNftId`, `parseNftId` | root | `nft-routing-config.ts` | FR-11 |
| `isKnownReputationState` | root | `types.ts` | FR-11 |
| `REPUTATION_STATES`, `REPUTATION_STATE_ORDER` | root | `types.ts` | FR-11 |
| `ECONOMIC_CHOREOGRAPHY` | `economy` | `economic-boundary.ts` | FR-11 |
| `TRANSFER_CHOREOGRAPHY`, `TRANSFER_INVARIANTS` | root | `billing-conservation-guard.ts` | FR-11 |
| `evaluateAccessPolicy` | root | `pool-enforcement.ts` | FR-12 |
| `CONTRACT_VERSION`, `parseSemver` | root | `protocol-handshake.ts` | FR-16 |

---

## 3. Component Design

### 3.1 Economic Boundary Adapter (`src/hounfour/economic-boundary.ts`) — NEW

**PRD**: FR-4, FR-5, FR-5a
**Purpose**: Adapter between loa-finn's existing `TenantContext` / budget state and the protocol's `evaluateEconomicBoundary()` function. Builds the required snapshots and translates the result into a middleware-compatible response.

```typescript
// src/hounfour/economic-boundary.ts

import {
  evaluateEconomicBoundary,
  evaluateFromBoundary,
  type TrustLayerSnapshot,
  type CapitalLayerSnapshot,
  type QualificationCriteria,
  type EconomicBoundaryEvaluationResult,
  type EconomicBoundary,
  type DenialCode,
  type EvaluationGap,
  ECONOMIC_CHOREOGRAPHY,
} from "@0xhoneyjar/loa-hounfour"
import { EconomicBoundarySchema } from "@0xhoneyjar/loa-hounfour/economy"
import type { TenantContext, PeerFeatures } from "./types.js"
import type { BudgetEnforcer } from "./budget.js"

// --- Constants ---

/**
 * Protocol-aligned tier → trust_level mapping.
 *
 * Keys: finn tier strings (from JWT claims.tier).
 * Values: protocol TrustLevel enum values.
 *
 * Validated at boot against protocol TIER definitions to catch drift.
 * If a tier is missing from this map, buildTrustSnapshot() returns null
 * (fail-closed — unknown tier cannot be authorized).
 *
 * Flatline HIGH_CONSENSUS IMP-001: explicit type, example values, boot validation.
 */
const TIER_TRUST_MAP: Record<string, TrustLevel> = {
  free:       TrustLevel.LOW,
  starter:    TrustLevel.STANDARD,
  pro:        TrustLevel.ELEVATED,
  enterprise: TrustLevel.HIGH,
  internal:   TrustLevel.MAXIMUM,
} as const

// Boot-time validation: ensure all protocol-defined tiers are covered
function validateTierTrustMap(): void {
  const protocolTiers = Object.keys(PROTOCOL_TIER_DEFINITIONS)
  for (const tier of protocolTiers) {
    if (!(tier in TIER_TRUST_MAP)) {
      throw new Error(
        `[economic-boundary] TIER_TRUST_MAP missing protocol tier "${tier}". ` +
        `Add mapping before deploying v7.9.2.`
      )
    }
  }
}

// --- Snapshot Builders ---

/**
 * Build capability-scoped trust dimensions from JWT claims.
 *
 * Populates the 6D trust model when peer supports capabilityScopedTrust (v7.6.0+).
 * Returns undefined dimensions as absent (evaluator treats missing as neutral).
 *
 * Flatline HIGH_CONSENSUS IMP-003: explicit contract and population logic.
 */
function buildCapabilityScopedTrust(
  claims: JwtClaims,
): CapabilityScopedTrust | undefined {
  // Only populate if claims contain the required scoped trust data
  if (!claims.trust_scopes) return undefined

  return {
    model_access: claims.trust_scopes.model_access,
    rate_allowance: claims.trust_scopes.rate_allowance,
    pool_priority: claims.trust_scopes.pool_priority,
    billing_trust: claims.trust_scopes.billing_trust,
    data_sensitivity: claims.trust_scopes.data_sensitivity,
    operational_trust: claims.trust_scopes.operational_trust,
  }
}

/**
 * Build TrustLayerSnapshot from TenantContext.
 *
 * Maps finn's existing tier/pool/trust data to the protocol's
 * 6-dimensional trust model. When peer doesn't support capability-scoped
 * trust (pre-v7.6.0), falls back to flat trust_level.
 *
 * TOTALITY: pool_id MUST be defined. If neither requestedPool nor
 * resolvedPools[0] exists, returns null — caller MUST DENY (fail-closed).
 *
 * TRUST MAPPING: Uses TIER_TRUST_MAP (protocol-aligned, audited) rather
 * than ad-hoc derivation. Map is defined at module scope and validated
 * against protocol constraints at startup.
 */
export function buildTrustSnapshot(
  tenant: TenantContext,
  peerFeatures: PeerFeatures | undefined,
): TrustLayerSnapshot | null {
  const claims = tenant.claims
  const pool_id = tenant.requestedPool ?? tenant.resolvedPools[0]

  // Fail-closed: no pool → cannot evaluate → caller must DENY
  if (!pool_id) return null

  // Trust mapping: protocol-aligned tier→trust_level mapping
  // Validated at boot against protocol TIER definitions
  const trust_level = TIER_TRUST_MAP[claims.tier]
  if (trust_level === undefined) return null // Unknown tier → fail-closed

  return {
    account_id: claims.sub,
    tier: claims.tier,
    trust_level,
    // 6D trust: populated when peer supports capability-scoped trust (v7.6.0+)
    capability_scoped_trust: peerFeatures?.capabilityScopedTrust
      ? buildCapabilityScopedTrust(claims)
      : undefined,
    pool_id,
    is_nft_routed: tenant.isNFTRouted,
    is_byok: tenant.isBYOK,
  }
}

/**
 * Build CapitalLayerSnapshot from budget state.
 *
 * Reads current budget snapshot (non-mutating) to determine
 * available capital for the economic boundary evaluation.
 *
 * Uses parseStrictMicroUSD (wire-boundary.ts) to ensure snapshot
 * values are protocol-branded MicroUSD before passing to evaluator.
 * Returns null on any failure — caller MUST DENY (fail-closed).
 */
export async function buildCapitalSnapshot(
  budget: BudgetEnforcer,
  accountId: string,
  tenantId: string,
): Promise<CapitalLayerSnapshot | null> {
  try {
    const snapshot = await budget.snapshot(accountId, tenantId)
    return {
      daily_limit: snapshot.limit,
      daily_spent: snapshot.spent,
      available: snapshot.available,
      // Economic boundary is a COARSE pre-check, not an atomic guarantee.
      // Budget reserve (step 3) is the authoritative contention point.
      // Under concurrency, multiple requests may pass boundary with the same
      // available value — reserve handles contention. (Flatline SKP-004)
      has_reservation: false,
    }
  } catch {
    // Budget snapshot unavailable → fail-closed
    return null
  }
}

// --- Middleware ---

/**
 * Hono middleware that evaluates economic boundary before provider call.
 *
 * Position: AFTER hounfourAuth (needs TenantContext), BEFORE budget reserve.
 * This is step 2 in the enforcement choreography (PRD §4.5).
 *
 * UNCONDITIONAL: This middleware ALWAYS runs regardless of peer version.
 * The decision engine is a LOCAL evaluation — it does not require peer
 * support. Peer features only affect which trust dimensions are populated
 * in the snapshot (6D trust vs flat trust_level). Skipping evaluation
 * based on peer version would be fail-open (GPT review finding #1).
 *
 * FAIL-CLOSED: Any error in snapshot building or evaluation → deterministic
 * DENY with structured error. No downstream steps execute (GPT finding #3).
 */
export function economicBoundaryMiddleware(deps: {
  budget: BudgetEnforcer
  peerFeatures?: PeerFeatures
}): MiddlewareHandler {
  return async (c, next) => {
    try {
      const tenant: TenantContext = c.get("tenant")

      // Build snapshots — null return means fail-closed DENY
      const trustSnapshot = buildTrustSnapshot(tenant, deps.peerFeatures)
      if (!trustSnapshot) {
        // 503: infrastructure error (snapshot builder failed), not a policy denial
        // Flatline BLOCKER SKP-002: differentiate 503 (infra) from 403 (policy)
        return c.json({
          error: "economic_boundary_unavailable",
          error_type: "infrastructure",
          denial_codes: ["snapshot_incomplete"],
          evaluation_gap: { reason: "trust_snapshot_unavailable" },
        }, 503)
      }

      const capitalSnapshot = await buildCapitalSnapshot(
        deps.budget,
        tenant.claims.sub,
        tenant.claims.tenant_id,
      )
      if (!capitalSnapshot) {
        return c.json({
          error: "economic_boundary_unavailable",
          error_type: "infrastructure",
          denial_codes: ["snapshot_incomplete"],
          evaluation_gap: { reason: "capital_snapshot_unavailable" },
        }, 503)
      }

      // Validate combined evaluation input against protocol schema before calling evaluator.
      // EconomicBoundarySchema validates the full { trust, capital, criteria } input shape.
      // (belt-and-suspenders: catches field mismatches at the adapter boundary)
      const inputValid = EconomicBoundarySchema.safeParse({
        trust: trustSnapshot,
        capital: capitalSnapshot,
      })
      if (!inputValid.success) {
        console.error("[economic-boundary] schema validation failed:", inputValid.error)
        return c.json({
          error: "economic_boundary_unavailable",
          error_type: "infrastructure",
          denial_codes: ["internal_error"],
          evaluation_gap: { reason: "snapshot_schema_invalid", fields: inputValid.error.issues.map(i => i.path.join(".")) },
        }, 503)
      }

      const result = evaluateEconomicBoundary(
        trustSnapshot,
        capitalSnapshot,
        { evaluatedAt: new Date() },
      )

      if (!result.allowed) {
        return c.json({
          error: "economic_boundary_denied",
          denial_codes: result.denial_codes,
          evaluation_gap: result.evaluation_gap,
        }, 403)
      }

      // Attach result to context for downstream use (logging, routing decisions)
      c.set("economicBoundary", result)
      await next()
    } catch (err) {
      // Any unhandled error → deterministic block (fail-closed)
      // 503 (not 403): this is an infrastructure failure, not a policy denial
      // Provider call is still blocked. Flatline BLOCKER SKP-002.
      console.error("[economic-boundary] unexpected error, blocking (fail-closed):", err)
      return c.json({
        error: "economic_boundary_unavailable",
        error_type: "infrastructure",
        denial_codes: ["internal_error"],
        evaluation_gap: { reason: "evaluation_exception" },
      }, 503)
    }
  }
}
```

**Design rationale**:
- **Adapter, not wrapper**: The middleware doesn't wrap `evaluateEconomicBoundary()` — it builds the inputs from finn's existing state and translates the output to HTTP semantics.
- **Unconditional evaluation**: The economic boundary is a LOCAL decision engine. It does not require peer support — peer features only control which trust dimensions are populated (6D vs flat). Skipping evaluation based on `peerFeatures.economicBoundary` would be fail-open.
- **Fail-closed on any error**: The entire middleware is wrapped in try/catch. Any failure blocks the provider call (no downstream steps execute). Policy denials return 403; infrastructure errors (snapshot unavailable, schema failure, exceptions) return 503 with `error_type: "infrastructure"` — this ensures 5xx monitoring catches operational issues (Flatline SKP-002).
- **Schema validation at adapter boundary**: Snapshots are validated against `EconomicBoundarySchema` before passing to `evaluateEconomicBoundary()`. This catches field type mismatches (e.g., wrong denomination, missing required fields) at the adapter layer rather than inside the protocol function.
- **`evaluateFromBoundary()` usage**: When an `EconomicBoundary` object is available (e.g., pre-configured per pool), use the convenience overload to prevent confused deputy attacks where the caller provides mismatched criteria.
- **No caching**: The function is pure computation (<1ms). Caching would add complexity without measurable benefit.

#### 3.1.1 Runtime Feature Flag (Flatline HIGH_CONSENSUS IMP-002)

The economic boundary middleware supports a runtime kill-switch via `ECONOMIC_BOUNDARY_MODE` environment variable for safe production rollout:

| Mode | Behavior | When to Use |
|------|----------|-------------|
| `enforce` (default) | Full fail-closed evaluation | Production after validation |
| `shadow` | Evaluate and log result, but always allow | Initial rollout / canary |
| `bypass` | Skip evaluation entirely, log bypass | Emergency rollback |

```typescript
const ECONOMIC_BOUNDARY_MODE = (process.env.ECONOMIC_BOUNDARY_MODE ?? "enforce") as
  | "enforce" | "shadow" | "bypass"

// Inside middleware, after evaluation:
if (ECONOMIC_BOUNDARY_MODE === "bypass") {
  console.warn("[economic-boundary] BYPASSED (kill-switch active)")
  c.set("economicBoundary", { allowed: true, bypassed: true })
  return next()
}

if (ECONOMIC_BOUNDARY_MODE === "shadow" && !result.allowed) {
  console.warn("[economic-boundary] shadow-deny (would have denied)", {
    denial_codes: result.denial_codes,
    account_id: tenant.claims.sub,
  })
  c.set("economicBoundary", { ...result, shadow: true })
  return next()
}
```

**Rollback plan**: Set `ECONOMIC_BOUNDARY_MODE=bypass` via environment config (no deploy required if using runtime config).

#### 3.1.2 Observability (Flatline HIGH_CONSENSUS IMP-004)

Metrics and structured logging for the economic boundary middleware:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `economic_boundary_evaluations_total` | Counter | `result={allow,deny,bypass,shadow_deny,error}` | Evaluation outcomes |
| `economic_boundary_latency_ms` | Histogram | `result` | Evaluation latency (should be <1ms) |
| `economic_boundary_snapshot_failures_total` | Counter | `snapshot={trust,capital}, reason` | Snapshot build failures |
| `economic_boundary_schema_failures_total` | Counter | — | Schema validation failures |

**Structured log fields** (emitted on every evaluation):

```typescript
console.info("[economic-boundary]", {
  result: result.allowed ? "allow" : "deny",
  mode: ECONOMIC_BOUNDARY_MODE,
  denial_codes: result.denial_codes ?? [],
  trust_level: trustSnapshot.trust_level,
  has_6d_trust: !!trustSnapshot.capability_scoped_trust,
  pool_id: trustSnapshot.pool_id,
  latency_ms: performance.now() - startTime,
  account_id: tenant.claims.sub,
})
```

**Alert thresholds**:
- `economic_boundary_evaluations_total{result="error"}` spike >5% of total → page
- `economic_boundary_latency_ms` p99 >10ms → warn (should be <1ms for pure computation)
- `economic_boundary_evaluations_total{result="deny"}` sustained >20% → investigate

### 3.2 Wire Boundary Extensions (`src/hounfour/wire-boundary.ts`) — MODIFY

**PRD**: FR-7, FR-7a, FR-9, FR-9a

#### 3.2.1 Strict Protocol Parser Wrapper

Add to `wire-boundary.ts` after the existing `parseMicroUSD()` function:

```typescript
import {
  parseMicroUsd,
  type MicroUSD as ProtocolMicroUSD,
} from "@0xhoneyjar/loa-hounfour"

/**
 * Nominally-branded StrictMicroUSD type for strict non-negative boundaries.
 *
 * This is NOT a simple alias of ProtocolMicroUSD — it adds a local unique
 * symbol brand to ensure nominal distinction from the internal MicroUSD type.
 * Without this, TS structural compatibility would allow local negative-capable
 * MicroUSD values to be passed into strict wire functions (GPT finding #4).
 *
 * Only `parseStrictMicroUSD()` can construct values of this type.
 */
declare const _strictMicroUSDBrand: unique symbol
export type StrictMicroUSD = ProtocolMicroUSD & { readonly [_strictMicroUSDBrand]: true }

/**
 * Strict non-negative parser for wire boundaries.
 * Delegates to protocol parseMicroUsd() — no cast, same type provenance.
 *
 * Use this at: HTTP ingress, JWT claim parsing, billing finalize wire.
 * Use parseMicroUSD() (local) at: internal accounting, deficit tracking.
 * Use parseMicroUSDLenient() at: persistence reads, WAL replay.
 *
 * Negative values produce WireBoundaryError (FR-7a invariant).
 */
export function parseStrictMicroUSD(raw: string): StrictMicroUSD {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("micro_usd", raw, "empty or non-string value")
  }
  if (raw.length > MAX_MICRO_USD_LENGTH) {
    throw new WireBoundaryError("micro_usd", raw, "value exceeds maximum length")
  }
  const result = parseMicroUsd(raw)
  if (!result.valid) {
    throw new WireBoundaryError("micro_usd", raw, result.reason)
  }
  // Brand the protocol value with StrictMicroUSD — sole constructor
  return result.amount as StrictMicroUSD
}
```

**Location**: After line 95 (after `parseMicroUSD()`), before `parseMicroUSDLenient()`.

#### 3.2.2 MicroUSDC Migration

Replace the local `MicroUSDC` branded type (lines 236-265) with protocol imports:

```typescript
// BEFORE (lines 236-265):
// declare const _microUSDCBrand: unique symbol
// export type MicroUSDC = bigint & { readonly [_microUSDCBrand]: true }
// ... local parseMicroUSDC() ...

// AFTER:
import {
  type MicroUSDC,
  microUSDC,
  readMicroUSDC,
} from "@0xhoneyjar/loa-hounfour/economy"

// Re-export for backward-compatible import paths (FR-9a step 3)
export type { MicroUSDC }
export { readMicroUSDC }

/**
 * Parse raw string to MicroUSDC. Delegates to protocol readMicroUSDC()
 * with WireBoundaryError wrapping for consistency with local error handling.
 *
 * Note: Protocol readMicroUSDC() is non-negative only. Internal accounting
 * that needs signed MicroUSDC should use a separate type or plain bigint.
 */
export function parseMicroUSDC(raw: string): MicroUSDC {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("micro_usdc", raw, "empty or non-string value")
  }
  if (raw.length > MAX_MICRO_USD_LENGTH) {
    throw new WireBoundaryError("micro_usdc", raw, "value exceeds maximum length")
  }
  try {
    return readMicroUSDC(raw)
  } catch (err) {
    throw new WireBoundaryError(
      "micro_usdc",
      raw,
      err instanceof Error ? err.message : "invalid MicroUSDC value",
    )
  }
}

// serializeMicroUSDC stays the same — toString() works on any bigint branded type
```

**Migration verification**: The existing `serializeMicroUSDC()` function remains unchanged since `MicroUSDC.toString()` produces identical output regardless of brand symbol. The `convertMicroUSDtoMicroUSDC()` function (line 326) needs its cast updated to use the checked constructor:

```typescript
// Line 338: return (product / divisor) as MicroUSDC
// Becomes:  validate non-negativity then construct via readMicroUSDC
const rawResult = product / divisor
if (rawResult < 0n) throw new WireBoundaryError("micro_usdc", rawResult, "negative conversion result")
return readMicroUSDC(rawResult.toString())
```

**Centralized re-export module** (`src/hounfour/protocol-types.ts` — NEW): All protocol economy types are re-exported from a single module to ensure every internal import resolves to the protocol brand symbol, preventing stale build artifacts from referencing the old local brand:

```typescript
// src/hounfour/protocol-types.ts — Single source of truth for protocol economy types
export type { MicroUSDC } from "@0xhoneyjar/loa-hounfour/economy"
export { microUSDC, readMicroUSDC } from "@0xhoneyjar/loa-hounfour/economy"
export type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"
export type { BasisPoints, AccountId, PoolId } from "@0xhoneyjar/loa-hounfour"
// Internal imports should use: import { MicroUSDC } from "./protocol-types.js"
```

**Compile-time brand verification test** (`tests/finn/branded-type-migration.test.ts`):
```typescript
import { expectTypeOf } from "vitest"
import type { MicroUSDC } from "../src/hounfour/protocol-types.js"
import type { MicroUSDC as EconomyMicroUSDC } from "@0xhoneyjar/loa-hounfour/economy"

// Verify re-export resolves to the exact same type (same brand symbol)
expectTypeOf<MicroUSDC>().toEqualTypeOf<EconomyMicroUSDC>()
```

#### 3.2.3 Negative Value Boundary Invariant (FR-7a)

The invariant is enforced by the parser selection table. No runtime check needed beyond using the correct parser at each boundary:

| Boundary | Parser | Negative Handling |
|----------|--------|-------------------|
| HTTP ingress (JWT claims, request bodies) | `parseStrictMicroUSD()` | **Rejects** — `parseMicroUsd()` returns `{ valid: false }` for negatives |
| Billing finalize wire | `parseStrictMicroUSD()` | **Rejects** |
| Cost ledger JSONL entries | `parseStrictMicroUSD()` | **Rejects** |
| Internal accounting (budget.ts, ledger.ts) | `parseMicroUSD()` (local) | **Allows** — deficit tracking |
| Persistence read (WAL, R2) | `parseMicroUSDLenient()` | **Allows** — normalization + negative |

**Compile-time enforcement**: The `StrictMicroUSD` type is nominally distinct from the local `MicroUSD` type via a local unique symbol brand (`_strictMicroUSDBrand`). This is NOT a simple type alias — it provides true nominal separation so TypeScript will reject assignment of local negative-capable `MicroUSD` values to `StrictMicroUSD` parameters. Only `parseStrictMicroUSD()` can construct `StrictMicroUSD` values. A compile-time test (tsd/expectType) MUST verify that `MicroUSD` is not assignable to `StrictMicroUSD`.

### 3.3 Conformance Vector Infrastructure (`tests/finn/conformance-vectors.test.ts`) — NEW

**PRD**: FR-13, FR-14, FR-15

```typescript
// tests/finn/conformance-vectors.test.ts

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve, join, dirname } from "node:path"

// --- Self-Verifying Vector Discovery ---

import { createRequire } from "node:module"
const require = createRequire(import.meta.url)

/**
 * Resolve vectors directory via Node package resolution (NOT hardcoded
 * node_modules path). This works correctly under pnpm virtual store,
 * hoisted layouts, and CI environments (GPT finding #7).
 */
function resolveVectorsDir(): string {
  // Resolve the package entry point, then navigate to vectors/
  const pkgEntry = require.resolve("@0xhoneyjar/loa-hounfour")
  const pkgRoot = resolve(dirname(pkgEntry), "..")
  return join(pkgRoot, "vectors")
}

/**
 * Discover all vector categories by enumerating the vectors/ directory.
 * Self-verifying: asserts count == 202, category coverage, and vector
 * identity uniqueness (each vector has a unique id field).
 */
function discoverVectors(): Map<string, Array<{ id: string; [k: string]: unknown }>> {
  const HOUNFOUR_VECTORS_DIR = resolveVectorsDir()
  const categories = new Map<string, Array<{ id: string; [k: string]: unknown }>>()

  // Check for manifest first (preferred — authoritative source)
  const manifestPath = join(HOUNFOUR_VECTORS_DIR, "manifest.json")
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
    for (const [category, vectors] of Object.entries(manifest.categories)) {
      categories.set(category, vectors as Array<{ id: string }>)
    }
    return categories
  }

  // Fallback: glob discovery with deduplication
  const entries = readdirSync(HOUNFOUR_VECTORS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const categoryDir = join(HOUNFOUR_VECTORS_DIR, entry.name)
    const files = readdirSync(categoryDir).filter(f => f.endsWith(".json"))
    for (const file of files) {
      const vectors = JSON.parse(
        readFileSync(join(categoryDir, file), "utf-8"),
      )
      const existing = categories.get(entry.name) ?? []
      const vectorArray = Array.isArray(vectors) ? vectors : [vectors]
      categories.set(entry.name, [...existing, ...vectorArray])
    }
  }

  return categories
}

describe("Conformance Vector Infrastructure", () => {
  const categories = discoverVectors()
  const allVectors = Array.from(categories.values()).flat()
  const totalCount = allVectors.length

  // FR-13: Assert total count == 202
  it("loads exactly 202 conformance vectors", () => {
    expect(totalCount).toBe(202)
  })

  // FR-13: Assert category coverage (minimum required categories)
  it("includes required categories", () => {
    const categoryNames = Array.from(categories.keys())
    expect(categoryNames).toContain("jwt")
    // Assert new v7.1.0-v7.9.2 categories are present
    // (exact names discovered during Sprint 1 resolution audit)
  })

  // Vector identity uniqueness: prevent accidental duplication
  it("all vectors have unique ids", () => {
    const ids = allVectors.map(v => v.id).filter(Boolean)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  // FR-15: Each category must have at least 1 vector
  for (const [category, vectors] of categories) {
    it(`category "${category}" has at least 1 vector (not empty)`, () => {
      expect(vectors.length).toBeGreaterThan(0)
    })
  }
})
```

**Per-category test files**: Each discovered category gets its own `describe` block within this file. The JWT category delegates to the existing `jwt-auth.test.ts` test infrastructure. New categories (billing, economic-boundary, constraint) get dedicated assertion logic based on the vector schema.

**Existing JWT test modification** (`tests/finn/jwt-auth.test.ts:31`): Update the vector loading path to use the shared discovery function. The existing vector-specific assertions remain unchanged — only the loading mechanism is shared.

### 3.4 Type System Adoption (`src/hounfour/types.ts`, `src/hounfour/jwt-auth.ts`) — MODIFY

**PRD**: FR-8, FR-10

#### 3.4.1 Extended Types (`src/hounfour/types.ts`)

Add protocol type imports for use across the codebase:

```typescript
// New imports at top of types.ts
import type {
  ConstraintOrigin,
  ReputationStateName,
  EconomicBoundaryEvaluationResult,
} from "@0xhoneyjar/loa-hounfour"
import type { ModelEconomicProfileSchema } from "@0xhoneyjar/loa-hounfour/economy"

// Re-export for use by other modules
export type { ConstraintOrigin, ReputationStateName }

// Extend TenantContext with economic boundary result
export interface TenantContext {
  claims: JWTClaims
  resolvedPools: readonly PoolId[]
  requestedPool?: PoolId | null
  isNFTRouted: boolean
  isBYOK: boolean
  /** Set by economic boundary middleware (step 2 in choreography) */
  economicBoundary?: EconomicBoundaryEvaluationResult
}
```

#### 3.4.2 JTI Policy Validation (`src/hounfour/jwt-auth.ts`)

```typescript
import { JTI_POLICY } from "@0xhoneyjar/loa-hounfour/economy"

// --- Effective JTI Policy (single source of truth at runtime) ---

const LOCAL_JTI_WINDOW_SECONDS = 300 // 5 min (existing)
const LOCAL_JTI_REQUIRED = true      // existing default

/**
 * Effective JTI policy: the STRICTER of local and protocol values.
 * One-way ratchet — never relaxes security. This value is wired into
 * the JTI cache TTL and the replay check function (GPT finding #8).
 *
 * window_seconds is the REPLAY CACHE duration: larger = stricter
 * (covers longer replay horizon). Use Math.max to take the stricter
 * of local and protocol values. (Flatline SKP-008)
 */
export const EFFECTIVE_JTI_POLICY = {
  window_seconds: Math.max(LOCAL_JTI_WINDOW_SECONDS, JTI_POLICY.window_seconds),
  required: LOCAL_JTI_REQUIRED || JTI_POLICY.required,
} as const

// Log if effective policy differs from either source
if (EFFECTIVE_JTI_POLICY.window_seconds !== LOCAL_JTI_WINDOW_SECONDS) {
  console.warn(
    `[jwt-auth] JTI window tightened: local=${LOCAL_JTI_WINDOW_SECONDS}s, ` +
    `protocol=${JTI_POLICY.window_seconds}s, effective=${EFFECTIVE_JTI_POLICY.window_seconds}s`
  )
}
```

**Enforcement wiring**: `EFFECTIVE_JTI_POLICY.window_seconds` is used as:
1. The Redis TTL for JTI replay keys (`x402:jti:{jti}`, TTL = `window_seconds + 30s` skew buffer)
2. The max-age check in `isJtiRequired()` — tokens with jti older than `window_seconds` are rejected
3. The JTI required flag in `validateJWT()` — when `EFFECTIVE_JTI_POLICY.required === true`, tokens without jti are rejected

**Required test**: A token with jti replayed after `LOCAL_JTI_WINDOW_SECONDS` but within `EFFECTIVE_JTI_POLICY.window_seconds` (when protocol window is larger) MUST be rejected — proving the effective (stricter/larger) replay cache window is enforced, not the local fallback.

### 3.5 Protocol Handshake Update (`src/hounfour/protocol-handshake.ts`) — MODIFY

**PRD**: FR-16, FR-17, FR-17a

#### 3.5.1 Extended PeerFeatures Interface

Replace the current `PeerFeatures` interface (line 41-44) and `detectPeerFeatures()` function (lines 232-237):

```typescript
/** Feature detection based on remote version (FR-17: semver-derived). */
export interface PeerFeatures {
  /** Remote supports trust_scopes (introduced v6.0.0). */
  trustScopes: boolean
  /** Remote supports capability-scoped trust (introduced v7.6.0). */
  capabilityScopedTrust: boolean
  /** Remote supports economic boundary evaluation (introduced v7.9.0). */
  economicBoundary: boolean
  /** Remote supports constraint origin provenance (introduced v7.9.0). */
  constraintOrigin: boolean
}

/**
 * Feature introduction version registry.
 * Each feature maps to the semver where it was introduced.
 * Derived from protocol changelog, NOT hardcoded booleans.
 */
const FEATURE_VERSIONS: Record<keyof PeerFeatures, { major: number; minor: number }> = {
  trustScopes: { major: 6, minor: 0 },
  capabilityScopedTrust: { major: 7, minor: 6 },
  economicBoundary: { major: 7, minor: 9 },
  constraintOrigin: { major: 7, minor: 9 },
} as const

/**
 * Detect peer features from remote contract version.
 *
 * FR-17: Derived from semver comparison, not hardcoded booleans.
 * Each feature is enabled when remote version >= feature introduction version.
 *
 * FAIL-CLOSED on parse failure: if remoteVersion is malformed or contains
 * prerelease tags, all features default to false with a warning log.
 * Prerelease versions (e.g., 7.9.0-rc.1) are treated as LESS THAN the
 * release version per semver spec — they do NOT satisfy >= 7.9.0.
 */
function detectPeerFeatures(
  remoteVersion: string,
  _healthData: Record<string, unknown>,
): PeerFeatures {
  const ALL_FALSE: PeerFeatures = {
    trustScopes: false,
    capabilityScopedTrust: false,
    economicBoundary: false,
    constraintOrigin: false,
  }

  let remote: { major: number; minor: number; patch: number }
  try {
    remote = parseSemver(remoteVersion)
  } catch {
    console.warn(
      `[protocol-handshake] Failed to parse remote version "${remoteVersion}" ` +
      `— defaulting all features to false (fail-closed)`
    )
    return ALL_FALSE
  }

  // Prerelease detection: if version string contains "-" after patch,
  // treat as pre-release (features not yet stable)
  const isPrerelease = /^\d+\.\d+\.\d+-.+/.test(remoteVersion)

  const gte = (target: { major: number; minor: number }) => {
    // Prerelease of the exact target version does NOT satisfy >= target
    if (isPrerelease && remote.major === target.major && remote.minor === target.minor) {
      return false
    }
    return remote.major > target.major ||
      (remote.major === target.major && remote.minor >= target.minor)
  }

  return {
    trustScopes: gte(FEATURE_VERSIONS.trustScopes),
    capabilityScopedTrust: gte(FEATURE_VERSIONS.capabilityScopedTrust),
    economicBoundary: gte(FEATURE_VERSIONS.economicBoundary),
    constraintOrigin: gte(FEATURE_VERSIONS.constraintOrigin),
  }
}
```

#### 3.5.2 Behavioral Compatibility Matrix (FR-17a)

The `PeerFeatures` are passed to the economic boundary adapter (§3.1) to determine graceful degradation behavior:

| Feature | Finn Behavior When Peer Supports | Finn Behavior When Peer Doesn't |
|---------|----------------------------------|--------------------------------|
| `trustScopes` | Economic boundary uses 6D trust in TrustLayerSnapshot | Falls back to flat `trust_level` derived from tier |
| `capabilityScopedTrust` | Populates `capability_scoped_trust` in snapshot | Omits field, economic boundary uses simpler trust model |
| `economicBoundary` | Populates 6D trust dimensions in TrustLayerSnapshot | Uses flat `trust_level` only; evaluation still runs unconditionally (local decision engine) |
| `constraintOrigin` | Validates `ConstraintOrigin` on incoming constraint payloads | Accepts constraints without origin metadata |

**Graceful degradation is logged, not silent**: When a feature is unavailable, a structured log message is emitted at WARN level with the feature name, remote version, and introduction version. This ensures operators can track protocol adoption across the fleet.

#### 3.5.3 Updated Log Line

```typescript
// Line 131 — update log format to include new features
console.log(
  `[protocol-handshake] status=compatible remote=${remoteVersion} ` +
  `trustScopes=${peerFeatures.trustScopes} ` +
  `capabilityScopedTrust=${peerFeatures.capabilityScopedTrust} ` +
  `economicBoundary=${peerFeatures.economicBoundary} ` +
  `constraintOrigin=${peerFeatures.constraintOrigin}` +
  warnSuffix
)
```

### 3.6 Vocabulary & Utilities Adoption

**PRD**: FR-11, FR-12

These are import-and-validate changes, not new components. Each adoption follows the same pattern:

1. Import the protocol function/constant
2. Write a test that validates consistency with the local implementation
3. Replace local implementation with protocol import (or document why not)

#### 3.6.1 Cost Computation Validation (`src/hounfour/budget.ts`)

```typescript
import { computeCostMicro, computeCostMicroSafe } from "@0xhoneyjar/loa-hounfour"

// In the test file: verify local computeTotalCostMicro() produces
// identical results to protocol computeCostMicro() for the same inputs.
// If divergence found, adopt protocol version.
```

#### 3.6.2 Billing Entry Validation (`src/billing/types.ts`)

```typescript
import { validateBillingEntry } from "@0xhoneyjar/loa-hounfour"

// Add protocol-level validation as a second gate on billing entry construction.
// Existing validation remains; protocol validation is additive (belt-and-suspenders).
```

#### 3.6.3 Access Policy Evaluation (`src/hounfour/pool-enforcement.ts`)

```typescript
import { evaluateAccessPolicy } from "@0xhoneyjar/loa-hounfour"

// FR-12: Evaluate alongside existing tier checks in enforcePoolClaims().
// ASYMMETRIC shadow mode (GPT finding #9):
//   - Protocol ALLOWS, local DENIES → log divergence, local DENY stands (safe)
//   - Protocol DENIES, local ALLOWS → DENY the request (fail-closed)
//     This prevents the existing tier checks from being more permissive
//     than the protocol policy on security-affecting conditions.
//   - Both agree → no action needed
```

**Design note**: `evaluateAccessPolicy()` is adopted in **asymmetric shadow mode** — not pure shadow. The asymmetry ensures that when the protocol would deny but local would allow, the request is denied (fail-closed). This prevents authorization bypass during adoption. The reverse case (protocol allows, local denies) logs divergence but keeps the local denial — existing security is never relaxed.

**Divergence logging**: Both divergence directions are logged with structured fields (`{direction: "protocol_stricter" | "local_stricter", pool_id, tier, policy_result}`) to enable analysis of whether local tier checks can eventually be replaced.

**Config flag**: `ECONOMIC_BOUNDARY_ACCESS_POLICY_ENFORCEMENT` env var (default: `"asymmetric"`) controls behavior:
- `"asymmetric"` (default): protocol-deny overrides local-allow; protocol-allow does not override local-deny
- `"shadow"`: pure shadow mode — log only, no enforcement (for initial rollout validation)
- `"full"`: protocol replaces local tier checks entirely (post-validation)

Required test: simulate a case where `evaluateAccessPolicy` denies but `enforcePoolClaims` allows → assert the request is denied in `"asymmetric"` mode.

#### 3.6.4 NFT ID Validation (`src/hounfour/nft-routing-config.ts`)

```typescript
import { isValidNftId, parseNftId } from "@0xhoneyjar/loa-hounfour"

// Replace any local NFT ID validation with protocol equivalents.
// These are pure validation functions with no side effects.
```

#### 3.6.5 Reputation Vocabulary (`src/hounfour/types.ts`)

```typescript
import {
  isKnownReputationState,
  REPUTATION_STATES,
  REPUTATION_STATE_ORDER,
} from "@0xhoneyjar/loa-hounfour"

// Export for use in reputation-aware routing decisions.
// isKnownReputationState() is a type guard that narrows string → ReputationStateName.
```

### 3.7 Server Middleware Wiring (`src/gateway/server.ts`) — MODIFY

The only change to `server.ts` is inserting the economic boundary middleware after the existing `hounfourAuth` middleware and before the billing readiness check.

Current middleware chain (relevant section):

```
hounfourAuth (pool-enforcement.ts:217)
  ↓
billingConservationGuard.isBillingReady() check (server.ts:197-205)
  ↓
createInvokeHandler (routes/invoke.ts:34)
```

New middleware chain:

```
hounfourAuth (pool-enforcement.ts:217)
  ↓
economicBoundaryMiddleware (economic-boundary.ts) — NEW
  ↓
billingConservationGuard.isBillingReady() check (server.ts:197-205)
  ↓
createInvokeHandler (routes/invoke.ts:34)
```

**Unconditional insertion**: The economic boundary middleware is always active regardless of `peerFeatures.economicBoundary`. It is a local decision engine — peer features only control trust dimension population (6D vs flat), not whether evaluation runs. When the peer doesn't support economic boundary (arrakis < v7.9.0), the middleware still evaluates using flat trust, ensuring fail-closed enforcement at every gate.

---

## 4. Data Architecture

### 4.1 No Schema Changes

This cycle introduces no database tables, no Redis key changes, and no new persistence. All changes are in-memory type imports and function integrations.

### 4.2 Conformance Vector Storage

Vectors are loaded from `node_modules/@0xhoneyjar/loa-hounfour/vectors/` at test time. No vendoring required unless FR-3a resolution audit discovers that the `vectors/` directory is not exported in v7.9.2's package.json `exports` map.

**Fallback plan** (if vectors are not exported): Vendor the vectors directory into `tests/fixtures/hounfour-vectors-v7.9.2/` with a pinned manifest. This is a last resort — prefer using the package's exported paths.

### 4.3 WAL Compensating Entries

The enforcement choreography (§2.1) specifies that when conservation guard (step 5) fails, a compensating WAL entry is written. This uses the existing WAL infrastructure (`src/persistence/wal.ts`) — no new WAL entry types needed. The compensating entry format:

```typescript
{
  type: "billing",
  operation: "compensate",
  key: `conservation-fail/${billing_entry_id}`,
  payload: {
    billing_entry_id: string,
    reason: "conservation_guard_failure",
    invariant_id: string,  // e.g., "budget_conservation"
    effective: "fail",
    timestamp: string,
  }
}
```

This entry already fits the existing `WAL.append(type, operation, key, payload)` signature.

---

## 5. Security Architecture

### 5.1 Negative Value Boundary Invariant

**Threat**: Negative MicroUSD values (deficit tracking) leak from internal accounting to strict non-negative wire boundaries, causing incorrect billing or unauthorized access.

**Controls**:

| Layer | Control | Enforcement |
|-------|---------|-------------|
| Type system | `StrictMicroUSD` vs `MicroUSD` distinct types | Compile-time — wrong type at boundary produces TS error |
| Runtime | `parseStrictMicroUSD()` rejects negatives | Runtime — protocol `parseMicroUsd()` returns `{ valid: false }` for `"-1"` |
| Testing | Round-trip WAL→internal→wire boundary tests | CI — property tests verify no negative leaks |
| Code review | ESLint rule bans `parseMicroUSD()` in files outside internal accounting | CI — grep/ESLint enforcement |

**Files where negative values are permitted** (exhaustive list from FR-7a):
- `src/hounfour/budget.ts` — deficit tracking
- `src/billing/ledger.ts` — internal ledger
- `src/billing/ledger-v2.ts` — internal ledger v2
- `src/billing/state-machine.ts` — state transitions may involve negative deltas

**Files where negative values MUST NOT appear**:
- Any file constructing JWT claims
- Any file constructing HTTP response bodies
- `src/hounfour/billing-finalize-client.ts` — cost must be non-negative
- Any conformance vector assertion

### 5.2 Branded Type Single-Source Invariant

After migration (FR-9a), every branded type has exactly one source of truth:

| Type | Source | Enforcement |
|------|--------|-------------|
| `MicroUSD` | Protocol (`BrandedMicroUSD`) | Already canonical |
| `BasisPoints` | Protocol | Already canonical |
| `AccountId` | Protocol | Already canonical |
| `PoolId` | Protocol | Already canonical |
| `MicroUSDC` | Protocol (`economy/branded-types.ts`) | **Migrated this cycle** — CI grep after Sprint 2 |
| `CreditUnit` | Local (`wire-boundary.ts:186`) | Finn-specific, no protocol equivalent |

**Post-Sprint-2 enforcement**: A CI check greps for `declare const _microUSDCBrand` — if found, the build fails. This prevents re-introduction of parallel local brand symbols.

### 5.3 Enforcement Choreography Security Properties

| Property | Guarantee | Test |
|----------|-----------|------|
| No charge without service | If provider call fails, billing finalize is not called | `tests/finn/economic-boundary.test.ts` — simulate provider error |
| No service without authorization | Economic boundary denial → no provider call | Simulate denied evaluation → verify no model invocation |
| No billing without conservation | Conservation failure → no billing commit | Simulate conservation failure → verify finalize not called |
| Compensating entries on failure | Conservation failure → WAL compensating entry | Verify WAL entry exists after conservation failure |

---

## 6. Testing Strategy

### 6.1 Test Categories

| Category | Files | Purpose |
|----------|-------|---------|
| Resolution audit | `tests/finn/resolution-audit.test.ts` (NEW) | FR-3a — verify all import specifiers resolve under v7.9.2 |
| Conformance vectors | `tests/finn/conformance-vectors.test.ts` (NEW) | FR-13/15 — self-verifying 202-vector runner |
| Economic boundary | `tests/finn/economic-boundary.test.ts` (NEW) | FR-4/5/5a — choreography failure simulation |
| Strict parser | `tests/finn/wire-boundary.test.ts` (EXTEND) | FR-7/7a — negative boundary invariant |
| Branded migration | `tests/finn/branded-type-migration.test.ts` (NEW) | FR-9/9a — type provenance verification |
| Handshake features | `tests/finn/protocol-handshake.test.ts` (EXTEND) | FR-16/17/17a — semver detection + degradation |
| Vocabulary consistency | `tests/finn/vocabulary-adoption.test.ts` (NEW) | FR-11 — local vs protocol function parity |
| Existing regression | All existing test files | Zero regressions after bump |

### 6.2 Resolution Audit Test (FR-3a)

```typescript
// tests/finn/resolution-audit.test.ts

import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"

/**
 * FR-3a: Enumerate all import specifiers used in loa-finn and verify
 * they resolve under v7.9.2's exports map.
 *
 * This test MUST pass before any Sprint 1 adoption tasks proceed.
 */
describe("Resolution Audit Gate", () => {
  const IMPORT_SPECIFIERS = [
    "@0xhoneyjar/loa-hounfour",
    "@0xhoneyjar/loa-hounfour/economy",
    // Deep paths discovered by grep:
    // Add all paths found during Sprint 1 Task 1
  ]

  for (const specifier of IMPORT_SPECIFIERS) {
    it(`resolves: ${specifier}`, async () => {
      // Dynamic import to verify runtime resolution
      const mod = await import(specifier)
      expect(mod).toBeDefined()
    })
  }

  it("vectors directory exists in installed package", async () => {
    // Use package resolution instead of hardcoded node_modules path
    // (works under pnpm virtual store, hoisted layouts, and CI)
    const { createRequire } = await import("node:module")
    const { dirname, join } = await import("node:path")
    const req = createRequire(import.meta.url)
    const pkgEntry = req.resolve("@0xhoneyjar/loa-hounfour")
    const vectorsDir = join(dirname(pkgEntry), "..", "vectors")
    expect(existsSync(vectorsDir)).toBe(true)
  })
})
```

### 6.3 Choreography Failure Tests (FR-5a)

```typescript
// tests/finn/economic-boundary.test.ts

describe("Enforcement Choreography", () => {
  it("step 2 denial → no provider call, no billing", async () => {
    // Setup: economic boundary returns { allowed: false, denial_codes: [...] }
    // Action: send request through middleware chain
    // Assert: provider.invoke() NOT called, billingFinalize.finalize() NOT called
    // Assert: response is 403 with denial_codes
  })

  it("step 5 conservation failure → no billing commit", async () => {
    // Setup: conservation guard returns { ok: false, invariant_id: "budget_conservation" }
    // Action: complete provider call, run conservation check
    // Assert: billingFinalize.finalize() NOT called
    // Assert: WAL contains compensating entry
    // Assert: response is 500
  })

  it("step 6 finalize failure → DLQ entry", async () => {
    // Setup: billingFinalize returns { ok: false, status: "dlq" }
    // Action: complete full lifecycle
    // Assert: DLQ entry created
    // Assert: response still returns model output (best-effort billing)
  })

  it("successful full lifecycle → all 6 steps execute", async () => {
    // Setup: all steps succeed
    // Assert: JWT validated, boundary allowed, budget reserved,
    //         provider called, conservation passed, billing finalized
  })
})
```

### 6.4 Simulated Peer Tests (FR-17a)

```typescript
// tests/finn/protocol-handshake.test.ts (extend)

describe("Semver-Derived Feature Detection", () => {
  const cases: Array<{ version: string; expected: PeerFeatures }> = [
    {
      version: "4.6.0",
      expected: {
        trustScopes: false,
        capabilityScopedTrust: false,
        economicBoundary: false,
        constraintOrigin: false,
      },
    },
    {
      version: "6.0.0",
      expected: {
        trustScopes: true,
        capabilityScopedTrust: false,
        economicBoundary: false,
        constraintOrigin: false,
      },
    },
    {
      version: "7.0.0",
      expected: {
        trustScopes: true,
        capabilityScopedTrust: false,
        economicBoundary: false,
        constraintOrigin: false,
      },
    },
    {
      version: "7.6.0",
      expected: {
        trustScopes: true,
        capabilityScopedTrust: true,
        economicBoundary: false,
        constraintOrigin: false,
      },
    },
    {
      version: "7.9.2",
      expected: {
        trustScopes: true,
        capabilityScopedTrust: true,
        economicBoundary: true,
        constraintOrigin: true,
      },
    },
  ]

  for (const { version, expected } of cases) {
    it(`v${version} → correct feature flags`, () => {
      const features = detectPeerFeatures(version, {})
      expect(features).toEqual(expected)
    })
  }
})
```

---

## 7. Sprint Mapping

### Sprint 1: Bump + Clean + Vectors (6 tasks)

| Task | FR | Files | Acceptance |
|------|-----|-------|------------|
| 1.1 Bump dependency to v7.9.2 tag SHA | FR-1 | `package.json` | `pnpm install` succeeds, `CONTRACT_VERSION === "7.9.2"` |
| 1.2 Delete postinstall patch script | FR-2 | `package.json`, `scripts/patch-hounfour-dist.sh` | File deleted, `postinstall` removed, `pnpm install` clean |
| 1.3 Resolution audit gate | FR-3, FR-3a | `tests/finn/resolution-audit.test.ts` | All import specifiers resolve, vectors directory exists |
| 1.4 Run existing test suite | — | All test files | ~1,105 tests pass (zero regressions) |
| 1.5 Self-verifying vector infrastructure | FR-13, FR-14, FR-15 | `tests/finn/conformance-vectors.test.ts`, `tests/finn/jwt-auth.test.ts` | 202 vectors loaded, category coverage asserted, per-category non-empty |
| 1.6 Run 202 conformance vectors | FR-13 | `tests/finn/conformance-vectors.test.ts` | 202/202 pass |

### Sprint 2: Type System + Vocabulary + Handshake (7 tasks)

| Task | FR | Files | Acceptance |
|------|-----|-------|------------|
| 2.1 Add `parseStrictMicroUSD` wrapper | FR-7 | `wire-boundary.ts`, `wire-boundary.test.ts` | No cast, negative → error, positive → `StrictMicroUSD` |
| 2.2 Negative boundary invariant tests | FR-7a | `wire-boundary.test.ts` | Round-trip WAL→internal→wire rejects negatives, property test |
| 2.3 Migrate MicroUSDC to protocol import | FR-9, FR-9a | `wire-boundary.ts`, `branded-type-migration.test.ts` | Local brand deleted, protocol import works, re-export backward-compat |
| 2.4 Import protocol schemas and types | FR-8, FR-10 | `types.ts`, `jwt-auth.ts`, `billing/types.ts` | Types compile, JTI_POLICY validated |
| 2.5 Adopt vocabulary utilities | FR-11 | `budget.ts`, `pricing.ts`, `billing/types.ts`, `nft-routing-config.ts` | Protocol functions imported, consistency tests pass |
| 2.6 Shadow-mode access policy evaluation | FR-12 | `pool-enforcement.ts` | `evaluateAccessPolicy` runs in shadow, divergence logged, zero divergence in test |
| 2.7 Update protocol handshake feature detection | FR-16, FR-17, FR-17a | `protocol-handshake.ts`, `protocol-handshake.test.ts` | Semver-derived features, 5 simulated peer versions pass |

### Sprint 3: Decision Engine + Choreography (6 tasks)

| Task | FR | Files | Acceptance |
|------|-----|-------|------------|
| 3.1 Economic boundary adapter + snapshot builders | FR-4, FR-5 | `economic-boundary.ts` | `buildTrustSnapshot` + `buildCapitalSnapshot` produce valid snapshots |
| 3.2 Economic boundary middleware | FR-4 | `economic-boundary.ts`, `server.ts` | Middleware wired after auth, denial → 403 + codes |
| 3.3 Choreography failure tests | FR-5a | `economic-boundary.test.ts` | All 4 failure scenarios pass (§6.3) |
| 3.4 Wire economic boundary into invoke/oracle paths | FR-4 | `server.ts`, `router.ts` | Middleware active on invoke + oracle routes |
| 3.5 Graceful degradation for pre-v7.9 peers | FR-17a | `economic-boundary.ts` | Evaluation runs unconditionally; flat trust used when `!peerFeatures.economicBoundary` |
| 3.6 Update hounfour code reality | FR-18 | `grimoires/oracle/code-reality-hounfour.md` | Reality doc reflects v7.9.2 exports and import map |

**Total**: 19 tasks across 3 sprints. No new infrastructure — pure adoption and integration.

---

## 8. Technical Risks & Mitigation

| # | Risk | Likelihood | Impact | Mitigation | Sprint |
|---|------|-----------|--------|------------|--------|
| R1 | v7.9.2 dist has unexpected export-map changes | Medium | High | FR-3a resolution audit gate — abort Sprint 1 if any path breaks | 1 |
| R2 | Vector count != 202 or directory structure changed | Low | Medium | Self-verifying loader asserts count + category coverage | 1 |
| R3 | MicroUSDC brand symbol mismatch causes widespread TS errors | Medium | High | Systematic migration (§3.2.2) with re-export adapters; rollback = revert import | 2 |
| R4 | `evaluateEconomicBoundary` adds >5ms latency to request path | Low | Low | Function is pure computation; benchmark in acceptance test | 3 |
| R5 | Handshake feature detection incorrect for edge version ranges | Low | Medium | Explicit test cases for v4.6.0, v6.0.0, v7.0.0, v7.6.0, v7.9.2 | 2 |
| R6 | Negative values leak through new `parseStrictMicroUSD` | Low | High | Property test: any negative input → `WireBoundaryError`; `StrictMicroUSD` type prevents compile-time mixing | 2 |
| R7 | Shadow-mode `evaluateAccessPolicy` diverges from tier checks | Medium | Low | Shadow mode only — no production impact; divergence logged for analysis | 2 |

---

*This SDD designs the minimum changes needed to fully adopt loa-hounfour v7.9.2. Every modification extends existing, tested code. No module reorganization. No new services. No new external dependencies. The goal is simple: eliminate the protocol drift table in PRD §1.2 and make loa-finn a reference consumer for arrakis to follow.*
