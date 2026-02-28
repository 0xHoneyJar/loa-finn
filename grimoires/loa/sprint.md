# Sprint Plan: Hounfour v8.3.0 Upgrade + CI Standardization

**Cycle:** 038
**PRD:** `grimoires/loa/prd.md`
**SDD:** `grimoires/loa/sdd.md`
**Date:** 2026-02-28
**Team:** 1 AI developer + 1 human reviewer
**Sprint duration:** ~2-4 hours each (AI-paced)
**Status:** COMPLETED

---

## Sprint 1: Pin Bump + Surface Adoption + CI (P0/P1)

**Goal:** Upgrade hounfour to v8.3.0, extend protocol-types barrel with all new re-exports, replace local x402 types with canonical schemas, and align CI action SHAs to fleet standard.

**Risk:** Medium — although v8.3.0 is a MINOR release (API-additive), runtime behavioral changes (stricter timestamp validation, hash/domain tag semantics, lock key computation) require focused regression coverage. Test vectors and fixtures are the safety net.

> Flatline SKP-001: Risk upgraded from Low to Medium per cross-model consensus (severity 720).

**Dependency:** None — this is the foundation sprint.

### Tasks

#### T-1.1: Pin bump to v8.3.0
- Update `package.json` hounfour dependency SHA from `33d2b71` to `c29337e305005c5de56f8796ba391fb42108b5c5`
- Run `pnpm install` and verify lockfile regenerates
- Verify `scripts/build-hounfour-dist.sh` runs successfully via postinstall
- **Rollback:** If postinstall or type check fails: revert `package.json` SHA to `33d2b71`, `pnpm install`, `pnpm test` to confirm clean revert
- **AC:** `pnpm why @0xhoneyjar/loa-hounfour` shows commit `c29337e`

> Flatline IMP-001: Concrete rollback procedure added (avg 780).

#### T-1.2: Extend protocol-types barrel
- Add `// ── v8.3.0 Pre-Launch Hardening (Cycle 038) ──` section to `src/hounfour/protocol-types.ts`
- Re-export all verified v8.3.0 exports per SDD §3.2: x402 schemas, chain-bound hash, audit timestamp, advisory lock, feedback dampening, GovernedResource, consumer contract, tier-reputation, constraint conditionals
- Handle `AuditEntryHashInput` alias as `ChainBoundHashInput` to avoid name collision
- **AC:** `pnpm tsc --noEmit` passes (all import paths resolve)

#### T-1.3: Replace x402 local types
- Remove local `X402Quote`, `PaymentProof`, `SettlementResult` interface definitions from `src/x402/types.ts`
- Import canonical types from `protocol-types.ts`
- Add backward-compatible type aliases: `PaymentProof = X402PaymentProof`, `SettlementResult = X402Settlement`
- Keep all finn-specific types unchanged
- **AC:** `pnpm tsc --noEmit` passes; `pnpm test:x402` passes with 0 modifications

#### T-1.4: Re-export governance + constraints (forward-looking)
- Verify `mapTierToReputationState`, `ConstraintCondition`, `resolveConditionalExpression` resolve from barrel
- No local implementation exists — these are pure re-exports for future use
- **AC:** `pnpm tsc --noEmit` passes

#### T-1.5: CI action SHA alignment
- Update `deploy-staging.yml` checkout action (two occurrences) to `34e114876b0b11c390a56381ad16ebd13914f8d5` (v4.3.1) — locate via `grep 'actions/checkout@' deploy-staging.yml`
- Update `deploy-staging.yml` ECS render-task-definition action to `9666dc9a3bf790a3a7a3a3ce7d1a8600100b0ad2` (v1.7.2) — locate via `grep 'ecs-render-task-definition@' deploy-staging.yml`
- Update `deploy-staging.yml` ECS deploy-task-definition action to `3e7310352de28fdb25b55df7a1dfd15a5ddeb369` (v2.3.1) — locate via `grep 'ecs-deploy-task-definition@' deploy-staging.yml`
- Update `oracle.yml` upload-artifact action to `4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1` (v4.6.1) — locate via `grep 'upload-artifact@' oracle.yml`

> Flatline IMP-002: Replaced brittle line-number references with semantic anchors (avg 865).
- **AC:** Each updated line matches the exact pinned SHA from the task; `rg 'uses: .*@[0-9a-f]{40}' .github/workflows/` returns all `uses:` lines (no tag references); explicit per-file assertion: `grep '34e114876b0b' .github/workflows/deploy-staging.yml | wc -l` equals 2 (lines 44, 77)

