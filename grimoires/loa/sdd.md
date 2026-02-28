# SDD: Hounfour v8.3.0 Upgrade + CI Standardization

**Status:** Draft
**Author:** Jani + Claude
**Date:** 2026-02-28
**Cycle:** 038
**PRD Reference:** `grimoires/loa/prd.md` (Cycle-038)
**Branch:** `feature/hounfour-v830-upgrade`

---

## 1. Executive Summary

This SDD designs the integration of hounfour v8.3.0 canonical exports into finn's existing architecture. The upgrade follows finn's established barrel re-export pattern through `src/hounfour/protocol-types.ts` — all new imports flow through this single file. The design is structured around three integration tiers matching the PRD's scope classification:

1. **API surface adoption** (Sprint 1-2): Pin bump, type replacement, test-vector-verified function adoption
2. **Behavioral adoption** (Sprint 3): Feature-flagged dampening, warn-only contract validation, type-level GovernedResource
3. **CI housekeeping** (Sprint 1): SHA alignment across 4 actions in 2 workflows

No new modules, services, or infrastructure. All changes are within existing files following existing patterns.

**Export verification:** All hounfour v8.3.0 export names and module paths were verified against commit `c29337e` during PRD creation (see PRD §2 "Source of Truth — Verified v8.3.0 Exports"). The PRD passed GPT review iteration 2 with explicit confirmation that export verification resolved the fabrication concern. Sprint 1's first task after pin bump is `pnpm tsc --noEmit` which provides compile-time proof that all import paths resolve.

**Decision Context:** Strategic choices (consumer contract scope, dampening default-off, GovernedBilling as conformance proof) are documented in [`grimoires/loa/a2a/cycle-038-decisions.md`](grimoires/loa/a2a/cycle-038-decisions.md).

---

## 2. System Architecture Overview

### 2.1 Current Module Topology (Relevant to Upgrade)

```
┌──────────────────────────────────────────────────────┐
│                     @0xhoneyjar/loa-hounfour         │
│  /economy  /commons  /integrity  /governance         │
│  /constraints                                        │
└──────────────┬───────────────────────────────────────┘
               │  (git SHA pin in package.json)
               ▼
┌──────────────────────────────────────────────────────┐
│  src/hounfour/protocol-types.ts  (barrel re-export)  │
│  ════════════════════════════════════════════════════ │
│  232 lines, ~80 current exports from /economy,       │
│  /commons, /governance                               │
│  +30 new re-exports from v8.3.0                      │
└──────────────┬───────────────────────────────────────┘
               │  (imported by all finn modules)
               ▼
┌──────────────────────────────────────────────────────┐
│  Consuming Modules                                   │
│  ├── src/x402/types.ts         (x402 schemas)        │
│  ├── src/hounfour/typebox-formats.ts (date-time)     │
│  ├── src/safety/audit-trail.ts (advisory lock, hash) │
│  ├── src/cron/store.ts         (audit sidecar)       │
│  ├── src/hounfour/audit/dynamo-audit.ts (hash chain) │
│  └── src/hounfour/goodhart/quality-signal.ts (EMA)   │
└──────────────────────────────────────────────────────┘
```

### 2.2 Design Principle: No New Abstractions

Every change in this cycle modifies an existing file or adds a test file. No new modules, no new abstractions, no new patterns. The protocol-types barrel is the only integration point for re-exports. Behavioral changes are gated by env vars using patterns already established in the codebase (`PROTOCOL_HASH_CHAIN_ENABLED`, `X402_CHAIN_ID`, etc.).

---

## 3. Component Design

### 3.1 Pin Bump (FR-1)

**Files modified:** `package.json`, `pnpm-lock.yaml`

**Change:** Single-line SHA replacement in the git dependency string.

```
- "github:0xHoneyJar/loa-hounfour#33d2b710ec939711568c596503f9d7b61575eeb3"
+ "github:0xHoneyJar/loa-hounfour#c29337e305005c5de56f8796ba391fb42108b5c5"
```

