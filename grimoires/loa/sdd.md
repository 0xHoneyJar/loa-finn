# SDD: Hounfour v7.11.0 Protocol Convergence

**Cycle**: 034
**Status**: Draft
**Author**: Claude Opus 4.6 + Jani (strategic direction)
**Date**: 2026-02-24
**PRD**: `grimoires/loa/prd-hounfour-v711.md` (GPT-5.2 APPROVED iteration 2)
**GPT-5.2 Review**: APPROVED (iteration 2, 11 blocking issues resolved)
**Flatline Review**: 5 HIGH_CONSENSUS integrated, DISPUTED/BLOCKERS addressed

---

## 1. Executive Summary

This SDD describes the architectural changes required to upgrade loa-finn's hounfour dependency from v7.9.2 to v7.11.0 and integrate five new protocol capabilities: dual-strategy handshake detection, task-dimensional reputation, open enum task types, native enforcement geometry, and protocol-aligned hash chains.

**Key architectural decisions:**

1. **No new runtime source modules** — All changes are surgical modifications to 9 existing source files plus `package.json`. Test fixture files (shared hash chain vectors) may be added.
2. **Feature flags gate all runtime behavior** — Every new capability is behind an env var defaulting to `false`. The dependency upgrade itself changes zero runtime behavior. Flags are read at module load; rollback requires process restart (not hot-reload).
3. **TaskType is branded end-to-end** — A single `TaskType` branded type (parsed at wire boundary) propagates through enforcement, reputation, WAL, and audit trail. Downstream interfaces accept `TaskType`, never raw `string`.
4. **Hash chain migration is append-only and irreversible** — Existing chain entries are never rewritten. A bridge entry marks the transition; dual-write ensures backward verifiability. Once migrated, toggling the flag off is forbidden (requires a second bridge entry).

**Files modified**: 9 source files + `package.json` (listed in Section 3)
**New files**: 1 test fixture (`tests/safety/hash-chain-vectors.json`)
**Estimated test additions**: ~120 test cases across existing test files

---

## 2. System Architecture

### 2.1 Component Interaction Overview

```
                            +--------------------+
                            |  arrakis health    |
                            |  /api/internal/    |
                            |    health          |
                            +--------+-----------+
                                     | { contract_version, capabilities[] }
                                     v
+-------------------------------------------------------------------------+
|  protocol-handshake.ts                                                  |
|  +---------------------+    +----------------------+                    |
|  | detectPeerFeatures() |--->| PeerFeatures          |                  |
|  | dual-strategy:       |    | + taskDimensionalRep  |                  |
|  |  1. capabilities[]   |    | + hashChain           |                  |
|  |  2. FEATURE_THRESHOLDS|   | + openTaskTypes       |                  |
|  |  3. unknown -> false  |   +----------+-----------+                   |
|  +---------------------+               |                                |
+------------------------------------------+------------------------------+
                                           |
        +----------------------------------+----------------------+
        |                                  v                      |
        |  +---------------+    +------------------+              |
        |  |wire-boundary  |--->| RequestMetadata   |             |
        |  |parseTaskType() |   | + task_type:      |             |
        |  |ns:type parse   |   |   TaskType (brand)|             |
        |  +---------------+    +--------+---------+              |
        |                                |                        |
        |  +-------- TASK TYPE GATE -----+----+                   |
        |  | validateTaskType()                |                   |
        |  | DENY unknown if policy=deny       |                   |
        |  | MUST run before routing/enforce    |                   |
        |  +-----------------------------------+                   |
        |                                |                        |
        |  +-----------------------------+--------------------+   |
        |  |                             v                    |   |
        |  |  economic-boundary.ts                            |   |
        |  |  +------------------------------------------+    |   |
        |  |  | evaluateBoundary(claims, budget, taskType)|   |   |
        |  |  | +----------+  +-----------------------+  |    |   |
        |  |  | |buildTrust|  | cohort query (v7.11)  |  |    |   |
        |  |  | |Snapshot()|  | OR blended (fallback) |  |    |   |
        |  |  | +----------+  +-----------------------+  |    |   |
        |  |  +------------------------------------------+    |   |
        |  +--------------------------------------------------+   |
        |                                |                        |
        |  +-----------------------------+--------------------+   |
        |  |                             v                    |   |
        |  |  pool-enforcement.ts                             |   |
        |  |  +------------------------------------------+    |   |
        |  |  | ENFORCEMENT_GEOMETRY env var              |    |   |
        |  |  | expression (default) | native (opt-in)   |    |   |
        |  |  | Wire protocol unchanged either way       |    |   |
        |  |  +------------------------------------------+    |   |
        |  +--------------------------------------------------+   |
        |                                |                        |
        |  +-----------------------------+--------------------+   |
        |  |                             v                    |   |
        |  |  audit-trail.ts                                  |   |
        |  |  +------------------------------------------+    |   |
        |  |  | appendRecord() with versioned envelope   |    |   |
        |  |  | format: "legacy" | "protocol_v1"         |    |   |
        |  |  | canonical_json: RFC 8785 (JCS library)   |    |   |
        |  |  | bridge entry at migration point          |    |   |
        |  |  +------------------------------------------+    |   |
        |  +--------------------------------------------------+   |
        |                                                         |
        +---------------------------------------------------------+
```

### 2.1.1 Health Endpoint Contract (IMP-001)

The handshake probes arrakis's `/api/internal/health` endpoint. The response schema must be explicitly defined to prevent silent failure on schema drift:

```typescript
/** Expected response from arrakis /api/internal/health */
interface ArrakisHealthResponse {
  status: "ok" | "degraded" | "down"
  contract_version: string                // semver, e.g. "7.11.0"
  capabilities?: string[]                 // capability identifiers, e.g. ["task_dimensional_reputation"]
  trust_scopes?: Record<string, unknown>  // legacy field (v4.6.0 compat)
}
```

**Versioning and negotiation rules:**
- `contract_version` is parsed with semver; parse failure → treat as unknown peer (all features = false)
- `capabilities` array absence → fall back to semver-only detection (v7.9.2 compat)
- Unknown capabilities are silently ignored (forward-compatible)
- HTTP errors or timeouts → default `PeerFeatures` (all false) with detection method `"timeout"` or `"error"`

**Transport security (SKP-005 addressed)**: The health endpoint carries capability advertisements that influence feature detection. To prevent spoofing:
- Health probes use the existing internal service mesh (mTLS between finn and arrakis in production)
- In development/staging without mTLS, health data is treated as **hints only** — no security-sensitive behavior (enforcement mode, hash chain migration) is enabled solely based on peer capability advertisement. These behaviors are gated by local feature flags, not peer detection.
- Capabilities influence **compatibility decisions** (e.g., whether to send cohort queries), not **security policy** (enforcement mode is always local config)
- Rate-limit health probes: max 1 probe per 30s per peer (existing `reputationTimeoutMs` pattern). Cache results for the TTL window.
- Log structured health probe results at DEBUG level (not per-request). Per-request logging of raw health data is prohibited in hot paths to prevent log injection/DoS.

**Error codes from health probe:**
| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 200 | Healthy response | Parse and detect features |
| 503 | Service degraded | Use cached features if available, else all false |
| 4xx/5xx | Unexpected error | All features false, log warning |
| Timeout (>5s) | Network issue | All features false, log warning |

### 2.2 Feature Flag Architecture

All new behavior is gated by env vars. No runtime change occurs on upgrade alone.

| Flag | Values | Default | Controls |
|------|--------|---------|----------|
| `TASK_DIMENSIONAL_REPUTATION_ENABLED` | `true`/`false` | `false` | Cohort queries in economic boundary |
| `NATIVE_ENFORCEMENT_ENABLED` | `true`/`false` | `false` | Native evaluation geometry in pool enforcement |
| `PROTOCOL_HASH_CHAIN_ENABLED` | `true`/`false` | `false` | RFC 8785 envelope format in audit trail |
| `OPEN_TASK_TYPES_ENABLED` | `true`/`false` | `false` | TaskType routing and unknown type denial |
| `ENFORCEMENT_GEOMETRY` | `expression`/`native` | `expression` | Evaluation path (local config, not peer) |
| `UNKNOWN_TASK_TYPE_POLICY` | `deny`/`safe_default` | `deny` | Unknown task type handling |

**Flag lifecycle**: Flags are read once at module load (same pattern as `ECONOMIC_BOUNDARY_MODE`). Changing a flag value requires a **process restart** — env vars are not hot-reloaded. This is consistent with the existing deployment model where config changes trigger rolling restarts via the container orchestrator.

**Flag `false` → existing behavior (no code path change). Flag `true` → new behavior activates.**

---

## 3. File Modification Map

Every change is mapped to a PRD functional requirement. No new runtime source modules are created. Test fixture files may be added.

