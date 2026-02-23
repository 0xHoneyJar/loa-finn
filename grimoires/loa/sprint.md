# Sprint Plan: Protocol Convergence v7.9.2 — Full Adoption

> **Version**: 1.0.0
> **Date**: 2026-02-23
> **Cycle**: cycle-032
> **PRD**: grimoires/loa/prd.md (v1.1.0 — GPT-5.2 APPROVED)
> **SDD**: grimoires/loa/sdd.md (v1.0.0 — GPT-5.2 APPROVED + Flatline APPROVED)
> **Total**: 30 tasks across 5 sprints
> **Global Sprint IDs**: 126–130

---

## Overview

| Sprint | Label | Tasks | Focus |
|--------|-------|-------|-------|
| Sprint 1 (global-126) | Bump + Clean + Vectors | 6 | Pin v7.9.2, remove patch, resolution audit, 202 conformance vectors |
| Sprint 2 (global-127) | Type System + Vocabulary + Handshake | 7 | Strict parser, MicroUSDC migration, schemas, access policy, handshake |
| Sprint 3 (global-128) | Decision Engine + Choreography | 6 | Economic boundary adapter, middleware, choreography tests, reality update |
| Sprint 4 (global-129) | Economic Boundary Hardening | 6 | Instance circuit breaker, configurable period, type alignment, tenant hash |
| Sprint 5 (global-130) | Test Depth + Dynamic Reputation | 5 | Half-open tests, interaction matrix, authoritative mapping, blended scoring |

**Dependencies**: Sprint 1 → Sprint 2 (dependency resolution required). Sprint 2 → Sprint 3 (type imports and handshake features needed by economic boundary). Sprint 3 → Sprint 4 (builds on economic boundary implementation). Sprint 3 → Sprint 5 (tests and extensions of economic boundary).

**Risk gates**: Sprint 1 has an abort gate at Task 1.3 — if resolution audit fails, the sprint stops and we investigate export map changes before proceeding.

---

## Sprint 1: Bump + Clean + Vectors (global-126)

**Goal**: Pin loa-hounfour v7.9.2, remove the postinstall patch, verify zero regressions, and establish the self-verifying 202-vector conformance infrastructure.

**Exit criteria**: `pnpm install` clean (no patch), all ~1,105 existing tests pass, 202/202 conformance vectors pass.

### Task 1.1 — Bump dependency to v7.9.2 tag SHA

| Field | Value |
|-------|-------|
| **FR** | FR-1 |
| **Files** | `package.json` |
| **Description** | Update `@0xhoneyjar/loa-hounfour` dependency from `d091a3c0` (v7.0.0) to `ff8c16b899b5bbebb9bf1a5e3f9e791342b49bea` (v7.9.2 tag). Run `pnpm install`. |
| **Acceptance** | `pnpm install` succeeds. `CONTRACT_VERSION === "7.9.2"` verified via `node -e "console.log(require('@0xhoneyjar/loa-hounfour').CONTRACT_VERSION)"`. No postinstall errors. Verify `pnpm-lock.yaml` contains expected integrity hash for the installed package (pnpm content-addressable store ensures tarball integrity). |
| **Blocked by** | None |

### Task 1.2 — Delete postinstall patch script

| Field | Value |
|-------|-------|
| **FR** | FR-2 |
| **Files** | `package.json`, `scripts/patch-hounfour-dist.sh` |
| **Description** | Delete `scripts/patch-hounfour-dist.sh`. Remove `"postinstall"` script from `package.json`. Run `pnpm install` to verify clean resolution. |
| **Acceptance** | File deleted. `postinstall` key absent from package.json scripts. `pnpm install` completes with no patching, no warnings. |
| **Blocked by** | 1.1 |

### Task 1.3 — Resolution audit gate (ABORT GATE)

| Field | Value |
|-------|-------|
| **FR** | FR-3, FR-3a |
| **Files** | `tests/finn/resolution-audit.test.ts` (NEW) |
| **Description** | Create resolution audit test that enumerates ALL hounfour import specifiers across loa-finn — including static `from` imports, dynamic `import()` calls, `require()` calls, and string literals referencing `@0xhoneyjar/loa-hounfour/`. For each unique specifier: verify TS compile resolution (`tsc --noEmit` as part of CI) AND Node runtime resolution (dynamic import in test). Verify vectors directory exists via `createRequire().resolve()` (not hardcoded node_modules path). Import `existsSync` from `node:fs`. |
| **Acceptance** | All import specifiers resolve at both compile-time and runtime. Vectors directory exists. Test passes. Deep subpaths (e.g., `@0xhoneyjar/loa-hounfour/economy`) validated against exports map. Also audit built `.js` output (not just `.ts` source) to catch specifiers generated or transformed at build time. **If this test fails, STOP — do not proceed to Task 1.4+. Investigate and fix resolution before continuing.** |
| **Blocked by** | 1.2 |

### Task 1.4 — Run existing test suite

| Field | Value |
|-------|-------|
| **FR** | — (zero regression gate) |
| **Files** | All existing test files |
| **Description** | Run `pnpm test` against the full existing test suite (~1,105 tests). No test modifications allowed — if tests fail, the bump or patch removal caused a regression. |
| **Acceptance** | All ~1,105 existing tests pass. Zero regressions. |
| **Blocked by** | 1.3 |

