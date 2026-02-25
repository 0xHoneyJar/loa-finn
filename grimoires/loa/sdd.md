# SDD: Hounfour v8.2.0 Upgrade — Commons Protocol + ModelPerformance

> **Version**: 1.1.0
> **Date**: 2026-02-25
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-033
> **PRD**: `grimoires/loa/prd.md` v1.1.0 (GPT-5.2 APPROVED iteration 2)

---

## 1. Overview

This SDD describes the technical design for upgrading `@0xhoneyjar/loa-hounfour` from v7.9.2 to v8.2.0 in loa-finn. The upgrade crosses a major version boundary with three breaking changes (commons module, required `actor_id`, `ModelPerformanceEvent` variant) — none causing compile-time breaks but requiring runtime behavioral changes.

**Design principles:**
- Centralized re-export hub (`protocol-types.ts`) remains the single import point
- Backward-compatible handshake during rollout grace period
- Explicit mapping boundaries at protocol-to-application type narrowing
- Schema-validated output contracts for downstream consumers (Dixie)

---

## 2. Component Design

### 2.1 Dependency Bump

**File**: `package.json`

```diff
- "@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#ff8c16b899b5bbebb9bf1a5e3f9e791342b49bea",
+ "@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#v8.2.0",
```

After bump: `pnpm install`, verify `CONTRACT_VERSION` export resolves to `"8.2.0"`, verify `@0xhoneyjar/loa-hounfour/commons` import path resolves.

### 2.2 Protocol Handshake — Compatibility Window

**File**: `src/hounfour/protocol-handshake.ts`

**Current behavior**: `finnValidateCompatibility()` uses semver comparison with `FINN_MIN_SUPPORTED = "4.0.0"`. The v4.0.0 floor was set during the arrakis v4.6.0 transition era (cycle-012). With finn moving to v8.2.0, the v4-v6 era is over.

**Changes**:

1. **Bump `FINN_MIN_SUPPORTED`** from `"4.0.0"` to `"7.0.0"`:

```typescript
export const FINN_MIN_SUPPORTED = "7.0.0" as const
```

This creates a precise compatibility window:
- `remote = "8.2.0"` → compatible (same major, same minor)
- `remote = "8.0.0"` → compatible with warning (minor mismatch)
- `remote = "7.9.2"` → compatible with warning (cross-major, above min 7.0.0) — **grace period**
- `remote = "7.0.0"` → compatible with warning (cross-major, above min)
- `remote = "6.0.0"` → **incompatible** (below FINN_MIN_SUPPORTED 7.0.0) — **AC4 satisfied**
- `remote = "4.6.0"` → **incompatible** (below min)
- `remote = "9.0.0"` → **incompatible** (future major)

2. **New feature thresholds** for v8.x capabilities:

```typescript
// Add to FEATURE_THRESHOLDS
commonsModule:        { major: 8, minor: 0, patch: 0 },
governanceActorId:    { major: 8, minor: 1, patch: 0 },
modelPerformance:     { major: 8, minor: 2, patch: 0 },
```

3. **Extend PeerFeatures**:

```typescript
/** Remote supports commons module governance schemas (v8.0.0+). */
commonsModule: boolean
/** Remote requires actor_id on GovernanceMutation (v8.1.0+). */
governanceActorId: boolean
/** Remote supports ModelPerformanceEvent reputation variant (v8.2.0+). */
modelPerformance: boolean
```

**Decision**: Bumping `FINN_MIN_SUPPORTED` to `"7.0.0"` is the correct action because: (a) no known peers run v4-v6 anymore, (b) AC4 requires rejecting v6.0.0, (c) the cross-major warning in `finnValidateCompatibility()` naturally provides v7.9.2 grace. The grace window is `[7.0.0, 8.x]`. It closes when `FINN_MIN_SUPPORTED` is bumped to `"8.0.0"` in a future cycle.

### 2.3 Protocol Types Hub — New Re-exports

**File**: `src/hounfour/protocol-types.ts`

Add re-exports for v8.x types. Grouped by subpackage:

```typescript
// === v8.0.0: Commons Module ===
export {
  GovernedCreditsSchema,
  ConservationLawSchema,
  AuditTrailSchema,
  StateMachineConfigSchema,
  GovernanceMutationSchema,
  DynamicContractSchema,
  GovernanceErrorSchema,
} from "@0xhoneyjar/loa-hounfour/commons"
export type {
  GovernedCredits,
  ConservationLaw,
  AuditTrail,
  StateMachineConfig,
  GovernanceMutation,
  DynamicContract,
  GovernanceError,
} from "@0xhoneyjar/loa-hounfour/commons"

// === v8.2.0: Governance Additions ===
export { QualityObservationSchema } from "@0xhoneyjar/loa-hounfour/governance"
export type { QualityObservation } from "@0xhoneyjar/loa-hounfour/governance"

// === v8.2.0: ReputationEvent with ModelPerformance variant ===
export { ModelPerformanceEventSchema } from "@0xhoneyjar/loa-hounfour/governance"
export type { ModelPerformanceEvent, ReputationEvent } from "@0xhoneyjar/loa-hounfour/governance"
```

**Implementation protocol — exports verification** (addresses speculative re-export risk):

1. After `pnpm install`, run an import surface test before writing re-exports:
   ```bash
   node --input-type=module -e "import('@0xhoneyjar/loa-hounfour/commons').then(m => console.log('commons:', Object.keys(m).join(', ')))"
   node --input-type=module -e "import('@0xhoneyjar/loa-hounfour/governance').then(m => console.log('governance:', Object.keys(m).join(', ')))"
   ```
2. Derive the re-export list from the actual named exports — do not copy the speculative list above verbatim.
3. Add a compile-time import surface test (`tests/finn/protocol-imports.test.ts`) that imports every re-exported symbol from `src/hounfour/protocol-types.ts` and asserts they are defined. This test satisfies AC5 and catches export map regressions.

### 2.4 ReputationEvent Normalizer

**New file**: `src/hounfour/reputation-event-normalizer.ts`

```typescript
import { Value } from "@sinclair/typebox/value"
import type { ReputationEvent } from "./protocol-types.js"
import { ReputationEventSchema } from "./protocol-types.js"

export interface NormalizedReputationEvent {
  type: string
  recognized: true
  metered: boolean
}

/**
 * Validate and normalize a ReputationEvent.
 *
 * Step 1: Runtime schema validation (catches discriminant/shape mismatches).
 * Step 2: Exhaustive switch on verified discriminant.
 *
 * The discriminant field and literal values are verified against
 * ReputationEventSchema at runtime, not assumed from documentation.
 */
export function normalizeReputationEvent(event: unknown): NormalizedReputationEvent {
  // Runtime validation — catches shape/discriminant mismatches
  if (!Value.Check(ReputationEventSchema, event)) {
    const errors = [...Value.Errors(ReputationEventSchema, event)]
    throw new Error(`Invalid ReputationEvent: ${errors.map(e => e.message).join(", ")}`)
  }

  const validated = event as ReputationEvent
  switch (validated.type) {
    case "quality_signal":
      return { type: "quality_signal", recognized: true, metered: true }
    case "task_completion":
      return { type: "task_completion", recognized: true, metered: true }
    case "peer_review":
      return { type: "peer_review", recognized: true, metered: true }
    case "model_performance":
      return { type: "model_performance", recognized: true, metered: true }
    default: {
      // If schema validation passes but switch doesn't match, the schema
      // has variants we haven't coded for — fail loudly.
      throw new Error(`Unhandled ReputationEvent type after schema validation: ${(validated as { type: string }).type}`)
    }
  }
}
```

**Implementation note**: The discriminant field (`type`) and literal values (`quality_signal`, etc.) are documented in MIGRATION.md but MUST be verified against the actual `ReputationEventSchema` export after v8.2.0 install. The `Value.Check()` gate at the boundary ensures runtime safety regardless of whether the documented values are accurate.

**Integration point**: Not wired into any existing pipeline (no existing ReputationEvent routing). This function exists for:
1. Runtime safety — `Value.Check()` at boundary prevents silent misclassification
2. Compile-time safety — adding a 5th variant that passes schema but not switch triggers the default throw
3. Test anchor — AC8 unit test exercises all 4 variants + one invalid input

