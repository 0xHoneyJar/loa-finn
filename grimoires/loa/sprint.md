# Sprint Plan: Protocol Convergence — loa-hounfour v5.0.0 → v7.0.0

> **Version**: 1.0.0
> **Date**: 2026-02-18
> **Cycle**: cycle-026
> **PRD**: `grimoires/loa/prd.md` v1.1.0 (Flatline-integrated)
> **SDD**: `grimoires/loa/sdd.md` v1.0.0 (Flatline-integrated)
> **Global Sprint IDs**: 65–67
> **Developer**: Claude Opus 4.6 (autonomous via `/run sprint-plan`)

---

## Sprint Overview

| Sprint | Global ID | Label | Goal | Tasks |
|--------|-----------|-------|------|-------|
| sprint-1 | 65 | Foundation — Bump + Cleanup + Safety Gates | Get to v7.0.0 with all safety gates green | 9 |
| sprint-2 | 66 | Type Adoption — Branded Types + Evaluator | Canonical types everywhere, evaluator operational | 10 |
| sprint-3 | 67 | Knowledge + Hardening | Oracle up to date, production hardening complete | 6 |

**Total**: 25 tasks across 3 sprints

**Dependencies**: Sprint 1 → Sprint 2 → Sprint 3 (strictly sequential — each sprint is independently shippable)

**Test Baseline**: 200 tests total, 187 passing, 13 pre-existing failures. Zero regression allowed.

**Pre-existing failure inventory** (must be enumerated before Sprint 1 starts):

| Test File | Failure Signature | Ticket/Reason |
|-----------|------------------|---------------|
| `reconciliation-e2e.test.ts` | Reconciliation flow failures | Pre-existing, unrelated to protocol |
| `s2s-jwt.test.ts` | JWT signing/verification failures | Pre-existing, may overlap with wire-compat (Sprint 1 coverage target) |
| `usage-handler.test.ts` | Usage tracking failures | Pre-existing, unrelated to protocol |

Any test NOT in this inventory that fails after migration is a **new regression** and blocks the sprint gate. This inventory must be refreshed at Sprint 1 start with exact test names, failure messages, and count.

**Rollback contract**: Each sprint is independently shippable. Rollback runbook (PRD §9) applies per-sprint. Every sprint gate includes a link to the rollback procedure and verification steps.

---

## Sprint 1: Foundation — Bump + Cleanup + Safety Gates (Global ID: 65)

**Objective**: Upgrade from v5.0.0 to v7.0.0 with comprehensive safety verification. Independently shippable — after this sprint, loa-finn runs on v7.0.0 with all existing functionality preserved.

**Gate**: Schema audit artifact committed, all golden wire fixtures green, `tsc --noEmit` clean, ≥187 tests passing, interop handshake fixture passes.

**Rollback**: Revert PR, re-pin `package.json` to previous commit SHA, `npm ci`, verify golden wire fixtures + ≥187 tests. RTO < 15 min. See PRD §9 rollback runbook.

### Task 1.1: Create Golden Wire Fixtures (BEFORE Bump)

**Description**: Generate deterministic JSON snapshot test fixtures from the current v5.0.0 behavior. These fixtures serve as the wire-compatibility canary — they must pass AFTER the version bump.

**Wire surface scope** — what "stable" means for each fixture type:

| Surface | Stability Rule | Comparison Method |
|---------|---------------|-------------------|
| JSON request/response bodies (billing, stream events) | Byte-for-byte via `json-stable-stringify` | `Buffer.compare` on canonical JSON |
| JWT claims payload | Byte-for-byte on canonicalized claims JSON | `json-stable-stringify(claims)` match |
| JWT signed token | Structural equivalence only (ES256 non-deterministic) | Decode → compare header fields + claims, verify signature separately |
| HTTP headers (Content-Type, etc.) | Name + value match | String equality on relevant headers |

**Files created**:
- `tests/fixtures/wire/jwt-claims.fixture.json` — Complete JWT claims payload with fixed `iat`/`exp`/`jti`
- `tests/fixtures/wire/billing-request.fixture.json` — Billing finalize request body with fixed costs
- `tests/fixtures/wire/billing-response.fixture.json` — Billing finalize response body with fixed totals
- `tests/fixtures/wire/stream-event.fixture.json` — Stream event envelope with fixed delta/usage
- `tests/fixtures/keys/es256-test.key` + `es256-test.pub` — Deterministic test ES256 keypair
- `tests/finn/wire-fixtures.test.ts` — Fixture verification test suite

**Determinism rules** (SDD §11.1):
- Timestamps: `iat: 1700000000, exp: 1700003600`
- Nonce: `"test-jti-fixture-001"`
- JSON format: `json-stable-stringify` (compact, deterministic key order)
- JWT: Claims-only golden (ES256 signatures are non-deterministic per RFC 6979). Sign at runtime, verify structurally.
- `req_hash`: SHA-256 of fixed request body, verified end-to-end

**Canonicalization contract** (per surface):

| Surface | Omit-defaults | Null/undefined | Numeric strings | Policy |
|---------|--------------|----------------|-----------------|--------|
| Billing JSON | Omit `undefined`, preserve explicit `null` | `null` preserved on wire | MicroUSD as canonical string (no leading zeros) | Byte-for-byte via `json-stable-stringify` |
| Stream event JSON | Same as billing | Same | N/A | Byte-for-byte via `json-stable-stringify` |
| JWT claims | Omit `undefined`, preserve explicit `null` | Same | N/A | Byte-for-byte on canonicalized claims JSON |
| JWT signed token | N/A | N/A | N/A | Structural equivalence only |