#### T-1.6: Sprint 1 verification gate
- Run full test suite: `pnpm test:finn && pnpm test:billing && pnpm test:gateway && pnpm test:x402`
- Run type check: `pnpm tsc --noEmit`
- All must pass with 0 regressions
- **AC:** All existing tests pass, 0 new warnings

---

## Sprint 2: Test-Vector Adoption (P1)

**Goal:** Replace local implementations with canonical hounfour functions for audit timestamp, chain-bound hash, and advisory lock — each verified by test vectors before replacement.

**Risk:** Medium — hash chain and advisory lock changes are integrity-critical. Test vectors are the safety net.

**Dependency:** Sprint 1 must be complete (v8.3.0 exports must be available).

### Tasks

#### T-2.1: Audit timestamp replacement
- Import `validateAuditTimestamp` from `protocol-types.ts` in `src/hounfour/typebox-formats.ts`
- Replace `ISO_8601_RE` regex with canonical validator in FormatRegistry
- Remove `ISO_8601_RE` constant
- **AC:** `typebox-formats.ts` uses `validateAuditTimestamp()` for `date-time` format

#### T-2.2: Timestamp fixture file
- Create `tests/finn/hounfour/audit-timestamp-fixtures.json` with >=20 valid and >=10 invalid timestamps
- Extract valid timestamps from existing audit trail entries where possible
- Include edge cases: impossible dates, out-of-range fields, missing timezone, date-only, garbage
- Create `tests/finn/hounfour/audit-timestamp-fixtures.test.ts` (vitest)
- Add `"test:audit-fixtures"` script to `package.json`
- **Compatibility policy:** If canonical validator rejects any timestamp that the local regex accepted:
  1. Document the rejected format in NOTES.md with example
  2. If <=5 entries affected: normalize stored timestamps via one-time migration script (output to NOTES.md)
  3. If >5 entries affected: keep local regex as fallback path gated by `FINN_STRICT_TIMESTAMPS` env var (default: `false` = use local regex, `true` = use canonical)
  4. Pre-validate: extract a sample of real stored timestamps from existing test fixtures / audit trail snapshots and run both validators against them in T-2.2
- **AC:** `pnpm test:audit-fixtures` passes; pre-validation results documented; if canonical rejects any existing valid timestamp, compatibility policy applied per above

> Flatline SKP-006: Timestamp compatibility policy defined with migration/fallback (severity 740).
> Flatline IMP-013: Pre-validation of existing timestamps added to T-2.2 (avg 810).

#### T-2.3: Chain-bound hash integration
- In `src/cron/store.ts`, add `hashAlg` field (`'legacyV1' | 'chainBoundV1'`) to audit entry metadata
- **Persistence:** `hashAlg` stored in the entry's existing metadata object (DynamoDB attribute map) — no schema migration needed, field is additive
- **Default for legacy entries:** Entries without `hashAlg` field are assumed `legacyV1`
- Update write path: new entries use `computeChainBoundHash()` with `hashAlg: 'chainBoundV1'`
- Update verification path: dual-format verification per SDD §3.5 / §4.1 — algorithm selection logic: `entry.metadata?.hashAlg === 'chainBoundV1'` → `computeChainBoundHash()`, otherwise → `computeAuditEntryHash()`
- **hashAlg authentication:** `hashAlg` value MUST be included in the chain-bound hash preimage (it is part of `ChainBoundHashInput`). For legacy entries (no `hashAlg` field), the absence itself is the discriminator — legacy hash function does not include `hashAlg`. This prevents an attacker from flipping `hashAlg` metadata to bypass verification: changing `hashAlg` would produce a different hash, failing integrity check.
- **Verification failure semantics:** If integrity verification detects a hash mismatch: log error with entry ID + expected/actual hash, mark trail as `INTEGRITY_FAILED`, do NOT silently continue. Cron job should halt processing for that trail and alert. This is a hard-fail path — integrity violations are never suppressed.
- Genesis hash: `AUDIT_TRAIL_GENESIS_HASH` (`'0'.repeat(64)`)
- Domain tag: from existing `buildDomainTag()` with `contractVersion: '8.3.0'` for new entries. Legacy entries use `contractVersion: '8.2.0'` (or whatever version produced them — determined from existing `buildDomainTag()` calls). Vector test must assert exact domainTag string and resulting hash for both legacy and chain-bound to prove cross-version compatibility.
- **Write-path feature flag:** New chain-bound writes gated by `FINN_CHAINBOUND_HASH` env var (default: `false`). When `false`, new entries continue using legacy `computeAuditEntryHash()`. When `true`, new entries use `computeChainBoundHash()` with `hashAlg: 'chainBoundV1'`. This allows rollback by disabling the flag — no DynamoDB entries with bad hashes can accumulate until the flag is explicitly enabled after staging validation.
- **AC:** Existing `verifyAuditTrailIntegrity()` tests pass without modification; new test covers mixed chain (legacy entries followed by chainBoundV1 entries); hash vector test (T-2.4) includes domainTag input/output assertions for both legacy and chain-bound; verification failure test asserts hard-fail behavior