| File | PRD Ref | Change Summary |
|------|---------|----------------|
| `package.json:32` | FR-1 | Pin to v7.11.0 exact commit hash |
| `src/hounfour/protocol-types.ts` | FR-1 | Conditionally re-export new types (with fallback wrappers) |
| `src/hounfour/types.ts` | FR-3, FR-6 | Extend `ReputationProvider` with cohort query; add `task_type: TaskType` to `RequestMetadata` and `LedgerEntryV2` |
| `src/hounfour/wire-boundary.ts` | FR-6 | Add `parseTaskType()` branded type parser |
| `src/hounfour/protocol-handshake.ts` | FR-2 | Add 3 `PeerFeatures` fields + dual-strategy detection |
| `src/hounfour/economic-boundary.ts` | FR-3, FR-7 | Task-dimensional cohort queries + shadow divergence metric |
| `src/hounfour/pool-enforcement.ts` | FR-4 | Native enforcement geometry path + task type gate |
| `src/hounfour/nft-routing-config.ts` | FR-6 | `TaskType` branded type routing + finn-native type registration |
| `src/safety/audit-trail.ts` | FR-5 | Versioned envelope, RFC 8785 (JCS), bridge entry, dual-write |
| `tests/safety/hash-chain-vectors.json` | FR-5 | Shared test vectors (NEW test fixture) |

---

## 4. Component Design

### 4.1 FR-1: Dependency Upgrade (`package.json`, `protocol-types.ts`, `economic-boundary.ts`)

**package.json** — Update line 32:
```
"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#<v7.11.0-commit-hash>"
```

**protocol-types.ts** — Conditional re-exports with fallback wrappers:

The SDD does NOT assume specific export names exist in v7.11.0. All new re-exports use conditional wrappers that fail gracefully if the upstream export is missing or renamed.

```typescript
// Task-Dimensional Reputation (v7.10.0) — conditional re-export
// If upstream does not export these, the local type stubs are used
// and the feature flag prevents runtime usage.
export type {
  TaskTypeCohort,
  ReputationEvent,
  ScoringPathLog,
} from "@0xhoneyjar/loa-hounfour"

// Open Task Types (v7.11.0)
// TaskType may be a branded string or plain alias — finn's parseTaskType()
// is the authoritative constructor regardless.
export type { TaskType } from "@0xhoneyjar/loa-hounfour"
```

**Conditional import strategy for functions (SKP-001 addressed)**:

The project uses `"type": "module"` in `package.json` (ESM). However, `await import()` at module top level is fragile across bundlers and test runners. Instead, use **static imports with build-time verification and flag-gated usage**:

```typescript
// Static import — build fails fast if export is missing (desired behavior)
import { evaluateNativeEnforcement } from "@0xhoneyjar/loa-hounfour"

// Re-export for downstream use (gated by NATIVE_ENFORCEMENT_ENABLED at call sites)
export { evaluateNativeEnforcement }
```

**Module system constraints** (verified during Sprint 1):
- Node.js: >= 20.x with `"type": "module"` in `package.json`
- TypeScript: `"module": "node16"` or `"nodenext"` in `tsconfig.json`
- Test runner: vitest (native ESM support)
- No bundler transformation for server-side code

**If an expected export is missing from v7.11.0**: The build will fail at compile time (static import error), which is the correct behavior — it prevents deploying code that references non-existent functions. During Sprint 1 compile-time verification, if any export is missing, the import is removed and the corresponding feature flag's code path is adjusted to use a finn-local implementation or is disabled.

**Startup self-check**: When a feature flag is enabled, the module validates that the required upstream function is available at startup. If not, it logs a FATAL error and exits (fail-fast, not fail-at-traffic):

```typescript
if (NATIVE_ENFORCEMENT_ENABLED && typeof evaluateNativeEnforcement !== "function") {
  throw new Error(
    "[pool-enforcement] FATAL: NATIVE_ENFORCEMENT_ENABLED=true but evaluateNativeEnforcement " +
    "is not available from @0xhoneyjar/loa-hounfour. Upgrade dependency or disable flag."
  )
}
```

The point is: **static imports fail at build time; flag-gated usage fails at startup — never at traffic time**.

**economic-boundary.ts** — Remove `EvaluationResultWithDenials` local type patch:
```typescript
// BEFORE: Local type extension (workaround for upstream gap)
type EvaluationResultWithDenials = EconomicBoundaryEvaluationResult & {
  denial_codes?: DenialCode[]
}

// AFTER: Use upstream type directly (v7.11.0 includes denial_codes)
// All usages of EvaluationResultWithDenials -> EconomicBoundaryEvaluationResult
```

If upstream v7.11.0 still does not include `denial_codes` in the exported type, retain the local extension with updated comment.

**Feature flag bootstrap** — Add to module scope in a new section at top of `economic-boundary.ts`:
```typescript
export const TASK_DIMENSIONAL_REPUTATION_ENABLED =
  process.env.TASK_DIMENSIONAL_REPUTATION_ENABLED === "true"

export const OPEN_TASK_TYPES_ENABLED =
  process.env.OPEN_TASK_TYPES_ENABLED === "true"
```

Similarly in `pool-enforcement.ts`:
```typescript
export const NATIVE_ENFORCEMENT_ENABLED =
  process.env.NATIVE_ENFORCEMENT_ENABLED === "true"
```

And in `audit-trail.ts`:
```typescript
const PROTOCOL_HASH_CHAIN_ENABLED =
  process.env.PROTOCOL_HASH_CHAIN_ENABLED === "true"
```

### 4.2 FR-2: Protocol Handshake Extension (`protocol-handshake.ts`)

#### 4.2.1 PeerFeatures Interface Extension

Add 3 new fields to the existing interface:
```typescript
export interface PeerFeatures {
  // Existing (unchanged)
  trustScopes: boolean
  reputationGated: boolean
  compoundPolicies: boolean
  economicBoundary: boolean
  denialCodes: boolean
  // New (v7.10.0+)
  taskDimensionalReputation: boolean   // v7.10.0+
  hashChain: boolean                    // v7.10.1+
  openTaskTypes: boolean                // v7.11.0+
}
```

#### 4.2.2 FEATURE_THRESHOLDS Extension

Add entries for new features:
```typescript
export const FEATURE_THRESHOLDS = {
  // Existing (unchanged)
  trustScopes:      { major: 6, minor: 0, patch: 0 },
  reputationGated:  { major: 7, minor: 3, patch: 0 },
  compoundPolicies: { major: 7, minor: 4, patch: 0 },
  economicBoundary: { major: 7, minor: 7, patch: 0 },
  denialCodes:      { major: 7, minor: 9, patch: 1 },
  // New
  taskDimensionalReputation: { major: 7, minor: 10, patch: 0 },
  hashChain:                 { major: 7, minor: 10, patch: 1 },
  openTaskTypes:             { major: 7, minor: 11, patch: 0 },
} as const satisfies Record<keyof PeerFeatures, { major: number; minor: number; patch: number }>
```

#### 4.2.3 Dual-Strategy Detection

Modify `detectPeerFeatures()` to implement the dual-strategy approach. The function retains its `PeerFeatures` return type (no new return type introduced). Detection methods are logged as a side effect for observability.

```typescript
export type DetectionMethod = "capability" | "semver" | "legacy_field" | "unknown"

function detectPeerFeatures(
  remoteVersion: string,
  healthData: Record<string, unknown>,
): PeerFeatures {
  // 1. Try capability-based detection (primary)
  const capabilities = healthData.capabilities
  const hasCapabilities = Array.isArray(capabilities)

  // 2. Try semver-based detection (fallback)
  let remote: { major: number; minor: number; patch: number } | null = null
  try {
    remote = parseSemver(remoteVersion)
  } catch {
    // Unparsable version -- semver fallback unavailable
  }

  // Track methods for observability logging (not returned, logged only)
  const methods: Partial<Record<keyof PeerFeatures, DetectionMethod>> = {}

  /**
   * Detect a feature using the three-strategy cascade:
   * 1. capabilities array (explicit peer advertisement)
   * 2. semver threshold (FEATURE_THRESHOLDS comparison)
   * 3. unknown (conservative false)
   *
   * For trustScopes only: also checks legacy health response field.
   */
  const detectFeature = (
    featureName: keyof PeerFeatures,
    capabilityKey: string,
    legacyHealthField?: string,
  ): boolean => {
    // Primary: explicit capabilities array
    if (hasCapabilities && (capabilities as string[]).includes(capabilityKey)) {
      methods[featureName] = "capability"
      return true
    }

    // Legacy field detection (trustScopes only): check for exact field
    // with expected shape (must be a non-null object or true)
    if (legacyHealthField && legacyHealthField in healthData) {
      const fieldValue = healthData[legacyHealthField]
      if (fieldValue != null && fieldValue !== false) {
        methods[featureName] = "legacy_field"
        return true
      }
    }

    // Fallback: semver threshold
    if (remote) {
      const threshold = FEATURE_THRESHOLDS[featureName]
      const meets = compareSemver(remote, threshold) >= 0
      methods[featureName] = "semver"
      return meets
    }

    // Unknown: conservative false
    methods[featureName] = "unknown"
    return false
  }

  const features: PeerFeatures = {
    // Existing features -- backward compatible
    // trustScopes has legacy field detection as explicit third strategy
    trustScopes:      detectFeature("trustScopes", "trust_scopes", "trust_scopes"),
    reputationGated:  detectFeature("reputationGated", "reputation_gated"),
    compoundPolicies: detectFeature("compoundPolicies", "compound_policies"),
    economicBoundary: detectFeature("economicBoundary", "economic_boundary"),
    denialCodes:      detectFeature("denialCodes", "denial_codes"),
    // New features -- no legacy field detection
    taskDimensionalReputation: detectFeature("taskDimensionalReputation", "task_dimensional_reputation"),
    hashChain:                 detectFeature("hashChain", "hash_chain"),
    openTaskTypes:             detectFeature("openTaskTypes", "open_task_types"),
  }

  // Log detection methods for observability (side effect, not returned)
  const methodSummary = Object.entries(methods)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
  console.log(`[protocol-handshake] detection: ${methodSummary}`)

  return features
}
```

