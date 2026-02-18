# SDD: Protocol Convergence — loa-hounfour v5.0.0 → v7.0.0

> **Version**: 1.0.0
> **Date**: 2026-02-18
> **Author**: @janitooor + Claude Opus 4.6
> **Status**: Draft
> **Cycle**: cycle-026
> **PRD**: `grimoires/loa/prd.md` v1.1.0 (Flatline-integrated)
> **Grounding**: `grimoires/loa/reality/` (2026-02-13), `src/hounfour/` (33 files), `packages/loa-hounfour/` (stale v1.0.0)

---

## 1. Executive Summary

This SDD designs the architecture for upgrading loa-finn's protocol package from `@0xhoneyjar/loa-hounfour` v5.0.0 to v7.0.0. The migration introduces three new architectural elements while preserving the existing system architecture:

1. **Wire Boundary Module** — Centralized branded type parse/serialize layer (FAANG pattern)
2. **BillingConservationGuard** — Fail-closed evaluator wrapping existing billing invariant checks
3. **Schema Audit & Golden Fixture Infrastructure** — Deterministic wire-compatibility verification

**What doesn't change**: Module structure (15 modules), request pipeline flow, persistence cascade (WAL→R2→Git), boot sequence, JWT auth algorithm (ES256), WebSocket protocol, API endpoints, database schemas.

**What changes**: Import paths (canonical types replace local), billing pipeline gains evaluator layer, protocol handshake advertises v7.0.0, Oracle knowledge sources updated.

---

## 2. System Architecture

### 2.1 High-Level Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                        Gateway Layer                         │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌──────────┐  │
│  │ HTTP/WS  │  │ JWT Auth  │  │   CORS    │  │Rate Limit│  │
│  └────┬─────┘  └─────┬─────┘  └───────────┘  └──────────┘  │
│       │              │                                       │
│       │    ┌─────────▼──────────┐                           │
│       │    │  Wire Boundary ◄── │ NEW: parse branded types  │
│       │    │  (wire-boundary.ts)│ at request ingress         │
│       │    └─────────┬──────────┘                           │
└───────┼──────────────┼──────────────────────────────────────┘
        │              │
┌───────▼──────────────▼──────────────────────────────────────┐
│                     Hounfour Layer (33→35 files)             │
│  ┌──────────────┐  ┌────────────────┐  ┌─────────────────┐  │
│  │Pool Enforce- │  │  Tier Bridge   │  │Protocol Handshake│ │
│  │ment (canonical│  │ (canonical     │  │(v7.0.0 advertise,│ │
│  │ PoolId)      │  │  vocabulary)   │  │ MIN_SUPP=4.0.0) │ │
│  └──────┬───────┘  └───────┬────────┘  └─────────────────┘  │
│         │                  │                                 │
│  ┌──────▼──────────────────▼────────────────────────────┐   │
│  │              Router + Orchestrator                     │   │
│  │  (pool selection → provider → model → invoke)         │   │
│  └──────────────────────┬────────────────────────────────┘   │
│                         │                                     │
│  ┌──────────────────────▼────────────────────────────────┐   │
│  │              Billing Pipeline                          │   │
│  │  cost-arithmetic.ts → budget.ts → billing-finalize    │   │
│  │         │                                              │   │
│  │  ┌──────▼───────────────────────┐                     │   │
│  │  │ BillingConservationGuard ◄── │ NEW: evaluator      │   │
│  │  │ (compiled at startup,        │ wraps ad-hoc checks │   │
│  │  │  fail-closed, bypass env)    │                     │   │
│  │  └──────────────────────────────┘                     │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 Architectural Invariants (Unchanged)

| Invariant | Preserved? | Notes |
|-----------|-----------|-------|
| ES256 JWT auth with req_hash | Yes | Algorithm, claims structure unchanged on wire |
| BigInt micro-USD arithmetic | Yes | Internal computation unchanged |
| WAL→R2→Git persistence cascade | Yes | No persistence changes |
| Hono v4 request pipeline | Yes | Middleware order unchanged |
| Boot sequence strict ordering | Yes | BillingConservationGuard.init() added after hounfour step |
| Graceful shutdown order | Yes | Evaluator has no shutdown requirements (in-memory only) |

### 2.3 New Architectural Elements

| Element | Type | Location | Purpose |
|---------|------|----------|---------|
| `wire-boundary.ts` | Module | `src/hounfour/` | Centralized branded type parse/serialize |
| `BillingConservationGuard` | Class | `src/hounfour/billing-conservation-guard.ts` | Fail-closed evaluator for billing invariants |
| Golden wire fixtures | Test infra | `tests/fixtures/wire/` | Deterministic wire-format stability tests |
| Schema audit artifact | Build artifact | `grimoires/loa/a2a/schema-audit-v5-v7.json` | Checked-in schema diff |

---

## 3. Technology Stack

### 3.1 Dependencies Changed

| Package | Before | After | Reason |
|---------|--------|-------|--------|
| `@0xhoneyjar/loa-hounfour` | `github:...#e5b9f16c` (v5.0.0) | `github:...#v7.0.0` | Protocol convergence |

### 3.2 Dependencies Unchanged

| Package | Version | Relevance |
|---------|---------|-----------|
| `@sinclair/typebox` | ^0.34.48 | Runtime schema validation — verify peer dep alignment with v7.0.0 |
| `jose` | ^6.1.3 | JWT signing/verification — unchanged |
| `hono` | ^4.0.0 | HTTP framework — unchanged |
| `ioredis` | (current) | Budget state — unchanged |

### 3.3 Dependencies Removed

| Package | Location | Reason |
|---------|----------|--------|
| `packages/loa-hounfour/` | Local workspace | Stale v1.0.0 — replaced by external v7.0.0 |

### 3.4 TypeBox Peer Dependency Verification

loa-hounfour v7.0.0 declares TypeBox as a peer dependency. Sprint 1 schema audit must verify:
- loa-finn's TypeBox version satisfies the peer range
- No TypeBox major version mismatch that could cause validation behavior differences
- If mismatch: align versions before proceeding

---

## 4. Component Design

### 4.1 Wire Boundary Module (`src/hounfour/wire-boundary.ts`)