**Verification sequence:**
1. `pnpm install` — lockfile regeneration
2. `pnpm why @0xhoneyjar/loa-hounfour` — confirm resolved commit
3. `pnpm tsc --noEmit` — type compatibility
4. `pnpm test:finn` — runtime compatibility
5. `scripts/build-hounfour-dist.sh` runs automatically via `postinstall`

**Rollback:** Revert `package.json` line, `pnpm install`, verify `pnpm test:finn` passes.

### 3.2 Protocol Types Barrel Extension (FR-2, FR-4, FR-5, FR-7, FR-8, FR-9)

**File modified:** `src/hounfour/protocol-types.ts`

**Design:** Append new export blocks at the end of the file, grouped by source module with version comments matching the existing pattern. The file already has section headers like `// ── v8.2.0 Governance Additions ──` — we add `// ── v8.3.0 Pre-Launch Hardening ──`.

**New export groups:**

```typescript
// ── v8.3.0 Pre-Launch Hardening (Cycle 038) ──────────────────────

// x402 Payment Schemas (economy/x402-payment.ts)
export {
  X402QuoteSchema, X402PaymentProofSchema, X402SettlementStatusSchema,
  X402SettlementSchema, X402ErrorCodeSchema,
  type X402Quote, type X402PaymentProof, type X402SettlementStatus,
  type X402Settlement, type X402ErrorCode,
} from '@0xhoneyjar/loa-hounfour/economy'

// Chain-Bound Hash (commons/chain-bound-hash.ts)
export {
  computeChainBoundHash, validateDomainTag, ChainBoundHashError,
  type AuditEntryHashInput as ChainBoundHashInput,
} from '@0xhoneyjar/loa-hounfour/commons'

// Audit Timestamp (commons/audit-timestamp.ts)
export {
  validateAuditTimestamp, type AuditTimestampResult,
} from '@0xhoneyjar/loa-hounfour/commons'

// Advisory Lock (commons/advisory-lock.ts)
export { computeAdvisoryLockKey } from '@0xhoneyjar/loa-hounfour/commons'

// Feedback Dampening (commons/feedback-dampening.ts)
export {
  FeedbackDampeningConfigSchema, computeDampenedScore,
  FEEDBACK_DAMPENING_ALPHA_MIN, FEEDBACK_DAMPENING_ALPHA_MAX,
  DAMPENING_RAMP_SAMPLES, DEFAULT_PSEUDO_COUNT,
  type FeedbackDampeningConfig,
} from '@0xhoneyjar/loa-hounfour/commons'

// GovernedResource Runtime (commons/governed-resource-runtime.ts)
export {
  TransitionResultSchema, InvariantResultSchema, MutationContextSchema,
  GovernedResourceBase,
  type TransitionResult, type InvariantResult, type MutationContext,
  type GovernedResource,
} from '@0xhoneyjar/loa-hounfour/commons'

// Consumer Contract (integrity/consumer-contract.ts)
export {
  ConsumerContractEntrypointSchema, ConsumerContractSchema,
  validateConsumerContract, computeContractChecksum,
  type ConsumerContractEntrypoint, type ConsumerContract,
  type ContractValidationResult,
} from '@0xhoneyjar/loa-hounfour/integrity'

// Tier-to-Reputation Mapping (governance/tier-reputation-map.ts)
export { mapTierToReputationState } from '@0xhoneyjar/loa-hounfour/governance'

// Constraint Conditionals (constraints/types.ts + evaluator.ts)
export {
  type ConstraintCondition,
  resolveConditionalExpression,
} from '@0xhoneyjar/loa-hounfour/constraints'
```

**Name collision check:** `AuditEntryHashInput` is already exported from `/commons` as part of the v8.0.0 audit trail block. The chain-bound hash module re-exports the same type. We alias the chain-bound import as `ChainBoundHashInput` to avoid ambiguity.

### 3.3 x402 Type Replacement (FR-2)

**File modified:** `src/x402/types.ts`

**Current state:** File contains local interfaces `X402Quote`, `PaymentProof`, `SettlementResult` alongside finn-specific types (`X402Error`, `ChainConfig`, `EIP3009Authorization`, USDC lookups, constants).

**Design:**