**Fixture update policy**: Any fixture change requires: (1) schema-audit justification documenting why the wire format changed, (2) reviewer sign-off, (3) arrakis compatibility assessment. Unjustified fixture changes are treated as regressions.

**Acceptance criteria**:
- [ ] All fixture files committed to `tests/fixtures/wire/`
- [ ] ES256 test keypair committed to `tests/fixtures/keys/`
- [ ] `wire-fixtures.test.ts` validates each fixture against current v5.0.0 TypeBox schemas
- [ ] JSON body fixtures use `json-stable-stringify` and compare byte-for-byte
- [ ] JWT fixture: claims compared byte-for-byte (canonicalized), signature verified separately (not snapshot)
- [ ] JWT fixture: JWS protected header fields asserted (alg, typ) but full token NOT byte-compared
- [ ] Canonicalization contract documented per surface (omit-defaults, null/undefined, numeric strings)
- [ ] Fixture update policy documented (schema-audit justification + reviewer sign-off required)
- [ ] All fixture tests pass on current v5.0.0

---

### Task 1.2: Schema Audit (v5.0.0 → v7.0.0)

**Description**: Perform a comprehensive 9-dimension schema audit comparing every imported symbol between v5.0.0 and v7.0.0. This task has two phases:

**Phase A (pre-bump)**: Clone/checkout v7.0.0 tag from loa-hounfour repo to a temp directory. Auto-generate a complete import/usage manifest by scanning all `*.ts` files for imports from `@0xhoneyjar/loa-hounfour` (grep/tsserver). Diff every imported schema and vocabulary against v5.0.0 (currently in `node_modules/`). Produce the initial audit artifact with per-schema results. The auto-generated manifest ensures no imported symbol is missed.

**Phase B (post-bump, after Task 1.4)**: Finalize the audit artifact by recording the lockfile-resolved commit SHA (`tag_sha` field) and verifying TypeBox peer dependency alignment against loa-finn's installed version.

**Audit dimensions** (PRD §FR-1):
1. Required fields added
2. Optional fields + defaults changed
3. Patterns/regex tightened or changed
4. Enum/vocabulary members added/removed/renamed
5. `additionalProperties` changed
6. Nullable/union changes narrowed
7. Numeric bounds changed
8. Validator strictness (TypeBox config)
9. TypeBox peer dependency compatibility

**Schemas to audit**: `JwtClaimsSchema`, `InvokeResponseSchema`, `StreamEventSchema`, `RoutingPolicySchema`, `CostBreakdownSchema`, `PoolId` vocabulary, all imported types.

**Files created**:
- `grimoires/loa/a2a/schema-audit-v5-v7.json` — Per-schema diff with 9-dimension checklist

**Acceptance criteria**:
- [ ] Phase A: Audit artifact committed with per-schema results and overall verdict (pre-bump)
- [ ] Phase A: No new required fields on any wire-format schema
- [ ] Phase A: All additive optional fields and their defaults documented
- [ ] Phase A: PoolId vocabulary diff: members added/removed/renamed documented
- [ ] Phase A: If PoolId vocabulary has non-additive changes, execute decision tree:
  - **Removed members**: Check production usage (ledger/Redis), create compatibility map in `parsePoolId()`, flag for arrakis coordination, block release until mapping verified
  - **Renamed members**: Add alias map in `parsePoolId()` (accept old → normalize to new), log deprecated usage, time-bound removal after arrakis migrates
  - **No changes**: Confirm with vocabulary snapshot test
- [ ] Phase A: Auto-generated import manifest included (all symbols from `@0xhoneyjar/loa-hounfour` enumerated)
- [ ] Phase B: `tag_sha` field records resolved commit SHA from lockfile (post-bump)
- [ ] Phase B: TypeBox peer dependency compatibility confirmed against installed version

---

### Task 1.3: Delete Local Package + ESLint Rule

**Description**: Remove the stale `packages/loa-hounfour/` local package (1,158 LOC across ~15 files) and add ESLint enforcement preventing imports from deleted paths.

**Comprehensive search** (PRD §FR-1):
- Workspace protocol entries in root `package.json`
- `tsconfig.json` path mappings
- `file:` protocol references
- Deep imports (`@0xhoneyjar/loa-hounfour/dist/...`)
- Compiled JS containing `packages/loa-hounfour` strings

**Files modified**:
- `package.json` — Remove workspace reference (if any)
- `tsconfig.json` — Remove packages/ path mapping (if any)
- `.eslintrc` / `eslint.config.*` — Add `no-restricted-imports` for local package paths

**Files deleted**:
- `packages/loa-hounfour/` (entire directory)

**Acceptance criteria**:
- [ ] `packages/loa-hounfour/` directory does not exist
- [ ] No path aliases, workspace refs, or deep imports reference the deleted local package
- [ ] ESLint `no-restricted-imports` rule blocks any future imports from deleted paths
- [ ] `grep -r "packages/loa-hounfour" --include="*.ts" --include="*.json"` returns zero matches

---

### Task 1.4: Bump Dependency to v7.0.0

**Description**: Update `package.json` to point at the v7.0.0 **immutable commit SHA** and install. Mutable git tags can be force-pushed; pinning to the resolved SHA ensures reproducible builds.

**Changes**:
- Resolve the v7.0.0 tag to its commit SHA: `git ls-remote https://github.com/0xHoneyJar/loa-hounfour.git refs/tags/v7.0.0`
- `package.json`: `"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#<RESOLVED_SHA>"` — pin to the immutable commit SHA, NOT the mutable tag
- Run `npm install` to update lockfile
- Record resolved commit SHA in schema audit artifact

