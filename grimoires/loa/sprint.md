# Sprint Plan: Hounfour v7.11.0 Protocol Convergence

> **Cycle**: 034
> **PRD**: `grimoires/loa/prd-hounfour-v711.md` (GPT-5.2 APPROVED iteration 2)
> **SDD**: `grimoires/loa/sdd-hounfour-v711.md` (GPT-5.2 APPROVED iteration 3, Flatline reviewed)
> **Date**: 2026-02-24
> **Sprints**: 3 (Global IDs: 129–131)
> **Total Tasks**: 35

---

## Sprint Overview

| Sprint | Global ID | Label | Focus | Tasks |
|--------|-----------|-------|-------|-------|
| sprint-1 | 129 | Compile-Time Foundation | Dependency upgrade, feature flags, type re-exports, test vectors | 10 |
| sprint-2 | 130 | Protocol Extension | Handshake, TaskType, routing, reputation, task type gate | 14 |
| sprint-3 | 131 | Internal Optimizations | Native enforcement, hash chain migration, Goodhart protection | 11 |

**Total Tasks**: 34
**Dependency chain**: Sprint 1 → Sprint 2 → Sprint 3 (sequential — each builds on previous)
**Key invariant**: All 779+ existing tests pass with zero behavior change when flags off (validated per sprint)

---

## Sprint 1: Compile-Time Foundation (Global Sprint 129)

**Goal**: Upgrade to v7.11.0 with zero behavior change. All feature flags wired and defaulting to false. Shared test vectors committed.

**Success Criteria**:
- `npm install` succeeds with v7.11.0 pin
- All 779+ existing tests pass identically
- Feature flags exist in code but are all `false`
- Conditional re-exports compile (or are simplified to direct re-exports if verified)
- Hash chain test vector file exists with computed reference hashes
- No runtime behavior change whatsoever

**SDD Reference**: Section 4.1, Section 6.1

### Tasks

#### Task 1.1: Pin dependency to v7.11.0
**Description**: Update `package.json:32` to pin `@0xhoneyjar/loa-hounfour` to exact v7.11.0 commit hash. Run `npm install` and fix any immediate compile errors.
**Acceptance Criteria**:
- `package.json` references exact v7.11.0 commit hash
- `npm install` succeeds without errors
- `npm run build` (if applicable) succeeds
**Effort**: Small
**Dependencies**: None

#### Task 1.2: Verify upstream exports
**Description**: Verify all expected exports from v7.11.0: `TaskTypeCohort`, `ReputationEvent`, `ScoringPathLog`, `TaskType`, `evaluateNativeEnforcement`. Document which exist and which are missing.
**Acceptance Criteria**:
- Export inventory documented (exists/missing for each)
- If all exist: plan to use direct re-exports in Task 1.3
- If any missing: plan conditional wrappers with local stubs
**Effort**: Small
**Dependencies**: Task 1.1

#### Task 1.3: Add type re-exports to protocol-types.ts
**Description**: Add new type re-exports to `protocol-types.ts` per SDD Section 4.1. Use direct re-exports for verified exports, static imports with startup self-check for functions (SKP-001 pattern).
**Acceptance Criteria**:
- `TaskTypeCohort`, `ReputationEvent`, `ScoringPathLog`, `TaskType` re-exported
- `evaluateNativeEnforcement` imported with startup self-check pattern
- Build succeeds; no runtime change
**Effort**: Medium
**Dependencies**: Task 1.2

#### Task 1.4: Remove EvaluationResultWithDenials local patch
**Description**: If v7.11.0 includes `denial_codes` in `EconomicBoundaryEvaluationResult`, remove the local type extension in `economic-boundary.ts`. If not, retain with updated comment.
**Acceptance Criteria**:
- Local type patch removed (or comment updated explaining retention)
- All existing tests pass
**Effort**: Small
**Dependencies**: Task 1.1