1. **Remove** local interface definitions for `X402Quote`, `PaymentProof`, `SettlementResult`
2. **Add** re-imports from `protocol-types.ts`:
   ```typescript
   import {
     type X402Quote, type X402PaymentProof, type X402Settlement,
   } from '../hounfour/protocol-types.js'
   ```
3. **Re-export** with backward-compatible aliases where names differ:
   ```typescript
   // Backward compatibility: local 'PaymentProof' → canonical 'X402PaymentProof'
   export type PaymentProof = X402PaymentProof
   // Backward compatibility: local 'SettlementResult' → canonical 'X402Settlement'
   export type SettlementResult = X402Settlement
   export type { X402Quote }
   ```
4. **Keep** all finn-specific types unchanged: `X402Error`, `ChainConfig`, `EIP3009Authorization`, `X402Receipt`, constants, USDC address lookups

**Why type aliases instead of find-replace:** The local names `PaymentProof` and `SettlementResult` are used across multiple consumer files. Type aliases preserve backward compatibility with zero consumer changes. The aliases can be deprecated in a future cycle.

### 3.4 Audit Timestamp Replacement (FR-3)

**File modified:** `src/hounfour/typebox-formats.ts`

**Current state:**
```typescript
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
```
Registered as the `date-time` format validator in TypeBox's FormatRegistry.

**Design:**

1. Import `validateAuditTimestamp` from `protocol-types.ts`
2. Replace the regex-based validator with a function call:
   ```typescript
   FormatRegistry.Set('date-time', (value) => {
     const result = validateAuditTimestamp(value)
     return result.valid
   })
   ```
3. Remove `ISO_8601_RE` constant
4. `assertFormatsRegistered()` remains unchanged — it only checks registry presence

**Compatibility analysis:** The canonical validator is strictly a superset of the regex:
- Regex: syntactic pattern match (YYYY-MM-DDThh:mm:ss with tz)
- Canonical: syntactic match + month/day range validation + leap second handling
- Risk: canonical rejects edge cases the regex accepts (e.g., `2026-02-30T00:00:00Z`)
- Mitigation: fixture test with existing timestamps (AC9-AC10)

**Consumer impact:** `assertFormatsRegistered()` is called in `src/cron/store.ts` constructor. Format registration happens once at module load. No per-call performance change.

### 3.5 Chain-Bound Hash Integration (FR-4)

**Files modified:** `src/cron/store.ts`

**Current state:**
- `store.ts` uses `computeAuditEntryHash()` (v8.0.0) for audit sidecar entries
- `dynamo-audit.ts` uses manual `SHA-256(prevHash + ':' + payloadHash + ':' + timestamp)` for DynamoDB chain
- `audit-trail.ts` has its own protocol v1 hash format (separate concern, not modified)

**Design — Dual-Format Verification:**

The chain-bound hash (`computeChainBoundHash`) adds domain tag binding to the existing `computeAuditEntryHash`. Backward compatibility requires verifying both formats.

**Hash function input specifications:**

| Algorithm | Function | Inputs | Chain-linked? |
|-----------|----------|--------|---------------|
| `legacyV1` | `computeAuditEntryHash(input: AuditEntryHashInput)` | `{ entry_id, timestamp, event_type, payload, previous_hash, hash_domain_tag }` | Yes — `previous_hash` is part of input |
| `chainBoundV1` | `computeChainBoundHash(entry: AuditEntryHashInput, domainTag: string, previousHash: string)` | Same entry fields + explicit domainTag + previousHash params | Yes — `previousHash` is a separate parameter bound into hash |

Both algorithms are chain-linked via `previous_hash`/`previousHash`. The legacy function includes `previous_hash` as a field in the `AuditEntryHashInput` struct. The chain-bound function takes it as a separate parameter for explicit domain binding.

**Genesis hash:** The first entry in any chain uses `AUDIT_TRAIL_GENESIS_HASH` (already exported from hounfour `/commons`, value: `'0'.repeat(64)`) as `previousHash`. This constant is already used in `store.ts` for legacy chain initialization.

**Domain tag canonicalization:** Domain tags are computed by `buildDomainTag(schemaId, contractVersion)` (already in store.ts). Format: `{schemaId}:{contractVersion}` where `schemaId` is the filename stem and `contractVersion` defaults to `'8.2.0'`. After upgrade, new entries use `contractVersion: '8.3.0'`. Domain tags are deterministic — same inputs produce same string across all environments.