**Immutable SHA pinning** (SKP-006):
- The `package.json` specifier MUST use the full 40-character commit SHA, not `#v7.0.0`
- Document the tag→SHA mapping in the schema audit artifact: `{ tag: "v7.0.0", sha: "<RESOLVED_SHA>", resolved_at: "<ISO-8601>" }`
- CI enforcement: add a lint check that rejects `github:...#v` patterns in `package.json` dependencies (only `#<hex40>` allowed)
- If the tag is force-pushed after pin, the lockfile integrity check still passes because the SHA is immutable

**Supply chain verification** (SDD §7.4):
- `npm ci` records resolved commit SHA in `package-lock.json`
- Verify lockfile SHA matches the pinned SHA in `package.json`: `jq '.packages["node_modules/@0xhoneyjar/loa-hounfour"].resolved' package-lock.json`
- Verify: `node -e "console.log(require.resolve('@0xhoneyjar/loa-hounfour/package.json'))"` resolves to `node_modules/`, not `packages/`
- Verify: `node -e "const p = require('@0xhoneyjar/loa-hounfour/package.json'); console.log(p.version);"` outputs `7.0.0`

**Acceptance criteria**:
- [ ] `package.json` references `github:0xHoneyJar/loa-hounfour#<FULL_40_CHAR_SHA>` (NOT the mutable tag)
- [ ] Tag→SHA mapping documented in schema audit artifact
- [ ] CI lint check rejects mutable tag references (`#v...`) in `package.json` dependencies
- [ ] `package-lock.json` updated with matching resolved commit SHA
- [ ] `require.resolve` points to `node_modules/`, not `packages/`
- [ ] Package version confirms `7.0.0`

---

### Task 1.5: Fix Compilation Errors

**Description**: Run `tsc --noEmit` and fix all compilation errors resulting from the version bump and local package deletion. Update import paths as needed.

**Expected changes**:
- Import paths that referenced `packages/loa-hounfour/` → `@0xhoneyjar/loa-hounfour`
- New exports in v7.0.0 that may have name changes
- TypeBox schema references

**Files modified**: Any file that fails compilation (estimated: `src/hounfour/*.ts`, `tests/finn/*.ts`)

**Acceptance criteria**:
- [ ] `tsc --noEmit` passes with zero errors
- [ ] All imports from `@0xhoneyjar/loa-hounfour` resolve correctly
- [ ] No type errors in any source or test file

---

### Task 1.6: Protocol Handshake Update

**Description**: Update `src/hounfour/protocol-handshake.ts` to advertise v7.0.0 while maintaining backward compatibility with arrakis at v4.6.0.

**Changes** (SDD §4.3):
- `CONTRACT_VERSION` imported from package (now `'7.0.0'`)
- `FINN_MIN_SUPPORTED = '4.0.0'` hardcoded in loa-finn (NOT imported)
- Feature detection: `trust_scopes` presence indicates v6.0.0+ peer
- Health endpoint: add protocol version in `/health` response

**Files modified**:
- `src/hounfour/protocol-handshake.ts`
- `src/config.ts` (protocol version in config)
- Health endpoint handler (protocol subsystem)

**Acceptance criteria**:
- [ ] `CONTRACT_VERSION` is `'7.0.0'`
- [ ] `FINN_MIN_SUPPORTED` is `'4.0.0'` (arrakis v4.6.0 is within range)
- [ ] Feature detection for `trust_scopes` implemented
- [ ] `/health` response includes protocol version info
- [ ] Existing handshake tests still pass

---

### Task 1.7: Interop Handshake Fixture

**Description**: Create a synthetic arrakis v4.6.0 handshake fixture to verify loa-finn v7.0.0 accepts the handshake. Document arrakis source code references.