**Key design choices:**
- **Return type remains `PeerFeatures`** — all call sites unchanged. Detection methods are logged, not returned.
- **Legacy field detection is an explicit strategy** — only applies to `trustScopes` via the optional `legacyHealthField` parameter. Validates field value is truthy (not just key presence).
- **Detection method tracking** uses `Partial<Record<keyof PeerFeatures, DetectionMethod>>` for type safety during construction.

**Test scenarios**: v4.6.0 (all false), v7.9.2 (existing 5 true, new 3 false), v7.11.0 (all true), absent version (all false via "unknown"), unparsable version (all false via "unknown"), backported feature (capabilities says true but semver says false -> capability wins), v4.6.0 with `trust_scopes` field in health response (trustScopes = true via "legacy_field", rest false).

### 4.3 FR-3: Task-Dimensional Reputation (`types.ts`, `economic-boundary.ts`)

#### 4.3.1 ReputationProvider Extension (`types.ts`)

Extend the existing `ReputationProvider` interface with an optional cohort-based method. The `taskType` parameter is typed as `TaskType` (branded), not `string`.

```typescript
import type { TaskType } from "./protocol-types.js"

export interface ReputationProvider {
  // Existing (unchanged)
  getReputationBoost(tenantId: string): Promise<{ boost: number; source: string } | null>

  // New: cohort-based query (optional -- callers check method existence)
  getTaskCohortScore?(
    tenantId: string,
    taskType: TaskType,
  ): Promise<{ score: number; state: string; cohort: string } | null>
}
```

The optional method pattern means existing `ReputationProvider` implementations continue working without modification.

#### 4.3.2 RequestMetadata Extension (`types.ts`)

Add `task_type` to the request context using the branded type:
```typescript
import type { TaskType } from "./protocol-types.js"

export interface RequestMetadata {
  agent: string
  tenant_id: string
  nft_id: string
  trace_id: string
  reservation_id?: string
  task_type?: TaskType  // Branded TaskType (parsed at wire boundary)
}
```

Add `task_type` to `LedgerEntryV2`:
```typescript
export interface LedgerEntryV2 {
  // ... existing fields ...
  task_type?: TaskType  // Branded TaskType for dimensional attribution
}
```

Note: `TaskType` serializes to a plain string in JSON (branded types are erased at runtime). The brand ensures that only values produced by `parseTaskType()` enter the pipeline.

#### 4.3.3 Cohort-Based Economic Boundary (`economic-boundary.ts`)

Modify `buildTrustSnapshot()` to accept task type and query cohort scores:

```typescript
import type { TaskType } from "./protocol-types.js"

export async function buildTrustSnapshot(
  claims: JWTClaims,
  peerFeatures?: PeerFeatures,
  opts?: {
    reputationProvider?: ReputationProvider
    reputationTimeoutMs?: number
    taskType?: TaskType  // Branded -- not raw string
  },
): Promise<TrustLayerSnapshot | null> {
  const tierMapping = TIER_TRUST_MAP[claims.tier]
  if (!tierMapping) {
    console.warn(`[economic-boundary] Unknown tier "${claims.tier}" -- trust snapshot unavailable`)
    return null
  }

  // ... existing degradation logic for pre-v7.9 peers ...

  // NEW: Task-dimensional reputation (when enabled + supported)
  if (
    TASK_DIMENSIONAL_REPUTATION_ENABLED &&
    peerFeatures?.taskDimensionalReputation &&
    opts?.reputationProvider?.getTaskCohortScore &&
    opts?.taskType
  ) {
    try {
      const timeoutMs = opts?.reputationTimeoutMs ?? DEFAULT_REPUTATION_TIMEOUT_MS
      // ... timeout race pattern (same as existing) ...
      const cohortResult = await Promise.race([
        opts.reputationProvider.getTaskCohortScore(claims.tenant_id, opts.taskType),
        rejectAfter(timeoutMs),
      ])

      if (cohortResult) {
        // Shadow mode: log divergence between cohort and blended
        if (cohortResult.score !== tierMapping.blended_score) {
          console.log(JSON.stringify({
            component: "economic-boundary",
            event: "cohort_vs_blended_delta",
            task_type: opts.taskType,
            cohort_score: cohortResult.score,
            blended_score: tierMapping.blended_score,
            delta: cohortResult.score - tierMapping.blended_score,
            cohort_state: cohortResult.state,
            tenant_hash: hashTenantId(claims.tenant_id),
          }))
        }

        return {
          reputation_state: cohortResult.state as ReputationStateName,
          blended_score: cohortResult.score,
          snapshot_at: new Date().toISOString(),
        }
      }
    } catch (err) {
      console.warn("[economic-boundary] Task cohort query failed -- falling back to blended:", err)
    }
  }

  // ... existing blended score logic (unchanged) ...
}
```

**evaluateBoundary()** — Thread `taskType` through:
```typescript
export async function evaluateBoundary(
  claims: JWTClaims,
  budget: BudgetSnapshot,
  peerFeatures?: PeerFeatures,
  criteria?: QualificationCriteria,
  opts?: {
    reputationProvider?: ReputationProvider
    reputationTimeoutMs?: number
    taskType?: TaskType  // Branded
  },
): Promise<EconomicBoundaryEvaluationResult | null> {
  const trustSnapshot = await buildTrustSnapshot(claims, peerFeatures, opts)
  // ... rest unchanged ...
}
```

**economicBoundaryMiddleware()** — Extract branded task type from Hono context:
```typescript
// Inside the handler, after extracting tenantContext:
const taskType = c.get("taskType") as TaskType | undefined

// Pass to evaluateBoundary:
const result = await evaluateBoundary(
  claims, budget, opts.peerFeatures, opts.criteria,
  { reputationProvider: opts.reputationProvider, reputationTimeoutMs: opts.reputationTimeoutMs, taskType },
)

// Include task_type in log payload (serializes to string in JSON):
const logPayload = {
  // ... existing fields ...
  task_type: taskType ?? "unknown",
}
```

### 4.4 FR-4: Native Enforcement Path (`pool-enforcement.ts`)

#### 4.4.1 Design

Native enforcement is a **local evaluator optimization** — it calls enforcement functions directly instead of parsing expressions. The wire protocol is unchanged. This is NOT gated on `PeerFeatures` — it's controlled by a local env var.

#### 4.4.2 Implementation

Add to `pool-enforcement.ts` after the existing access policy evaluation:

```typescript
import { evaluateNativeEnforcement } from "./protocol-types.js"

const NATIVE_ENFORCEMENT_ENABLED =
  process.env.NATIVE_ENFORCEMENT_ENABLED === "true"

const ENFORCEMENT_GEOMETRY: "expression" | "native" = (() => {
  if (!NATIVE_ENFORCEMENT_ENABLED) return "expression"
  const raw = process.env.ENFORCEMENT_GEOMETRY ?? "expression"
  if (raw === "native" || raw === "expression") return raw
  console.warn(`[pool-enforcement] Invalid ENFORCEMENT_GEOMETRY="${raw}", defaulting to "expression"`)
  return "expression"
})()

/**
 * Evaluate enforcement using configured geometry.
 * Both paths MUST produce identical AccessPolicyResult -- only execution path differs.
 *
 * If evaluateNativeEnforcement is undefined (upstream does not export it),
 * falls back to expression regardless of config.
 */
export function evaluateWithGeometry(
  policy: Parameters<typeof evaluateAccessPolicy>[0],
  context: AccessPolicyContext,
): AccessPolicyResult {
  if (ENFORCEMENT_GEOMETRY === "native" && evaluateNativeEnforcement) {
    return evaluateNativeEnforcement(policy, context)
  }
  return evaluateAccessPolicy(policy, context)
}
```

**Integration point**: Replace `evaluateAccessPolicy()` call in `evaluateAccessPolicyShadow()` with `evaluateWithGeometry()`.