### Task 1.5 — Self-verifying vector infrastructure

| Field | Value |
|-------|-------|
| **FR** | FR-13, FR-14, FR-15 |
| **Files** | `tests/finn/conformance-vectors.test.ts` (NEW), `tests/finn/jwt-auth.test.ts` (VERIFY) |
| **Description** | Create conformance vector test infrastructure. Discovery uses `createRequire().resolve()` for package-layout-independent vector resolution. Import `{ dirname }` from `node:path`. Load from manifest.json if available, fallback to directory enumeration. Assert: count == 202, category coverage (at minimum `jwt` + new categories), per-category non-empty, vector ID uniqueness. Verify existing JWT vector path still valid. |
| **Acceptance** | 202 vectors discovered. All required categories present and non-empty. Vector ID uniqueness asserted. JWT conformance path verified. |
| **Blocked by** | 1.3 |

### Task 1.6 — Run 202 conformance vectors

| Field | Value |
|-------|-------|
| **FR** | FR-13 |
| **Files** | `tests/finn/conformance-vectors.test.ts` |
| **Description** | Execute all 202 conformance vectors. Each vector defines inputs and expected outputs — the test runner validates finn's implementation against protocol expectations. |
| **Acceptance** | 202/202 pass. Zero failures. |
| **Blocked by** | 1.5 |

---

## Sprint 2: Type System + Vocabulary + Handshake (global-127)

**Goal**: Adopt protocol type system (strict parser, MicroUSDC migration, schemas), vocabulary utilities, access policy in shadow mode, and update protocol handshake with semver-derived feature detection.

**Exit criteria**: `StrictMicroUSD` wrapper works with nominal branding, MicroUSDC migrated to protocol import with compile-time verification, JTI policy enforced, access policy running in asymmetric shadow mode, handshake detects 4 peer features.

### Task 2.1 — Add `parseStrictMicroUSD` wrapper

| Field | Value |
|-------|-------|
| **FR** | FR-7 |
| **Files** | `src/hounfour/wire-boundary.ts`, `tests/finn/wire-boundary.test.ts` |
| **Description** | Add `parseStrictMicroUSD()` that delegates to protocol `parseMicroUsd()`. Return type is `StrictMicroUSD` — a locally-branded type that intersects the protocol `ProtocolMicroUSD` with a local `_strictMicroUSDBrand: unique symbol`. This ensures: (1) the value is protocol-validated (non-negative), and (2) it cannot be assigned from the local `MicroUSD` type (which allows negatives). The function validates via `parseMicroUsd()`, then brands the result with a single safe constructor (the only place where the internal branding cast occurs). |
| **Acceptance** | Positive values return `StrictMicroUSD`. Negative values throw `WireBoundaryError`. Zero returns `StrictMicroUSD`. Compile-time test: `StrictMicroUSD` is NOT assignable from local `MicroUSD`. Compile-time test: `StrictMicroUSD` IS assignable to `ProtocolMicroUSD` (superset). No `as unknown as` casts outside the single `parseStrictMicroUSD` constructor. |
| **Blocked by** | Sprint 1 complete |

### Task 2.2 — Negative boundary invariant tests

| Field | Value |
|-------|-------|
| **FR** | FR-7a |
| **Files** | `tests/finn/wire-boundary.test.ts` |
| **Description** | Add tests enforcing the negative value boundary invariant: negative MicroUSD ONLY in internal accounting contexts, NEVER at strict boundaries. Round-trip: WAL -> internal -> outbound wire must reject negatives at the wire boundary. Property test: any negative input to `parseStrictMicroUSD` produces `WireBoundaryError`. |
| **Acceptance** | Round-trip test rejects negative at wire boundary. Property test (100+ random negative values) all produce error. No negative value can be branded as `StrictMicroUSD`. |
| **Blocked by** | 2.1 |

### Task 2.3 — Migrate MicroUSDC to protocol import

| Field | Value |
|-------|-------|
| **FR** | FR-9, FR-9a |
| **Files** | `src/hounfour/wire-boundary.ts`, `src/hounfour/protocol-types.ts` (NEW), `tests/finn/branded-type-migration.test.ts` (NEW) |
| **Description** | Replace local `MicroUSDC` brand (wire-boundary.ts:236-265) with protocol import from `@0xhoneyjar/loa-hounfour/economy`. Create `src/hounfour/protocol-types.ts` as centralized re-export module. Use `readMicroUSDC(raw.toString())` for conversion (validates non-negativity) — guard that `raw` is `bigint` before calling `.toString()` to prevent Number precision loss (e.g., `Number(9007199254740993).toString()` loses precision). Add compile-time `expectTypeOf` brand verification test. |
| **Acceptance** | Local MicroUSDC brand declaration deleted. Protocol import used everywhere. Re-export provides backward-compatible import path. `readMicroUSDC()` validates non-negativity. Brand verification test passes. |
| **Blocked by** | 2.1 |

### Task 2.4 — Import protocol schemas and types