### 2.5 QualityObservation Adoption

**File**: `src/hounfour/quality-gate-scorer.ts`

The current `score()` method returns `Promise<number>`. Refactoring approach:

1. **Add `scoreToObservation()`** method returning `QualityObservation`:

```typescript
import { Value } from "@sinclair/typebox/value"
import { QualityObservationSchema } from "./protocol-types.js"
import type { QualityObservation } from "./protocol-types.js"

async scoreToObservation(result: CompletionResult): Promise<QualityObservation> {
  const startMs = Date.now()
  const rawScore = await this.score(result)
  const latencyMs = Date.now() - startMs

  // Clamp score to [0, 1] — guard against gate script returning out-of-range values
  const clampedScore = Math.max(0, Math.min(1, Number.isFinite(rawScore) ? rawScore : 0))

  // Build observation — fields derived from QualityObservationSchema after install.
  // The field list below is illustrative; implementation MUST inspect the actual
  // schema to discover required/optional fields and constraints.
  const observation: QualityObservation = {
    score: clampedScore,
    evaluator: "quality-gates-sh",
    latency_ms: Math.round(latencyMs),
    // Additional fields populated after schema inspection:
    // dimensions, task_type, model_id, timestamp_ms, source — as required by schema
  }

  if (!Value.Check(QualityObservationSchema, observation)) {
    const errors = [...Value.Errors(QualityObservationSchema, observation)]
    throw new Error(`QualityObservation schema validation failed: ${errors.map(e => e.message).join(", ")}`)
  }

  return observation
}
```

**Implementation protocol — schema-led field discovery**:

1. After `pnpm install`, inspect `QualityObservationSchema` to discover all required and optional fields:
   ```bash
   node --input-type=module -e "import('@0xhoneyjar/loa-hounfour/governance').then(m => console.log(JSON.stringify(m.QualityObservationSchema, null, 2)))"
   ```
2. Populate all required fields in `scoreToObservation()`. The code above is illustrative — adapt to actual schema.
3. Unit test MUST include: (a) valid output passes `Value.Check()`, (b) `Value.Errors()` returns empty array, (c) negative test with out-of-range score (e.g., `NaN`, `-1`, `2.0`) asserts the clamp/guard works.

2. **Keep `score()` unchanged** — backward compatible for `ScorerFunction` consumers.

3. **Keep `toScorerFunction()` unchanged** — ensemble still gets `Promise<number>`.

**Decision**: Additive refactor. `scoreToObservation()` wraps `score()` and adds schema validation. No existing callers change. New callers (future Dixie integration) use `scoreToObservation()`.

### 2.6 TaskType Mapping Layer

**File**: `src/hounfour/nft-routing-config.ts`

**Current**: Local `NFTTaskType = "chat" | "analysis" | "architecture" | "code" | "default"` used throughout.

**Design**:

1. **Rename local union** to `NFTRoutingKey` (internal implementation detail):

```typescript
export type NFTRoutingKey = "chat" | "analysis" | "architecture" | "code" | "default"
```

2. **Add two mapping functions** — typed (compile-time safe) and wire (runtime safe):

```typescript
import type { TaskType } from "./protocol-types.js"

const KNOWN_ROUTING_KEYS = new Set<string>(["chat", "analysis", "architecture", "code", "default"])

/**
 * Type-safe mapping for verified TaskType values.
 * Exhaustive switch with never — compile error if protocol adds new variants.
 */
export function mapTaskTypeToRoutingKey(taskType: TaskType): NFTRoutingKey {
  switch (taskType) {
    case "chat":
    case "analysis":
    case "architecture":
    case "code":
      return taskType
    case "unspecified":
      return "default"
    default: {
      const _exhaustive: never = taskType
      throw new Error(`Unhandled TaskType: ${_exhaustive}`)
    }
  }
}

/**
 * Wire-boundary mapping for untrusted string input.
 * Runtime guard — warns and falls back to "default" for unknown values.
 * 'unspecified' is handled first as an expected protocol value (no warning).
 */
export function mapUnknownTaskTypeToRoutingKey(taskType: unknown): NFTRoutingKey {
  if (taskType === "unspecified") return "default"
  if (typeof taskType === "string" && KNOWN_ROUTING_KEYS.has(taskType)) {
    return taskType as NFTRoutingKey
  }
  console.warn(`[nft-routing] Unknown task type "${String(taskType)}", routing to default`)
  return "default"
}
```