#### Task 1.5: Add feature flag env vars
**Description**: Add all 6 feature flag/config constants per SDD Section 2.2 across `economic-boundary.ts`, `pool-enforcement.ts`, and `audit-trail.ts`. All default to `false` / `expression`.
**Acceptance Criteria**:
- `TASK_DIMENSIONAL_REPUTATION_ENABLED` in economic-boundary.ts
- `OPEN_TASK_TYPES_ENABLED` in economic-boundary.ts
- `NATIVE_ENFORCEMENT_ENABLED` in pool-enforcement.ts
- `ENFORCEMENT_GEOMETRY` in pool-enforcement.ts
- `PROTOCOL_HASH_CHAIN_ENABLED` in audit-trail.ts
- `UNKNOWN_TASK_TYPE_POLICY` referenced (used in Sprint 2)
- All flags default `false`; existing behavior unchanged
**Effort**: Small
**Dependencies**: Task 1.1

#### Task 1.6: Add health endpoint contract types
**Description**: Add `ArrakisHealthResponse` interface per SDD Section 2.1.1 (IMP-001). Include transport security notes (SKP-005) as code comments.
**Acceptance Criteria**:
- `ArrakisHealthResponse` interface defined with schema per SDD
- Error handling for parse failure/timeout documented in code
**Effort**: Small
**Dependencies**: Task 1.1

#### Task 1.7: Create hash chain test vectors file
**Description**: Create `tests/safety/hash-chain-vectors.json` per SDD Section 4.5.6. Compute actual hash values using the `canonicalize` npm package (RFC 8785).
**Acceptance Criteria**:
- Test vector file exists with 4+ vectors (legacy_genesis, bridge_entry, protocol_v1_first, unicode_edge_case)
- All `expected_hash` values are computed (not placeholders)
- Legacy hash matches existing canonicalization
- Protocol hash uses RFC 8785 library
**Effort**: Medium
**Dependencies**: Task 1.8 (requires canonicalize library)
**Testing**: Verify vectors are self-consistent; cross-check legacy vectors against existing `canonicalize()` output

#### Task 1.8: Install canonicalize (RFC 8785) library
**Description**: Add `canonicalize` npm package as a dependency. Verify it's RFC 8785 compliant by running it against known test vectors.
**Acceptance Criteria**:
- Package installed and importable
- Verified against RFC 8785 test cases (Unicode, number edge cases)
**Effort**: Small
**Dependencies**: Task 1.1

#### Task 1.9: Add Hono context type augmentation
**Description**: Add TypeScript module augmentation for Hono's `ContextVariableMap` per SDD Section 4.6.6 (IMP-006). Defines `taskType: TaskType` and `taskTypeRestricted: boolean`.
**Acceptance Criteria**:
- `c.get("taskType")` returns `TaskType` in TypeScript
- `c.set("taskType", value)` requires `TaskType` parameter
- No runtime change (types only)
**Effort**: Small
**Dependencies**: Task 1.3

#### Task 1.10: Full regression test run
**Description**: Run the complete test suite (779+ tests). Verify zero failures, zero behavior changes. This is the Sprint 1 gate.
**Acceptance Criteria**:
- All existing tests pass
- No new warnings or deprecations from v7.11.0
- Test output captured for comparison baseline
**Effort**: Small
**Dependencies**: All Sprint 1 tasks

---

## Sprint 2: Protocol Extension (Global Sprint 130)

**Goal**: Wire all new capabilities with feature flags disabled. All new code paths are dead code until flags are enabled. TaskType flows branded end-to-end.

**Success Criteria**:
- `PeerFeatures` has 3 new fields with dual-strategy detection
- `parseTaskType()` exists in wire-boundary.ts and validates namespace:type format
- TaskType is branded through RequestMetadata, LedgerEntryV2, ReputationProvider
- Task type gate in hounfourAuth() denies unknown types before routing
- NFT routing accepts TaskType with legacy mapping
- All tests pass with flags off; new tests cover flag-on behavior
- Unknown task type denial test proves gate runs before enforcement

**SDD Reference**: Sections 4.2, 4.3, 4.6, 5, 6.2

### Tasks