**Compatibility invariant**: Both paths MUST produce identical `AccessPolicyResult` for identical inputs. This is enforced as a hard CI gate (correctness assertion). Performance is measured separately.

#### 4.4.3 CI Benchmark Strategy

**Correctness = hard gate. Performance = reported metric (non-blocking).**

Add to existing test suite (not a new file):
```typescript
// In tests/hounfour/pool-enforcement.test.ts
describe("native enforcement", () => {
  // HARD GATE: correctness equivalence
  it("native produces identical results to expression for all inputs", () => {
    const inputs = generateBenchmarkInputs(1000)
    for (const input of inputs) {
      expect(evaluateWithGeometry(input.policy, input.context))  // native
        .toEqual(evaluateAccessPolicy(input.policy, input.context))  // expression
    }
  })

  // REPORTED METRIC: performance (non-blocking to avoid CI flakiness)
  it.skip("native enforcement benchmark (manual / perf job only)", () => {
    const inputs = generateBenchmarkInputs(1000)
    // Warmup
    for (let i = 0; i < 3; i++) {
      for (const input of inputs) evaluateWithGeometry(input.policy, input.context)
    }
    // Measure
    const expressionMs = benchmarkExpression(inputs)
    const nativeMs = benchmarkNative(inputs)
    console.log(`native=${nativeMs.toFixed(2)}ms expression=${expressionMs.toFixed(2)}ms ratio=${(expressionMs/nativeMs).toFixed(1)}x`)
    // Soft assertion: log warning if below 3x but don't fail CI
    if (nativeMs > expressionMs / 3) {
      console.warn(`[benchmark] native is only ${(expressionMs/nativeMs).toFixed(1)}x faster (target: 3x)`)
    }
  })
})
```

The 3x target is validated in a controlled perf job (dedicated runner, pinned Node 22, single-thread), not in general CI which runs on variable-performance shared runners.

### 4.5 FR-5: Hash Chain Alignment (`audit-trail.ts`)

#### 4.5.1 RFC 8785 Canonical JSON

The existing `canonicalize()` function uses `JSON.stringify` with a `sortReplacer`. While this is close to RFC 8785 for ASCII-only data, it does not handle Unicode escaping correctly per RFC 8785 Section 3.2.2.2.

**Decision**: Use a dedicated JCS (JSON Canonicalization Scheme) library for protocol_v1 entries. The `canonicalize` npm package implements RFC 8785 correctly. If a library dependency is rejected, implement the RFC 8785 canonicalizer with test vectors covering:
- Unicode characters above U+FFFF (surrogate pairs)
- Number serialization edge cases (`1e20`, `-0`)
- Nested object key ordering

```typescript
import canonicalize from "canonicalize"  // RFC 8785 JCS library

// Legacy canonicalization (unchanged -- used for format="legacy")
function canonicalizeLegacy(record: Record<string, unknown>): string {
  // ... existing implementation ...
}

// Protocol v1 canonicalization (RFC 8785 compliant)
function canonicalizeProtocol(obj: Record<string, unknown>): string {
  // Uses RFC 8785 library for deterministic cross-implementation output
  return canonicalize(obj) as string
}
```

#### 4.5.2 Finalized Record Schema

Three record variants with explicit field inclusion rules:

```typescript
// Fields common to ALL record types
interface AuditRecordBase {
  seq: number
  prevHash: string              // Previous record's hash (format-specific chain)
  hash: string                  // This record's hash
  hmac?: string                 // Optional HMAC signature
  phase: AuditPhase
  intentSeq?: number
  ts: string
  jobId: string
  runUlid: string
  templateId: string
  action: string
  target: string
  params: Record<string, unknown>
  dedupeKey?: string
  result?: unknown
  error?: string
  rateLimitRemaining?: number
  dryRun: boolean
}

// Legacy format (pre-migration and flags-off)
interface LegacyAuditRecord extends AuditRecordBase {
  format?: undefined | "legacy"   // Absent for pre-migration records
}

// Protocol v1 format (post-migration)
interface ProtocolV1AuditRecord extends AuditRecordBase {
  format: "protocol_v1"
  envelope_version: 1
  payload_hash: string           // SHA-256 of canonicalized payload
  prevHashProtocol: string       // Protocol chain previous hash
  prevHashLegacy?: string        // Legacy chain previous hash (dual-write only)
}

// Bridge record (marks migration point)
interface BridgeAuditRecord extends ProtocolV1AuditRecord {
  action: "hash_chain_migration"
  legacy_chain_tip: string       // Hash of last legacy record before bridge
}

// Union type for all record variants
export type AuditRecord = LegacyAuditRecord | ProtocolV1AuditRecord | BridgeAuditRecord
```

**Field inclusion rules for hash computation:**

| Computation | Included Fields | Excluded Fields |
|-------------|-----------------|-----------------|
| Legacy hash | All AuditRecordBase fields except `hash`, `hmac` | `hash`, `hmac` |
| Protocol payload_hash | `action`, `target`, `params`, `ts`, `phase`, `dryRun`, `result`, `error` | All envelope/chain fields |
| Protocol entry hash | `prevHashProtocol` + envelope (see 4.5.3) | `hash`, `hmac`, `prevHashLegacy` |

#### 4.5.3 Hash Computation (Protocol v1)

Precise, language-agnostic hash input specification:

```
payload_hash = SHA-256(canonical_jcs(payload_fields))

envelope = canonical_jcs({
  version: 1,
  algo: "sha256",
  format: "protocol_v1",
  timestamp: <ISO-8601>,
  action: <string>,
  payload_hash: <hex string>
})

entry_hash = SHA-256(prev_hash_protocol_hex + "\n" + envelope)
```

Where:
- `canonical_jcs` = RFC 8785 JSON Canonicalization Scheme (via `canonicalize` npm package)
- `prev_hash_protocol_hex` = lowercase hex-encoded SHA-256 hash of previous protocol_v1 entry (or the literal string `"genesis"` for bridge entry)
- `"\n"` = literal newline character (byte 0x0A) as separator (unambiguous, not boolean-or)
- `payload_fields` = `{ action, target, params, ts, phase, dryRun, result?, error? }` (excluding all envelope/chain fields)
- All hash outputs are lowercase hex strings (64 characters for SHA-256)

**Formal hash input specification (SKP-003 addressed)**:

To eliminate ambiguity between writer and verifier, the exact byte sequence for each hash is:

| Hash | Exact Input Bytes |
|------|-------------------|
| `payload_hash` | `SHA-256(canonical_jcs({ action, target, params, ts, phase, dryRun [, result] [, error] }))` |
| `entry_hash` | `SHA-256(utf8_bytes(prev_hash_hex) + 0x0A + utf8_bytes(canonical_jcs(envelope)))` |
| `legacy_hash` | `SHA-256(canonical_legacy({ ...base_fields_except_hash_and_hmac }))` |

**Field presence rules for hash inputs**:
- `result`: Included in payload hash **only if present and not `undefined`**. `null` IS included (canonicalizes to `null`). `undefined` fields are omitted from the object before canonicalization.
- `error`: Same rule as `result` — included only if present and not `undefined`.
- `prevHashLegacy`: NEVER included in protocol entry hash computation. It is a metadata field for verifiers only.
- `hmac`: NEVER included in any hash computation. Computed separately over the final `hash` value.
- Number formatting: All numbers are IEEE 754 double-precision; JCS handles serialization per RFC 8785 Section 3.2.2.3.
- Timestamp (`ts`): Always ISO-8601 with milliseconds (`YYYY-MM-DDTHH:mm:ss.SSSZ`). Source is `new Date(this.now()).toISOString()`.

**Bridge record field consistency**:
- `prevHash`: Links to legacy chain (for legacy verifiers reading sequentially). Set to `this.lastHashLegacy`.
- `prevHashProtocol`: Links to protocol chain. Set to `"genesis"` for the bridge entry.
- `legacy_chain_tip`: Same value as `prevHash` on the bridge record. Explicit field for clarity.
- `hash`: Computed via protocol entry hash formula (not legacy).

**Property-based test requirement**: Tests MUST include a round-trip property test that generates random valid records, writes them via `appendRecord()`, reads them back, and verifies via `verifyChain()`. This catches any field inclusion/exclusion mismatch between writer and verifier.

#### 4.5.4 Migration: Bridge Entry and Dual Pointers

The AuditTrail class maintains **two independent chain tips** after migration:

```typescript
private lastHashLegacy = "genesis"     // Legacy chain tip
private lastHashProtocol = "genesis"   // Protocol chain tip (starts at bridge)
private migrated = false
private dualWriteRemaining = 0

private async appendBridgeEntry(): Promise<number> {
  await this.mutex.acquire()
  try {
    this.seq += 1

    const bridgeRecord: BridgeAuditRecord = {
      seq: this.seq,
      prevHash: this.lastHashLegacy,      // Links to legacy chain
      format: "protocol_v1",
      envelope_version: 1,
      phase: "intent",
      action: "hash_chain_migration",
      target: "audit_trail",
      params: {},
      ts: new Date(this.now()).toISOString(),
      jobId: this.runContext?.jobId ?? "",
      runUlid: this.runContext?.runUlid ?? "",
      templateId: this.runContext?.templateId ?? "",
      dryRun: false,
      legacy_chain_tip: this.lastHashLegacy,
      prevHashProtocol: "genesis",        // Protocol chain starts here
      payload_hash: "",                    // Computed below
      hash: "",                            // Computed below
    }

    // Compute payload hash
    bridgeRecord.payload_hash = computePayloadHash(bridgeRecord)

    // Compute protocol entry hash
    const envelope = buildEnvelope(bridgeRecord)
    bridgeRecord.hash = sha256("genesis" + "\n" + canonicalizeProtocol(envelope))
    bridgeRecord.prevHashProtocol = "genesis"

    // Also compute legacy hash for the bridge record itself
    bridgeRecord.prevHashLegacy = computeLegacyHash(bridgeRecord)

    const line = JSON.stringify(bridgeRecord) + "\n"
    await appendFile(this.filePath, line, "utf-8")

    this.lastHashLegacy = bridgeRecord.prevHashLegacy!  // Legacy chain continues
    this.lastHashProtocol = bridgeRecord.hash            // Protocol chain starts
    this.migrated = true
    this.dualWriteRemaining = DUAL_WRITE_ENTRIES

    return this.seq
  } finally {
    this.mutex.release()
  }
}
```

#### 4.5.5 Dual-Write Period and Migration Irreversibility

After the bridge entry, each record carries both chain pointers:

```typescript
const DUAL_WRITE_ENTRIES = parseInt(process.env.HASH_CHAIN_DUAL_WRITE_COUNT ?? "1000", 10)

// In appendRecord():
if (PROTOCOL_HASH_CHAIN_ENABLED) {
  if (!this.migrated) {
    await this.appendBridgeEntry()
  }

  // Protocol hash (always computed post-migration)
  record.format = "protocol_v1"
  record.envelope_version = 1
  record.payload_hash = computePayloadHash(record)
  record.prevHashProtocol = this.lastHashProtocol
  const protocolHash = computeProtocolEntryHash(this.lastHashProtocol, record)
  record.hash = protocolHash

  // Dual-write: also maintain legacy chain pointer
  if (this.dualWriteRemaining > 0) {
    record.prevHashLegacy = computeLegacyHash(this.lastHashLegacy, record)
    this.lastHashLegacy = record.prevHashLegacy
    this.dualWriteRemaining--
  }

  this.lastHashProtocol = protocolHash
} else if (this.migrated) {
  // FORBIDDEN: cannot toggle off after migration without a reverse bridge entry
  throw new Error(
    "[audit-trail] FATAL: PROTOCOL_HASH_CHAIN_ENABLED=false but chain is already migrated. " +
    "Toggling off would create an unverifiable gap. Set flag back to true or write a reverse bridge entry."
  )
} else {
  // Legacy path (unchanged -- pre-migration)
  record.format = "legacy"
  // ... existing hash computation ...
}
```

**Migration irreversibility (SKP-002 addressed)**: Once `this.migrated = true` (detected via log reconstruction at startup, see 4.5.5.1), the system enforces protocol mode. However, the enforcement is designed to be **safe during rolling deploys** rather than fatally crashing request paths:

```typescript
} else if (this.migrated) {
  // Post-migration with flag off: force protocol mode ON rather than throwing.
  // This handles the rolling deploy case where an older config starts a new instance.
  // Log a critical warning — this MUST be investigated — but do not crash requests.
  if (!this._migrationWarningEmitted) {
    console.error(
      "[audit-trail] CRITICAL: PROTOCOL_HASH_CHAIN_ENABLED=false but chain is already migrated. " +
      "Forcing protocol mode to prevent chain corruption. Set flag to true or write reverse bridge entry."
    )
    this._migrationWarningEmitted = true
    // Emit metric for alerting
    emitMetric("hash_chain_forced_protocol_mode", 1)
  }
  // Continue in protocol mode (safe: produces valid chain entries)
  record.format = "protocol_v1"
  // ... protocol hash computation as above ...
```

**Coordinated rollout plan**: To enable hash chain migration safely:
1. Deploy code with `PROTOCOL_HASH_CHAIN_ENABLED=false` to all instances
2. Verify boot-time log reconstruction works (Section 4.5.5.1)
3. Set `PROTOCOL_HASH_CHAIN_ENABLED=true` in config and trigger coordinated rolling restart (all instances get new config)
4. First instance to restart with flag=true writes the bridge entry
5. Subsequent instances reconstruct `migrated=true` from the log and continue in protocol mode

If an instance starts with flag=false after migration, it detects `migrated=true` from log reconstruction and forces protocol mode on (with critical alert) rather than throwing. This prevents the rolling-deploy footgun while maintaining chain integrity.

#### 4.5.5.1 Migration State Recovery on Restart (IMP-003, IMP-010)

The in-memory state (`migrated`, `lastHashLegacy`, `lastHashProtocol`, `dualWriteRemaining`) is reconstructed from the audit log at process startup. This prevents duplicate bridge entries and broken chains after restarts.

```typescript
/**
 * Reconstruct migration state by scanning the audit log.
 * Called once during AuditTrail construction (before any appends).
 *
 * Invariants:
 * - If a bridge entry exists, migrated=true and protocol chain tip is derived
 * - dualWriteRemaining is derived from counting records with prevHashLegacy after bridge
 * - If no bridge entry, migrated=false and all state is legacy-only
 */
private async reconstructStateFromLog(): Promise<void> {
  const content = await readFile(this.filePath, "utf-8").catch(() => "")
  if (!content) return  // Empty log: fresh state

  const lines = content.trim().split("\n").filter(Boolean)
  let sawBridge = false
  let dualWriteCount = 0

  for (const line of lines) {
    const record = JSON.parse(line)
    const format = record.format ?? "legacy"

    this.seq = record.seq  // Track highest seq

    if (format === "legacy") {
      this.lastHashLegacy = record.hash
    } else if (format === "protocol_v1") {
      if (!sawBridge && record.action === "hash_chain_migration") {
        sawBridge = true
      }
      this.lastHashProtocol = record.hash

      // Track legacy chain during dual-write
      if (record.prevHashLegacy) {
        this.lastHashLegacy = record.prevHashLegacy
        dualWriteCount++
      }
    }
  }

  this.migrated = sawBridge
  // Derive remaining dual-write entries from what's been written
  this.dualWriteRemaining = sawBridge
    ? Math.max(0, DUAL_WRITE_ENTRIES - dualWriteCount)
    : 0
}
```

**Partial write recovery (SKP-004 addressed)**: Process crashes can leave a partial trailing JSON line in the audit file. The reconstruction algorithm handles this:

```typescript
// In reconstructStateFromLog():
for (const line of lines) {
  try {
    const record = JSON.parse(line)
    // ... normal processing ...
  } catch (parseError) {
    if (i === lines.length - 1) {
      // Last line is corrupt — truncate to previous valid newline
      console.error(`[audit-trail] WARNING: Truncating partial trailing line (${line.length} bytes)`)
      const validContent = content.substring(0, content.lastIndexOf("\n", content.length - line.length - 1) + 1)
      await writeFile(this.filePath, validContent, "utf-8")
      emitMetric("hash_chain_partial_line_recovery", 1)
      break
    } else {
      // Mid-file corruption — cannot recover, enter quarantine
      throw new Error(`[audit-trail] FATAL: Corrupt record at line ${i + 1} (not trailing)`)
    }
  }
}
```

**Boot-time verification**: After reconstruction, run `verifyChain()` on the existing log. If verification fails, the audit trail enters a quarantine mode: appends are still allowed (to avoid blocking requests) but a critical alert is emitted and the `hash_chain_verification_failure` metric fires. This ensures corruption is detected immediately rather than silently propagated.

**Dual-write verifier rules (IMP-010)**: Verifiers encountering a record with `prevHashLegacy` present verify both chain pointers. Records without `prevHashLegacy` after the bridge entry indicate the dual-write period has ended — the verifier switches to protocol-chain-only verification from that point forward. The dual-write count is NOT stored as a separate field; it is derived from the presence/absence of `prevHashLegacy` on post-bridge records, making it restart-safe and unambiguous.

#### 4.5.6 Shared Test Vectors

File: `tests/safety/hash-chain-vectors.json` (NEW test fixture)