**3.5.1 store.ts audit sidecar changes:**

```typescript
interface AuditEntryMetadata {
  // ... existing fields
  hashAlg?: 'legacyV1' | 'chainBoundV1'  // New field
}
```

- **Write path:** New entries use `computeChainBoundHash(entryInput, domainTag, prevHash)` with `hashAlg: 'chainBoundV1'`. Genesis: `prevHash = AUDIT_TRAIL_GENESIS_HASH`.
- **Read/verify path:** Check `hashAlg` field:
  - Missing or `'legacyV1'` → verify with `computeAuditEntryHash(entryInput)` where `entryInput.previous_hash` comes from the prior entry
  - `'chainBoundV1'` → verify with `computeChainBoundHash(entryInput, domainTag, prevHash)` where `prevHash` is the prior entry's `entry_hash`
- Domain tag: Already computed via `buildDomainTag()` (existing in store.ts)

**3.5.2 dynamo-audit.ts — no change this cycle:**

DynamoDB audit uses a custom hash formula (`prevHash + ':' + payloadHash + ':' + timestamp`) that is independent of the hounfour commons hash functions. Migrating this to chain-bound hash is out of scope — it would require a DynamoDB data migration strategy.

**3.5.3 audit-trail.ts — no change this cycle:**

The safety audit trail has its own protocol v1 envelope format with JCS canonicalization. This is a separate hash chain from the cron store sidecar. The `PROTOCOL_HASH_CHAIN_ENABLED` feature flag already gates protocol v1 adoption. No interaction with chain-bound hash.

### 3.6 Advisory Lock Key Replacement (FR-5)

**File modified:** TBD — depends on where local advisory lock key computation exists.

**Current state:** `FileLock` in `audit-trail.ts` uses PID-based file locking (not advisory locks). Advisory lock key computation (database-level PostgreSQL `pg_advisory_lock`) may exist elsewhere. Implementation must search for local lock key computation across: `audit-trail.ts`, `store.ts`, `billing/`, `drizzle/`.

**Signature:** `computeAdvisoryLockKey(domainTag: string) => number`
- Input: domain tag string (e.g., from `buildDomainTag()`)
- Output: signed 32-bit integer via FNV-1a hash
- Deterministic: same input always produces same output

**Design — test-vector-first approach with mandatory adoption:**

1. **Locate** local advisory lock key computation (grep for `pg_advisory`, `advisory_lock`, or numeric hash of domain tags)
2. **Extract** >=3 test vectors: `{ domainTag, expectedKey }` from current implementation
3. **Compare** canonical `computeAdvisoryLockKey()` output against vectors
4. **Expected outcome (identical):** Both implementations target FNV-1a 32-bit signed. Replace local computation, add re-export to `protocol-types.ts`. This is the expected path.
5. **Fallback (different):** If canonical function produces different keys despite both targeting FNV-1a:
   - **Phase A (this cycle):** Implement dual-try lock acquisition behind `FINN_CANONICAL_LOCK_KEY` flag (default: `false`). When flag is `false`, acquire lock with local key. When flag is `true`, acquire lock with canonical key. Log both keys for comparison at startup.
   - **Phase B (next deploy):** After verifying logs show both keys are stable, flip flag to `true` in staging. Monitor for lock contention.
   - **Phase C (subsequent cycle):** Remove local implementation and flag.
   - Document mismatch details and dual-try plan in `NOTES.md`.

**Why this approach:** Advisory lock key mismatches between service instances during rolling deployment cause lock contention failures. The dual-try mechanism ensures adoption happens (FR-5 is met) while preventing split-brain during the transition window. The PRD's AC17 safety requirement ("if different, do NOT replace") is satisfied by the feature flag defaulting to `false` — the local key is used until explicitly switched.

### 3.7 Feedback Dampening (FR-6) — Feature-Flagged

**File modified:** `src/hounfour/goodhart/quality-signal.ts`