**Design philosophy**: Branded types are a security boundary. The Wire Boundary Module is the **sole constructor** for branded type values in the application. This is enforced through three layers:

1. **Type-level**: Brand symbol is not exported — only the parse functions can construct branded values. The brand type helper (`__brand`) is module-private (Stripe pattern).
2. **Lint-level**: ESLint rule bans `as MicroUSD`, `as BasisPoints`, `as AccountId`, `as PoolId` type assertions outside of `wire-boundary.ts` and test files.
3. **Runtime-level**: Critical persistence boundaries (ledger write, billing finalize) include a runtime format assertion (`assertMicroUSDFormat()`) that validates the string matches the canonical pattern before writing. This catches any bypass that slipped through compile-time and lint-time checks.

```typescript
// === PARSE FUNCTIONS (wire → domain) ===
// Each is the ONLY way to create the corresponding branded type.
// All normalization and validation happens here.

export function parseMicroUSD(raw: string): MicroUSD
  // 1. Reject empty string
  // 2. Reject plus sign prefix
  // 3. Strip leading zeros (except for "0" itself)
  // 4. Normalize "-0" → "0"
  // 5. Validate pattern: /^-?[1-9][0-9]*$|^0$/
  // 6. Return as MicroUSD branded type
  // Throws: WireBoundaryError with { field: 'micro_usd', raw, reason }

export function parseBasisPoints(raw: number): BasisPoints
  // 1. Verify integer (Number.isInteger)
  // 2. Verify range [0, 10000]
  // 3. Return as BasisPoints branded type
  // Throws: WireBoundaryError

export function parseAccountId(raw: string): AccountId
  // 1. Reject empty string
  // 2. Validate pattern: /^[a-zA-Z0-9_-]+$/
  // 3. Return as AccountId branded type
  // Throws: WireBoundaryError

export function parsePoolId(raw: string): PoolId
  // 1. Validate membership in canonical POOL_IDS vocabulary
  // 2. Return as PoolId branded type
  // Throws: WireBoundaryError with { field: 'pool_id', raw, valid: POOL_IDS }

// === SERIALIZE FUNCTIONS (domain → wire) ===
// Guarantee canonical wire format for outbound data.

export function serializeMicroUSD(value: MicroUSD): string
  // Returns the branded string directly (MicroUSD is already a string)
  // Asserts normalization invariant (no leading zeros, no -0)

export function serializeBasisPoints(value: BasisPoints): number
  // Returns the branded number directly

export function serializeAccountId(value: AccountId): string
  // Returns the branded string directly

// === ERROR TYPE ===
export class WireBoundaryError extends Error {
  constructor(
    public readonly field: string,
    public readonly raw: unknown,
    public readonly reason: string,
  ) { super(`Wire boundary violation: ${field} — ${reason}`) }
}
```

**Integration points:**

| Call Site | Function | Direction |
|-----------|----------|-----------|
| `jwt-auth.ts` → claim extraction | `parseAccountId(claims.tenant_id)` | Inbound |
| `jwt-auth.ts` → claim extraction | `parsePoolId(claims.pool_id)` (if present) | Inbound |
| `billing-finalize-client.ts` → cost recording | `parseMicroUSD(cost_string)` | Internal boundary |
| `budget.ts` → config loading | `parseBasisPoints(threshold)` | Config boundary |
| `billing-finalize-client.ts` → response | `serializeMicroUSD(total)` | Outbound |
| Pool enforcement → validation | `parsePoolId(requested)` | Inbound |
| WAL deserialization → ledger read | `parseMicroUSD(entry.total_cost_micro)` | Persistence read |
| R2 deserialization → recovery | `parseMicroUSD(entry.total_cost_micro)` | Persistence read |
| Redis deserialization → budget snapshot | `parseMicroUSD(snapshot.spent_usd)` | Cache read |

**Exhaustive runtime boundary enforcement**: Every ingress point where data enters the application must pass through wire-boundary parse functions. This includes not just HTTP/WS/JWT ingress but also deserialization from WAL, R2, and Redis. Persistence reads are trust boundaries — data written by a previous version could have different format assumptions.

**Testing**: Each parse function has a dedicated test suite covering all edge cases from the PRD's MicroUSD normalization table, plus property-based tests for round-trip stability (`parse(serialize(x)) === x`).

### 4.2 BillingConservationGuard (`src/hounfour/billing-conservation-guard.ts`)

**Design**: Singleton guard that compiles the constraint registry at startup and validates billing invariants at each billing checkpoint. Wraps (does not replace) existing ad-hoc checks — the ad-hoc checks serve as the `EVALUATOR_BYPASS` fallback.