```json
{
  "version": 1,
  "description": "Shared hash chain test vectors for finn <-> arrakis cross-system validation",
  "canonicalization": "RFC 8785 (JCS)",
  "hash_algorithm": "SHA-256",
  "separator": "\\n (0x0A)",
  "vectors": [
    {
      "id": "legacy_genesis",
      "format": "legacy",
      "prev_hash": "genesis",
      "record": {
        "seq": 1, "phase": "intent", "action": "self_check", "target": "self",
        "ts": "2026-01-01T00:00:00.000Z", "params": {}, "dryRun": false,
        "jobId": "_test", "runUlid": "_test", "templateId": "_test"
      },
      "expected_hash": "<computed during Sprint 1>"
    },
    {
      "id": "bridge_entry",
      "format": "protocol_v1",
      "prev_hash_legacy": "<from legacy_genesis>",
      "prev_hash_protocol": "genesis",
      "record": { "action": "hash_chain_migration", "target": "audit_trail" },
      "expected_payload_hash": "<computed>",
      "expected_entry_hash": "<computed>"
    },
    {
      "id": "protocol_v1_first",
      "format": "protocol_v1",
      "prev_hash_protocol": "<from bridge_entry>",
      "record": {
        "seq": 3, "phase": "intent", "action": "test_action", "target": "test",
        "ts": "2026-01-01T00:00:02.000Z", "params": {"key": "value"}, "dryRun": false
      },
      "expected_payload_hash": "<computed>",
      "expected_entry_hash": "<computed>"
    },
    {
      "id": "unicode_edge_case",
      "format": "protocol_v1",
      "description": "Verifies RFC 8785 Unicode handling for non-BMP characters",
      "record": { "action": "test", "params": {"emoji": "\ud83d\ude00"} },
      "expected_payload_hash": "<computed>"
    }
  ]
}
```

Hash values will be computed during Sprint 1 implementation using the chosen JCS library and committed as the reference values.

#### 4.5.7 Chain Verification Update

Extend `verifyChain()` to handle both formats using the dual-pointer system:

```typescript
async verifyChain(): Promise<VerifyResult> {
  // ... existing read logic ...

  let expectedPrevHashLegacy = "genesis"
  let expectedPrevHashProtocol = "genesis"
  let sawBridge = false

  for (let i = 0; i < lines.length; i++) {
    const record = JSON.parse(lines[i])
    const format = record.format ?? "legacy"

    if (format === "legacy") {
      // Verify using legacy hash computation (unchanged)
      const canonical = canonicalizeLegacy(record)
      const expectedHash = createHash("sha256").update(canonical).digest("hex")
      if (record.hash !== expectedHash) { /* error */ }
      if (record.prevHash !== expectedPrevHashLegacy) { /* error */ }
      expectedPrevHashLegacy = record.hash
    } else if (format === "protocol_v1") {
      if (!sawBridge && record.action === "hash_chain_migration") {
        sawBridge = true
        // Verify bridge links to legacy chain tip
        if (record.legacy_chain_tip !== expectedPrevHashLegacy) { /* error */ }
      }
      // Verify protocol hash
      const expectedHash = computeProtocolEntryHash(expectedPrevHashProtocol, record)
      if (record.hash !== expectedHash) { /* error */ }
      expectedPrevHashProtocol = record.hash

      // Verify legacy pointer during dual-write
      if (record.prevHashLegacy) {
        const expectedLegacy = computeLegacyHash(expectedPrevHashLegacy, record)
        if (record.prevHashLegacy !== expectedLegacy) { /* error */ }
        expectedPrevHashLegacy = record.prevHashLegacy
      }
    }
  }
}
```

### 4.6 FR-6: Open Task Types (`wire-boundary.ts`, `nft-routing-config.ts`, `pool-enforcement.ts`)

#### 4.6.1 TaskType Branded Type Parser (`wire-boundary.ts`)

Add to `wire-boundary.ts` after the PoolId section. `parseTaskType()` is finn's authoritative constructor for TaskType, regardless of whether upstream provides one.

```typescript
// ---------------------------------------------------------------------------
// TaskType -- namespace:type branded string (v7.11.0)
// ---------------------------------------------------------------------------

import type { TaskType } from "./protocol-types.js"

const TASK_TYPE_PATTERN = /^[a-z0-9_-]+:[a-z0-9_-]+$/
const MAX_TASK_TYPE_LENGTH = 64

/**
 * Parse a raw string into a TaskType branded string.
 * This is the SOLE CONSTRUCTOR for TaskType values in finn.
 *
 * Format: namespace:type (e.g., "finn:conversation", "finn:summarize")
 * Charset: [a-z0-9_-] for both namespace and type
 * Max length: 64 chars total
 * Normalization: lowercase (input is lowercased before validation)
 */
export function parseTaskType(raw: string): TaskType {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("task_type", raw, "empty or non-string value")
  }

  const normalized = raw.toLowerCase()

  if (normalized.length > MAX_TASK_TYPE_LENGTH) {
    throw new WireBoundaryError("task_type", raw, `exceeds maximum length of ${MAX_TASK_TYPE_LENGTH}`)
  }

  if (!TASK_TYPE_PATTERN.test(normalized)) {
    throw new WireBoundaryError("task_type", raw, "must match namespace:type format with charset [a-z0-9_-]")
  }

  // Cast to branded TaskType. If upstream TaskType is a branded string, this
  // is compatible. If it's a plain string alias, the cast is a no-op.
  return normalized as TaskType
}
```

#### 4.6.2 Finn-Native Task Types and Registry

Define finn's registered task types as pre-parsed constants:

```typescript
// In nft-routing-config.ts
import type { TaskType } from "./protocol-types.js"
import { parseTaskType } from "./wire-boundary.js"

// Pre-parsed at module load -- validated by parseTaskType
export const FINN_TASK_TYPES = {
  CONVERSATION:   parseTaskType("finn:conversation"),
  SUMMARIZE:      parseTaskType("finn:summarize"),
  MEMORY_INJECT:  parseTaskType("finn:memory_inject"),
  ANALYSIS:       parseTaskType("finn:analysis"),
  ARCHITECTURE:   parseTaskType("finn:architecture"),
  CODE:           parseTaskType("finn:code"),
} as const

/** Default task type when no routing match exists */
export const DEFAULT_TASK_TYPE: TaskType = FINN_TASK_TYPES.CONVERSATION

// Registry of known task types (finn-native + dynamically loaded)
const KNOWN_TASK_TYPES = new Set<string>(Object.values(FINN_TASK_TYPES))

/** Check if a TaskType is registered (finn-native or dynamically added) */
export function isRegisteredTaskType(taskType: TaskType): boolean {
  return KNOWN_TASK_TYPES.has(taskType as string)
}
```

#### 4.6.3 NFT Routing Config Migration (`nft-routing-config.ts`)

The `TaskRouting` interface is updated to accept `TaskType` branded values:

```typescript
// Legacy mapping: old string literal -> new TaskType
const LEGACY_TASK_TYPE_MAP: Record<string, TaskType> = {
  "chat":          FINN_TASK_TYPES.CONVERSATION,
  "analysis":      FINN_TASK_TYPES.ANALYSIS,
  "architecture":  FINN_TASK_TYPES.ARCHITECTURE,
  "code":          FINN_TASK_TYPES.CODE,
  "default":       FINN_TASK_TYPES.CONVERSATION,
}

/**
 * Resolve legacy NFTTaskType to protocol TaskType.
 * Used during migration period when callers haven't updated.
 */
export function resolveLegacyTaskType(legacy: string): TaskType {
  const mapped = LEGACY_TASK_TYPE_MAP[legacy]
  if (!mapped) {
    throw new WireBoundaryError("task_type", legacy, `unknown legacy task type: "${legacy}"`)
  }
  return mapped
}
```

The `NFTRoutingCache.resolvePool()` method is updated to accept `TaskType`:

```typescript
/**
 * Resolve pool for a personality + task type.
 * Returns null if personality not found OR no routing for this task type.
 * Caller MUST handle null (fail with routing denial, never silently pick a pool).
 */
resolvePool(personalityId: string, taskType: TaskType): PoolId | null {
  const personality = this.personalities.get(personalityId)
  if (!personality) return null

  // Exact match by TaskType string value
  const poolId = personality.task_routing[taskType as string]
  if (poolId) return poolId

  // Explicit default for this personality
  const defaultPool = personality.task_routing[DEFAULT_TASK_TYPE as string]
  if (defaultPool) return defaultPool

  // No routing found -- caller must handle (deny or use tier default)
  return null
}
```

**Key change from v1**: No silent fallback to a hardcoded pool. When `resolvePool` returns `null`, the caller uses tier-based routing (existing `resolvePool` in `tier-bridge.ts`) or denies. This prevents silent misrouting under economic enforcement.

#### 4.6.4 Task Type Gate (`pool-enforcement.ts` — `hounfourAuth` pipeline)

The task type validation gate is placed at a **single authoritative point** in `hounfourAuth()`, immediately after JWT validation and before pool enforcement / economic boundary evaluation.