#### Task 2.1: Extend PeerFeatures + dual-strategy detection
**Description**: Add 3 new fields to `PeerFeatures` (`taskDimensionalRep`, `hashChain`, `openTaskTypes`) and implement dual-strategy detection per SDD Section 4.2. Add `DetectionMethod` type and side-effect logging.
**Acceptance Criteria**:
- `PeerFeatures` has 8 fields (5 existing + 3 new)
- `FEATURE_THRESHOLDS` updated for new features
- Detection: capabilities array (primary) → semver (fallback) → legacy_field (trustScopes only) → unknown=false
- Detection methods logged at DEBUG level
- ~20 new tests covering all 3 strategies and version scenarios
**Effort**: Large
**Dependencies**: Sprint 1 complete

#### Task 2.2: Add parseTaskType() to wire-boundary.ts
**Description**: Implement `parseTaskType()` branded type parser per SDD Section 4.6.1. Validates `namespace:type` format, max 64 chars, lowercase normalized.
**Acceptance Criteria**:
- `parseTaskType("finn:conversation")` returns branded `TaskType`
- Invalid inputs throw `WireBoundaryError`
- Edge cases: empty string, too long, invalid charset, missing colon
- ~15 new tests
**Effort**: Medium
**Dependencies**: Task 1.3 (TaskType type available)

#### Task 2.3: Add task_type to RequestMetadata and LedgerEntryV2
**Description**: Extend `RequestMetadata` and `LedgerEntryV2` in `types.ts` with `task_type?: TaskType`. Optional to maintain backward compatibility when flags off.
**Acceptance Criteria**:
- `RequestMetadata.task_type?: TaskType`
- `LedgerEntryV2.task_type?: TaskType`
- Existing code compiles without changes (optional field)
**Effort**: Small
**Dependencies**: Task 1.3

#### Task 2.4: Extend ReputationProvider with cohort query
**Description**: Add optional `getTaskCohortScore(tenantId: string, taskType: TaskType): Promise<number | null>` to `ReputationProvider` interface per SDD Section 4.3.
**Acceptance Criteria**:
- Optional method added to interface
- Existing implementations don't need changes (optional)
- When `TASK_DIMENSIONAL_REPUTATION_ENABLED=true`, cohort score is preferred over blended
**Effort**: Small
**Dependencies**: Task 2.3

#### Task 2.5: Thread TaskType through economic boundary
**Description**: Modify `evaluateBoundary()` to accept optional `taskType: TaskType` parameter. When flag enabled, use cohort query. Add shadow mode divergence metric.
**Acceptance Criteria**:
- `evaluateBoundary()` signature extended with optional `taskType`
- Flag off: zero code path change (taskType ignored)
- Flag on: cohort query preferred, blended fallback
- Shadow divergence metric emitted when both scores available
- ~25 new tests covering cohort/blended/fallback scenarios
**Effort**: Large
**Dependencies**: Task 2.4

#### Task 2.6: Define FINN_TASK_TYPES and registry
**Description**: Implement `FINN_TASK_TYPES` constants, `DEFAULT_TASK_TYPE`, `isRegisteredTaskType()`, and `LEGACY_TASK_TYPE_MAP` per SDD Section 4.6.2-4.6.3.
**Acceptance Criteria**:
- 6 finn-native task types pre-parsed at module load
- Legacy mapping from old string literals to TaskType
- `resolveLegacyTaskType()` for migration
- `isRegisteredTaskType()` works for all 6 types
**Effort**: Medium
**Dependencies**: Task 2.2

#### Task 2.7: Update NFTRoutingCache.resolvePool for TaskType
**Description**: Update `resolvePool()` to accept `TaskType` instead of string. Returns `null` when no routing found (no silent fallback). Add legacy caller fallback via endpoint mapping.
**Acceptance Criteria**:
- `resolvePool(personalityId, taskType: TaskType): PoolId | null`
- No silent fallback to hardcoded pool
- `resolveTaskTypeFromEndpoint()` maps paths to TaskType for legacy callers
- ~15 new tests
**Effort**: Medium
**Dependencies**: Task 2.6