**Current state:** `feedQualitySignal()` applies exploration dampening via `score *= explorationFeedbackWeight`. The EMA update via `config.decay.updateEMA()` is the scoring mechanism. Composite quality score uses weights: 0.3 latency, 0.4 error, 0.3 content.

**Canonical function signature analysis:**

```typescript
computeDampenedScore(
  oldScore: number | null,  // Previous EMA value (null for first observation)
  newScore: number,         // Raw composite quality score [0, 1]
  sampleCount: number,      // Number of observations for this key so far
  config?: FeedbackDampeningConfig  // Optional: alpha bounds, ramp samples, pseudo count
): number  // Returns dampened score [0, 1]
```

The canonical function implements sample-count-aware EMA dampening: alpha ramps from `FEEDBACK_DAMPENING_ALPHA_MIN` (conservative, low weight on new data) to `FEEDBACK_DAMPENING_ALPHA_MAX` (responsive) as `sampleCount` increases through `DAMPENING_RAMP_SAMPLES`. This replaces finn's current exploration dampening (`score *= explorationFeedbackWeight`) which is a fixed multiplier, not sample-count-aware.

**Integration point:** The canonical function replaces the EMA alpha calculation within `feedQualitySignal()`, NOT the composite quality scoring (latency/error/content weights). The composite score is finn-local logic that produces `newScore`. The canonical dampening controls how `newScore` blends with the prior EMA value `oldScore`.

**Design:**

```typescript
const USE_CANONICAL_DAMPENING = process.env.FINN_CANONICAL_DAMPENING === 'true'
let dampeningConfigValid = true  // Set at startup

// At startup — config validation (non-blocking):
const config: FeedbackDampeningConfig | undefined = loadDampeningConfig()
if (config) {
  dampeningConfigValid = Value.Check(FeedbackDampeningConfigSchema, config)
  if (!dampeningConfigValid) {
    logger.warn('dampening_config_invalid', { config })
    // Falls back to local regardless of flag
  }
}

// In feedQualitySignal(), after composite score is computed:
function applyDampening(oldScore: number | null, newScore: number, sampleCount: number): number {
  if (USE_CANONICAL_DAMPENING && dampeningConfigValid) {
    const canonical = computeDampenedScore(oldScore, newScore, sampleCount, config)
    const local = localEMAUpdate(oldScore, newScore, sampleCount)
    if (Math.abs(canonical - local) > 0.001) {
      logger.info('dampening_delta', { canonical, local, delta: canonical - local, sampleCount })
    }
    return canonical
  }
  return localEMAUpdate(oldScore, newScore, sampleCount)
}
```

**Config validation side effects:** `dampeningConfigValid` is set once at startup. If validation fails, the flag is permanently false for this process lifetime — no config validation code runs in the hot path. The `FeedbackDampeningConfigSchema` check uses TypeBox `Value.Check` which is pure (no side effects beyond boolean return).

### 3.8 GovernedResource Type Conformance (FR-7)

**File modified:** One finn governed state transition module (TBD during implementation)

**Design:** Type-level only. No runtime changes.

```typescript
import type { GovernedResource } from '../hounfour/protocol-types.js'

interface FinnResourceState { /* existing fields */ }

class FinnResourceManager implements GovernedResource<FinnResourceState> {
  // TypeScript compiler enforces interface conformance
  // Existing methods already satisfy the interface
}
```

**Selection criteria:** Module with existing state transition logic. Candidates: `src/billing/state-machine.ts` (strongest), `src/cron/runner.ts`, `src/credits/entitlement.ts`.

**Verification:** `pnpm tsc --noEmit` — compiler error if interface is not satisfied.

### 3.9 Consumer Contract Validation (FR-8) — Warn-Only

**File modified:** `src/index.ts` or `src/gateway/server.ts` (startup path)

**Design:** Startup-time validation, non-blocking.

**Contract definition:** The `ConsumerContract` declares which hounfour exports finn actually consumes. The `version` field is finn's own consumed-API version (matching the hounfour version finn was built against), not finn's package version.

