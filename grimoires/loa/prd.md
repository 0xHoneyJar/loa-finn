# PRD: Hounfour v8.3.0 Upgrade + CI Standardization

**Status:** Draft
**Author:** Jani + Claude
**Date:** 2026-02-28
**Cycle:** 038
**References:** [Hounfour PR #39](https://github.com/0xHoneyJar/loa-hounfour/pull/39) (MERGED) · [Freeside Issue #108](https://github.com/0xHoneyJar/loa-freeside/issues/108) · [Launch Readiness #66](https://github.com/0xHoneyJar/loa-finn/issues/66)
**Flatline Review:** 3-model (Opus + GPT-5.3 + Gemini 2.5) — 4 HIGH_CONSENSUS integrated, 3 BLOCKERS addressed

---

## 1. Problem Statement

Hounfour PR #39 merged on 2026-02-28, releasing v8.3.0 with pre-launch protocol hardening across 8 feature requirements. Finn is pinned to v8.2.0 (commit `33d2b710ec939711568c596503f9d7b61575eeb3`). The v8.3.0 release exports canonical implementations for patterns finn currently implements locally — x402 payment schemas, audit timestamp validation, advisory lock key computation, and chain-bound hashing. It also introduces new capabilities finn should adopt: feedback dampening, consumer contract validation, and GovernedResource runtime interfaces.

Separately, finn's 11 CI workflows have minor action version drift across 4 actions. These are low-risk but should be standardized for supply chain hygiene.

**Scope classification:** This cycle contains two categories of work:
1. **API surface adoption** (FRs 1-5, 9): Purely additive — importing new exports, replacing local implementations with type-compatible canonical versions. No behavioral change.
2. **Behavioral adoption** (FRs 6-8): Intentional behavioral changes — adopting canonical dampening, governance interfaces, and contract validation that may alter runtime behavior. These require gated rollout.
3. **CI housekeeping** (FR-10): Version alignment only — no behavioral changes.

> **Note on FR-7 (GovernedResource):** Classified as "behavioral adoption" in scope heading for visibility, but scoped to **type-level conformance only** this cycle. No runtime behavior change. Reclassified here per Flatline IMP-002.

> Source: Hounfour v8.3.0 tag at commit `c29337e305005c5de56f8796ba391fb42108b5c5`, finn `package.json:33`, CI workflow audit

---

## 2. Source of Truth — Verified v8.3.0 Exports

All export names and paths below were verified against hounfour tag v8.3.0 (commit `c29337e`). Source files are listed for traceability. Hounfour FR numbers refer to the hounfour v8.3.0 release FRs, not this PRD's FRs.

### From `@0xhoneyjar/loa-hounfour/economy` (hounfour FR-1: x402-payment.ts)

```typescript
import {
  X402QuoteSchema, X402PaymentProofSchema, X402SettlementStatusSchema,
  X402SettlementSchema, X402ErrorCodeSchema,
  type X402Quote, type X402PaymentProof, type X402SettlementStatus,
  type X402Settlement, type X402ErrorCode,
} from '@0xhoneyjar/loa-hounfour/economy'
```

### From `@0xhoneyjar/loa-hounfour/commons` (hounfour FRs 3, 5, 8)

```typescript
// hounfour FR-5: chain-bound-hash.ts
import {
  computeChainBoundHash, validateDomainTag, ChainBoundHashError,
  type AuditEntryHashInput as ChainBoundHashInput,
} from '@0xhoneyjar/loa-hounfour/commons'

// hounfour FR-5: audit-timestamp.ts
import {
  validateAuditTimestamp, type AuditTimestampResult,
} from '@0xhoneyjar/loa-hounfour/commons'

// hounfour FR-5: advisory-lock.ts
import { computeAdvisoryLockKey } from '@0xhoneyjar/loa-hounfour/commons'

// hounfour FR-3: feedback-dampening.ts
import {
  FeedbackDampeningConfigSchema, computeDampenedScore,
  FEEDBACK_DAMPENING_ALPHA_MIN, FEEDBACK_DAMPENING_ALPHA_MAX,
  DAMPENING_RAMP_SAMPLES, DEFAULT_PSEUDO_COUNT,
  type FeedbackDampeningConfig,
} from '@0xhoneyjar/loa-hounfour/commons'

// hounfour FR-8: governed-resource-runtime.ts
import {
  TransitionResultSchema, InvariantResultSchema, MutationContextSchema,
  GovernedResourceBase,
  type TransitionResult, type InvariantResult, type MutationContext,
  type GovernedResource,
} from '@0xhoneyjar/loa-hounfour/commons'
```

### From `@0xhoneyjar/loa-hounfour/integrity` (hounfour FR-4: consumer-contract.ts)

```typescript
import {
  ConsumerContractEntrypointSchema, ConsumerContractSchema,
  validateConsumerContract, computeContractChecksum,
  type ConsumerContractEntrypoint, type ConsumerContract,
  type ContractValidationResult,
} from '@0xhoneyjar/loa-hounfour/integrity'
```

### From `@0xhoneyjar/loa-hounfour/governance` (hounfour FR-2: tier-reputation-map.ts)

```typescript
import { mapTierToReputationState } from '@0xhoneyjar/loa-hounfour/governance'
```

### From `@0xhoneyjar/loa-hounfour/constraints` (hounfour FR-6: types.ts + evaluator.ts)

```typescript
import {
  type ConstraintCondition,
  resolveConditionalExpression,
} from '@0xhoneyjar/loa-hounfour/constraints'
```

---

## 3. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Bump hounfour to v8.3.0 | `pnpm why @0xhoneyjar/loa-hounfour` shows v8.3.0 commit | Commit `c29337e` in lockfile |
| Replace local x402 types | `src/x402/types.ts` local interfaces removed | 0 local x402 schema definitions |
| Adopt audit timestamp validation | `typebox-formats.ts` local regex removed | `validateAuditTimestamp()` used |
| Verify chain-bound hash compat | Test suite with known hash vectors passes, dual-format verification | 0 regressions |
| Adopt advisory lock key | Local key computation replaced | `computeAdvisoryLockKey()` used |
| Adopt feedback dampening (gated) | Quality pipeline uses canonical dampening behind flag | Feature flag `FINN_CANONICAL_DAMPENING` |
| CI action version alignment | All workflows use fleet-standard SHAs | 0 version drift |
| All existing tests pass | `pnpm test` green | 0 regressions |

---

## 4. Scope

### In Scope

#### FR-1: Pin Bump (P0)

Update `package.json` hounfour dependency from:
```json
"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#33d2b710ec939711568c596503f9d7b61575eeb3"
```
to:
```json
"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#c29337e305005c5de56f8796ba391fb42108b5c5"
```

Run `pnpm install`, verify lockfile resolves correctly. v8.3.0 is API-additive (MINOR release, no removed exports).

**Rollback procedure:** If runtime-only incompatibilities emerge after pin bump (types check but runtime fails):
1. Revert `package.json` to the v8.2.0 SHA
2. Run `pnpm install` to restore lockfile
3. Run `pnpm test` to verify clean revert
4. Document the incompatibility in `NOTES.md` blockers section

> Flatline IMP-001: Rollback procedure added (avg score 885).

**Supply-chain note:** Hounfour is consumed via git commit SHA pin, not a registry package. This is the established pattern across the ecosystem (finn, dixie, freeside all use the same mechanism). The hounfour repo has branch protection enabled on `main`. Full registry publishing with signed provenance is tracked as a future ecosystem improvement but is out of scope for this cycle.

> Flatline SKP-001: Supply-chain risk acknowledged. Registry migration deferred — ecosystem-wide concern, not finn-specific.

**Acceptance Criteria:**
- AC1: `package.json` contains the exact v8.3.0 dependency string above
- AC2: `pnpm install` succeeds; `pnpm why @0xhoneyjar/loa-hounfour` output shows commit `c29337e`
- AC3: `pnpm test` passes with 0 failures and 0 new warnings

#### FR-2: x402 Schema Canonicalization (P0)

Replace local x402 interfaces in `src/x402/types.ts` with canonical schemas from `@0xhoneyjar/loa-hounfour/economy` (source: `src/economy/x402-payment.ts`).

| Local Interface (src/x402/types.ts) | Canonical Export |
|-------------------------------------|-----------------|
| `X402Quote` (local interface) | `X402QuoteSchema` / `type X402Quote` |
| `PaymentProof` (local interface) | `X402PaymentProofSchema` / `type X402PaymentProof` |
| `SettlementResult` (local interface) | `X402SettlementSchema` / `type X402Settlement` |

Keep finn-specific types in `src/x402/types.ts`: `X402Error`, `ChainConfig`, `EIP3009Authorization`, USDC address lookups. Re-export canonical types from `src/hounfour/protocol-types.ts`.

**Acceptance Criteria:**
- AC4: Local `X402Quote`, `PaymentProof`, `SettlementResult` interface definitions removed from `src/x402/types.ts`
- AC5: All x402 consumers compile successfully with canonical types (verified by `pnpm tsc --noEmit`)
- AC6: `pnpm test` passes with 0 failures — no test modifications needed (types are structurally compatible)

#### FR-3: Audit Timestamp Validation (P1)

Replace the local ISO 8601 regex in `src/hounfour/typebox-formats.ts`:
```typescript
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
```
with `validateAuditTimestamp()` from `@0xhoneyjar/loa-hounfour/commons` (source: `src/commons/audit-timestamp.ts`). The canonical validator returns `{ valid: boolean; normalized: string; error?: string }`.

**Compatibility requirement:** Create a test fixture file (`tests/finn/hounfour/audit-timestamp-fixtures.json`) with timestamps extracted from existing audit trail entries. Run both local regex and canonical validator against fixtures. Any existing valid timestamp that the canonical validator rejects requires a documented exception or data migration.

**Acceptance Criteria:**
- AC7: `typebox-formats.ts` uses `validateAuditTimestamp()` for TypeBox `date-time` format registration
- AC8: Local `ISO_8601_RE` regex removed
- AC9: Timestamp fixture file contains >= 20 valid and >= 10 invalid timestamps; `pnpm test:audit-fixtures` passes
- AC10: If canonical validator rejects any existing valid timestamp, a migration decision is documented in `NOTES.md` blockers section

#### FR-4: Chain-Bound Hash Adoption (P1)

Verify finn's audit hash chain (`src/cron/store.ts`, `src/hounfour/audit/dynamo-audit.ts`) is compatible with `computeChainBoundHash()` from `@0xhoneyjar/loa-hounfour/commons` (source: `src/commons/chain-bound-hash.ts`). Signature: `computeChainBoundHash(entry: AuditEntryHashInput, domainTag: string, previousHash: string): string`.

Finn already imports `computeAuditEntryHash()` from v8.2.0. The chain-bound variant adds domain tag binding. Adopt `validateDomainTag()` where finn constructs domain tags via `buildDomainTag()`.

**Compatibility requirements:**
1. Existing stored hashes must remain verifiable (chain-bound hash must not invalidate entries written with `computeAuditEntryHash`)
2. New entries may use `computeChainBoundHash()` if domain tag is available
3. Create a deterministic test that computes hashes for a known 3-entry sequence and matches expected values

**Dual-format verification strategy:** Introduce a `hashAlg` field in audit entry metadata to distinguish legacy entries (computed with `computeAuditEntryHash`) from new entries (computed with `computeChainBoundHash`). Verification logic must detect the algorithm version and apply the correct hash function. Entries without `hashAlg` are assumed legacy. This ensures historical audit trails remain verifiable after the write-path transitions to chain-bound hashes.

> Flatline SKP-006: Hash versioning and dual-format verification added (severity 860).

**Acceptance Criteria:**
- AC11: `computeChainBoundHash` and `validateDomainTag` re-exported from `protocol-types.ts`
- AC12: Hash vector test: compute chain for `[genesis, entry-A, entry-B]` with fixed inputs; assert specific expected hash values for both legacy and chain-bound algorithms
- AC13: Existing `verifyAuditTrailIntegrity()` tests pass without modification
- AC14: Verification logic correctly validates both legacy (no `hashAlg`) and chain-bound (`hashAlg: 'chainBoundV1'`) entries

#### FR-5: Advisory Lock Key (P1)

Replace local advisory lock key computation in `src/safety/audit-trail.ts` with `computeAdvisoryLockKey()` from `@0xhoneyjar/loa-hounfour/commons` (source: `src/commons/advisory-lock.ts`). Signature: `(domainTag: string) => number` — returns signed 32-bit integer via FNV-1a hash.

**Test vector requirement:** Extract 3 lock key test vectors from current implementation: `{ domainTag: string, expectedKey: number }`. Verify canonical function produces identical keys. If keys differ, do NOT replace — document incompatibility in `NOTES.md`.

**Acceptance Criteria:**
- AC15: `computeAdvisoryLockKey()` re-exported from `protocol-types.ts`
- AC16: Test file contains >= 3 lock key vectors; all pass with canonical function
- AC17: If canonical function produces different keys for same inputs, replacement is blocked and documented

#### FR-6: Feedback Dampening (P2) — BEHAVIORAL CHANGE

Adopt `computeDampenedScore()` from `@0xhoneyjar/loa-hounfour/commons` (source: `src/commons/feedback-dampening.ts`). Signature: `(oldScore: number | null, newScore: number, sampleCount: number, config?: FeedbackDampeningConfig) => number`. This is an **intentional behavioral change** — the canonical dampening algorithm may produce different scores than finn's current local implementation.

**Rollout strategy:** Gate behind `FINN_CANONICAL_DAMPENING` env var (default: `false`). When enabled, use canonical `computeDampenedScore()`; when disabled, use existing local logic. Log both values for comparison. Remove flag after validation on staging.

**Promotion gate:** The feature flag may be promoted to `true` (and local logic removed) when:
- Staging comparison logs show max absolute score delta < 0.05 across >= 100 routing decisions
- No quality signal anomalies observed in staging metrics for >= 24 hours

> Flatline IMP-003: Quantitative promotion gate added (avg score 850).

**Config validation failure behavior:** If `FeedbackDampeningConfigSchema` validation fails at startup, log warning and fall back to local implementation (do not block service startup).

**Acceptance Criteria:**
- AC18: Feature flag `FINN_CANONICAL_DAMPENING` controls which dampening function is used
- AC19: When flag is disabled, behavior is identical to current implementation (0 diff)
- AC20: When flag is enabled, canonical function is called; both local and canonical scores are logged for comparison
- AC21: Dampening config validated against `FeedbackDampeningConfigSchema` at startup; invalid config falls back to local implementation with warning log
- AC22: Promotion criteria documented in `NOTES.md` (delta threshold + observation window)

#### FR-7: GovernedResource Runtime Interface (P2) — TYPE-LEVEL ONLY

Adopt `GovernedResource<T>` type interface from `@0xhoneyjar/loa-hounfour/commons` (source: `src/commons/governed-resource-runtime.ts`). This is **type-level conformance only** for this cycle — finn's governed state transitions will implement the `GovernedResource<T>` generic interface, verified by the TypeScript compiler. Runtime schema validation via `TransitionResultSchema`/`InvariantResultSchema` is deferred to a future cycle.

> Flatline IMP-002: Reclassified from "BEHAVIORAL CHANGE" to "TYPE-LEVEL ONLY" — no runtime behavior change in this cycle (avg score 835).

**Acceptance Criteria:**
- AC23: `GovernedResource<T>`, `GovernedResourceBase`, `TransitionResult`, `InvariantResult`, `MutationContext` types re-exported from `protocol-types.ts`
- AC24: At least one finn governed state transition implements `GovernedResource<T>` — verified by `pnpm tsc --noEmit` (compiler enforces interface conformance)
- AC25: No runtime schema validation added in this cycle (deferred)

#### FR-8: Consumer Contract Validation (P2) — BEHAVIORAL CHANGE

Adopt `ConsumerContractSchema` and `validateConsumerContract()` from `@0xhoneyjar/loa-hounfour/integrity` (source: `src/integrity/consumer-contract.ts`). Signature: `validateConsumerContract(contract: ConsumerContract, exportMap: Record<string, string[]>): ContractValidationResult`.

**Rollout strategy:** Warn-only mode. Contract validation runs at service startup with `console.warn()` on failure — does NOT block startup or reject requests. Fail-closed enforcement deferred until downstream services (dixie, freeside) have conforming contracts.

**Acceptance Criteria:**
- AC26: `ConsumerContractSchema`, `validateConsumerContract`, `computeContractChecksum` re-exported from `protocol-types.ts`
- AC27: Startup validation runs in warn-only mode: logs warning on contract mismatch, does not throw or exit
- AC28: Contract definition stored as code constant (not fetched from external source)

#### FR-9: Re-export New Governance + Constraint Exports (P3)

Re-export `mapTierToReputationState` from `/governance` and `ConstraintCondition`/`resolveConditionalExpression` from `/constraints` via `protocol-types.ts`. **No local implementation exists to replace** — these are forward-looking re-exports for future use.

**Acceptance Criteria:**
- AC29: `mapTierToReputationState`, `ConstraintCondition`, `resolveConditionalExpression` available via `protocol-types.ts`
- AC30: `pnpm tsc --noEmit` passes (imports resolve correctly)

#### FR-10: CI Action Version Standardization (P1)

Standardize all action SHAs to fleet-standard versions. Target SHAs (verified from existing majority usage):

| Action | Target SHA | Version | Files to Update |
|--------|-----------|---------|-----------------|
| `actions/checkout` | `34e114876b0b11c390a56381ad16ebd13914f8d5` | v4.3.1 | deploy-staging.yml lines 44, 77 |
| `amazon-ecs-render-task-definition` | `9666dc9a3bf790a3a7a3a3ce7d1a8600100b0ad2` | v1.7.2 | deploy-staging.yml line 162 |
| `amazon-ecs-deploy-task-definition` | `3e7310352de28fdb25b55df7a1dfd15a5ddeb369` | v2.3.1 | deploy-staging.yml line 169 |
| `actions/upload-artifact` | `4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1` | v4.6.1 | oracle.yml line 91 |

No functional workflow changes. No new verification steps added to workflows. SHA-to-version correspondence verified manually in PR description.

**Note on broader CI pinning:** All 11 workflows already pin third-party actions to commit SHAs — this FR only addresses version *drift* (same action at different SHAs). A comprehensive CI supply-chain audit (automated SHA-to-release verification, tag retargeting detection) is a valid future improvement but out of scope for this cycle.

> Flatline SKP-002: Broader CI pinning audit acknowledged as future work. Current scope limited to drift alignment.

**Acceptance Criteria:**
- AC31: `deploy-staging.yml` lines 44, 77 use checkout SHA `34e114876b...` (v4.3.1)
- AC32: `deploy-staging.yml` line 162 uses ECS render SHA `9666dc9a3b...` (v1.7.2)
- AC33: `deploy-staging.yml` line 169 uses ECS deploy SHA `3e7310352d...` (v2.3.1)
- AC34: `oracle.yml` line 91 uses upload-artifact SHA `4cec3d8aa0...` (v4.6.1)
- AC35: `grep -r 'uses:' .github/workflows/ | sort` shows no SHA duplicates for same action

### Out of Scope

- Hounfour v9 contributions (covered by archived cycle-037 PRD)
- New CI workflows or pipeline restructuring
- Node.js version changes (current multi-version matrix is correct)
- Breaking changes to finn's public API
- Dixie/freeside deployment changes
- Runtime schema validation for GovernedResource (deferred)
- Fail-closed consumer contract enforcement (deferred)
- Registry-based package publishing for hounfour (ecosystem-wide concern)
- Automated CI SHA-to-release verification tooling (future improvement)

---

## 5. Technical Approach

### 5.1 Protocol Types Barrel Strategy

All new v8.3.0 re-exports go through `src/hounfour/protocol-types.ts` — finn's single import point for hounfour. This preserves the existing pattern and makes future upgrades a single-file diff for re-exports.

### 5.2 Local Implementation Replacement Pattern

For each local implementation being replaced:
1. Add canonical import to `protocol-types.ts`
2. Create test vectors from current implementation's behavior
3. Verify canonical function produces identical outputs for test vectors
4. If identical: update consuming module, remove local implementation
5. If different: document incompatibility, do NOT replace (block item)

### 5.3 Behavioral Change Gating

FRs classified as behavioral changes (FR-6 feedback dampening, FR-8 consumer contracts) use feature flags or warn-only modes. This ensures the pin bump and API surface adoption can merge independently of behavioral validation. FR-7 (GovernedResource) is type-level only — no runtime gating needed.

### 5.4 CI Standardization

Pin to the SHA already used by the majority of workflows (fleet standard). No version bumps — only alignment. Each updated file gets a single commit for clear git blame.

### 5.5 Sprint Dependency Order

Sprint 1 (pin bump + x402 + CI) MUST complete before Sprint 2 (audit timestamp + hash + lock), which MUST complete before Sprint 3 (dampening + GovernedResource + contract). This ordering reflects:
- FR-1 (pin bump) is prerequisite for all other FRs — new exports are not available until v8.3.0 is installed
- FR-10 (CI) is independent and parallelizable with FR-1/FR-2
- Sprint 2 FRs are pure adoption with test vectors; Sprint 3 FRs involve behavioral gating

---

## 6. Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| v8.3.0 type incompatibility with finn's local x402 types | Low | Medium | Verify structural compatibility via `pnpm tsc --noEmit` before removing locals |
| Canonical audit timestamp validator rejects existing stored timestamps | Medium | Low | Fixture-based comparison (AC9-AC10); block replacement if incompatible |
| Advisory lock key computation differs between local and canonical | Low | High | Test vector comparison (AC16-AC17); block replacement if different |
| Canonical feedback dampening produces materially different scores | Expected | Medium | Feature flag rollout (AC18-AC22); log comparison on staging; quantitative promotion gate |
| Chain-bound hash breaks legacy audit trail verification | Low | Critical | Dual-format verification with `hashAlg` field (AC14); legacy entries verified with legacy function |
| CI SHA update breaks workflow | Very Low | Low | All changes are patch-level version alignment within same major |

### Dependencies

- **Hounfour v8.3.0** — MERGED (PR #39, commit `c29337e`). No dependency risk.
- **pnpm** — Already using pnpm. No change needed.
- **Freeside Issue #108** — Parallel v8.3.0 upgrade. No coordination needed.

---

## 7. Non-Functional Requirements

| NFR | Requirement | Verification |
|-----|------------|-------------|
| Backward compatibility | Zero breaking changes to finn's public API | `pnpm tsc --noEmit` + `pnpm test` |
| Test coverage | All existing tests pass; new fixture tests for adopted functions | `pnpm test` shows 0 regressions |
| Performance | No measurable latency change | Canonical functions are pure/synchronous |
| Bundle size | Net reduction (removing local implementations) | `du -sh dist/` before/after |

---

## 8. Implementation Notes

### Sprint Sizing

Estimated 3 sprints (dependency-ordered — see §5.5):
- **Sprint 1** (P0 + CI): Pin bump (FR-1) + x402 schemas (FR-2) + CI standardization (FR-10) + re-exports (FR-9)
- **Sprint 2** (P1 — requires Sprint 1): Audit timestamp (FR-3) + chain-bound hash (FR-4) + advisory lock (FR-5)
- **Sprint 3** (P2 — requires Sprint 2): Feedback dampening (FR-6) + GovernedResource (FR-7) + consumer contract (FR-8)

### Key Files

| File | Role | Change |
|------|------|--------|
| `package.json` | Hounfour pin | Bump commit SHA to `c29337e` |
| `pnpm-lock.yaml` | Lockfile | Regenerated by `pnpm install` |
| `src/hounfour/protocol-types.ts` | Re-export barrel | Add ~30 new re-exports |
| `src/x402/types.ts` | Local x402 interfaces | Remove replaced interfaces, keep finn-specific types |
| `src/hounfour/typebox-formats.ts` | ISO 8601 regex | Replace with `validateAuditTimestamp()` |
| `src/safety/audit-trail.ts` | Advisory lock | Replace local key computation |
| `src/hounfour/goodhart/quality-signal.ts` | Quality scoring | Adopt canonical dampening behind feature flag |
| `src/hounfour/audit/dynamo-audit.ts` | Audit hash chain | Add `hashAlg` field, dual-format verification |
| `.github/workflows/deploy-staging.yml` | CI | Update 4 action SHAs |
| `.github/workflows/oracle.yml` | CI | Update 1 action SHA |

---

## Appendix: Flatline Review Trail

| ID | Category | Summary | Resolution |
|----|----------|---------|------------|
| IMP-001 | HIGH_CONSENSUS (885) | Add rollback procedure for pin bump | Integrated into FR-1 |
| IMP-002 | HIGH_CONSENSUS (835) | Fix FR-7 scope classification inconsistency | Integrated — FR-7 reclassified to TYPE-LEVEL ONLY |
| IMP-003 | HIGH_CONSENSUS (850) | Add quantitative promotion gate for dampening | Integrated into FR-6 |
| IMP-004 | HIGH_CONSENSUS (855) | Fix FR numbering in export inventory | Integrated — hounfour FR prefix added throughout §2 |
| SKP-001 | BLOCKER (900) | Supply-chain risk with git SHA pins | Acknowledged in FR-1; registry migration out of scope |
| SKP-002 | BLOCKER (720) | CI pinning only covers 4 actions | Acknowledged in FR-10; broader audit out of scope |
| SKP-006 | BLOCKER (860) | Chain-bound hash backward compatibility | Addressed in FR-4 with dual-format verification strategy |