> Flatline IMP-003: Verification failure semantics specified — hard-fail, no silent continue (avg 885).
> Flatline IMP-004: Legacy contractVersion documented for dual-format compatibility (avg 855).
> Flatline IMP-009: Write-path feature flag added to prevent bad DynamoDB entries (avg 855).
> Flatline SKP-009: hashAlg included in hash preimage — metadata flipping prevented (severity 900).
> Flatline SKP-007: Domain tag versioning explicit for both legacy and chain-bound (severity 860).

#### T-2.4: Hash vector test file
- Create `tests/finn/hounfour/chain-bound-hash-vectors.test.ts` (vitest)
- Test fixed entries with known field values against both algorithms
- Build 3-entry chain (genesis → A → B) for both legacy and chain-bound
- Assert: changing prevHash produces different hash (tamper detection)
- Assert: legacy and chain-bound produce different hashes for same entry (algorithm isolation)
- **AC:** All hash vector tests pass; expected hex values hardcoded in test

#### T-2.5: Advisory lock key replacement
- Locate local advisory lock key computation (grep for `pg_advisory`, advisory lock, FNV hash)
- Extract >=3 test vectors from current implementation
- Compare canonical `computeAdvisoryLockKey()` output
- If identical: replace local computation
- If different: implement dual-try mechanism per SDD §3.6 (feature flag `FINN_CANONICAL_LOCK_KEY`):
  - **Lock ordering:** Always try canonical key first, then legacy key. Never hold both simultaneously — acquire canonical, if fails acquire legacy, release in reverse order.
  - **Timeout:** Each `pg_try_advisory_lock` attempt bounded to 5s. If both fail, log error and skip (do not block indefinitely).
  - **Release semantics:** Release the key that was successfully acquired. Track which key variant was used per-lock to ensure correct release.
  - **Concurrency test:** Two-worker test verifying mutual exclusion holds during dual-try transition (no deadlock, no lost exclusion).
- **AC:** Test vectors pass; lock key computation uses canonical function (or dual-try if mismatch); concurrency test passes

> Flatline IMP-005: Advisory lock ordering/conflict behavior specified (avg 850).
> Flatline SKP-011: Dual-try protocol defined with ordering, timeouts, release semantics (severity 880).

#### T-2.6: Advisory lock vector test file
- Create `tests/finn/hounfour/advisory-lock-vectors.test.ts` (vitest)
- >=3 vectors with known domainTag → expectedKey pairs
- **AC:** All lock key vectors pass with canonical function

#### T-2.7: Sprint 2 verification gate
- Run full test suite + new fixture/vector tests
- **AC:** All existing + new tests pass, 0 regressions

---

## Sprint 3: Behavioral Adoption (P2)

**Goal:** Adopt behavioral changes behind feature flags and warn-only modes: canonical dampening, GovernedResource type conformance, consumer contract validation.

**Risk:** Medium — dampening is a behavioral change (gated by flag), contract validation is warn-only. GovernedResource is type-level only (no risk).

**Dependency:** Sprint 2 must be complete (test-vector adoption validated).

### Tasks

#### T-3.1: Feature-flagged feedback dampening
- In `src/hounfour/goodhart/quality-signal.ts`, add `FINN_CANONICAL_DAMPENING` env var check
- Implement `applyDampening()` function per SDD §3.7
- When flag=false: local EMA logic unchanged
- When flag=true: canonical `computeDampenedScore(oldScore, newScore, sampleCount, config)` called
- Log delta when flag=true and values differ by >0.001
- **AC:** `pnpm test:dampening` passes; tests assert exact numeric outputs for fixed scenarios (oldScore=0.5, newScore=0.8, sampleCount=10 → expected value hardcoded); flag=false path produces identical output to pre-upgrade local EMA; flag=true path calls canonical function; delta >0.001 triggers log emission (verified via mocked logger)

#### T-3.2: Dampening config validation
- At startup, validate dampening config against `FeedbackDampeningConfigSchema`
- Invalid config: log warning, set `dampeningConfigValid = false`, fall back to local regardless of flag
- No startup blocking — warn only
- **AC:** Invalid config falls back to local with warning log