```typescript
export class BillingConservationGuard {
  private compiled: CompiledConstraintRegistry | null = null
  private state: 'uninitialized' | 'ready' | 'degraded' | 'bypassed' = 'uninitialized'

  // === LIFECYCLE ===

  async init(): Promise<void>
    // 1. Check EVALUATOR_BYPASS env — if true, set state='bypassed', return
    // 2. Attempt compilation with retry (3 attempts, 1s/2s/4s backoff)
    // 3. On success: state='ready', log compiled constraint count
    // 4. On all retries exhausted: state='degraded', log error, emit alert
    // Idempotent: calling init() when ready is a no-op

  getHealth(): { billing: 'ready' | 'degraded' | 'unavailable', evaluator_compiled: boolean }
    // Maps state to health response for /health endpoint

  // === INVARIANT CHECKS ===
  // Each method runs BOTH the evaluator check AND the existing ad-hoc check.
  // Strict fail-closed lattice: effective = FAIL if EITHER check fails or errors.
  // Only PASS if both evaluator AND ad-hoc return PASS.
  // An evaluator error is treated as FAIL, NOT a fallback trigger.

  checkBudgetConservation(spent: MicroUSD, limit: MicroUSD): InvariantResult
    // Evaluator: bigint_lte(spent, limit)
    // Ad-hoc: existing budget.ts check
    // If evaluator errors: effective = 'fail' (not fallback), log + alert

  checkCostNonNegative(cost: MicroUSD): InvariantResult
    // Evaluator: bigint_gte(cost, '0')
    // Ad-hoc: existing cost-arithmetic.ts check
    // Same strict lattice

  checkReserveWithinAllocation(reserve: MicroUSD, allocation: MicroUSD): InvariantResult
    // Evaluator: bigint_lte(reserve, allocation)
    // Ad-hoc: existing billing-finalize-client.ts check
    // Same strict lattice

  checkMicroUSDFormat(value: string): InvariantResult
    // Evaluator: string_matches_pattern(value, MICRO_USD_PATTERN)
    // Ad-hoc: regex check
    // Same strict lattice

  // === BYPASS MODE (break-glass only) ===
  // EVALUATOR_BYPASS is the ONLY way to fall back to ad-hoc-only.
  // It is NOT activated automatically by evaluator errors.
  // When EVALUATOR_BYPASS=true:
  // - All check methods run ONLY the ad-hoc path
  // - Every check logs { evaluator_bypassed: true } to append-only audit sink
  // - Metrics emit evaluator.bypassed counter
  // - High-severity alert fires on every pod start with bypass enabled
  // See Section 7.2 for bypass security requirements.
}

// === RESULT TYPE ===
export interface InvariantResult {
  ok: boolean
  invariant_id: string
  evaluator_result: 'pass' | 'fail' | 'error' | 'bypassed'
  adhoc_result: 'pass' | 'fail'
  // Strict lattice: PASS only if evaluator=pass AND adhoc=pass
  // FAIL if evaluator=fail|error OR adhoc=fail
  // When bypassed: effective follows adhoc_result only
  effective: 'pass' | 'fail'
}

// === FAIL-CLOSED LATTICE ===
// evaluator | adhoc | effective
// pass      | pass  | pass
// pass      | fail  | fail      ← ad-hoc caught something evaluator missed
// fail      | pass  | fail      ← evaluator caught something ad-hoc missed
// fail      | fail  | fail
// error     | pass  | fail      (evaluator error = FAIL, not fallback)
// error     | fail  | fail
// bypassed  | pass  | pass      (explicit break-glass only)
// bypassed  | fail  | fail

// === DIVERGENCE MONITORING ===
// When evaluator and ad-hoc disagree (evaluator=pass, adhoc=fail OR vice versa):
// - Emit metric: evaluator.divergence{invariant_id, evaluator_result, adhoc_result}
// - Log structured event with full input context for debugging
// - Alert if divergence rate > 0 (any disagreement is a bug signal)
// Divergence is a high-signal indicator of drift or implementation bugs.
// The strict lattice ensures safety (always FAIL on disagreement),
// but divergence must be investigated and resolved.
```

**Boot sequence integration:**

```
Current: config → validate → identity → persistence → recovery → beads →
         compound → activityFeed → workerPool → redis → hounfour →
         sidecar/orchestrator → gateway → scheduler → HTTP serve

New:     config → validate → identity → persistence → recovery → beads →
         compound → activityFeed → workerPool → redis → hounfour →
         ┌──────────────────────────────────────────────┐
         │ BillingConservationGuard.init() ◄── NEW STEP │
         └──────────────────────────────────────────────┘
         sidecar/orchestrator → gateway → scheduler → HTTP serve
```

The guard initializes AFTER hounfour (needs package loaded) and BEFORE gateway (needs to be ready before serving requests).

**Startup behavior decision tree:**

```
BillingConservationGuard.init()
├── EVALUATOR_BYPASS=true → state='bypassed', log to audit sink, alert, READY
├── Compilation succeeds → state='ready', READY
├── Compilation fails, retry 1 → ...
├── Compilation fails, retry 2 → ...
├── Compilation fails, retry 3 → state='degraded'
│   ├── Billing endpoints: return 503 (BILLING_EVALUATOR_UNAVAILABLE)
│   ├── Non-billing endpoints: serve normally (/health, /api/sessions, /ws, etc.)
│   └── Readiness probe: READY (pod can serve non-billing traffic)
└── Pod is always READY after init() completes (even if degraded)
```

**Key decisions:**
1. **Pod always becomes ready** — init() never crashes the process. Zero-downtime is preserved.
2. **Billing endpoints fail individually** — 503 only for billing operations, not the whole pod.
3. **Non-billing traffic unaffected** — sessions, WebSocket, dashboard, health all serve normally.
4. **Readiness is endpoint-level, not pod-level** — Kubernetes readiness probe passes; billing endpoint readiness is checked per-request by the guard.

**Health endpoint integration:**

```typescript
// In /health handler:
const guardHealth = billingConservationGuard.getHealth()
return {
  status: 'healthy', // Pod is healthy even if evaluator degraded
  subsystems: {
    // ... existing subsystems ...
    billing_evaluator: guardHealth
    // billing: 'ready' | 'degraded' | 'bypassed'
  }
}
```

**Per-request billing gate** (in billing middleware):
```typescript
if (guard.state === 'degraded') {
  return c.json({ error: 'BILLING_EVALUATOR_UNAVAILABLE', retry_after_seconds: 30 }, 503)
}
```

**CI preflight gate** (Sprint 2): Evaluator compilation runs in the same Node version and container base image as production during CI. If compilation fails in CI, the build is red — this catches env-specific issues before deploy.

**Degraded state recovery**: The `degraded` state is not permanent. Recovery paths:
1. **Automatic**: Background timer retries compilation every 60s while degraded. On success, transitions to `ready` and resumes billing.
2. **Manual**: Redeploy with fix (constraint file fix, dependency fix, etc.)
3. **Emergency**: Set `EVALUATOR_BYPASS=true` via redeploy to restore billing via ad-hoc path (break-glass, see Section 7.2).
The `degraded` → `ready` transition emits a recovery metric and clears the alert.

### 4.3 Protocol Handshake Updates (`src/hounfour/protocol-handshake.ts`)

**Changes:**

| Field | Before | After |
|-------|--------|-------|
| `CONTRACT_VERSION` | `'1.0.0'` (from local package) | `'7.0.0'` (from external v7.0.0) |
| `MIN_SUPPORTED_VERSION` | `'1.0.0'` (from local package) | `'4.0.0'` (hardcoded in loa-finn) |

**Design decision**: `MIN_SUPPORTED_VERSION` is set in loa-finn's own code, NOT imported from the package. This prevents the package from inadvertently raising the minimum and rejecting arrakis.