```typescript
import {
  validateConsumerContract, computeContractChecksum,
  type ConsumerContract,
} from './hounfour/protocol-types.js'

// Inline code constant — finn's declaration of consumed hounfour exports
const FINN_CONTRACT: ConsumerContract = {
  name: 'finn',
  version: '8.3.0',  // hounfour API version finn targets
  entrypoints: [
    { module: '/economy', symbols: ['microUSDC', 'readMicroUSDC', 'BillingEntrySchema', 'X402QuoteSchema', /* ... */] },
    { module: '/commons', symbols: ['computeAuditEntryHash', 'buildDomainTag', 'computeChainBoundHash', 'validateAuditTimestamp', 'computeAdvisoryLockKey', /* ... */] },
    { module: '/integrity', symbols: ['validateConsumerContract', 'computeContractChecksum'] },
    { module: '/governance', symbols: ['mapTierToReputationState'] },
    { module: '/constraints', symbols: ['resolveConditionalExpression'] },
  ],
}

// Export map: built from protocol-types.ts actual imports at module evaluation time.
// This is a Record<string, string[]> mapping module paths to exported symbol names.
// Constructed once at startup by introspecting the barrel re-exports.
const FINN_EXPORT_MAP: Record<string, string[]> = {
  '/economy': Object.keys(await import('@0xhoneyjar/loa-hounfour/economy')),
  '/commons': Object.keys(await import('@0xhoneyjar/loa-hounfour/commons')),
  '/integrity': Object.keys(await import('@0xhoneyjar/loa-hounfour/integrity')),
  '/governance': Object.keys(await import('@0xhoneyjar/loa-hounfour/governance')),
  '/constraints': Object.keys(await import('@0xhoneyjar/loa-hounfour/constraints')),
}

// At startup (after imports resolved):
const result = validateConsumerContract(FINN_CONTRACT, FINN_EXPORT_MAP)
if (!result.valid) {
  console.warn('[contract-validation] Consumer contract mismatch:', result.errors)
  // Do NOT throw or exit — warn-only mode
}
```

**Note:** The `FINN_EXPORT_MAP` construction uses dynamic imports to introspect actual available exports. If dynamic imports are not supported in the startup path (ESM top-level await is available per tsconfig target ES2024), an alternative is a static object manually listing known exports. Implementation will determine the simplest approach that passes the unit test (AC27).

**Contract source:** Inline code constant. Not fetched externally. Updated when finn's hounfour consumption changes.

### 3.10 CI Action SHA Alignment (FR-10)

**Files modified:** `.github/workflows/deploy-staging.yml`, `.github/workflows/oracle.yml`

**Design:** Direct SHA replacement. No functional changes.

| File | Line(s) | Current | Target | Action |
|------|---------|---------|--------|--------|
| deploy-staging.yml | 44, 77 | v4.2.2 SHA | `34e114876b0b11c390a56381ad16ebd13914f8d5` (v4.3.1) | checkout |
| deploy-staging.yml | 162 | v1.7.1 SHA | `9666dc9a3bf790a3a7a3a3ce7d1a8600100b0ad2` (v1.7.2) | ecs-render |
| deploy-staging.yml | 169 | v2.3.1 SHA (different) | `3e7310352de28fdb25b55df7a1dfd15a5ddeb369` (v2.3.1) | ecs-deploy |
| oracle.yml | 91 | v4.6.2 SHA | `4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1` (v4.6.1) | upload-artifact |

---

## 4. Data Architecture

### 4.1 Audit Entry hashAlg Field

New optional field in audit sidecar entries (`.audit.jsonl` files managed by `src/cron/store.ts`):

```typescript
{
  // ... existing AuditEntry fields (entry_id, timestamp, event_type, etc.)
  hashAlg?: 'legacyV1' | 'chainBoundV1'
}
```

**Migration:** No data migration required. Missing `hashAlg` implies `legacyV1`. New entries written with `'chainBoundV1'`. Existing entries remain valid and verifiable.