#### Task 2.8: Implement task type gate in hounfourAuth()
**Description**: Add task type validation gate at step 1.5 in `hounfourAuth()` per SDD Section 4.6.4. Deny unknown types when `policy=deny`.
**Acceptance Criteria**:
- Gate runs after JWT validation, before pool routing/enforcement
- Unknown + policy=deny → 403 with `UNKNOWN_TASK_TYPE` code
- Unknown + policy=safe_default → allowed with restricted flag
- Known or allowlisted → passes through
- TaskType set in Hono context as branded type
**Effort**: Large
**Dependencies**: Task 2.6, Task 2.7, Task 2.9 (allowlist must exist before gate references it)

#### Task 2.9: Implement tenant task type allowlist
**Description**: Add `isTenantAllowlisted()` function per SDD Section 4.6.4.1 (IMP-004). Parse from `TENANT_TASK_TYPE_ALLOWLIST` env var. **Critical**: Parsing must be gated behind `OPEN_TASK_TYPES_ENABLED` to preserve the "flags off = zero behavior change" invariant (SKP-004).
**Acceptance Criteria**:
- Default deny when env var empty/missing
- Allowlist JSON parsing ONLY when `OPEN_TASK_TYPES_ENABLED=true` (flag off = no new module-load throws, no new required env vars)
- Invalid JSON throws at module load ONLY when flag is enabled (fail-fast when feature active, silent when inactive)
- Allowlist grants logged at INFO level
- Tests for deny/allow/malformed scenarios + test that malformed JSON is ignored when flag=false
**Effort**: Small
**Dependencies**: Task 2.2, Task 1.5 (flag must exist)

#### Task 2.10: Unknown task type denial gate test
**Description**: Critical test proving unknown task types with `policy=deny` return 403 BEFORE any routing/enforcement code executes.
**Acceptance Criteria**:
- Test sends request with unknown task type + deny policy
- Verifies 403 response with `UNKNOWN_TASK_TYPE` code
- Verifies `selectAuthorizedPool` was NOT called (mock assertion)
- Verifies `evaluateBoundary` was NOT called (mock assertion)
**Effort**: Medium
**Dependencies**: Task 2.8

#### Task 2.11: TaskType end-to-end integration test
**Description**: Integration test proving branded TaskType flows from wire boundary through enforcement, routing, reputation, WAL, and audit without type widening.
**Acceptance Criteria**:
- Request with `X-Task-Type: finn:conversation` flows through all layers
- RequestMetadata.task_type, LedgerEntryV2.task_type, AuditRecord.params.task_type all contain `"finn:conversation"`
- Compile-time type assertion: `expectTypeOf(metadata.task_type).toEqualTypeOf<TaskType>()` (using vitest `expectTypeOf` or equivalent)
- Runtime assertion: `parseTaskType(auditRecord.params.task_type)` succeeds (round-trip validates format is preserved)
**Effort**: Medium
**Dependencies**: Task 2.8, Task 2.5

#### Task 2.12: Health endpoint contract validation
**Description**: Validate arrakis health response against `ArrakisHealthResponse` schema at runtime. Use structural type checks (typeof/in guards) rather than adding a schema validation library — finn does not use zod/typebox elsewhere and this is a single internal endpoint.
**Acceptance Criteria**:
- Runtime structural validation: check `status` is string, `contract_version` is string, `capabilities` is array-of-strings (if present)
- Invalid shape → log warning, return default PeerFeatures (all false)
- Timeout/error → all features false (not throw)
- Unknown capabilities silently ignored (forward-compatible)
- Rate-limited probe caching (max 1 probe per 30s per peer)
**Effort**: Medium
**Dependencies**: Task 1.6 (ArrakisHealthResponse type), Task 2.1 (PeerFeatures extension)

#### Task 2.13: Flags-off regression gate
**Description**: Run full test suite with all flags explicitly set to `false`. Verify identical behavior to Sprint 1 baseline.
**Acceptance Criteria**:
- All 779+ original tests pass
- All new Sprint 2 flags-off tests pass
- No behavior change from Sprint 1 baseline
**Effort**: Small
**Dependencies**: All Sprint 2 tasks

#### Task 2.14: Flags-on test suite
**Description**: Run all new tests with flags set to `true`. Verify new behavior activates correctly.
**Acceptance Criteria**:
- Dual-strategy detection works end-to-end
- TaskType routing resolves correctly
- Cohort reputation queries fire when available
- Unknown task types denied with correct codes
**Effort**: Small
**Dependencies**: All Sprint 2 tasks