| Field | Value |
|-------|-------|
| **FR** | FR-8, FR-10 |
| **Files** | `src/hounfour/types.ts`, `src/hounfour/jwt-auth.ts`, `src/billing/types.ts` |
| **Description** | Import and use `JwtClaimsSchema`, `BillingEntrySchema`, `EconomicBoundarySchema`, `QualificationCriteria`, `DenialCode`, `EvaluationGap`, `ModelEconomicProfileSchema`, `ConstraintOrigin`, `ReputationStateName` from protocol. Import `JTI_POLICY` and create `EFFECTIVE_JTI_POLICY` (replay cache window = `Math.min(Math.max(local, protocol), MAX_JTI_WINDOW_SECONDS)` — larger is stricter for replay detection, but capped by `MAX_JTI_WINDOW_SECONDS` env var (default: 600s) to protect tenants from protocol-imposed excessively large windows; required = OR of both). Wire into Redis TTL, max-age check, required flag. |
| **Acceptance** | All types imported and used. `EFFECTIVE_JTI_POLICY` created with capped `Math.max` for window_seconds. `MAX_JTI_WINDOW_SECONDS` env var respected (default 600). Test: token with jti replayed after local window but within effective window is rejected. Test: protocol window of 3600s capped to 600s default. Log WARNING when protocol window exceeds local by >2x. |
| **Blocked by** | 2.1 |

### Task 2.5 — Adopt vocabulary utilities

| Field | Value |
|-------|-------|
| **FR** | FR-11 |
| **Files** | `src/budget.ts`, `src/pricing.ts`, `src/billing/types.ts`, `src/nft-routing-config.ts` |
| **Description** | Import and use: `computeCostMicro()`/`computeCostMicroSafe()` (validate against local `calculateCostMicro`), `verifyPricingConservation()`, `validateBillingEntry()`, `isValidNftId()`/`parseNftId()`, `isKnownReputationState()`, vocabulary constants (`REPUTATION_STATES`, `ECONOMIC_CHOREOGRAPHY`, `TRANSFER_INVARIANTS`). |
| **Acceptance** | Protocol functions imported. Consistency tests verify local and protocol functions agree on same inputs. Vocabulary constants used in documentation/logging. |
| **Blocked by** | 2.1 |

### Task 2.6 — Shadow-mode access policy evaluation

| Field | Value |
|-------|-------|
| **FR** | FR-12 |
| **Files** | `src/hounfour/pool-enforcement.ts` |
| **Description** | Import `evaluateAccessPolicy()` and run with documented rollout ladder. Rename modes: `observe` (log-only, no enforcement), `asymmetric` (protocol-deny overrides local-allow, protocol-allow does NOT override local-deny), `enforce` (protocol result replaces local result). Controlled by `ECONOMIC_BOUNDARY_ACCESS_POLICY_ENFORCEMENT` env var (observe/asymmetric/enforce, default: observe). Log divergence with structured fields. Document rollout ladder in code comments: observe → asymmetric → enforce, with criteria for each promotion (e.g., <1% divergence rate for 7 days to promote observe→asymmetric). |
| **Acceptance** | `evaluateAccessPolicy()` runs on every request. `observe` mode: logs divergence only, never blocks. `asymmetric` mode: protocol deny blocks even when local allows. `enforce` mode: protocol result used directly. Divergence logged with account_id, pool_id, local_result, protocol_result. Test: all 3 modes with protocol-deny + local-allow scenario. Rollout ladder documented in code. |
| **Blocked by** | 2.4 |

### Task 2.7 — Update protocol handshake feature detection

| Field | Value |
|-------|-------|
| **FR** | FR-16, FR-17, FR-17a |
| **Files** | `src/hounfour/protocol-handshake.ts`, `tests/finn/protocol-handshake.test.ts` |
| **Description** | Extend `PeerFeatures` with `capabilityScopedTrust` (v7.6.0+), `economicBoundary` (v7.9.0+), and `constraintOrigin` (v7.9.0+). Create `FEATURE_VERSIONS` registry mapping all 4 feature names to introduction versions. Use semver comparison (not hardcoded booleans). Handle parse failures: try/catch with all-false default (fail-closed). Handle prerelease: treat as < release for same major.minor. |
| **Acceptance** | 5 simulated peer versions pass (v4.6.0, v6.0.0, v7.0.0, v7.6.0, v7.9.2) — all 4 flags correct for each version. Malformed version -> all features false. Prerelease "7.9.0-rc.1" -> economicBoundary false. Structured log line includes all 4 feature flags (`trustScopes`, `capabilityScopedTrust`, `economicBoundary`, `constraintOrigin`). |
| **Blocked by** | 2.1 |

---

## Sprint 3: Decision Engine + Choreography (global-128)

**Goal**: Integrate `evaluateEconomicBoundary()` as the pre-invocation gate (step 2 in the enforcement choreography), wire it into invoke/oracle routes, verify choreography failure semantics, and update documentation.

**Exit criteria**: Economic boundary middleware active on all invoke/oracle routes, 4 choreography failure scenarios tested, runtime feature flag operational, observability metrics emitting, code reality updated.

### Task 3.1 — Economic boundary adapter + snapshot builders