```typescript
// In hounfourAuth() middleware, after step 1 (JWT validation):

// 1.5. Task Type Gate (when OPEN_TASK_TYPES_ENABLED)
if (OPEN_TASK_TYPES_ENABLED) {
  const rawTaskType = c.req.header("X-Task-Type")
    ?? c.req.query("task_type")
    ?? resolveTaskTypeFromEndpoint(c.req.path)

  let taskType: TaskType
  try {
    taskType = parseTaskType(rawTaskType)
  } catch {
    return c.json({
      error: "Bad Request",
      code: "INVALID_TASK_TYPE",
      message: `Invalid task type format: "${rawTaskType}"`,
    }, 400)
  }

  // Validate task type is known or allowlisted
  if (!isRegisteredTaskType(taskType) && !isTenantAllowlisted(claims.tenant_id, taskType)) {
    const policy = process.env.UNKNOWN_TASK_TYPE_POLICY ?? "deny"
    if (policy === "deny") {
      return c.json({
        error: "Forbidden",
        code: "UNKNOWN_TASK_TYPE",
        denial_code: "unknown_task_type",
        task_type: taskType,
      }, 403)
    }
    // safe_default: allow but flag for restricted routing
    c.set("taskTypeRestricted", true)
  }

  // Set branded TaskType in Hono context for downstream consumption
  c.set("taskType", taskType)
}

// 2. Pool enforcement (existing -- now has taskType in context)
// ...
```

**Invariant**: When `OPEN_TASK_TYPES_ENABLED=true` and `UNKNOWN_TASK_TYPE_POLICY=deny`, unknown task types NEVER reach `selectAuthorizedPool()` or `evaluateBoundary()`. This is enforced by the gate's position before steps 2-5.

**Test requirement**: A test must prove that unknown task types with `policy=deny` return 403 before any routing/enforcement code executes.

#### 4.6.4.1 Tenant Task Type Allowlist (IMP-004)

The `isTenantAllowlisted(tenantId, taskType)` function referenced in the task type gate must have a well-defined data source and trust model:

**Data source**: Environment variable `TENANT_TASK_TYPE_ALLOWLIST` containing a JSON-encoded map:

```typescript
// Parsed once at module load (consistent with flag pattern)
const TENANT_TASK_TYPE_ALLOWLIST: Record<string, string[]> =
  JSON.parse(process.env.TENANT_TASK_TYPE_ALLOWLIST ?? "{}")

/**
 * Check if a specific tenant is allowlisted for an unknown task type.
 * Returns false if allowlist is empty, tenant not listed, or task type not in list.
 * Default-deny: absence = not allowed.
 */
export function isTenantAllowlisted(tenantId: string, taskType: TaskType): boolean {
  const allowed = TENANT_TASK_TYPE_ALLOWLIST[tenantId]
  if (!allowed) return false
  return allowed.includes(taskType as string)
}
```

**Example configuration:**
```json
{
  "tenant_abc123": ["partner:custom_analysis", "partner:summarize_v2"],
  "tenant_def456": ["internal:debug"]
}
```

**Trust model and operational rules:**
- **Default deny**: Empty allowlist or absent tenant = not allowed (no implicit grants)
- **Update path**: Config changes via environment variable, deployed through the same rolling restart mechanism as feature flags
- **Caching**: Parsed once at module load (same lifecycle as flags). No hot-reload.
- **Auditability**: Allowlist grants are logged at INFO level when a request passes via allowlist (not via registry), including `tenant_id`, `task_type`, and timestamp
- **Failure mode**: If `TENANT_TASK_TYPE_ALLOWLIST` contains invalid JSON, parse throws at module load (fail-fast, prevents startup with misconfigured allowlist)

**Future consideration**: If the allowlist grows beyond ~50 entries, migrate to a database-backed lookup with TTL caching. For v7.11.0, the env var approach is sufficient given the expected tenant count.

#### 4.6.5 Legacy Caller Fallback

Deterministic endpoint-to-TaskType mapping for callers that don't provide a task type header:

```typescript
const ENDPOINT_TASK_TYPE_MAP: Record<string, TaskType> = {
  "/api/v1/chat":       FINN_TASK_TYPES.CONVERSATION,
  "/api/v1/summarize":  FINN_TASK_TYPES.SUMMARIZE,
  "/api/v1/memory":     FINN_TASK_TYPES.MEMORY_INJECT,
}

function resolveTaskTypeFromEndpoint(path: string): string {
  const mapped = ENDPOINT_TASK_TYPE_MAP[path]
  return mapped ? (mapped as string) : "finn:conversation"
}
```

#### 4.6.6 Hono Context Type Augmentation (IMP-006)

To preserve the branded `TaskType` guarantee through Hono middleware context (preventing `c.get("taskType")` from returning `unknown` and requiring unsafe casts), add module augmentation:

```typescript
// In types.ts or a dedicated hono-env.d.ts
import type { TaskType } from "./protocol-types.js"

declare module "hono" {
  interface ContextVariableMap {
    taskType: TaskType
    taskTypeRestricted: boolean
  }
}
```

This ensures `c.get("taskType")` returns `TaskType` and `c.set("taskType", value)` requires `TaskType` — compile-time enforcement that the branded type is not accidentally widened to `string` in middleware chains. Without this, every downstream `c.get("taskType")` requires `as TaskType` casts that silently defeat the branded-type boundary.

### 4.7 FR-7: Goodhart Protection

When `ScoringPathLog` is available from upstream, add scoring path logging to the reputation event emission:

```typescript
import type { ScoringPathLog } from "./protocol-types.js"

// In economic boundary evaluation, after computing the trust snapshot:
if (TASK_DIMENSIONAL_REPUTATION_ENABLED && scoringPathLog) {
  console.log(JSON.stringify({
    component: "economic-boundary",
    event: "scoring_path",
    task_type: taskType,
    path: scoringPathLog,
    tenant_hash: hashTenantId(claims.tenant_id),
  }))
}
```

This ensures no single metric can determine enforcement outcome alone -- the scoring path is logged for audit and analysis.

---

## 5. Data Flow: TaskType End-to-End (Branded)

This is the critical data flow defined in PRD FR-6 and grounded in code reality. **All downstream steps use the branded `TaskType`, never raw `string`.**

```
1. INGRESS (wire-boundary.ts)
   |
   |  Request arrives with X-Task-Type header OR endpoint path
   |  parseTaskType("finn:conversation") -> TaskType (branded)
   |  OR resolveTaskTypeFromEndpoint("/api/v1/chat") -> "finn:conversation" -> parseTaskType()
   |
   v
2. TASK TYPE GATE (pool-enforcement.ts, hounfourAuth step 1.5)
   |
   |  Validates: known OR tenant-allowlisted OR policy=safe_default
   |  DENY with code "unknown_task_type" if policy=deny and unknown
   |  Sets: c.set("taskType", taskType: TaskType)
   |
   v
3. REQUEST CONTEXT (types.ts -> RequestMetadata)
   |
   |  metadata.task_type: TaskType = c.get("taskType")
   |
   v
4. POOL ROUTING (nft-routing-config.ts)
   |
   |  NFTRoutingCache.resolvePool(personalityId, taskType: TaskType)
   |  Returns PoolId or null (caller handles)
   |
   v
5. ECONOMIC BOUNDARY (economic-boundary.ts)
   |
   |  evaluateBoundary(claims, budget, peerFeatures, criteria, { taskType: TaskType })
   |  -> buildTrustSnapshot uses cohort-specific score if available
   |  -> Shadow logs cohort vs blended delta
   |
   v
6. POOL ENFORCEMENT (pool-enforcement.ts)
   |
   |  evaluateWithGeometry(policy, context)
   |  -> Native or expression path (local config, wire unchanged)
   |  -> selectAuthorizedPool(tenantContext, taskType)
   |
   v
7. REPUTATION EVENT EMISSION
   |
   |  ReputationEvent includes task_type: TaskType for dimensional scoring
   |  ScoringPathLog logged for Goodhart protection
   |
   v
8. WAL / LEDGER (types.ts -> LedgerEntryV2)
   |
   |  entry.task_type: TaskType
   |  Persisted for attribution and analytics
   |
   v
9. AUDIT TRAIL (audit-trail.ts)
   |
   |  AuditRecord.params.task_type = taskType (serialized as string in JSON)
   |  Hash chain includes task_type in payload hash
```

---

## 6. Migration Strategy

### 6.1 Phase A: Compile-Time Upgrade (Sprint 1)

**Goal**: Upgrade dependency with zero behavior change.

1. Update `package.json` to v7.11.0 exact commit hash
2. Run `npm install` / `npm test` -- fix any compile errors
3. Add new type re-exports to `protocol-types.ts` (with conditional wrappers for missing exports)
4. Verify all expected upstream exports exist; simplify conditional wrappers to direct re-exports where confirmed
5. Remove `EvaluationResultWithDenials` if upstream includes `denial_codes`
6. Add feature flag env vars (all `false`)
7. Compute and commit shared hash chain test vector values
8. Verify all 779+ tests pass

**Rollback**: Revert `package.json` to previous commit hash.

### 6.2 Phase B: Protocol Extension (Sprint 2)

**Goal**: Wire new capabilities with feature flags disabled.