---

## Sprint 3: Internal Optimizations (Global Sprint 131)

**Goal**: Native enforcement path + hash chain migration. Performance benchmark baseline. Goodhart protection logging.

**Success Criteria**:
- Native enforcement produces identical results to expression path (hard CI gate)
- Performance benchmark shows >= 3x speedup (reported, non-blocking)
- Hash chain migration: bridge entry + dual-write + verification all work
- Migration state recovery survives restart (IMP-003)
- Partial write recovery on crash (SKP-004)
- Goodhart scoring path logged
- All tests pass with flags on and off

**SDD Reference**: Sections 4.4, 4.5, 4.7, 6.3

### Tasks

#### Task 3.1: Implement evaluateWithGeometry()
**Description**: Add native enforcement path in `pool-enforcement.ts` per SDD Section 4.4. When `ENFORCEMENT_GEOMETRY=native`, call `evaluateNativeEnforcement()` directly. Wire protocol unchanged.
**Acceptance Criteria**:
- `ENFORCEMENT_GEOMETRY=expression` → existing path (unchanged)
- `ENFORCEMENT_GEOMETRY=native` → direct evaluator call
- Both paths produce identical `PoolEnforcementResult`
- Startup self-check validates function availability when native enabled
**Effort**: Large
**Dependencies**: Sprint 2 complete

#### Task 3.2: Native enforcement correctness gate
**Description**: Hard CI gate proving native and expression paths produce identical results for 1000+ diverse inputs. Equivalence is defined as structural equality on the `PoolEnforcementResult` object (decision fields must match exactly; any numeric fields use integer comparison since enforcement results use basis-point integers, not floats).
**Acceptance Criteria**:
- Property-based test with 1000+ generated inputs
- Structurally identical `PoolEnforcementResult` for every input (deep-equal, not byte-identical serialization)
- If floats are encountered: normalize to fixed precision before comparison
- Deterministic iteration order enforced (sorted keys)
- Test fails build if any divergence detected; reports minimal counterexample for debugging
- ~20 new tests
**Effort**: Medium
**Dependencies**: Task 3.1

#### Task 3.3: Native enforcement performance benchmark
**Description**: Benchmark native vs expression. Reported metric, NOT a CI gate (SKP-002 resolution from GPT review iteration 1).
**Acceptance Criteria**:
- Benchmark runs in separate perf job (or skipped in CI)
- Reports speedup ratio (target >= 3x)
- Does NOT block merges
- Results logged for tracking
**Effort**: Small
**Dependencies**: Task 3.1

#### Task 3.4: Implement protocol_v1 canonicalization and hash computation
**Description**: Add `canonicalizeProtocol()` (RFC 8785 JCS), `computePayloadHash()`, `computeProtocolEntryHash()`, and `buildEnvelope()` per SDD Sections 4.5.1-4.5.3.
**Acceptance Criteria**:
- Uses `canonicalize` npm package for RFC 8785
- Exact byte sequence per formal hash spec (SKP-003)
- Field inclusion/exclusion rules match SDD table exactly
- All 4+ test vectors pass
**Effort**: Large
**Dependencies**: Task 1.7, Task 1.8

#### Task 3.5: Implement bridge entry and dual-write
**Description**: Implement `appendBridgeEntry()` and dual-write logic per SDD Sections 4.5.4-4.5.5. Dual-write count configurable via `HASH_CHAIN_DUAL_WRITE_COUNT` (default 1000). Includes migration abort/containment procedures (IMP-002).
**Acceptance Criteria**:
- Bridge entry links legacy chain to protocol chain
- Dual-write records carry both `prevHashProtocol` and `prevHashLegacy`
- Post-migration with flag off: force protocol mode + critical alert (not fatal throw) per SDD Section 4.5.5
- `dualWriteRemaining` derived from log, not stored separately (IMP-010)
- **Migration abort procedures implemented**:
  - Pre-bridge: set `PROTOCOL_HASH_CHAIN_ENABLED=false` + restart → clean rollback, no chain impact
  - Post-bridge, during dual-write: force-protocol-mode activates if flag set to false → chain remains valid, critical alert fires
  - Post-bridge, post-dual-write: same as above (force-protocol-mode, chain integrity preserved)
  - Full revert path: write reverse bridge entry (manual CLI command documented in code), then set flag to false
  - `verifyChain()` must pass after any abort/recovery scenario