| Field | Value |
|-------|-------|
| **FR** | FR-4, FR-5 |
| **Files** | `src/hounfour/economic-boundary.ts` (NEW) |
| **Description** | Create economic boundary adapter. Implement `TIER_TRUST_MAP` (typed `Record<string, TrustLevel>`, validated at boot against protocol tier definitions). Implement `buildCapabilityScopedTrust()` (populates 6D trust from JWT claims.trust_scopes). Implement `buildTrustSnapshot()` (returns null on missing pool_id or unknown tier — fail-closed). Implement `buildCapitalSnapshot()` (reads budget.snapshot(), returns null on any failure — fail-closed). Import `EconomicBoundarySchema` from `@0xhoneyjar/loa-hounfour/economy`. Capital snapshot is a coarse pre-check — budget reserve is the authoritative contention point. Env flag interaction matrix: document valid combinations of `ECONOMIC_BOUNDARY_MODE` × `ECONOMIC_BOUNDARY_ACCESS_POLICY_ENFORCEMENT` (6 cells). Add startup validation: reject invalid env values with descriptive error (e.g., `ECONOMIC_BOUNDARY_MODE=foo` → process exits with message listing valid values). |
| **Acceptance** | `buildTrustSnapshot` returns valid snapshot with correct tier->trust mapping. Returns null when pool_id missing or tier unknown. `buildCapitalSnapshot` returns valid snapshot from budget state. Returns null on budget.snapshot() failure. Boot-time `validateTierTrustMap()` throws if protocol tier missing from map. |
| **Blocked by** | Sprint 2 complete |

### Task 3.2 — Economic boundary middleware

| Field | Value |
|-------|-------|
| **FR** | FR-4 |
| **Files** | `src/hounfour/economic-boundary.ts`, `src/server.ts` |
| **Description** | Create `economicBoundaryMiddleware()` that runs UNCONDITIONALLY (local decision engine, not gated on peer features). Policy denials return 403. Infrastructure errors (snapshot unavailable, schema failure, exceptions) return 503 with `error_type: "infrastructure"`. Validate combined `{ trust, capital }` input against `EconomicBoundarySchema.safeParse()`. Entire middleware wrapped in try/catch. Implement `ECONOMIC_BOUNDARY_MODE` env var (enforce/shadow/bypass) for safe production rollout. Add observability: `economic_boundary_evaluations_total` counter, `economic_boundary_latency_ms` histogram, structured log on every evaluation. |
| **Acceptance** | Middleware compiles and mounts. Policy denial -> 403 with denial_codes. Infra error -> 503 with error_type. Schema validation failure -> 503. Unhandled exception -> 503 (no provider call). `ECONOMIC_BOUNDARY_MODE=bypass` skips evaluation. `shadow` mode logs but allows — structured log includes `{ mode: "shadow", decision, denial_codes, trust_tier, latency_ms }` and divergence from local-only path is tracked with SLO threshold (>5% divergence rate triggers alert). Performance budget: p95 < 2ms, p99 < 5ms (pure computation, no I/O). Metrics emitting. **Circuit breaker** on snapshot failures: after 5 consecutive failures in 30s, circuit opens. Behavior is **mode-aware**: `enforce` mode → 503 (fail-closed — authorization gate must not silently bypass); `shadow` mode → allow through (observability-only, no security impact). Resets on next successful snapshot after 60s cooldown (half-open). |
| **Blocked by** | 3.1 |

### Task 3.3 — Choreography failure tests

| Field | Value |
|-------|-------|
| **FR** | FR-5a |
| **Files** | `tests/finn/economic-boundary.test.ts` (NEW) |
| **Description** | Test all 4 failure scenarios from SDD section 6.3. Steps 5-6 test EXISTING behaviors (WAL compensating entries via `billing-conservation-guard.ts`, DLQ via `billing-finalize-client.ts` — no new implementation needed). Steps 1-2 test NEW economic boundary behavior. Scenarios: (1) Step 2 denial -> no provider call, no billing (NEW). (2) Step 5 conservation failure -> no billing commit (EXISTING `BillingConservationGuard` behavior — verify no regression). (3) Step 6 finalize failure -> DLQ entry (EXISTING `BillingFinalizeClient` DLQ behavior — verify no regression). (4) Successful full lifecycle -> all 6 steps execute (integration). Also test new infra error paths: budget.snapshot throws -> 503, schema validation fails -> 503, trust snapshot null -> 503. |
| **Acceptance** | All 4 choreography scenarios pass. Infrastructure error tests pass (503 for snapshot/schema/exception failures, 403 for policy denials). No provider call on boundary denial. Steps 5-6 assertions verify existing behavior is preserved. TOCTOU concurrency test: two concurrent requests where economic boundary allows but budget reserve denies (race between snapshot read and reserve write) — verify second request gets 402/503, not silent overcommit. |
| **Blocked by** | 3.2 |

### Task 3.4 — Wire economic boundary into invoke/oracle paths

| Field | Value |
|-------|-------|
| **FR** | FR-4 |
| **Files** | `src/server.ts`, `src/routes/invoke.ts`, `src/routes/oracle.ts` |
| **Description** | Wire `economicBoundaryMiddleware` after `hounfourAuth` and before budget reserve on both invoke and oracle routes. Position in middleware chain: JWT Auth -> Economic Boundary -> Budget Reserve -> Provider Call -> Conservation Guard -> Billing Finalize. Add route-level test asserting middleware ordering (auth before boundary, boundary before reserve). |
| **Acceptance** | Middleware active on `/api/v1/invoke` and `/api/v1/oracle` routes. Request with insufficient trust/capital gets 403 before provider call. Existing tests still pass (middleware in enforce mode with valid tenants). Route-level ordering test passes. |
| **Blocked by** | 3.1, 3.2 |