**Prerequisite — arrakis source access**: The arrakis repo (`0xHoneyJar/arrakis`) must be accessible to construct the synthetic fixture. Steps:
1. Clone or fetch arrakis at the commit corresponding to v4.6.0 vendored protocol
2. Locate handshake construction code (file:line:commit)
3. If repo is inaccessible: fall back to contract test derived from loa-hounfour protocol docs + known wire captures from cycle-022 (PR #71 E2E billing verification)

**Two-tier verification** (PRD §FR-4):
1. **Synthetic fixture** (required): Simulated arrakis v4.6.0 handshake constructed from arrakis source code analysis. If source unavailable, construct from protocol specification + documented wire behavior.
2. **Captured traffic replay** (required — at least one real capture): Capture a real arrakis→loa-finn handshake from staging or production logs. If staging unavailable, use the wire captures from cycle-022 (PR #71 E2E billing verification) as the baseline. If NO real capture exists, this is a **release blocker** requiring manual verification with arrakis team before production deploy.

**Files created**:
- `tests/finn/interop-handshake.test.ts` — arrakis v4.6.0 handshake acceptance test

**Acceptance criteria**:
- [ ] Test verifies arrakis v4.6.0 handshake is accepted by loa-finn v7.0.0
- [ ] Test verifies `CONTRACT_VERSION_MISMATCH` error for versions below 4.0.0
- [ ] Arrakis source code reference documented (file:line:commit) OR "source unavailable" path documented with alternative evidence (protocol spec + prior wire captures)
- [ ] Captured traffic replay attempted; if unavailable, risk documented

---

### Task 1.8: Post-Bump Wire Fixture Verification

**Description**: Run all golden wire fixtures created in Task 1.1 against the v7.0.0 schemas. Verify byte-for-byte stability.

**Verification flow** (SDD §11.1):
- Load each fixture JSON
- Validate against v7.0.0 TypeBox schema (must pass)
- Parse through wire-boundary parse paths (where applicable)
- Re-serialize and compare to fixture (byte-for-byte match for JSON bodies)
- JWT: sign at runtime, verify claims structural match

**Acceptance criteria**:
- [ ] All golden wire fixtures pass against v7.0.0 schemas
- [ ] Byte-for-byte stability confirmed for billing and stream event fixtures
- [ ] JWT claims structural match confirmed
- [ ] Zero fixture changes required (if any needed, justification documented)

---

### Task 1.9: Test Suite Verification + s2s-jwt Coverage

**Description**: Run full test suite and verify ≥187 passing. Fix or independently cover the `s2s-jwt.test.ts` wire-compat surface.

**Strategy** (PRD §NFR-1):
- Preferred: Fix `s2s-jwt.test.ts` pre-existing failures if they're related to wire format
- Alternative: Create independent JWT wire fixture that covers the same surface
- Pre-existing failures in `reconciliation-e2e.test.ts`, `usage-handler.test.ts` are separate concerns

**Acceptance criteria**:
- [ ] Full test suite: ≥187 passing
- [ ] Zero new failures (compared to pre-migration baseline)
- [ ] `s2s-jwt.test.ts` wire-compat surface covered (either fixed or independently covered)
- [ ] Pre-existing 13 failures documented as separate concerns

---

## Sprint 2: Type Adoption — Branded Types + Evaluator (Global ID: 66)

**Objective**: Replace all local type equivalents with canonical branded types from v7.0.0. Wire the conservation evaluator. After this sprint, all billing invariants are enforced by both evaluator AND ad-hoc checks (strict fail-closed lattice).

**Gate**: All branded types canonical, evaluator compiled + passing, microbenchmark green, golden fixtures byte-for-byte stable, ≥207 tests passing.

**Rollback**: Revert evaluator wiring commits, circuit-open billing endpoints if needed. Ad-hoc checks still present as fallback. Sprint 1 state is valid baseline. RTO < 10 min. See PRD §9 rollback runbook.

### Task 2.1: Wire Boundary Module

**Description**: Create `src/hounfour/wire-boundary.ts` — the centralized branded type parse/serialize layer (sole constructor for branded types).

**Functions** (SDD §4.1):
- `parseMicroUSD(raw: string): MicroUSD` — Full normalization (reject empty, reject `+`, strip leading zeros, normalize `-0` → `"0"`, validate pattern)
- `parseBasisPoints(raw: number): BasisPoints` — Integer, range [0, 10000]
- `parseAccountId(raw: string): AccountId` — Pattern `/^[a-zA-Z0-9_-]+$/`
- `parsePoolId(raw: string): PoolId` — Canonical vocabulary membership
- `serializeMicroUSD`, `serializeBasisPoints`, `serializeAccountId` — Canonical output format
- `WireBoundaryError` — Structured error with `field`, `raw`, `reason`
- Module-private brand helper (`__brand`) — Stripe pattern

**MicroUSD arithmetic semantics** (must be explicit in module docs and tests):

| Aspect | Rule | Rationale |
|--------|------|-----------|
| Internal representation | `BigInt` (via `BigInt(microUsdString)`) | Exact integer arithmetic, no floating-point |
| Arithmetic operations | `BigInt` add/subtract/compare only | No division (micro-USD is smallest unit) |
| Intermediate values | Stay as `BigInt` until final serialize | Branding applies at boundary, not mid-computation |
| Rounding | Not applicable (integer arithmetic) | MicroUSD is already the smallest unit |
| Overflow | No JS overflow (BigInt is arbitrary precision) | Application budget limits apply upstream |
| Negative results | Allowed (deficit tracking) | Must serialize back via `serializeMicroUSD` |
| Type safety | Arithmetic helpers accept `MicroUSD`, return `MicroUSD` | e.g., `addMicroUSD(a: MicroUSD, b: MicroUSD): MicroUSD` |

**3-layer enforcement** (SDD §4.1):
1. Type-level: Brand symbol not exported
2. Lint-level: ESLint bans `as MicroUSD` etc. outside `wire-boundary.ts` and test files
3. Runtime-level: `assertMicroUSDFormat()` at persistence boundaries

**Files created**:
- `src/hounfour/wire-boundary.ts`
- `tests/finn/wire-boundary.test.ts` — Comprehensive test suite including all PRD MicroUSD edge cases

**Acceptance criteria**:
- [ ] All parse functions handle every edge case from PRD MicroUSD normalization table
- [ ] Round-trip property: `parse(serialize(x)) === x` for all types
- [ ] `WireBoundaryError` thrown with structured details on invalid input
- [ ] Brand symbol is module-private (not exported)
- [ ] ESLint rule bans type assertions for branded types outside wire-boundary and tests
- [ ] Tests cover: valid values, edge cases, error messages, round-trip stability

---

### Task 2.2: Branded Type Adoption — JWT + Pool Files

**Description**: Replace local type equivalents with canonical branded types in JWT auth and pool enforcement files.

**Files modified** (SDD §4.4):
- `src/hounfour/jwt-auth.ts` — `parseAccountId(claims.tenant_id)` at claim extraction
- `src/hounfour/pool-enforcement.ts` — `parsePoolId(requested)` at validation
- `src/hounfour/pool-registry.ts` — Canonical `PoolId` types
- `src/hounfour/tier-bridge.ts` — Canonical vocabulary re-exports
- `src/hounfour/nft-routing-config.ts` — Canonical `PoolId`
- `src/hounfour/types.ts` — Import branded types from `@0xhoneyjar/loa-hounfour`, remove local shadows

**Acceptance criteria**:
- [ ] Zero local type aliases that shadow canonical protocol types in these files
- [ ] All branded type creation goes through wire-boundary parse functions
- [ ] Existing pool enforcement tests pass with updated types
- [ ] Existing JWT tests pass with updated types

---

### Task 2.3: Branded Type Adoption — Billing Files

**Description**: Replace local type equivalents with canonical branded types in billing pipeline files.

**Files modified**:
- `src/hounfour/billing-finalize-client.ts` — `parseMicroUSD(cost_string)` at cost boundary, `serializeMicroUSD(total)` at response
- `src/hounfour/cost-arithmetic.ts` — `MicroUSD` branded types throughout
- `src/hounfour/budget.ts` — `parseBasisPoints(threshold)` at config load

**Exhaustive runtime boundary enforcement** (SDD §4.1):
- WAL deserialization → `parseMicroUSD(entry.total_cost_micro)` at persistence read
- R2 deserialization → `parseMicroUSD(entry.total_cost_micro)` at recovery
- Redis deserialization → `parseMicroUSD(snapshot.spent_usd)` at cache read

**Lenient read / strict write transition** (SKP-005):
Before enforcing strict parsing on persistence reads, run a one-time audit over representative stored values (WAL segments, R2 checkpoints, Redis budget snapshots) to quantify non-conforming MicroUSD data. Strategy:
- **Write path**: Always strict (`parseMicroUSD` rejects non-canonical)
- **Read path**: Use `parseMicroUSDLenient(raw)` that normalizes instead of rejecting (strip leading zeros, fix `-0`, etc.), emits `wire_boundary.lenient_normalization{field}` metric
- **Transition**: After 2 weeks of zero lenient normalization events, switch read path to strict. Metrics-driven, not time-driven.
- If non-conforming data found: document count and patterns, verify lenient parser handles all cases

**Acceptance criteria**:
- [ ] All billing math uses `MicroUSD` branded types
- [ ] Write path uses strict `parseMicroUSD` (rejects non-canonical)
- [ ] Read path uses `parseMicroUSDLenient` with normalization + metric emission
- [ ] One-time stored data audit: WAL/R2/Redis sampled for non-conforming values
- [ ] All persistence read boundaries parse through wire-boundary (lenient initially)
- [ ] Existing billing tests pass with branded types
- [ ] Budget tests pass with `BasisPoints` branded type

---

### Task 2.4: Golden Wire Fixture Post-Migration Verification

**Description**: Verify all golden wire fixtures remain byte-for-byte stable after branded type adoption. Add new snapshot tests.

**Verification** (SDD §11.1):
- All Sprint 1 fixtures re-validated against branded type parse/serialize
- New snapshot tests for billing req/res through the full branded type pipeline
- JWT claims through `parseAccountId` still match fixture

**Acceptance criteria**:
- [ ] All Sprint 1 golden wire fixtures pass byte-for-byte
- [ ] New branded type snapshot tests pass
- [ ] Zero fixture changes (branded types are compile-time only — wire format unchanged)

---

### Task 2.5: BillingConservationGuard — Core Implementation

**Description**: Create `src/hounfour/billing-conservation-guard.ts` — the fail-closed evaluator wrapper for billing invariants.

**Implementation** (SDD §4.2):
- Singleton guard with `state: 'uninitialized' | 'ready' | 'degraded' | 'bypassed'`
- `init()`: Compile constraint registry with retry (3 attempts, 1s/2s/4s backoff)
- `getHealth()`: Maps state to health response
- 4 invariant check methods: `checkBudgetConservation`, `checkCostNonNegative`, `checkReserveWithinAllocation`, `checkMicroUSDFormat`
- **Strict fail-closed lattice**: evaluator error = FAIL (not fallback). Only `EVALUATOR_BYPASS` env enables ad-hoc-only.
- Divergence monitoring: emit metric when evaluator and ad-hoc disagree

**Files created**:
- `src/hounfour/billing-conservation-guard.ts`

**Acceptance criteria**:
- [ ] All 4 invariant checks implement strict fail-closed lattice
- [ ] Evaluator runtime error → effective=FAIL (no fallback), logs error + fires alert
- [ ] Bypass mode requires explicit `EVALUATOR_BYPASS=true` env, not auto-activated on error
- [ ] Divergence monitoring emits metrics on evaluator/ad-hoc disagreement
- [ ] `InvariantResult` type with `ok`, `invariant_id`, `evaluator_result`, `adhoc_result`, `effective`

---

### Task 2.6: BillingConservationGuard — Bypass Security + WAL Audit + Schema Migration

**Description**: Implement break-glass bypass security requirements, WAL audit entry schema, and update all WAL readers/writers to safely handle the new entry type.

**Bypass security** (SDD §7.2):
- Immutable audit trail: WAL append-only entry on startup with `EVALUATOR_BYPASS=true`
- High-severity alert: `AlertService.fire()` with `evaluator_bypass_active` trigger
- Structured logging: Every billing request logs `{ evaluator_bypassed: true, pod_id, build_sha }`
- No runtime toggle: bypass is startup-only (env var read at init)

**WAL audit event schema** (SDD §7.6):
- New `type: 'audit'` discriminator
- Subtypes: `evaluator_bypass`, `evaluator_recovery`, `evaluator_degraded`
- Existing WAL consumers filter by `type` and ignore `audit` entries

**WAL schema migration** (required for safe introduction of new entry type):
- Update WAL TypeBox schema/union to include the new `type: 'audit'` variant
- Update ALL WAL readers/consumers to explicitly filter or skip `audit` entries:
  - R2 sync consumer
  - Git sync consumer
  - Recovery/replay code path
  - WAL segment reader/iterator
- Add recovery test fixture containing mixed WAL entries (billing + audit) proving no crash and correct filtering
- Verify R2/Redis/WAL replay code paths handle `audit` entries without data corruption

**Bypass access control** (SDD §7.5):
- GitOps-only env var setting
- External Prometheus gauge `evaluator_bypass_active{pod}`

**Acceptance criteria**:
- [ ] WAL audit entry written on startup when bypass enabled
- [ ] WAL entry uses `type: 'audit'` discriminator (compatible with existing consumers)
- [ ] WAL TypeBox schema updated to include `audit` type variant
- [ ] Exhaustive WAL consumer inventory documented (R2 sync, Git sync, recovery, replay, iterator, any other reader)
- [ ] ALL inventoried WAL consumers explicitly filter/skip `audit` entries
- [ ] Forward-compatible unknown type handling: WAL readers skip unknown `type` values with alerting (not fatal). Future entry types won't crash recovery.
- [ ] Recovery test: mixed WAL segment (billing + audit + unknown-future-type entries) replays without crash, non-billing entries filtered correctly
- [ ] Property-based/fuzz test generating mixed WAL segments with random types to verify forward-compatible skipping
- [ ] Critical alert fires on pod start with bypass enabled
- [ ] Every bypassed request logged with structured `evaluator_bypassed: true`
- [ ] Bypass is startup-only — cannot be toggled at runtime

---

### Task 2.7: BillingConservationGuard — Boot Sequence + Health + Recovery + Entrypoint Inventory

**Description**: Integrate the guard into the boot sequence and health endpoint. Implement degraded state recovery. Enumerate and gate ALL billing side-effect entrypoints.

**Billing entrypoint inventory** (exhaustive gating):
Before wiring the guard, enumerate every code path that writes billing side-effects:
- HTTP routes: billing finalize endpoint, budget debit endpoint, any route that calls `BillingFinalizeClient`
- Background jobs: DLQ retry processor, reconciliation worker (if any)
- Internal callers: any module that invokes cost-arithmetic or budget mutation

All identified entrypoints must be gated by a shared guard middleware/check. A test must iterate the route registry (or explicit entrypoint list) and assert billing routes are guarded. At least one integration test per entrypoint must verify 503 when degraded.

**Boot sequence** (SDD §4.2):
- Guard init after hounfour step, before gateway step
- Pod always becomes READY after init (even if degraded)
- Billing endpoints fail individually with 503, not the whole pod
- Per-request billing gate checks `guard.state === 'degraded'`

**Degraded state recovery** (SDD §4.2):
- Automatic: Background timer retries compilation every 60s while degraded
- On success: transitions to `ready`, resumes billing, emits recovery metric
- Emergency: `EVALUATOR_BYPASS=true` via redeploy

**Degraded state operational policy** (SKP-003):
- Maximum tolerated degraded duration: 10 minutes. After 10 min, escalate alert to PagerDuty critical.
- Backpressure: billing endpoints return 503 with `Retry-After: 30` header. Callers must respect backoff.
- Retry storm prevention: billing middleware enforces per-client rate limit during degraded state (reuse existing rate limiter with tighter threshold).
- Deployment gate: canary rollout blocks if `ready_for_billing` is false on any canary pod.

**Health endpoint** (SDD §6.2):
- Add `billing_evaluator` subsystem: `{ billing: 'ready'|'degraded'|'bypassed', evaluator_compiled: boolean }`
- Add top-level `ready_for_billing: boolean` — true only when `billing === 'ready'` or `billing === 'bypassed'`. Deployment gates check this field.

**Files modified**:
- `src/index.ts` — Boot: add `BillingConservationGuard.init()` after hounfour step
- Health endpoint handler — Add `billing_evaluator` subsystem
- Billing middleware — Per-request gate for degraded state
- All billing entrypoints — Shared guard check applied

**Acceptance criteria**:
- [ ] Billing entrypoint inventory documented (HTTP routes, background jobs, internal callers)
- [ ] Shared guard middleware applied to ALL identified billing entrypoints
- [ ] Test iterates entrypoint list and asserts each is guarded
- [ ] Integration test per entrypoint: returns 503 when evaluator degraded
- [ ] Guard initializes after hounfour, before gateway in boot sequence
- [ ] Pod always READY after init (even if evaluator degraded)
- [ ] Billing endpoints return 503 `BILLING_EVALUATOR_UNAVAILABLE` when degraded
- [ ] Non-billing endpoints serve normally when evaluator degraded
- [ ] `/health` response includes `billing_evaluator` subsystem
- [ ] Degraded state recovery: auto-retry every 60s, transition to ready on success

---

### Task 2.8: Evaluator Test Suite

**Description**: Comprehensive test suite for the BillingConservationGuard.

**Tests** (SDD §11.4):

| Test | Type | Coverage |
|------|------|---------|
| Guard compilation success | Unit | Happy path — registry compiles |
| Guard compilation failure + retry | Unit | 3 retries with backoff, degraded state |
| Guard bypass mode | Unit | `EVALUATOR_BYPASS=true` → ad-hoc only + audit |
| Budget conservation check | Unit | Evaluator + ad-hoc agree → pass |
| Evaluator/ad-hoc disagreement | Unit | Strictest wins (fail-closed) |
| Evaluator runtime error | Unit | effective=FAIL (no fallback), logs error + fires alert |
| Bypass does not auto-activate on error | Unit | Evaluator error does NOT toggle bypass mode |
| Health endpoint with guard | Integration | `/health` reflects evaluator state |
| Degraded state recovery | Unit | Auto-retry, transition to ready |

**Files created**:
- `tests/finn/billing-conservation-guard.test.ts`

**Acceptance criteria**:
- [ ] All 9 test scenarios pass
- [ ] Strict fail-closed lattice verified in every disagreement scenario
- [ ] Bypass audit trail verified (WAL entry + alert + structured log)
- [ ] Degraded recovery tested with mock timer

---

### Task 2.9: CI Microbenchmark Harness

**Description**: Add CI microbenchmark to enforce evaluator performance budget.

**Performance contract** (SDD §9.1):
- Per-invariant check: p95 < 1ms
- Constraint compilation: < 500ms
- Total billing pipeline overhead: < 5ms
- 10,000 iterations of each billing invariant check on representative payloads

**CI preflight gate** (SDD §4.2): Evaluator compilation runs in same Node version as production.

**Acceptance criteria**:
- [ ] Microbenchmark harness runs 10,000 iterations per invariant
- [ ] Build fails if p95 exceeds 1ms
- [ ] Compilation latency measured and reported
- [ ] CI step added to test workflow

---

### Task 2.10: Observability — Metrics + Structured Logging

**Description**: Implement evaluator observability for fail-closed components.

**Signals** (PRD §NFR-5):

| Signal | Metric | Alert Threshold |
|--------|--------|----------------|
| Evaluator compilation | `evaluator.compile.duration_ms` | > 500ms or failure |
| Invariant check latency | `evaluator.check.p95_ms` per invariant ID | > 1ms |
| HARD-FAIL rate | `evaluator.hard_fail.count` by invariant ID | > 0 for new failures |
| Circuit-open state | `evaluator.circuit.state` | Any transition to OPEN |
| Constraint registry size | `evaluator.registry.constraint_count` | Drift from expected |
| Divergence | `evaluator.divergence{invariant_id}` | > 0 (any disagreement) |

**Structured logging**: Every HARD-FAIL emits `{invariant_id, input_summary, expected, actual, timestamp}`. No PII in billing logs.

**Acceptance criteria**:
- [ ] All 6 metric signals implemented
- [ ] HARD-FAIL structured logs include invariant_id and input summary (no PII)
- [ ] Circuit-open state transition fires alert
- [ ] Divergence monitoring active (metric emitted on any evaluator/ad-hoc disagreement)

---

## Sprint 3: Knowledge + Hardening (Global ID: 67)

**Objective**: Update Oracle knowledge sources for v7.0.0 protocol reality. Add CI hardening for version drift detection. Final integration verification.

**Gate**: Gold-set 20/20, all CI checks green, production-ready.

**Rollback**: Revert knowledge source commits. Sprint 2 state is valid baseline (code fully functional, only knowledge content reverted). RTO < 15 min. See PRD §9 rollback runbook.

### Task 3.1: Oracle Knowledge Corpus Rewrite

**Description**: Rewrite Oracle knowledge sources to reflect v7.0.0 protocol reality.

**Files modified** (SDD §4.5):
- `grimoires/oracle/code-reality-hounfour.md` — Complete rewrite for v7.0.0 (87+ schemas, 31 builtins, constraint system, branded types)
- `grimoires/oracle/architecture.md` — Update protocol layer description (wire boundary module, evaluator guard)
- `grimoires/oracle/capabilities.md` — Add conservation evaluator, branded types, liveness properties

**Acceptance criteria**:
- [ ] `code-reality-hounfour.md` reflects v7.0.0 protocol reality (not v5.x)
- [ ] Architecture description includes wire boundary module and evaluator guard
- [ ] Capabilities include branded types, conservation evaluator, fail-closed billing
- [ ] No knowledge source references v5.x-specific concepts without noting migration

---

### Task 3.2: Knowledge Sources Checksums + Expansion

**Description**: Update `grimoires/oracle/sources.json` checksums for modified knowledge sources. Add any new knowledge sources needed for v7.0.0 coverage.

**Files modified**:
- `grimoires/oracle/sources.json` — Update checksums for rewritten files

**Acceptance criteria**:
- [ ] All checksums in `sources.json` match current file contents
- [ ] Knowledge loader validates all sources without checksum errors
- [ ] No stale v5.x checksums remain

---

### Task 3.3: Gold-Set Verification

**Description**: Update gold-set test vectors for v7.0.0 protocol questions and verify 20/20 pass rate.

**Updates needed**:
- Questions about protocol version → expect v7.0.0 answers
- Questions about branded types → expect canonical wire-boundary answers
- Questions about conservation evaluator → expect fail-closed evaluator answers
- Questions about billing invariants → expect evaluator + ad-hoc lattice answers

**Acceptance criteria**:
- [ ] Gold-set passes at 100% (20/20)
- [ ] Protocol-related questions return v7.0.0-accurate answers
- [ ] Evaluator/billing questions return correct fail-closed semantics
- [ ] No regression in non-protocol questions

---

### Task 3.4: CI Hardening — Version Drift Detection

**Description**: Add CI checks to detect protocol version drift and ensure evaluator preflight.

**Checks**:
- Protocol version drift: CI step verifies `@0xhoneyjar/loa-hounfour` resolves to expected version
- Evaluator preflight: Compile constraint registry in production container image
- TypeBox version check: Verify peer dependency compatibility
- Supply chain: `npm ci` (not `npm install`) with lockfile integrity

**Acceptance criteria**:
- [ ] CI step verifies protocol package version matches expected (7.0.0)
- [ ] CI step compiles evaluator constraint registry (catches env-specific failures)
- [ ] CI step verifies TypeBox peer dependency compatibility
- [ ] `npm ci` used in CI (fails on lockfile mismatch)

---

### Task 3.5: Final Integration Pass

**Description**: End-to-end verification of the complete migration. Run all tests, all fixtures, all gates.

**Verification**:
- Full test suite: ≥207 passing, zero new failures
- All golden wire fixtures byte-for-byte stable
- Evaluator compilation green
- Microbenchmark green
- Schema audit artifact matches final state
- Health endpoint reports all subsystems healthy

**Acceptance criteria**:
- [ ] Test suite: ≥207 passing, zero new failures beyond pre-existing 13
- [ ] All golden wire fixtures pass
- [ ] Evaluator health: `ready`
- [ ] Microbenchmark: p95 < 1ms
- [ ] `/health` reports all subsystems healthy

---

### Task 3.6: Shadow Mode Implementation + SLO-Based Canary Gate

**Description**: Implement `SHADOW_MODE` via an injected `WriteGate` capability interface at all persistence/write boundaries, and configure the SLO-based canary deployment gate for production rollout.

**WriteGate interface** (SKP-010):
Shadow mode MUST be implemented via a single injected `WriteGate` interface, NOT scattered `if (SHADOW_MODE)` conditionals throughout the codebase:

```typescript
interface WriteGate {
  /** Returns true if writes are permitted */
  readonly enabled: boolean;
  /** Log a shadow event when writes are suppressed */
  logShadow(operation: string, key: string): void;
}

// Production: WriteGateImpl reads SHADOW_MODE env at startup
// Test: MockWriteGate asserts operation/key pairs
```

All persistence clients (WAL, R2, Redis, billing finalize) receive `WriteGate` via constructor injection:
- WAL writer: `new WalWriter(writeGate, ...)`
- R2 client: `new R2Client(writeGate, ...)`
- Redis budget: `new RedisBudget(writeGate, ...)`
- Billing client: `new BillingClient(writeGate, ...)`

Each client checks `writeGate.enabled` before writes. If disabled, calls `writeGate.logShadow(operation, key)` and returns the computed result without side-effects.

**Why WriteGate, not scattered conditionals**:
- New persistence clients automatically require `WriteGate` in their constructor (compile-time enforcement)
- Single toggle point — no missed conditionals
- `MockWriteGate` in tests enables assertion on exact operation/key pairs
- No runtime string matching or env var reads scattered across modules

**Shadow mode behavior** (SDD §10.1):
When `WriteGate.enabled = false` (shadow mode):
- WAL append → no-op (log shadow event)
- R2 writes → no-op (log shadow event)
- Redis budget debit → no-op (log shadow event)
- Billing finalize external API call → no-op (log shadow event)
- Responses are still computed and returned for comparison

Each shadow event log: `{ shadow_mode: true, operation, key, timestamp }`

**SLO gates** (SDD §10.1):
- Billing success rate: ≥ 99.9% (non-503 billing responses)
- `BILLING_EVALUATOR_UNAVAILABLE` rate: must be 0
- Evaluator divergence rate: must be 0
- p95 billing latency: within 5ms of pre-deploy baseline

**Acceptance criteria**:
- [ ] `WriteGate` interface defined with `enabled` property and `logShadow` method
- [ ] All 4 persistence clients (WAL, R2, Redis, billing) accept `WriteGate` via constructor injection
- [ ] `WriteGateImpl` reads `SHADOW_MODE` env at startup (consistent with evaluator bypass pattern)
- [ ] No `if (SHADOW_MODE)` or `if (env.SHADOW_MODE)` conditionals outside `WriteGateImpl`
- [ ] Integration test: with `MockWriteGate(enabled=false)`, billing request returns computed response but zero writes occur (verified via mock operation/key assertions)
- [ ] Shadow event logging at each gated boundary with operation, key, and timestamp
- [ ] SLO gate thresholds documented and configured
- [ ] Rollback triggers documented per rollback runbook (PRD §9)
- [ ] Canary deployment procedure documented (5% → 30min → full rollout)

---

## Risk Register

| Risk | Sprint | Mitigation | Status |
|------|--------|------------|--------|
| Undocumented wire-format changes in v7.0.0 | 1 | 9-dimension schema audit + golden fixtures | Open |
| PoolId vocabulary changed v5→v7 | 1 | Schema audit vocabulary diff + migration strategy | Open |
| Evaluator compilation fails in production env | 2 | CI preflight + emergency bypass | Open |
| MicroUSD normalization mismatch with arrakis | 2 | Canonical rules + edge-case fixtures | Open |
| TypeBox version mismatch | 1 | Peer dep alignment check | Open |
| Git tag v7.0.0 force-pushed | 1 | Lockfile SHA pinning + CI integrity | Open |
| arrakis rejects v7.0.0 contract_version | 1 | Interop fixture + source code analysis | Open |
| Evaluator adds measurable latency | 2 | Startup compilation + cache + microbenchmark gate | Open |
| Oracle knowledge regression | 3 | Gold-set 20/20 gate | Open |

---

## Success Criteria (Cycle Complete)

- [ ] loa-finn imports from `@0xhoneyjar/loa-hounfour` at v7.0.0 tag
- [ ] Zero local type definitions that shadow canonical protocol types
- [ ] Billing invariants validated by canonical evaluator builtins (fail-closed)
- [ ] Oracle knowledge sources reflect v7.0.0 protocol reality (20/20 gold-set)
- [ ] `packages/loa-hounfour/` directory deleted, all imports from external package
- [ ] ≥207 tests passing (zero regression from 187 baseline + ~20 new tests)
- [ ] SLO-based canary gate configured for production deployment