**Effort**: Large
**Dependencies**: Task 3.4

#### Task 3.6: Implement migration state recovery
**Description**: Implement `reconstructStateFromLog()` per SDD Section 4.5.5.1 (IMP-003). Reconstruct `migrated`, `lastHashProtocol`, `lastHashLegacy`, `dualWriteRemaining` from audit log on startup.
**Acceptance Criteria**:
- Fresh log → clean state
- Log with bridge entry → `migrated=true`, correct chain tips
- Log with partial dual-write → correct `dualWriteRemaining`
- Partial trailing line → truncate and recover (SKP-004)
- Boot-time `verifyChain()` runs; quarantine mode on failure
**Effort**: Large
**Dependencies**: Task 3.5

#### Task 3.7: Update verifyChain() for dual-format
**Description**: Extend `verifyChain()` to handle legacy, bridge, and protocol_v1 records per SDD Section 4.5.7. Dual-pointer verification during dual-write period.
**Acceptance Criteria**:
- Legacy records verified with legacy hash
- Bridge entry verified: links to legacy chain tip
- Protocol records verified with protocol hash
- Dual-write records verify both chain pointers
- Post-dual-write records verify protocol only
**Effort**: Medium
**Dependencies**: Task 3.5

#### Task 3.8: Hash chain property-based round-trip test
**Description**: Property-based test generating random records, writing via `appendRecord()`, reading back, and verifying via `verifyChain()` per SDD Section 4.5.3 formal spec requirement.
**Acceptance Criteria**:
- 100+ randomly generated records per run
- Mix of legacy and protocol_v1 formats
- Bridge entry included
- Round-trip: write → read → verify succeeds
- Any field inclusion mismatch between writer and verifier is caught
**Effort**: Medium
**Dependencies**: Task 3.7

#### Task 3.9: Implement single-writer enforcement for audit trail
**Description**: Implement and test the single-writer deployment constraint per SDD Section 8.3 (IMP-002). Ensure only one process appends to the audit file at a time.
**Acceptance Criteria**:
- Advisory file lock (`flock`) acquired before any append, released after
- If lock acquisition fails (another writer): log CRITICAL warning, enter quarantine mode (appends buffered or denied)
- Boot-time check: acquire lock → if stale (PID not running), take ownership → if active, refuse to start audit writer
- Integration test: simulate two concurrent AuditTrail instances → second one is denied/quarantined
- Graceful shutdown releases lock before process exit
**Effort**: Medium
**Dependencies**: Task 3.6

#### Task 3.10: Implement Goodhart protection scoring path logging
**Description**: Add `ScoringPathLog` emission in economic boundary per SDD Section 4.7. Log scoring path with tenant hash when task-dimensional reputation is active.
**Acceptance Criteria**:
- Structured JSON log emitted when `TASK_DIMENSIONAL_REPUTATION_ENABLED=true`
- Includes `task_type`, `path` (scoring path), `tenant_hash`
- No PII in logs (tenant hash, not tenant ID)
**Effort**: Small
**Dependencies**: Task 2.5

#### Task 3.11: Full regression + integration gate
**Description**: Final gate: all flags off = identical to Sprint 1 baseline. All flags on = all new features active and tested.
**Acceptance Criteria**:
- All 779+ original tests pass (flags off)
- All ~120 new tests pass (flags on)
- Native enforcement correctness gate passes
- Hash chain: write bridge → dual-write → verify → restart → verify
- Single-writer lock acquired/released correctly in tests
- End-to-end TaskType flow verified
**Effort**: Medium
**Dependencies**: All Sprint 3 tasks

---

## Flatline Finding → Task Mapping