1. Extend `PeerFeatures` + `FEATURE_THRESHOLDS` + dual-strategy detection
2. Add `parseTaskType()` to `wire-boundary.ts`
3. Add `task_type: TaskType` to `RequestMetadata` and `LedgerEntryV2`
4. Extend `ReputationProvider` with optional `getTaskCohortScore(taskType: TaskType)`
5. Modify `evaluateBoundary()` to thread `taskType: TaskType`
6. Implement open task types routing in `nft-routing-config.ts`
7. Add task type gate in `hounfourAuth()` with deny-by-default
8. Add unknown task type denial test (proves gate runs before routing)

**All new code paths gated on feature flags = false -> dead code until enabled.**

### 6.3 Phase C: Internal Optimizations (Sprint 3)

**Goal**: Native enforcement + hash chain migration.

1. Implement `evaluateWithGeometry()` in `pool-enforcement.ts`
2. Install `canonicalize` (RFC 8785 JCS) library
3. Implement versioned envelope + bridge entry in `audit-trail.ts`
4. Validate shared test vectors against JCS library output
5. Add correctness gate for native vs expression (hard CI gate)
6. Add performance benchmark (reported metric, non-blocking)
7. Implement Goodhart protection scoring path logging

---

## 7. Testing Strategy

### 7.1 Compatibility Matrix

| Test Class | v7.9.2 Behavior | v7.11.0 Types | Flags Off | Flags On |
|-----------|-----------------|---------------|-----------|----------|
| Handshake | 5 features detected | 8 features detected | New 3 = false | New 3 = true |
| Economic Boundary | Blended score | Cohort + blended | Blended only | Cohort preferred |
| Pool Enforcement | Expression only | Expression + native | Expression | Native available |
| Audit Trail | Legacy hash chain | Legacy + protocol | Legacy format | Protocol format |
| Task Routing | String literals | TaskType branded | Legacy routing | TaskType routing |

### 7.2 Test Additions by File

| File | New Tests | Focus |
|------|-----------|-------|
| `protocol-handshake.test.ts` | ~20 | Dual-strategy detection (all 3 strategies), version scenarios |
| `economic-boundary.test.ts` | ~25 | Cohort queries, shadow divergence, fallback |
| `pool-enforcement.test.ts` | ~20 | Native geometry correctness, task type gate, unknown denial |
| `wire-boundary.test.ts` | ~15 | parseTaskType validation, edge cases |
| `nft-routing-config.test.ts` | ~15 | TaskType routing, legacy fallback, null handling |
| `audit-trail.test.ts` | ~25 | Bridge entry, dual-write, dual-pointer verification, test vectors |

### 7.3 Cross-System Validation

The shared test vectors in `tests/safety/hash-chain-vectors.json` enable both finn and arrakis to validate identical hash chain computation. Vectors include Unicode edge cases (RFC 8785 Section 3.2.2.2).

### 7.4 Critical Test Requirements

1. **Unknown task type denial gate**: Prove unknown task types with `policy=deny` return 403 before any routing/enforcement code executes
2. **Native enforcement correctness**: Hard CI gate proving identical results for expression and native paths across 1000+ inputs
3. **Hash chain bridge entry**: Verify chain verifies correctly through genesis -> bridge -> protocol_v1 entries
4. **Migration irreversibility**: Verify that toggling `PROTOCOL_HASH_CHAIN_ENABLED=false` after migration throws
5. **Feature flag off = no change**: All tests pass identically with all flags off vs v7.9.2

---

## 8. Security Considerations

### 8.1 Unknown Task Type Denial

Default `deny` policy prevents economic bypass via arbitrary `namespace:type` minting. The `unknown_task_type` denial code is auditable and distinct from other denial reasons. The gate is placed before routing and enforcement in the `hounfourAuth()` pipeline, making bypass impossible when enabled.

### 8.2 Feature Flag Safety

All flags default to `false`. The deployment sequence is:
1. Deploy code with flags off
2. Verify all existing tests pass in production
3. Enable flags one at a time with observability
4. Monitor shadow mode metrics for divergence

Flag changes require process restart (rolling restart via orchestrator). This is consistent with existing deployment patterns.

### 8.3 Hash Chain Integrity

Existing chain entries are NEVER rewritten. The bridge entry creates a deterministic transition point that both legacy and protocol verifiers can validate. The dual-pointer system (`prevHashLegacy` + `prevHashProtocol`) maintains two independently verifiable chains during the dual-write period. Migration is irreversible without a deliberate reverse bridge entry.

**Single-writer deployment constraint (IMP-002)**: The in-process `Mutex` serializes appends within a single Node.js process. It does NOT protect against concurrent writes from multiple instances (e.g., during rolling deploys with a shared audit file on networked storage). The deployment model MUST ensure single-writer semantics for the audit trail:

- **Preferred**: Each instance writes to its own local audit file (instance-scoped path). A periodic merge/aggregation step combines per-instance files for verification.
- **Alternative**: If a shared file is required, use advisory file locks (`flock`) or an append-only database (e.g., SQLite WAL mode with EXCLUSIVE locking) instead of raw `appendFile`.
- **Rolling deploy safety**: During rolling restarts, the old instance must drain and close the audit file before the new instance begins writing. The orchestrator's graceful shutdown (SIGTERM → drain → close) already provides this for single-replica deployments.

If multi-replica writes to a shared file are ever needed, this MUST be revisited with a distributed locking strategy (leader election, compare-and-swap, or an external append-only log service). For the v7.11.0 upgrade scope, the single-writer constraint is sufficient and matches the existing deployment model.

### 8.4 Wire Protocol Invariant

Native enforcement does NOT change the wire protocol. Request/response shapes are identical regardless of local geometry choice. This is validated by correctness equality tests (hard CI gate).

### 8.5 Branded Type Boundary Safety

`TaskType` is branded at the wire boundary (`parseTaskType()`) and propagated through all downstream interfaces as the branded type. Raw strings cannot enter the enforcement/routing/audit pipeline without passing through the parser. This prevents bypasses via unnormalized or unparsed task type values.

---

## 9. Deployment & Rollback

### 9.1 Deployment Order

1. **Sprint 1 merge**: Dependency upgrade + feature flags + test vectors. Zero behavior change.
2. **Sprint 2 merge**: Protocol extensions. All gated by flags = false.
3. **Sprint 3 merge**: Internal optimizations. All gated by flags = false.
4. **Feature enablement**: One flag at a time, monitored in shadow mode first.

### 9.2 Rollback Strategies

| Scenario | Action | Downtime |
|----------|--------|----------|
| Compile errors from upgrade | Revert `package.json` to v7.9.2 pin | None (pre-deploy) |
| Runtime regression with flags off | Revert the merge commit | Rolling restart |
| Regression with specific flag on | Set flag to `false` + rolling restart | Rolling restart (~30s) |
| Hash chain corruption (pre-migration) | Set `PROTOCOL_HASH_CHAIN_ENABLED=false` + restart | Rolling restart |
| Hash chain corruption (post-migration) | Write reverse bridge entry (manual) + restart | Manual intervention |

**Important**: Flag rollback is NOT instant. It requires a rolling restart because flags are read at module load. The rolling restart takes ~30s in the current deployment model.

### 9.3 Monitoring

| Metric | Alert Threshold |
|--------|-----------------|
| `hounfour_reputation_cohort_vs_blended_delta` | Delta > 30 for > 5% of requests |
| `economic_boundary_unknown_task_type_denial` | Spike > 10x baseline |
| `hash_chain_verification_failure` | Any failure |
| `native_enforcement_result_divergence` | Any divergence from expression path |
| `handshake_detection_method_unknown` | > 50% of features detected as unknown |

---

## 10. Technical Risks & Mitigations

| Risk | Severity | Mitigation | Detection |
|------|----------|------------|-----------|
| v7.11.0 type changes break compile | Medium | Exact commit pin + CHANGELOG review + conditional import wrappers | CI compile check |
| v7.11.0 missing expected exports | Medium | Conditional import strategy with local fallbacks (Section 4.1) | Sprint 1 compile check |
| Cohort score diverges wildly from blended | Medium | Shadow mode + delta metric + threshold alert | Observability |
| RFC 8785 canonicalization differs from existing | Medium | Use dedicated JCS library (not handrolled) + cross-system test vectors | Test vectors |
| Native enforcement produces different results | High | Hard CI gate: correctness equivalence assertion | Pre-merge gate |
| CI benchmark flakiness blocks merges | Medium | Performance is non-blocking reported metric; only correctness is hard gate | Separate perf job |
| Unknown task type flood | Medium | Deny-by-default + gate before routing | Spike alert |
| Bridge entry corrupts chain | High | Never rewrite history + dual pointers + verification test | Chain verify on boot |
| Feature flag rollback fails (not instant) | Low | Document: requires rolling restart (~30s) | Ops runbook |
| Toggle hash chain off after migration | High | Runtime check throws; irreversible without reverse bridge | appendRecord() guard |