### Task 3.5 — Graceful degradation for pre-v7.9 peers

| Field | Value |
|-------|-------|
| **FR** | FR-17a |
| **Files** | `src/hounfour/economic-boundary.ts` |
| **Description** | Verify economic boundary runs unconditionally regardless of peer features. When `!peerFeatures.economicBoundary` or `!peerFeatures.capabilityScopedTrust`, trust snapshot uses flat `trust_level` only (no 6D trust). Log degraded mode at WARN with feature name, remote version, and introduction version. |
| **Acceptance** | With peer at v4.6.0: boundary evaluates using flat trust, logs degradation warning. With peer at v7.9.2: boundary uses full 6D trust. Both cases: evaluation runs (never skipped). |
| **Blocked by** | 3.4, 2.7 (requires PeerFeatures including `capabilityScopedTrust`) |

### Task 3.6 — Update hounfour code reality

| Field | Value |
|-------|-------|
| **FR** | FR-18 |
| **Files** | `grimoires/oracle/code-reality-hounfour.md` |
| **Description** | Update the hounfour code reality document to reflect v7.9.2 exports, new modules, updated import map, and new protocol functions. Include: `evaluateEconomicBoundary`, `evaluateFromBoundary`, `EconomicBoundarySchema`, `parseMicroUsd`, `MicroUSDC`/`readMicroUSDC`, `evaluateAccessPolicy`, `ConstraintOrigin`, `CapabilityScopedTrust`, 202 conformance vectors. |
| **Acceptance** | Reality doc reflects v7.9.2. All new exports documented. Import map updated. No stale v7.0.0 references. |
| **Blocked by** | 3.5 |

---

## Risk Matrix

| # | Risk | Sprint | Mitigation |
|---|------|--------|------------|
| R1 | v7.9.2 export-map changes break imports | 1 | Task 1.3 abort gate — stop if resolution fails |
| R2 | Vector count != 202 | 1 | Self-verifying loader with hard count assertion |
| R3 | MicroUSDC brand symbol mismatch -> TS errors | 2 | Centralized re-export + compile-time brand verification |
| R4 | Economic boundary adds latency | 3 | Pure computation (<1ms); benchmark in acceptance test |
| R5 | Handshake feature detection edge cases | 2 | 5 simulated peer versions + malformed/prerelease tests |
| R6 | Negative values leak to strict boundary | 2 | Property test + nominal StrictMicroUSD branding |
| R7 | Shadow access policy diverges from tier checks | 2 | Asymmetric mode: protocol-deny overrides local-allow |

---

## Success Criteria (All Sprints)

- [ ] `pnpm install` clean — no postinstall patching
- [ ] ~1,105+ existing tests pass (zero regressions)
- [ ] 202/202 conformance vectors pass
- [ ] No `as unknown as` casts at protocol boundaries
- [ ] `StrictMicroUSD` nominally branded (compile-time verification)
- [ ] `MicroUSDC` migrated to single protocol source of truth
- [ ] `EFFECTIVE_JTI_POLICY` uses `Math.max` (larger replay window = stricter)
- [ ] Economic boundary middleware active on invoke + oracle routes
- [ ] 4 choreography failure scenarios tested
- [ ] Feature detection works for 5 peer versions + edge cases
- [ ] Access policy in asymmetric shadow mode
- [ ] Runtime kill-switch (`ECONOMIC_BOUNDARY_MODE`) operational
- [ ] Observability metrics emitting

---

---

## Sprint 4: Economic Boundary Hardening (global-129)