```typescript
// src/hounfour/protocol-handshake.ts

import { CONTRACT_VERSION, validateCompatibility } from '@0xhoneyjar/loa-hounfour'

// Override: loa-finn controls its own minimum, not the package
const FINN_MIN_SUPPORTED = '4.0.0' as const

export async function performHandshake(arrakisUrl: string): Promise<HandshakeResult> {
  const peerVersion = await fetchPeerVersion(arrakisUrl)

  // Validate using package's validateCompatibility but with our minimum
  const compat = validateCompatibility(peerVersion, FINN_MIN_SUPPORTED)

  // Feature detection
  const hasTrustScopes = semverGte(peerVersion, '6.0.0')

  return {
    peerVersion,
    advertisedVersion: CONTRACT_VERSION, // '7.0.0'
    compatible: compat.ok,
    features: { trustScopes: hasTrustScopes },
  }
}
```

**Version response in health endpoint:**

```json
{
  "protocol": {
    "version": "7.0.0",
    "min_supported": "4.0.0",
    "peer_version": "4.6.0",
    "compatible": true
  }
}
```

### 4.4 Import Path Migration

**Before (v5.0.0 + local package):**

```typescript
// Some files import from external:
import { PoolId, POOL_IDS } from '@0xhoneyjar/loa-hounfour'

// Some files import from local package:
import { ... } from '../../packages/loa-hounfour/src/...'

// Some files define local equivalents:
type MicroUSD = string  // local shadow
```

**After (v7.0.0, single source):**

```typescript
// ALL protocol types from one source:
import { PoolId, POOL_IDS, MicroUSD, BasisPoints, AccountId } from '@0xhoneyjar/loa-hounfour'

// Branded type creation ONLY through wire boundary:
import { parseMicroUSD, parseAccountId } from './wire-boundary'

// NO local type shadows, NO local package imports
```

**ESLint enforcement** (new rule):

```json
{
  "no-restricted-imports": ["error", {
    "patterns": [{
      "group": ["**/packages/loa-hounfour/**"],
      "message": "Import from '@0xhoneyjar/loa-hounfour' instead"
    }]
  }]
}
```

### 4.5 Oracle Knowledge Corpus Architecture

**No architectural change** — same knowledge source format, same gold-set evaluation. Content update only:

| File | Action | Content |
|------|--------|---------|
| `grimoires/oracle/code-reality-hounfour.md` | Rewrite | v7.0.0 schemas, builtins, constraints, branded types |
| `grimoires/oracle/architecture.md` | Update | Protocol layer describes v7.0.0 |
| `grimoires/oracle/capabilities.md` | Update | Add evaluator, branded types, liveness properties |
| `grimoires/oracle/sources.json` | Update | Checksums for updated files |

---

## 5. Data Architecture

### 5.1 No Schema Changes

This migration does not change:
- Ledger entry format (V2 is already string-serialized BigInt micro-USD)
- WAL segment format
- R2 checkpoint format
- Redis key structure
- Session state format

### 5.2 Type Narrowing Changes

The internal TypeScript types narrow from loose to branded:

| Field | Before (v5) | After (v7) | Wire Format |
|-------|-------------|------------|-------------|
| `LedgerEntryV2.total_cost_micro` | `string` | `MicroUSD` (branded string) | Unchanged: `"12345"` |
| `LedgerEntryV2.tenant_id` | `string` | `AccountId` (branded string) | Unchanged: `"user_abc"` |
| `LedgerEntryV2.pool_id` | `string \| undefined` | `PoolId \| undefined` (branded) | Unchanged: `"cheap"` |
| `BudgetSnapshot.limit_usd` | `string` | `MicroUSD` (branded string) | Unchanged |

**Key invariant**: Branded types are purely compile-time narrowing. The runtime wire representation is identical. This is verified by golden wire fixtures.

---

## 6. API Design

### 6.1 No New Endpoints

No API endpoints are added or removed. Existing endpoints remain backward-compatible.

### 6.2 Health Endpoint Enhancement

**`GET /health`** — adds evaluator status:

```json
{
  "status": "healthy",
  "subsystems": {
    "persistence": { "wal": "ok", "r2": "ok" },
    "scheduler": { "state": "running", "jobs": 4 },
    "billing_evaluator": {
      "billing": "ready",
      "evaluator_compiled": true
    },
    "protocol": {
      "version": "7.0.0",
      "min_supported": "4.0.0",
      "peer_version": "4.6.0",
      "compatible": true
    }
  }
}
```

### 6.3 Error Response Changes

New error codes from evaluator:

| Code | HTTP | When | Body |
|------|------|------|------|
| `BILLING_INVARIANT_VIOLATION` | 402 | Budget conservation check fails | `{ error, invariant_id, details }` |
| `BILLING_INVARIANT_VIOLATION` | 409 | Reserve ≤ allocation check fails | `{ error, invariant_id, details }` |
| `BILLING_EVALUATOR_UNAVAILABLE` | 503 | Evaluator not compiled (circuit-open) | `{ error, retry_after_seconds }` |

These replace existing ad-hoc error responses with structured invariant IDs. The HTTP status codes remain the same (402/409 were already used).

---

## 7. Security Architecture

### 7.1 JWT Auth (Unchanged)

- Algorithm: ES256 (ECDSA P-256) — unchanged
- Claims: Same wire format — branded types are compile-time only
- Validation: Same flow in `jwt-auth.ts`, with `parseAccountId()` call added at extraction
- `req_hash`: SHA-256 of raw body — unchanged
- JWKS caching: 5-minute TTL — unchanged

### 7.2 Billing Safety (Enhanced)

| Control | Before (v5) | After (v7) |
|---------|-------------|------------|
| Budget check | Ad-hoc `if (spent > limit)` | Evaluator `bigint_lte` + ad-hoc (strict lattice) |
| Cost validation | Ad-hoc regex | `parseMicroUSD()` + evaluator `string_matches_pattern` |
| Fail mode | Implicit fail-closed | Explicit HARD-FAIL classification, strict lattice |
| Observability | Minimal logging | Structured logs with invariant_id, metrics, alerts |
| Emergency bypass | None | Break-glass `EVALUATOR_BYPASS` with immutable audit |

**Break-glass bypass security requirements:**

The `EVALUATOR_BYPASS` mechanism is a billing safety control and must be treated as a break-glass operation:

| Requirement | Implementation |
|-------------|---------------|
| **Immutable audit trail** | On startup with bypass enabled, write an entry to the WAL append-only log with: build SHA, pod identity, `EVALUATOR_BYPASS=true`, timestamp. WAL is synced to R2 (durable). |
| **High-severity alert** | Every pod start with bypass enabled fires a `critical` alert via `AlertService.fire()` with trigger type `evaluator_bypass_active`. |
| **Structured logging** | Every billing request while bypassed logs `{ evaluator_bypassed: true, pod_id, build_sha }` to structured logs. |
| **No silent activation** | Bypass requires an explicit deploy with the env var set. It is NOT auto-activated by evaluator errors (errors = FAIL, not bypass). |
| **Expiry recommendation** | Operational runbook should specify max bypass duration (recommended: 4 hours). Monitoring should alert if bypass has been active > 4 hours. |
| **No runtime toggle** | Bypass is startup-only (env var read at init). Cannot be toggled without a redeploy. This prevents runtime manipulation. |

### 7.3 Wire Format Integrity

**Threat model**: Version bump silently changes wire encoding, breaking arrakis interop.

**Mitigations:**
1. Golden wire fixtures (deterministic, pre/post comparison)
2. Schema audit checklist (9 dimensions)
3. Interop handshake fixture (synthetic + captured traffic)
4. TypeBox peer dependency alignment verification

### 7.4 Supply Chain

**Git tag pin security**: `github:0xHoneyJar/loa-hounfour#v7.0.0` — the tag is mutable (can be force-pushed). Mitigation:

| Control | Mechanism | Failure Mode |
|---------|-----------|-------------|
| Lockfile SHA pinning | `npm install` records resolved commit SHA in `package-lock.json` | Tag force-push → lockfile SHA mismatch on next `npm ci` |
| CI lockfile integrity | `npm ci` (not `npm install`) in CI — fails if lockfile doesn't match `package.json` | Tampered lockfile → CI red |
| SHA documentation | Schema audit artifact records `tag_sha` field with the resolved commit | Post-hoc verification of what was actually installed |
| Lockfile diff review | PR review must include `package-lock.json` diff showing resolved SHA | Human verification of dependency change |

**Verification command** (CI step): `npm ci && node -e "const p = require('@0xhoneyjar/loa-hounfour/package.json'); console.log(p.version);"` — must output `7.0.0`.

### 7.5 Bypass Access Control

The `EVALUATOR_BYPASS` env var must be controlled through the deployment pipeline, not set ad-hoc:

| Control | Implementation |
|---------|---------------|
| **GitOps-only** | Bypass env var is set in deployment manifests (Terraform/Kubernetes YAML), not via runtime env injection |
| **Mandatory review** | Any PR that adds `EVALUATOR_BYPASS=true` to deploy config requires approval from `@janitooor` |
| **External metrics** | Bypass state is exported as a Prometheus gauge (`evaluator_bypass_active{pod}`) scraped by external monitoring — cannot be suppressed by the application |
| **Centralized audit** | WAL audit entry + structured log, both forwarded to centralized log aggregator |

### 7.6 WAL Audit Event Schema

Bypass audit entries in the WAL use a typed discriminator to avoid breaking existing WAL consumers:

```typescript
// New WAL entry type for audit events
interface WALAuditEntry {
  type: 'audit'           // Discriminator — existing types: 'session', 'bead', 'memory', 'config'
  subtype: 'evaluator_bypass' | 'evaluator_recovery' | 'evaluator_degraded'
  timestamp: string
  pod_id: string
  build_sha: string
  details: Record<string, unknown>
}
```

Existing WAL consumers (R2 sync, Git sync, recovery) filter by `type` and will ignore `audit` entries. The `type` discriminator is the compatibility contract — no existing `WALEntryType` values are changed.

---

## 8. Integration Points

### 8.1 loa-hounfour v7.0.0

| Import Category | Examples | Count |
|----------------|---------|-------|
| Type definitions | `MicroUSD`, `BasisPoints`, `AccountId`, `PoolId` | ~10 types |
| Vocabulary | `POOL_IDS`, `TIER_POOL_ACCESS`, `TIER_DEFAULT_POOL` | 3 constants |
| Schemas (TypeBox) | `JwtClaimsSchema`, `StreamEventSchema` | ~5 schemas |
| Evaluator builtins | `bigint_lte`, `bigint_gte`, `string_matches_pattern` | 4 builtins |
| Evaluator registry | `EVALUATOR_BUILTIN_SPECS`, `ConservationPropertyRegistry` | 2 registry types |
| Protocol | `CONTRACT_VERSION`, `validateCompatibility` | 2 functions |

### 8.2 arrakis (Peer — No Changes Required)

| Interaction | Protocol | Changes |
|------------|----------|---------|
| JWT validation | ES256 via JWKS | None — same claims, same signing |
| Stream events | WebSocket JSON | None — same envelope format |
| Health/handshake | HTTP GET | Advertised version changes (cosmetic) |

### 8.3 External Services (No Changes)

Redis, R2, GitHub API, Anthropic API — all unchanged.

---

## 9. Scalability & Performance

### 9.1 Evaluator Performance Contract

| Metric | Budget | Measurement |
|--------|--------|-------------|
| Constraint compilation (startup) | < 500ms | `evaluator.compile.duration_ms` |
| Per-invariant check (p95) | < 1ms | `evaluator.check.p95_ms` |
| Total billing pipeline overhead | < 5ms | End-to-end billing latency delta |
| Memory (compiled registry) | < 1MB | Process RSS delta at boot |

**CI enforcement**: Microbenchmark harness runs 10,000 iterations of each billing invariant check on representative payloads. Build fails if p95 exceeds 1ms.

### 9.2 Wire Boundary Performance

Branded type parse/serialize functions are trivial (regex match + string comparison). Expected overhead: < 0.01ms per call. No caching needed.

### 9.3 No Scalability Changes

Request concurrency, worker pool sizing, Redis usage patterns, rate limiting — all unchanged.

---

## 10. Deployment Architecture

### 10.1 Canary Deployment Strategy (Per Sprint)