#### T-3.3: Dampening comparison tests
- Create dampening test file (vitest)
- Test boundary sampleCount values: 0, 1, DAMPENING_RAMP_SAMPLES, DAMPENING_RAMP_SAMPLES+100
- Assert numeric outputs for fixed scenarios — compute expected values during implementation by running canonical `computeDampenedScore()` once with known inputs, then hardcode those values as assertions (e.g., `expect(result).toBeCloseTo(0.xxxxx, 5)`)
- Test flag=false uses local, flag=true uses canonical
- Test comparison logging behavior (delta >0.001 triggers log)
- Test config validation failure → fallback
- **AC:** All dampening tests pass with numeric assertions; at least 4 scenarios with hardcoded expected values to 5 decimal places

> Flatline IMP-008: Expected numeric values required in dampening tests (avg 830).

#### T-3.4: GovernedResource type annotation
- Select strongest candidate module (billing state machine, cron runner, or credit entitlement)
- Add `implements GovernedResource<T>` to an existing class/interface
- Type-level only — no runtime changes, no schema validation
- **AC:** `pnpm tsc --noEmit` passes (compiler enforces interface conformance)

#### T-3.5: Consumer contract warn-only validation
- Define `FINN_CONTRACT` as inline code constant in startup path (lists expected exports by module path)
- Construct `FINN_EXPORT_MAP` via `import * as ProtocolTypes from '../hounfour/protocol-types'` and derive map from `Object.keys(ProtocolTypes)` — no dynamic `import()` or filesystem introspection
- Run `validateConsumerContract(FINN_CONTRACT, FINN_EXPORT_MAP)` at startup
- Log warning on mismatch, do NOT throw or exit
- **AC:** `pnpm test:contract` passes; unit test asserts export map contains minimum required keys (>=10 from v8.3.0); startup validation runs in warn-only mode verified via mocked logger

#### T-3.6: Consumer contract test
- Unit test that runs `validateConsumerContract` against the constructed export map
- Verify it executes without throwing and returns a valid result
- **AC:** Contract validation test passes

#### T-3.7: Sprint 3 verification gate
- Run full test suite + all new tests from sprints 1-3
- Type check: `pnpm tsc --noEmit`
- Verify `FINN_CANONICAL_DAMPENING=false` produces identical behavior to pre-upgrade
- **AC:** All tests pass, 0 regressions, dampening flag=false is behavioral no-op

---

## PRD Functional Requirements → Task Traceability

| FR | PRD Title | Tasks | PRD AC IDs | Verification Command |
|----|-----------|-------|------------|---------------------|
| FR-1 | Pin Bump (P0) | T-1.1 | AC1, AC2, AC3 | `pnpm why @0xhoneyjar/loa-hounfour` shows `c29337e` |
| FR-2 | x402 Schema Canonicalization (P0) | T-1.3 | AC4, AC5, AC6 | `pnpm tsc --noEmit && pnpm test:x402` |
| FR-3 | Audit Timestamp Validation (P1) | T-2.1, T-2.2 | AC7, AC8, AC9, AC10 | `pnpm test:audit-fixtures` |
| FR-4 | Chain-Bound Hash Adoption (P1) | T-1.2, T-2.3, T-2.4 | AC11, AC12, AC13, AC14 | `pnpm test:hash-vectors` (hardcoded hex) |
| FR-5 | Advisory Lock Key (P1) | T-2.5, T-2.6 | AC15, AC16, AC17 | `pnpm test:lock-vectors` |
| FR-6 | Feedback Dampening (P2) | T-3.1, T-3.2, T-3.3 | AC18, AC19, AC20, AC21, AC22 | `pnpm test:dampening` (numeric assertions) |
| FR-7 | GovernedResource Interface (P2) | T-3.4 | AC23, AC24, AC25 | `pnpm tsc --noEmit` |
| FR-8 | Consumer Contract Validation (P2) | T-3.5, T-3.6 | AC26, AC27, AC28 | `pnpm test:contract` (warn-only) |
| FR-9 | Governance + Constraint Re-exports (P3) | T-1.4 | AC29, AC30 | `pnpm tsc --noEmit` |
| FR-10 | CI Action Version Standardization (P1) | T-1.5 | (PRD §FR-10) | `rg 'uses: .*@[0-9a-f]{40}' .github/workflows/` |

> Flatline IMP-006: Traceability AC references now match PRD AC numbering exactly (avg 775).