| Finding | Description | Task(s) |
|---------|-------------|---------|
| IMP-001 | Health endpoint schema + error codes | Task 1.6, Task 2.12 |
| IMP-002 | Single-writer audit trail constraint | Task 3.9 |
| IMP-003 | Migration state recovery on restart | Task 3.6 |
| IMP-004 | Tenant task type allowlist mechanism | Task 2.9 |
| IMP-010 | Dual-write counter persistence | Task 3.5, Task 3.6 |
| SKP-001 | Static imports + startup self-check | Task 1.3 |
| SKP-002 | Force-protocol-mode (not throw) post-migration | Task 3.5 |
| SKP-003 | Formal hash input byte spec | Task 3.4, Task 3.8 |
| SKP-004 | Partial trailing line crash recovery | Task 3.6 |
| SKP-005 | Health endpoint transport security | Task 1.6, Task 2.12 |
| IMP-006 | Hono context type augmentation | Task 1.9 |

---

## Flag Enablement Runbook

After all 3 sprints are merged (code deployed with all flags `false`), flags are enabled one at a time in this order:

| Step | Flag | Prerequisites | Canary | Rollback |
|------|------|--------------|--------|----------|
| 1 | `OPEN_TASK_TYPES_ENABLED=true` | Sprint 2 merged, all tests pass | Enable on 1 instance, monitor `unknown_task_type_denial` for 1h | Set to `false` + restart |
| 2 | `TASK_DIMENSIONAL_REPUTATION_ENABLED=true` | Step 1 stable | Shadow mode: log cohort vs blended delta for 24h before relying on cohort | Set to `false` + restart |
| 3 | `NATIVE_ENFORCEMENT_ENABLED=true` + `ENFORCEMENT_GEOMETRY=native` | Step 2 stable, correctness gate passed | Run shadow comparison on 10% traffic for 4h | Set `ENFORCEMENT_GEOMETRY=expression` + restart |
| 4 | `PROTOCOL_HASH_CHAIN_ENABLED=true` | Steps 1-3 stable, single-writer confirmed | Enable on single instance only (coordinated rollout) | **Cannot simply disable** — force-protocol-mode activates. See SDD Section 4.5.5. |

**Decision points for abort**:
- Step 1-3: Any spike in denial rates, enforcement divergence, or error rates → disable flag + restart (rolling, ~30s)
- Step 4: Pre-migration: disable flag + restart. Post-migration: flag off triggers force-protocol-mode (safe but generates critical alert). Full revert requires reverse bridge entry (manual, documented in SDD).

**Who flips**: Deployment config change via container orchestrator. Requires PR to config repo, reviewed by @janitooor.

---

## Risk Assessment

| Risk | Sprint | Mitigation |
|------|--------|------------|
| v7.11.0 missing expected exports | 1 | Task 1.2 verifies before coding; static imports fail at build time |
| Hash chain test vector mismatch with arrakis | 1 | Compute vectors from actual library output, not manually |
| Cohort score diverges wildly from blended | 2 | Shadow mode + delta metric before enabling in production |
| Unknown task type flood from confused clients | 2 | Deny-by-default gate + spike alert; allowlist for partners |
| Native enforcement correctness divergence | 3 | Hard CI gate with 1000+ inputs; not deployed until gate passes |
| Hash chain corruption during migration | 3 | Bridge entry is append-only; dual-write maintains both chains; state recovery from log |
| Rolling deploy with mixed flag states | 3 | Force-protocol-mode (not throw) on post-migration flag mismatch |

## Buffer

Each sprint has ~20% buffer built into the task estimates. Sprint 1 is the lightest (foundation work), Sprint 2 is the heaviest (most new code), and Sprint 3 has the highest-risk tasks (hash chain migration).

## Success Metrics

| Metric | Target | Gate Type |
|--------|--------|-----------|
| Existing test pass rate | 100% | Hard (per sprint) |
| New test coverage | ~120 new tests | Soft |
| Native enforcement correctness | 100% identical results | Hard (CI) |
| Native enforcement performance | >= 3x speedup | Reported (non-blocking) |
| Hash chain cross-system verification | Pass test vectors | Hard |
| Unknown task type denial latency | < 1ms overhead | Soft |