**Verification logic:**
```typescript
function verifyEntry(entry: AuditEntry, prevHash: string, domainTag: string): boolean {
  if (!entry.hashAlg || entry.hashAlg === 'legacyV1') {
    // Legacy: previous_hash is INSIDE the AuditEntryHashInput struct
    const input: AuditEntryHashInput = {
      entry_id: entry.entry_id,
      timestamp: entry.timestamp,
      event_type: entry.event_type,
      payload: entry.payload,
      previous_hash: prevHash,       // Chain linkage via struct field
      hash_domain_tag: domainTag,
    }
    return computeAuditEntryHash(input) === entry.entry_hash
  }
  if (entry.hashAlg === 'chainBoundV1') {
    // Chain-bound: previousHash is a separate parameter for explicit binding
    const input: AuditEntryHashInput = {
      entry_id: entry.entry_id,
      timestamp: entry.timestamp,
      event_type: entry.event_type,
      payload: entry.payload,
      previous_hash: prevHash,
      hash_domain_tag: domainTag,
    }
    return computeChainBoundHash(input, domainTag, prevHash) === entry.entry_hash
  }
  return false // Unknown algorithm version
}
```

### 4.2 No Schema Changes

- No database migrations (DynamoDB schema unchanged, PostgreSQL unchanged)
- No new configuration files
- One new env var: `FINN_CANONICAL_DAMPENING` (boolean, default `false`)

---

## 5. Testing Strategy

### 5.1 New Test Files

| File | Purpose | FR |
|------|---------|-----|
| `tests/finn/hounfour/audit-timestamp-fixtures.json` | Valid/invalid timestamp corpus (>=20 valid, >=10 invalid) | FR-3 |
| `tests/finn/hounfour/chain-bound-hash-vectors.test.ts` | Deterministic 3-entry hash sequence test | FR-4 |
| `tests/finn/hounfour/advisory-lock-vectors.test.ts` | Lock key test vectors (>=3 vectors) | FR-5 |

### 5.2 Timestamp Fixture Design (FR-3)

JSON file with `valid` and `invalid` arrays. Valid timestamps extracted from existing audit trail entries where possible. Invalid timestamps cover: impossible dates (Feb 30), out-of-range months (13), out-of-range hours (25), missing timezone, date-only strings, garbage input.

**Test command:** Add `"test:audit-fixtures": "vitest run tests/finn/hounfour/audit-timestamp-fixtures.test.ts"` to package.json.

### 5.3 Hash Vector Test Design (FR-4)

Vitest test that:
1. Creates fixed test entries with known field values (hardcoded entry_id, timestamp, event_type, payload)
2. Computes legacy hash via `computeAuditEntryHash(input)` with `previous_hash: AUDIT_TRAIL_GENESIS_HASH` — asserts expected hex
3. Computes chain-bound hash via `computeChainBoundHash(input, domainTag, AUDIT_TRAIL_GENESIS_HASH)` — asserts expected hex
4. Builds 3-entry chain (genesis → A → B) for both algorithms, verifying:
   - Each entry's hash depends on the previous entry's hash (chain linkage)
   - Changing `prevHash` in any entry produces a DIFFERENT hash (tamper detection)
   - Legacy and chain-bound produce DIFFERENT hashes for the same entry (algorithm isolation)
5. Domain tag for test: `buildDomainTag('test-vector-store', '8.3.0')`

### 5.4 Advisory Lock Vector Test Design (FR-5)

Vitest test with >=3 vectors extracted from current implementation. Each vector: `{ domainTag: string, expectedKey: number }`. All must pass with canonical `computeAdvisoryLockKey()`.

### 5.5 Existing Test Suites (Must Pass Unmodified)

| Suite | Command | Expected |
|-------|---------|----------|
| Core finn | `pnpm test:finn` | 27 pass, 0 fail |
| Billing | `pnpm test:billing` | All pass |
| Gateway | `pnpm test:gateway` | All pass |
| X402 | `pnpm test:x402` | All pass |
| Type check | `pnpm tsc --noEmit` | 0 errors |

### 5.6 Dampening Comparison Test (FR-6)