**Goal**: Address all HIGH and MEDIUM findings from [Bridgebuilder Deep Review (PR #102)](https://github.com/0xHoneyJar/loa-finn/pull/102#issuecomment-3947676926). Refactor circuit breaker to instance-per-middleware, make budget period configurable, align protocol types upstream, and hash tenant IDs in observability logs.

**Exit criteria**: Circuit breaker is instance-scoped. Budget period accepted from BudgetSnapshot. `denial_codes` type gap documented as upstream issue. Tenant ID hashed in structured logs. All existing + new tests pass.

**Source**: Bridgebuilder Review PR #102 — 2 HIGH, 2 MEDIUM findings.

### Task 4.1 — Instance-level circuit breaker (HIGH)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder HIGH — Singleton circuit breaker in multi-route context |
| **Files** | `src/hounfour/economic-boundary.ts` |
| **Description** | Refactor the module-level `CIRCUIT_BREAKER` singleton into a `CircuitBreaker` class instantiated per `economicBoundaryMiddleware()` call. Each middleware instance owns its own circuit state (failureCount, lastFailure, open flag). The class exposes `recordSuccess()`, `recordFailure()`, `isOpen()`, `reset()` methods. The `resetCircuitBreaker()` test helper resets via the instance returned from middleware factory. Constructor accepts configurable `threshold`, `windowMs`, `resetMs` with current defaults. Export the class for direct testing. |
| **Acceptance** | Two middleware instances have independent circuit state. Opening one circuit does not affect the other. Existing tests pass with updated `resetCircuitBreaker()` pattern. New test: open circuit on instance A, verify instance B still evaluates. Constructor params configurable. |
| **Blocked by** | Sprint 3 complete |

### Task 4.2 — Configurable budget period end (HIGH)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder HIGH — Budget period end hardcode blocks monetary pluralism |
| **Files** | `src/hounfour/types.ts`, `src/hounfour/economic-boundary.ts`, `tests/finn/economic-boundary.test.ts` |
| **Description** | Add optional `budget_period_end?: string` (ISO 8601) to `BudgetSnapshot` interface. In `buildCapitalSnapshot()`, use `budget.budget_period_end` when provided, fall back to current 30-day default only when absent. Log at DEBUG when using fallback. This opens the path for upstream providers (arrakis, DAOs) to supply their own budget cycles without loa-finn assuming monthly periods. |
| **Acceptance** | `BudgetSnapshot` accepts optional `budget_period_end`. When provided, capital snapshot uses it verbatim. When absent, 30-day fallback used (existing behavior preserved). Test: custom period end flows through to `CapitalLayerSnapshot.budget_period_end`. Test: absent period end uses 30-day default. No breaking changes to existing callers. |
| **Blocked by** | Sprint 3 complete |

### Task 4.3 — Protocol type alignment for denial_codes (MEDIUM)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder MEDIUM — Type extension reveals protocol-consumer contract gap |
| **Files** | `src/hounfour/economic-boundary.ts` |
| **Description** | The local `EvaluationResultWithDenials` type extension is the correct tactical fix for the `denial_codes` gap. This task: (1) Add a code comment on the type extension explaining the gap and linking to the upstream issue. (2) File an issue on [loa-hounfour](https://github.com/0xHoneyJar/loa-hounfour) requesting `denial_codes` be added to the exported `EconomicBoundaryEvaluationResult` type, referencing this PR as evidence. (3) Add a `// TODO(loa-hounfour#XX): Remove when upstream type includes denial_codes` comment. |
| **Acceptance** | Issue filed on loa-hounfour with reproduction context. Local type extension has upstream issue reference. TODO comment with issue number. |
| **Blocked by** | Sprint 3 complete |

### Task 4.4 — Tenant ID hashing in observability logs (MEDIUM)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder MEDIUM — Tenant ID logging in observability payload |
| **Files** | `src/hounfour/economic-boundary.ts`, `tests/finn/economic-boundary.test.ts` |
| **Description** | Replace raw `tenant_id` in structured log payloads with a hashed identifier using `createHash('sha256').update(tenant_id).digest('hex').slice(0, 16)` (truncated to 16 chars for log readability). This preserves correlation (same tenant always produces same hash) while preventing PII leakage to external log sinks (Datadog, Grafana Cloud). Import `createHash` from `node:crypto`. Keep raw `tenant_id` in 403 response bodies (those go to the authenticated tenant, not to logs). **Log capture strategy**: Tests use `vi.spyOn(console, 'warn')` and `vi.spyOn(console, 'log')` to capture structured log calls (existing pattern in economic-boundary.test.ts lines 294, 544, 576). The middleware already emits logs via `console.warn`/`console.log` with JSON.stringify payloads, so parsing the second argument of the spy call provides deterministic assertion on payload fields. |
| **Acceptance** | Structured logs contain `tenant_hash` (16-char hex) instead of raw `tenant_id`. 403 response bodies still contain raw `tenant_id` for debugging. Same tenant always produces same hash (deterministic). Test (via `vi.spyOn(console, 'warn')`): parse JSON from log call, verify payload contains `tenant_hash` field and does NOT contain `tenant_id` field. Test: verify 403 response body still contains raw `tenant_id`. |
| **Blocked by** | Sprint 3 complete |

### Task 4.5 — Comprehensive test harness for Sprint 4 changes

| Field | Value |
|-------|-------|
| **Finding** | All Sprint 4 findings |
| **Files** | `tests/finn/economic-boundary.test.ts` |
| **Description** | Add test sections for: (1) Instance circuit breaker isolation — two independent breakers, open one, verify other evaluates. (2) Configurable budget period — custom period flows through, absent uses default. (3) Tenant hash — structured log contains hash not raw ID, 403 contains raw ID. (4) Circuit breaker constructor params — custom threshold/window/reset. |
| **Acceptance** | All new tests pass. All existing tests pass (no regressions). Tests cover both happy path and edge cases for each finding. |
| **Blocked by** | 4.1, 4.2, 4.3, 4.4 |

### Task 4.6 — Update code reality documentation

| Field | Value |
|-------|-------|
| **Finding** | Documentation maintenance |
| **Files** | `grimoires/oracle/code-reality-hounfour.md` |
| **Description** | Update the hounfour code reality to document: instance circuit breaker pattern, configurable budget period end, tenant ID hashing approach, and the denial_codes type gap (with upstream issue reference). |
| **Acceptance** | Reality doc reflects Sprint 4 changes. No stale information. |
| **Blocked by** | 4.5 |

---

## Sprint 5: Test Depth + Dynamic Reputation Foundation (global-130)

**Goal**: Address all LOW and SPECULATION findings from [Bridgebuilder Deep Review (PR #102)](https://github.com/0xHoneyJar/loa-finn/pull/102#issuecomment-3947676926). Complete circuit breaker test coverage, add interaction matrix tests, and lay the foundation for dynamic reputation scoring with the "authoritative" tier mapping.

**Exit criteria**: Half-open circuit breaker transition tested with time manipulation. Interaction matrix has cross-mode tests. `TIER_TRUST_MAP` includes "authoritative" mapping. Blended score weighting interface defined. All tests pass.

**Source**: Bridgebuilder Review PR #102 — 2 LOW, 2 SPECULATION findings.

### Task 5.1 — Half-open circuit breaker time-travel tests (LOW)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder LOW — Consider testing half-open circuit breaker transition |
| **Files** | `tests/finn/economic-boundary.test.ts` |
| **Description** | Add tests that manipulate `Date.now()` (via `vi.spyOn(Date, 'now')`) to verify the half-open transition. Scenarios: (1) Circuit opens after threshold failures. (2) Advance time past `RESET_MS` cooldown. (3) Next request attempts evaluation (half-open). (4a) If evaluation succeeds → circuit fully closes. (4b) If evaluation fails → circuit re-opens immediately (no gradual recovery). Also test: time advances to just *before* cooldown → circuit stays open. |
| **Acceptance** | Time-travel test verifies half-open transition at exact cooldown boundary. Success in half-open → circuit closes. Failure in half-open → circuit re-opens. Off-by-one test at cooldown boundary (cooldown-1ms stays open, cooldown+1ms goes half-open). |
| **Blocked by** | Sprint 4 complete (uses instance circuit breaker from 4.1) |

### Task 5.2 — Interaction matrix cross-mode tests (LOW)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder LOW — Consider documenting the interaction matrix in tests |
| **Files** | `tests/finn/economic-boundary.test.ts` |
| **Description** | The interaction matrix (economic-boundary.ts:13-21) defines 9 cells for `ECONOMIC_BOUNDARY_MODE × ECONOMIC_BOUNDARY_ACCESS_POLICY_ENFORCEMENT`. Add a `describe("Interaction matrix")` block that tests the 4 most critical cells: (1) `shadow × observe` — both log, neither enforces. (2) `shadow × enforce` — AP enforces, EB logs. (3) `enforce × observe` — EB enforces, AP logs. (4) `enforce × enforce` — both enforce, EB denial takes precedence (returns 403 before AP evaluates). These tests require the access policy evaluation from Task 2.6 to be wired in. If not yet in enforce mode, test at the middleware level using mode overrides. |
| **Acceptance** | 4 cross-mode interaction tests pass. Each test verifies the correct behavior per the documented matrix. Comments reference the matrix table in the source file. |
| **Blocked by** | Sprint 4 complete, Task 2.6 (access policy wiring required for AP × EB cross-mode tests) |

### Task 5.3 — "Authoritative" tier mapping + reputation interface (SPECULATION)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder SPECULATION — From static tiers to dynamic reputation |
| **Files** | `src/hounfour/economic-boundary.ts`, `src/hounfour/types.ts`, `tests/finn/economic-boundary.test.ts` |
| **Description** | Extend `TIER_TRUST_MAP` with an `authoritative` entry: `{ reputation_state: "authoritative", blended_score: 95 }`. This is the tier that money cannot buy — it requires behavioral evidence beyond subscription level. Define a `ReputationProvider` interface: `{ getReputationBoost(tenantId: string): Promise<{ boost: number; source: string } | null> }`. In `buildTrustSnapshot()`, accept an optional `reputationProvider` parameter. When provided and tenant tier is "enterprise", query for a reputation boost using `Promise.race([provider.getReputationBoost(tenantId), rejectAfter(5)])` where `rejectAfter(ms)` creates a timeout via `setTimeout`. 5ms timeout chosen to stay within the 2ms p95 evaluation budget (snapshot build is one of several steps). If boost exists and meets threshold (e.g., boost >= 15), upgrade reputation_state to "authoritative" and add boost to blended_score. When provider is absent, returns null, throws, or times out — use static mapping (existing behavior preserved, fail-closed). |
| **Acceptance** | `TIER_TRUST_MAP.authoritative` exists and passes boot-time validation. `ReputationProvider` interface exported from types.ts. `buildTrustSnapshot()` accepts optional provider. Without provider: existing behavior unchanged (all tests pass). With provider returning boost >= 15 for enterprise tenant: reputation upgrades to "authoritative". With provider returning null: static mapping used. With provider throwing: static mapping used (fail-closed, logged at WARN). With provider exceeding 5ms timeout (tested via `vi.useFakeTimers()`): static mapping used (fail-closed, logged at WARN). |
| **Blocked by** | Sprint 4 complete |

### Task 5.4 — Blended score weighting foundation (SPECULATION)

| Field | Value |
|-------|-------|
| **Finding** | Bridgebuilder SPECULATION — blended_score = α × tier_base + β × behavioral_score |
| **Files** | `src/hounfour/economic-boundary.ts`, `tests/finn/economic-boundary.test.ts` |
| **Description** | Create `computeBlendedScore(tierBase: number, behavioralBoost: number, weights?: { alpha: number; beta: number }): number`. Default weights: `{ alpha: 0.7, beta: 0.3 }` (tier-dominant, behavioral supplementary). Score clamped to `[0, 100]`. When `ReputationProvider` returns a boost, `buildTrustSnapshot()` uses `computeBlendedScore(tierMapping.blended_score, boost)` instead of raw `tierMapping.blended_score`. Export weights as `DEFAULT_BLENDING_WEIGHTS` for documentation and override. This is the foundation for dynamic reputation scoring — the weights can be tuned per-community as governance evolves. |
| **Acceptance** | `computeBlendedScore(50, 30)` → `Math.round(0.7*50 + 0.3*30)` = 44 (integer). Score clamped: `computeBlendedScore(90, 100)` ≤ 100. Custom weights: `computeBlendedScore(50, 30, {alpha: 0.5, beta: 0.5})` → 40. **Epsilon weight validation**: `Math.abs(alpha + beta - 1) < 1e-9` (throw if violated — handles IEEE-754 non-terminating decimals like 0.1+0.2). All score assertions use `toBeCloseTo(expected, 0)` (integer precision), not exact equality. Final score always `Math.round()` to integer, clamped [0, 100]. Integration test: enterprise tenant with behavioral boost → blended score > static score. |
| **Blocked by** | 5.3 |

### Task 5.5 — Update documentation and code reality

| Field | Value |
|-------|-------|
| **Finding** | Documentation + REFRAME |
| **Files** | `grimoires/oracle/code-reality-hounfour.md` |
| **Description** | Update code reality to document: (1) `ReputationProvider` interface and its role in the trust snapshot pipeline. (2) `computeBlendedScore()` and the weighting model. (3) The "authoritative" tier and what it represents (earned through behavior, not purchased). (4) The interaction matrix with all 9 cells documented. (5) The circuit breaker half-open transition behavior. Reference the REFRAME from Bridgebuilder: "This isn't convergence — it's fluency." |
| **Acceptance** | Reality doc covers all Sprint 5 additions. ReputationProvider documented with usage examples. Blending weights explained. Authoritative tier described as behavioral, not transactional. |
| **Blocked by** | 5.4 |

---

## Risk Matrix (Updated)

| # | Risk | Sprint | Mitigation |
|---|------|--------|------------|
| R1 | v7.9.2 export-map changes break imports | 1 | Task 1.3 abort gate — stop if resolution fails |
| R2 | Vector count != 202 | 1 | Self-verifying loader with hard count assertion |
| R3 | MicroUSDC brand symbol mismatch -> TS errors | 2 | Centralized re-export + compile-time brand verification |
| R4 | Economic boundary adds latency | 3 | Pure computation (<1ms); benchmark in acceptance test |
| R5 | Handshake feature detection edge cases | 2 | 5 simulated peer versions + malformed/prerelease tests |
| R6 | Negative values leak to strict boundary | 2 | Property test + nominal StrictMicroUSD branding |
| R7 | Shadow access policy diverges from tier checks | 2 | Asymmetric mode: protocol-deny overrides local-allow |
| R8 | Instance circuit breaker increases memory per route | 4 | Negligible — 5 primitives per instance (<100 bytes) |
| R9 | Tenant hash collision at 16 chars | 4 | 16 hex chars = 64-bit space, sufficient for operational correlation |
| R10 | ReputationProvider latency in trust snapshot | 5 | Fail-closed with timeout; provider failure uses static mapping |
| R11 | Blending weights misconfigured (α + β ≠ 1.0) | 5 | Epsilon validation (`Math.abs(α+β-1) < 1e-9`) throws on mismatch; final score `Math.round()` to integer eliminates float drift |

---

## Success Criteria (All Sprints)

- [ ] `pnpm install` clean — no postinstall patching
- [ ] ~1,105+ existing tests pass (zero regressions)
- [ ] 202/202 conformance vectors pass
- [ ] No `as unknown as` casts at protocol boundaries
- [ ] `StrictMicroUSD` nominally branded (compile-time verification)
- [ ] `MicroUSDC` migrated to single protocol source of truth
- [ ] `EFFECTIVE_JTI_POLICY` uses `Math.max` (larger replay window = stricter)
- [ ] Economic boundary middleware active on invoke + oracle routes
- [ ] 4 choreography failure scenarios tested
- [ ] Feature detection works for 5 peer versions + edge cases
- [ ] Access policy in asymmetric shadow mode
- [ ] Runtime kill-switch (`ECONOMIC_BOUNDARY_MODE`) operational
- [ ] Observability metrics emitting
- [ ] Circuit breaker is instance-scoped (no shared state between routes)
- [ ] Budget period end configurable from upstream provider
- [ ] Tenant ID hashed in structured logs (PII protection)
- [ ] Half-open circuit breaker transition tested with time manipulation
- [ ] Interaction matrix cross-mode behavior verified
- [ ] "Authoritative" reputation state mapped and reachable via behavioral evidence
- [ ] Blended score weighting foundation with configurable α/β weights

---

*30 tasks. 5 sprints. Sprints 1-3: pure protocol adoption. Sprint 4: hardening from Bridgebuilder HIGH/MEDIUM findings. Sprint 5: test depth and dynamic reputation foundation from LOW/SPECULATION findings.*