3. **`NFTRoutingCache.resolvePool()` accepts `NFTRoutingKey` only** — mapping happens at the boundary:

```typescript
// Signature unchanged — accepts NFTRoutingKey (the internal type)
resolvePool(personalityId: string, taskType: NFTRoutingKey): PoolId | null {
  // ... existing logic, no casts needed
}
```

**File**: `src/hounfour/tier-bridge.ts`

The mapping happens at the protocol boundary in `resolvePool()`, before passing to NFT routing:

```typescript
import { mapUnknownTaskTypeToRoutingKey } from "./nft-routing-config.js"

// taskType comes from external input (string), map at the boundary
const routingKey = taskType ? mapUnknownTaskTypeToRoutingKey(taskType) : "default"
const preferredPool = nftPreferences?.[routingKey]
```

**Decision**: Two-function split creates a clean narrowing boundary. `mapTaskTypeToRoutingKey()` is compile-time exhaustive for internal callers with verified `TaskType`. `mapUnknownTaskTypeToRoutingKey()` handles untrusted wire input at `tier-bridge.ts`. `NFTRoutingCache.resolvePool()` accepts only `NFTRoutingKey` — no union types, no casts.

### 2.7 Conformance Vector Tests

**File**: `tests/finn/conformance-vectors.test.ts`

**Changes**:

1. **Add manifest-match assertion** alongside baseline:

```typescript
expect(schemas.length).toBeGreaterThanOrEqual(202)  // Regression baseline
expect(schemas.length).toBe(manifest.schemas.length)  // Exact manifest match
console.log(`[conformance-vectors] Discovered ${schemas.length} schemas from manifest`)
```

2. **Add new required categories** if v8.2.0 introduces them (e.g., `commons`). Verify against installed manifest. Add `commons` pattern to `classifySchema()`:

```typescript
if (/commons|governed|conservation|audit.trail|state.machine|governance.error/i.test(name)) return "commons"
```

---

## 3. Data Flow

### 3.1 TaskType Narrowing Flow

```
Protocol TaskType (external)
  │ 'chat' | 'analysis' | 'architecture' | 'code' | 'unspecified' | ...
  │
  ▼
mapTaskTypeToRoutingKey()     ← narrowing boundary
  │ NFTRoutingKey: 'chat' | 'analysis' | 'architecture' | 'code' | 'default'
  │
  ▼
NFTRoutingCache.resolvePool()
  │
  ▼
PoolId
```

### 3.2 QualityObservation Flow

```
CompletionResult.content
  │
  ▼
QualityGateScorer.score()     ← existing, returns number
  │
  ▼
QualityGateScorer.scoreToObservation()  ← new wrapper
  │ QualityObservation { score, evaluator, latency_ms }
  │
  ▼
Value.Check(QualityObservationSchema)  ← runtime validation
  │
  ▼
Quality governance pipeline (cycle-031)
  │
  ▼
[Future] Dixie ModelPerformanceEvent emission
```

### 3.3 Handshake Compatibility Flow

```
Boot time
  │
  ▼
validateProtocolAtBoot()
  │ CONTRACT_VERSION = "8.2.0"
  │ FINN_MIN_SUPPORTED = "7.0.0"
  │
  ├── remote = "8.2.0" → compatible (same major, same minor)
  ├── remote = "8.0.0" → compatible with warning (minor mismatch)
  ├── remote = "7.9.2" → compatible with warning (cross-major, above min)
  ├── remote = "7.0.0" → compatible with warning (cross-major, at min)
  ├── remote = "6.0.0" → incompatible (below FINN_MIN_SUPPORTED 7.0.0)
  ├── remote = "4.6.0" → incompatible (below min)
  └── remote = "9.0.0" → incompatible (future major)
```

---