```
1. PR merge → CI green (tests + fixtures + schema audit + microbenchmark)
2. Deploy to staging
3. Run full test suite against staging (including golden wire fixtures)
4. Shadow traffic (read-only replay):
   - Replay 10 min of captured production billing requests against staging
   - Staging runs in READ-ONLY shadow mode: processes requests but does NOT
     write to ledger, does NOT debit budgets, does NOT call external APIs
   - Compare response payloads (status code + body) against production responses
   - Divergence report: any response difference flagged for manual review
   - Shadow mode enforced by env var SHADOW_MODE=true (disables all side effects)
5. Canary: route 5% production traffic for 30 min
6. Monitor (SLO-based canary gate):
   - Billing success rate SLO: ≥ 99.9% (measured as non-503 billing responses)
   - BILLING_EVALUATOR_UNAVAILABLE rate: must be 0
   - Evaluator divergence rate: must be 0
   - p95 billing latency: within 5ms of pre-deploy baseline
   - Any SLO breach → automated rollback (not just error rate > 0.1%)
7. Full rollout (only if ALL SLO gates pass for 30 min)
8. Rollback hook: automated revert on any SLO breach during canary window
```

### 10.2 Rollback Procedure

| Trigger | Action | RTO |
|---------|--------|-----|
| Wire fixture failure post-deploy | Revert PR, re-pin previous commit SHA | < 15 min |
| Billing invariant violation (new) | Circuit-open billing, revert evaluator wiring | < 10 min |
| arrakis handshake rejection | Revert `CONTRACT_VERSION` | < 10 min |
| Test regression > 2 beyond baseline | Block merge, fix or revert | Before merge |

### 10.3 Environment Variables (New)

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `EVALUATOR_BYPASS` | `false` | boolean | Emergency: disable evaluator, fall back to ad-hoc checks |

No other new environment variables required.

---

## 11. Testing Strategy

### 11.1 Golden Wire Fixtures (`tests/fixtures/wire/`)

**Purpose**: Deterministic JSON snapshots that must remain byte-for-byte stable across the migration.

**Fixture files:**

| File | Contents | Determinism |
|------|----------|-------------|
| `jwt-claims.fixture.json` | Complete JWT claims payload | Fixed `iat`/`exp`/`jti`, fixed `tenant_id`/`tier` |
| `jwt-signed.fixture.txt` | JWT header + payload segments (signature verified at runtime, not snapshot) | Fixed claims, header checked structurally |
| `billing-request.fixture.json` | Billing finalize request body | Fixed costs, reservation_id |
| `billing-response.fixture.json` | Billing finalize response body | Fixed totals, ledger entry |
| `stream-event.fixture.json` | Stream event envelope | Fixed delta, usage, trace_id |

**Determinism rules:**

| Element | Fixed Value | Rationale |
|---------|-------------|-----------|
| JWT signing key | `tests/fixtures/keys/es256-test.{key,pub}` | Deterministic signatures |
| Timestamps | `iat: 1700000000, exp: 1700003600` | Reproducible |
| Nonce/JTI | `"test-jti-fixture-001"` | Deterministic token body |
| JSON format | `json-stable-stringify(obj)` (compact, deterministic key order) | Byte-for-byte |
| req_hash | SHA-256 of fixed request body | End-to-end verification |

**Fixture test flow:**

```
For JSON fixtures (billing, stream events):
  1. Load fixture JSON
  2. Validate against v7.0.0 TypeBox schema (must pass)
  3. Parse through wire-boundary functions (must succeed)
  4. Re-serialize
  5. Compare output to fixture (byte-for-byte match)

For JWT fixtures (non-deterministic ECDSA signatures):
  1. Load fixture claims JSON (jwt-claims.fixture.json)
  2. Validate claims against v7.0.0 JwtClaimsSchema (must pass)
  3. Sign at runtime with test ES256 keypair
  4. Decode signed token, compare decoded claims to fixture (structural match)
  5. Verify signature with test public key (round-trip integrity)
  6. Verify req_hash computation matches fixture request body
  NOTE: Do NOT snapshot the full signed JWT token — ES256 signatures
        are non-deterministic (ECDSA uses random k unless RFC 6979).
        Only the claims payload is golden.
```

### 11.2 Schema Audit Infrastructure

**Sprint 1 gate artifact**: `grimoires/loa/a2a/schema-audit-v5-v7.json`

```json
{
  "audit_version": "1.0.0",
  "source_version": "5.0.0",
  "target_version": "7.0.0",
  "tag_sha": "<resolved commit SHA>",
  "typebox_alignment": { "finn": "0.34.48", "hounfour_peer": "..." , "compatible": true },
  "schemas": {
    "JwtClaimsSchema": {
      "required_fields_added": [],
      "optional_fields_added": ["trust_scopes"],
      "fields_removed": [],
      "pattern_changes": [],
      "default_changes": [],
      "additional_properties_change": null,
      "verdict": "COMPATIBLE"
    }
  },
  "vocabulary": {
    "POOL_IDS": { "added": [], "removed": [], "verdict": "UNCHANGED" }
  },
  "overall_verdict": "COMPATIBLE"
}
```

**Checklist per schema** (9 dimensions from PRD):

1. Required fields: New required fields added?
2. Optional fields + defaults: Changed defaults?
3. Patterns/regex: Tightened or changed?
4. Enum/vocabulary members: Added, removed, renamed?
5. `additionalProperties`: Changed from true/absent to false?
6. Nullable/union changes: Narrowed unions or removed null?
7. Numeric bounds: Changed min/max/multipleOf?
8. Validator strictness: TypeBox config changes?
9. TypeBox version: Peer dependency compatible?

### 11.3 Interop Handshake Fixture

**Synthetic fixture** (Sprint 1, required):

```typescript
// tests/finn/interop-handshake.test.ts

test('arrakis v4.6.0 handshake accepted', () => {
  const arrakisResponse = {
    contract_version: '4.6.0',
    // Fields from arrakis source analysis
  }

  const result = validateHandshake(arrakisResponse)
  expect(result.compatible).toBe(true)
  expect(result.peerVersion).toBe('4.6.0')
})

// Document: arrakis handshake code reference
// https://github.com/0xHoneyJar/arrakis/blob/<commit>/src/<file>#L<line>
```

**Captured traffic replay** (Sprint 1, best-effort):
- If staging available: capture real handshake, replay against v7.0.0
- If unavailable: document as risk, require manual verification pre-deploy