Vitest test with fixed numeric scenarios verifying:
- **Boundary cases:** `sampleCount=0` (first observation), `sampleCount=1`, `sampleCount=DAMPENING_RAMP_SAMPLES` (alpha fully ramped), `sampleCount=DAMPENING_RAMP_SAMPLES+100` (past ramp)
- **Numeric assertions:** For each scenario, assert `computeDampenedScore(oldScore, newScore, sampleCount)` equals expected numeric value (hardcoded in test, computed once during test authoring)
- **Flag disabled:** Verify local EMA update called, canonical function NOT called
- **Flag enabled:** Verify canonical `computeDampenedScore` called with correct `(oldScore, newScore, sampleCount, config)` args
- **Comparison logging:** When flag enabled and delta > 0.001, verify `dampening_delta` log emitted with `{ canonical, local, delta, sampleCount }`
- **Config validation failure:** Verify that invalid config causes fallback to local regardless of flag

---

## 6. Security Considerations

### 6.1 Supply Chain

- Git SHA pin (not semver tag) — immutable commit reference
- `postinstall` builds hounfour from source (`scripts/build-hounfour-dist.sh`)
- Lockfile integrity verified by pnpm
- No new external dependencies

### 6.2 Hash Chain Integrity

- Dual-format verification prevents hash algorithm confusion
- `hashAlg` field is append-only (new entries only, never backfilled)
- Legacy entries verified with legacy function — no recomputation
- `verifyAuditTrailIntegrity()` validates entire chain

### 6.3 Feature Flag Security

- `FINN_CANONICAL_DAMPENING` — boolean env var, default false
- No new API endpoints or user-facing surfaces
- Consumer contract validation is read-only, non-blocking

---

## 7. Deployment & Rollback

### 7.1 Deployment

Standard flow: merge → CI (typecheck + test + Docker + Trivy) → ECR → ECS rolling update with circuit breaker.

### 7.2 Rollback Scenarios

| Scenario | Detection | Action |
|----------|-----------|--------|
| Type incompatibility | `pnpm tsc --noEmit` fails pre-merge | Revert package.json SHA |
| Test regression | CI test failure | Revert package.json SHA |
| Runtime failure | ECS health check | ECS circuit breaker auto-rollback |
| Dampening anomaly | Comparison logging | `FINN_CANONICAL_DAMPENING=false` (no redeploy) |

---

## 8. Sprint Architecture Mapping

### Sprint 1: Pin Bump + Surface Adoption + CI (P0/P1)

| Task | Files | Section |
|------|-------|---------|
| Pin bump to v8.3.0 | `package.json` | §3.1 |
| Extend protocol-types barrel | `protocol-types.ts` | §3.2 |
| Replace x402 local types | `src/x402/types.ts` | §3.3 |
| Re-export governance + constraints | `protocol-types.ts` | §3.2 |
| CI SHA alignment | 2 workflow files | §3.10 |
| Verify typecheck + all tests pass | — | §5.5 |

### Sprint 2: Test-Vector Adoption (P1)

| Task | Files | Section |
|------|-------|---------|
| Audit timestamp replacement + fixtures | `typebox-formats.ts`, test file | §3.4, §5.2 |
| Chain-bound hash integration + vectors | `store.ts`, test file | §3.5, §5.3 |
| Advisory lock replacement + vectors | TBD source, test file | §3.6, §5.4 |

### Sprint 3: Behavioral Adoption (P2)

| Task | Files | Section |
|------|-------|---------|
| Feature-flagged dampening + tests | `quality-signal.ts`, test file | §3.7, §5.6 |
| GovernedResource type annotation | TBD state module | §3.8 |
| Consumer contract warn-only validation | startup path | §3.9 |

---

## 9. Decision Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Type aliases for x402 backward compat | Zero consumer changes, aliases deprecatable later | Find-replace across all consumers (higher risk, more churn) |
| `hashAlg` field for dual-format | Explicit versioning, no ambiguity | Heuristic detection based on hash length (fragile) |
| Feature flag for dampening | Decouples adoption from validation | Shadow mode running both paths always (higher complexity) |
| Warn-only contract validation | No risk to service availability | Skip entirely (loses early warning) |
| No dynamo-audit.ts changes | Custom hash formula is separate concern | Migrate to chain-bound (requires DynamoDB data migration) |
| No audit-trail.ts protocol v1 changes | Already has its own migration path via `PROTOCOL_HASH_CHAIN_ENABLED` | Integrate chain-bound into protocol v1 (conflicting migration chains) |