## 4. File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `package.json` | Modify | Bump hounfour to v8.2.0 tag |
| `src/hounfour/protocol-types.ts` | Modify | Add new re-exports from commons, governance (derived from install) |
| `src/hounfour/protocol-handshake.ts` | Modify | Add 3 feature thresholds, extend PeerFeatures |
| `src/hounfour/reputation-event-normalizer.ts` | **New** | Exhaustive ReputationEvent normalizer |
| `src/hounfour/quality-gate-scorer.ts` | Modify | Add `scoreToObservation()` method |
| `src/hounfour/nft-routing-config.ts` | Modify | Rename NFTTaskType → NFTRoutingKey, add mapping function |
| `src/hounfour/tier-bridge.ts` | Modify | Use mapping function in resolvePool NFT path |
| `tests/finn/conformance-vectors.test.ts` | Modify | Add manifest-match assertion, log count |
| `tests/finn/interop-handshake.test.ts` | Modify | Add v8.2.0 + v7.9.2 grace + v6.0.0 reject cases |
| `tests/finn/reputation-event-normalizer.test.ts` | **New** | All 4 variants + invalid input + exhaustiveness test |
| `tests/finn/quality-observation.test.ts` | **New** | Schema validation + negative tests (NaN, out-of-range) |
| `tests/finn/protocol-imports.test.ts` | **New** | Import surface test — all re-exports resolve (AC5) |
| `tests/finn/nft-routing.test.ts` | Modify | Add 'unspecified' TaskType routing test |

**New files**: 2 source, 3 test
**Modified files**: 8 (4 source, 4 test)

---

## 5. Testing Strategy

| Test | Type | Verifies |
|------|------|----------|
| All existing tests pass | Regression | AC2: zero regression |
| `conformance-vectors.test.ts` | Conformance | AC3: manifest match, ≥202 baseline |
| `interop-handshake.test.ts` (new cases) | Integration | AC4: v8.2.0 accept, v7.9.2 grace, v6.0.0 reject |
| Import compilation test | Unit | AC5: new type re-exports resolve |
| `quality-observation.test.ts` | Unit | AC6: `scoreToObservation()` output passes `Value.Check()` |
| `nft-routing.test.ts` (new case) | Unit | AC7: `resolvePool(tier, 'unspecified')` → default pool |
| `reputation-event-normalizer.test.ts` | Unit | AC8: all 4 variants handled, never exhaustiveness |

---

## 6. Risks & Mitigations (SDD-Level)

| Risk | Mitigation |
|------|------------|
| v8.2.0 `exports` map doesn't include `./commons` | Verify immediately after `pnpm install` with a bare import test |
| `QualityObservationSchema` fields differ from assumption | Read schema source after install; adjust `scoreToObservation()` fields |
| `ReputationEvent` type name or discriminant differs | Verify exact type export name from `governance` subpackage |
| `TaskType` union members changed in v8.x (beyond adding `'unspecified'`) | Typed `mapTaskTypeToRoutingKey()` is compile-time exhaustive — new variants cause `never` error. Wire `mapUnknownTaskTypeToRoutingKey()` handles arbitrary strings at runtime. |
| `parseSemver()` behavior changes in v8.2.0 | Unlikely (utility function), but handshake tests cover both directions |

---

## 7. Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Bump `FINN_MIN_SUPPORTED` from `"4.0.0"` to `"7.0.0"` | The v4-v6 era is over (no known peers). AC4 requires rejecting v6.0.0. Cross-major warning provides v7.9.2 grace. |
| Additive `scoreToObservation()` instead of changing `score()` return type | Backward compatible — `ScorerFunction` callers (ensemble) are unchanged. |
| New file for reputation normalizer instead of adding to economic-boundary.ts | Separation of concerns — economic boundary handles trust x capital, normalizer handles event type dispatch. |
| Rename `NFTTaskType` to `NFTRoutingKey` | Clarifies that the internal union is a routing implementation detail, not the protocol type. Protocol `TaskType` is the input type. |
| No configurable grace period timer | Cross-major warning is already built into handshake. Grace ends when `FINN_MIN_SUPPORTED` is bumped — a deliberate manual action in a future cycle. |