### 11.4 Evaluator Tests

| Test | Type | Coverage |
|------|------|---------|
| Guard compilation success | Unit | Happy path — registry compiles |
| Guard compilation failure + retry | Unit | 3 retries with backoff, degraded state |
| Guard bypass mode | Unit | `EVALUATOR_BYPASS=true` → ad-hoc only |
| Budget conservation check | Unit | Evaluator + ad-hoc agree |
| Evaluator/ad-hoc disagreement | Unit | Strictest wins (fail-closed) |
| Evaluator runtime error | Unit | effective=FAIL (no fallback), logs error + fires alert |
| Bypass does not auto-activate on error | Unit | Evaluator error does NOT toggle bypass mode |
| Health endpoint with guard | Integration | `/health` reflects evaluator state |
| Microbenchmark | Performance | p95 < 1ms per invariant |

### 11.5 Wire Boundary Tests

| Test | Coverage |
|------|---------|
| `parseMicroUSD` — valid values | `"0"`, `"12345"`, `"-100"` |
| `parseMicroUSD` — edge cases | `""`, `"+100"`, `"007"`, `"-0"`, `"00"` |
| `parseBasisPoints` — valid | `0`, `5000`, `10000` |
| `parseBasisPoints` — invalid | `-1`, `10001`, `0.5`, `NaN` |
| `parseAccountId` — valid/invalid | Pattern validation |
| `parsePoolId` — vocabulary | Known/unknown pool IDs |
| Round-trip property tests | `serialize(parse(x)) === x` for all types |

### 11.6 Test Baseline

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Total tests | 200 | ~220 | +20 (fixtures, evaluator, boundary) |
| Passing | 187 | ≥ 207 | All new tests pass, zero regression |
| Pre-existing failures | 13 | 13 | Unchanged (separate concern) |

---

## 12. Migration Plan (Sprint Breakdown)

### Sprint 1: Foundation — Bump + Cleanup + Safety Gates

**Objective**: Get to v7.0.0 with all safety gates green.

```
1. Create golden wire fixtures (BEFORE bump)
   - Generate fixture files from current v5.0.0 behavior
   - Commit to tests/fixtures/wire/

2. Schema audit
   - Install v7.0.0 temporarily alongside v5.0.0
   - Generate schema-audit-v5-v7.json (9-dimension checklist)
   - Verify TypeBox peer dep alignment
   - Commit audit artifact

3. Delete packages/loa-hounfour/
   - Comprehensive search (workspace, tsconfig, file:, deep imports, compiled JS)
   - Remove all references
   - Add ESLint no-restricted-imports rule

4. Bump dependency
   - Update package.json to github:...#v7.0.0
   - npm install
   - Record resolved commit SHA

5. Fix compilation
   - tsc --noEmit
   - Update import paths as needed

6. Protocol handshake update
   - Set FINN_MIN_SUPPORTED = '4.0.0'
   - CONTRACT_VERSION from package (7.0.0)
   - Feature detection for trust_scopes
   - Add health endpoint protocol version

7. Interop verification
   - Synthetic arrakis v4.6.0 handshake fixture
   - Captured traffic replay (if staging available)
   - Document arrakis source code reference

8. Wire fixture verification (AFTER bump)
   - All golden fixtures still pass byte-for-byte

9. Test suite
   - Full run: ≥ 187 passing
   - Fix or independently cover s2s-jwt.test.ts wire-compat surface

GATE: Schema audit artifact committed, all fixtures green, tsc clean, ≥ 187 tests
```

### Sprint 2: Type Adoption — Branded Types + Evaluator

**Objective**: Canonical types everywhere, evaluator operational.

```
1. Wire Boundary Module
   - Create src/hounfour/wire-boundary.ts
   - All parse/serialize functions with full edge-case coverage
   - Wire boundary test suite

2. Branded type adoption (file by file)
   - jwt-auth.ts: parseAccountId at claim extraction
   - pool-enforcement.ts: parsePoolId
   - tier-bridge.ts: canonical vocabulary re-exports
   - billing-finalize-client.ts: parseMicroUSD
   - cost-arithmetic.ts: MicroUSD types
   - budget.ts: parseBasisPoints
   - types.ts: import branded types, remove local shadows

3. Golden wire fixture verification
   - All fixtures byte-for-byte stable after type migration
   - New snapshot tests for billing req/res, JWT claims, stream events

4. BillingConservationGuard
   - Create src/hounfour/billing-conservation-guard.ts
   - Compile constraint registry at startup
   - Wire into billing pipeline
   - Bypass mode with EVALUATOR_BYPASS env
   - Health endpoint integration

5. Boot sequence update
   - Add BillingConservationGuard.init() after hounfour step

6. Evaluator tests
   - Unit tests for all invariant checks
   - Disagreement handling tests
   - Bypass mode tests
   - CI microbenchmark (p95 < 1ms)

7. Observability
   - Structured logging for HARD-FAIL events
   - Metrics: compile duration, check latency, fail count, bypass count
   - Alert: circuit-open state → PagerDuty

GATE: All branded types canonical, evaluator compiled + passing, microbenchmark green,
      golden fixtures stable, ≥ 207 tests passing
```

### Sprint 3: Knowledge + Hardening

**Objective**: Oracle up to date, production hardening complete.

```
1. Oracle knowledge corpus update
   - Rewrite code-reality-hounfour.md for v7.0.0
   - Update architecture.md, capabilities.md
   - Update sources.json checksums

2. Gold-set verification
   - Update test vectors for v7.0.0 protocol questions
   - Verify 20/20 pass rate

3. CI hardening
   - Protocol version drift detection
   - Evaluator preflight (compile in production container image)
   - TypeBox version check

4. Final integration pass
   - End-to-end billing flow with evaluator
   - Full fixture suite
   - Test suite: ≥ 207 passing, zero new failures

GATE: Gold-set 20/20, all CI checks green, production-ready
```

---

## 13. Technical Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|-----------|--------|------------|-------|
| v7.0.0 has undocumented wire-format changes | Low | High | 9-dimension schema audit + golden fixtures | Sprint 1 |
| PoolId vocabulary changed between v5 and v7 | Low | High | Schema audit vocabulary diff + migration strategy (see below) | Sprint 1 |
| Evaluator compilation fails in production env | Low | High | CI preflight in production container + emergency bypass | Sprint 2 |
| MicroUSD normalization mismatch with arrakis | Medium | High | Canonical rules + edge-case fixtures | Sprint 2 |
| TypeBox version mismatch causes validation drift | Low | Medium | Peer dep alignment check in Sprint 1 | Sprint 1 |
| Git tag `v7.0.0` is force-pushed | Very Low | High | Lockfile SHA pinning + CI integrity check | Sprint 1 |
| arrakis rejects v7.0.0 contract_version | Low | High | Interop fixture + arrakis source code analysis | Sprint 1 |
| Evaluator adds measurable latency | Low | Medium | Startup compilation + cache + microbenchmark gate | Sprint 2 |
| Oracle knowledge regression | Low | Low | Gold-set 20/20 gate | Sprint 3 |

**PoolId vocabulary migration strategy** (if schema audit detects vocabulary changes):

| Change Type | Strategy | Implementation |
|------------|----------|----------------|
| Members added | Backward-compatible — existing code handles known members, new fall through to default | Add new members to any local switch/match statements; no breaking change |
| Members removed | **Breaking** — requires coordinated handling | Add a compatibility map: `{ removedId: replacementId }`. Apply at `parsePoolId()` boundary. Log deprecated usage. Coordinate with arrakis. |
| Members renamed | **Breaking** — same as removal + addition | Add alias map in `parsePoolId()`: accept old name, normalize to new. Log deprecated alias usage. Time-bound: remove alias after arrakis migrates. |
| No changes | No action | Verified by vocabulary snapshot test in schema audit |

Persisted data (ledger entries, Redis keys) may contain old PoolId values. Deserialization via `parsePoolId()` must accept both old and new vocabulary during the transition period. The compatibility map is the mechanism for this.

---

## 14. File Manifest

### New Files

| File | Sprint | Purpose |
|------|--------|---------|
| `src/hounfour/wire-boundary.ts` | 2 | Branded type parse/serialize (sole constructor) |
| `src/hounfour/billing-conservation-guard.ts` | 2 | Fail-closed evaluator wrapper |
| `tests/fixtures/wire/jwt-claims.fixture.json` | 1 | Golden JWT claims fixture |
| `tests/fixtures/wire/jwt-signed.fixture.txt` | 1 | Golden signed JWT fixture |
| `tests/fixtures/wire/billing-request.fixture.json` | 1 | Golden billing request fixture |
| `tests/fixtures/wire/billing-response.fixture.json` | 1 | Golden billing response fixture |
| `tests/fixtures/wire/stream-event.fixture.json` | 1 | Golden stream event fixture |
| `tests/fixtures/keys/es256-test.key` | 1 | Deterministic test signing key |
| `tests/fixtures/keys/es256-test.pub` | 1 | Deterministic test public key |
| `tests/finn/wire-boundary.test.ts` | 2 | Wire boundary unit tests |
| `tests/finn/billing-conservation-guard.test.ts` | 2 | Evaluator guard tests |
| `tests/finn/interop-handshake.test.ts` | 1 | arrakis v4.6.0 interop fixture |
| `tests/finn/wire-fixtures.test.ts` | 1 | Golden wire fixture verification |
| `grimoires/loa/a2a/schema-audit-v5-v7.json` | 1 | Schema audit artifact |

### Modified Files

| File | Sprint | Changes |
|------|--------|---------|
| `package.json` | 1 | Bump dep, remove workspace ref |
| `tsconfig.json` | 1 | Remove packages/ path mapping |
| `src/hounfour/protocol-handshake.ts` | 1 | v7.0.0 version, FINN_MIN_SUPPORTED=4.0.0 |
| `src/hounfour/jwt-auth.ts` | 2 | parseAccountId at extraction |
| `src/hounfour/pool-enforcement.ts` | 2 | parsePoolId, canonical types |
| `src/hounfour/tier-bridge.ts` | 2 | Canonical vocabulary re-exports |
| `src/hounfour/pool-registry.ts` | 2 | Canonical PoolId |
| `src/hounfour/nft-routing-config.ts` | 2 | Canonical PoolId |
| `src/hounfour/billing-finalize-client.ts` | 2 | parseMicroUSD, evaluator guard |
| `src/hounfour/cost-arithmetic.ts` | 2 | MicroUSD branded types |
| `src/hounfour/budget.ts` | 2 | parseBasisPoints, evaluator guard |
| `src/hounfour/types.ts` | 2 | Import branded types, remove shadows |
| `src/config.ts` | 1 | Protocol version in config |
| `src/index.ts` | 2 | Boot: add BillingConservationGuard.init() |
| `tests/finn/pool-enforcement.test.ts` | 1-2 | Update imports, branded types |
| `tests/finn/budget-accounting.test.ts` | 2 | Branded type assertions, evaluator |
| `tests/finn/jwt-roundtrip.test.ts` | 1 | Wire compat verification |
| `tests/finn/pool-registry.test.ts` | 1-2 | Update imports |
| `grimoires/oracle/code-reality-hounfour.md` | 3 | Complete rewrite for v7.0.0 |
| `grimoires/oracle/sources.json` | 3 | Update checksums |
| `.eslintrc` / `eslint.config.*` | 1 | no-restricted-imports for local package |

### Deleted Files

| File | Sprint | Reason |
|------|--------|--------|
| `packages/loa-hounfour/` (entire directory, ~15 files) | 1 | Replaced by external v7.0.0 |

---

## 15. Future Considerations

| Item | When | Dependency |
|------|------|-----------|
| Raise `MIN_SUPPORTED_VERSION` to 6.0.0 | After arrakis upgrades to v7.0.0 | arrakis migration |
| Adopt `trust_scopes` in JWT flow | After arrakis sends trust_scopes | arrakis v7.0.0 |
| Adopt composition schemas (sagas, governance) | Future cycle | Feature work |
| npm publish of loa-hounfour | Independent | loa-hounfour repo |
| Remove ad-hoc billing checks | After evaluator proves stable (2+ weeks production) | Confidence period |
| Cross-system E2E on v7.0.0 | Phase 4 | Both consumers at v7.0.0 |
