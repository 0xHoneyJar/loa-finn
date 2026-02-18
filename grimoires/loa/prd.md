# PRD: Protocol Convergence — loa-hounfour v5.0.0 → v7.0.0

> **Version**: 1.1.0 (Flatline-integrated)
> **Date**: 2026-02-18
> **Author**: @janitooor + Claude Opus 4.6
> **Status**: Draft
> **Cycle**: cycle-026
> **Command Center**: [#66](https://github.com/0xHoneyJar/loa-finn/issues/66)
> **Source**: [#66 Protocol Convergence Update](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3914427997)
> **Cross-references**: [loa-hounfour v7.0.0](https://github.com/0xHoneyJar/loa-hounfour/releases/tag/v7.0.0) · [loa-hounfour PR #14](https://github.com/0xHoneyJar/loa-hounfour/pull/14) · [MIGRATION.md](https://github.com/0xHoneyJar/loa-hounfour/blob/main/MIGRATION.md) · [Issue #13 (extraction tracker, CLOSED)](https://github.com/0xHoneyJar/loa-hounfour/issues/13)
> **Grounding**: `src/hounfour/` (33 files), `packages/loa-hounfour/` (1,158 LOC, stale v1.0.0), `tests/finn/` (200 tests, 15 suites), `grimoires/oracle/` (20 knowledge sources)
> **Predecessor**: cycle-025 "The Oracle" (v1.29.0, PR #75 merged), cycle-021 "S2S Billing" (v5.0.0 adoption, PR #68 merged)

---

## 1. Problem Statement

### The Protocol Gap

loa-finn's shared protocol package (`@0xhoneyjar/loa-hounfour`) is pinned to a commit corresponding to **v5.0.0**. The canonical version is now **v7.0.0** — three major versions ahead, shipping 87+ schemas, 31 evaluator builtins, and 147 constraints across 40 constraint files.

The gap creates three problems:

**Type safety erosion.** loa-finn uses local equivalents for types that now have canonical protocol definitions. `MicroUSD` is a string pattern in local code but a branded type in the protocol. `PoolId` is a union literal that could drift from the canonical vocabulary. Local and canonical types coexist with no guarantee of compatibility.

**Conservation blind spot.** The protocol now includes 14 conservation invariants with LTL formalization and a constraint evaluation system. loa-finn's billing pipeline (`billing-finalize-client.ts`, `cost-arithmetic.ts`, `budget.ts`) enforces invariants through ad-hoc checks rather than the canonical evaluator. If a billing invariant is added to the protocol, loa-finn won't know.

**Knowledge staleness.** The Oracle (PR #75) has knowledge sources grounded in v5.x protocol reality. `code-reality-hounfour.md` describes a protocol that no longer exists. Users asking the Oracle about the protocol will get outdated answers.

### What's Changed (v5.0.0 → v7.0.0)

| Version | Breaking Change | Impact on loa-finn |
|---------|----------------|-------------------|
| v5.5.0 | None (additive) | New: ConservationPropertyRegistry, branded types, AgentIdentity, JWT boundary spec |
| v6.0.0 | `AgentIdentity.trust_level` → `trust_scopes` | **Low** — loa-finn doesn't use `AgentIdentity` directly. Uses JWT `Tier` (different concept). |
| v7.0.0 | `RegistryBridge` gains required `transfer_protocol` | **None** — loa-finn doesn't use `RegistryBridge` yet. |

**Key insight**: Neither breaking change affects existing loa-finn code *based on current import analysis* (11 files import from loa-hounfour; none use `AgentIdentity` or `RegistryBridge`). However, shared schemas used indirectly (validators, vocabularies, TypeBox defaults) may have changed in ways not visible from import analysis alone. **Sprint 1 must include an explicit schema audit** — diff every imported symbol and every runtime-validated schema between v5.0.0 and v7.0.0, verifying no new required fields appear on wire-format schemas. See FR-1 acceptance criteria.

> Source: [MIGRATION.md](https://github.com/0xHoneyJar/loa-hounfour/blob/main/MIGRATION.md), [CHANGELOG.md](https://github.com/0xHoneyJar/loa-hounfour/blob/main/CHANGELOG.md), codebase exploration (11 files with hounfour imports)

---

## 2. Goals & Success Metrics

### Business Objectives

| Objective | Success Metric |
|-----------|---------------|
| Protocol convergence | loa-finn imports from `@0xhoneyjar/loa-hounfour` at v7.0.0 tag |
| Type safety | Zero local type definitions that shadow canonical protocol types |
| Conservation coverage | Billing invariants validated by canonical evaluator builtins |
| Knowledge freshness | Oracle knowledge sources reflect v7.0.0 protocol reality |
| Local package removal | `packages/loa-hounfour/` directory deleted, all imports from external package |
| Test parity | 187+ tests passing (no regression from current baseline) |

### Non-Goals

- **Arrakis upgrade** — different repo, parallel work stream (Phase 3 in the convergence plan)
- **Cross-system E2E** — requires both consumers at v7.0.0 (Phase 4, blocked on arrakis)
- **npm publish** — loa-hounfour npm publishing is a separate concern; we use git tag pin
- **New protocol features** — no new features built on v7.0.0 schemas (sagas, governance, etc.) — just adoption of existing canonical types and evaluator

---

## 3. User & Stakeholder Context

### Primary Stakeholders

| Stakeholder | Concern | Impact |
|-------------|---------|--------|
| **loa-finn developers** | Type safety, import clarity | All hounfour imports resolve to single canonical source |
| **Oracle users** | Accurate protocol knowledge | Knowledge sources reflect current protocol reality |
| **arrakis team** | Wire format compatibility | No wire format changes — JWT claims, stream events unchanged |
| **loa-hounfour maintainers** | Consumer adoption feedback | First consumer at v7.0.0 provides validation |

### User Stories

1. **As a developer**, I want all protocol types to come from one package, so I don't have to guess which `PoolId` definition to use.
2. **As a developer**, I want billing invariants validated by the protocol's evaluator, so new conservation properties are automatically enforced.
3. **As an Oracle user**, I want accurate answers about the protocol, so I can understand how the system works.
4. **As a CI pipeline**, I want the protocol version to be verifiable, so I can detect drift automatically.

---

## 4. Functional Requirements

### FR-1: Version Bump & Dependency Cleanup

**Remove local package (comprehensive gate):**
- Delete `packages/loa-hounfour/` directory (1,158 LOC across 15 files)
- Remove any workspace references in root `package.json` or `tsconfig.json`
- Search for ALL references: workspace protocol entries, tsconfig `paths`, `file:` references, deep imports (`@0xhoneyjar/loa-hounfour/dist/...`), and any compiled JS containing `packages/loa-hounfour` strings
- Verify `node -e "console.log(require.resolve('@0xhoneyjar/loa-hounfour/package.json'))"` resolves to `node_modules/`, not `packages/`

**Bump external dependency:**
- Change `package.json` from git commit pin to: `"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#v7.0.0"`
- Run `npm install` to update lockfile
- Verify `tsc --noEmit` compiles cleanly

**Schema audit gate (Sprint 1 prerequisite for FR-2/FR-3):**
- Enumerate every symbol imported from `@0xhoneyjar/loa-hounfour` in loa-finn today
- For each imported schema used in runtime validation (`JwtClaimsSchema`, `InvokeResponseSchema`, `StreamEventSchema`, `RoutingPolicySchema`, `CostBreakdownSchema`): diff v5.0.0 vs v7.0.0 field definitions
- **TypeBox peer dependency alignment**: Verify loa-finn's TypeBox version is compatible with loa-hounfour v7.0.0's peer dependency. Mismatched TypeBox versions can cause silent schema validation differences.
- Verify: no new **required** fields on any wire-format schema (JWT claims, stream events, invoke request/response)
- Document any additive optional fields and their defaults

**Comprehensive audit checklist** (each wire-format schema must be checked for ALL of these):

| Dimension | What to Check | Failure Mode if Missed |
|-----------|--------------|----------------------|
| Required fields | New required fields added | Request rejection |
| Optional fields + defaults | Changed defaults or new optionals with non-undefined defaults | Silent behavior change |
| Patterns/regex | Tightened or changed string patterns | Validation rejection of previously valid values |
| Enum/vocabulary members | Added, removed, or renamed members | Unhandled variants or rejected values |
| `additionalProperties` | Changed from `true`/absent to `false` | Previously accepted extra fields rejected |
| Nullable/union changes | Narrowed unions or removed `null` | Runtime type errors |
| Numeric bounds | Changed min/max/multipleOf constraints | Value rejection |
| Validator strictness | TypeBox `additionalProperties`, `$ref` resolution, default mode | Entire schema behavior change |
| TypeBox version | Peer dependency compatibility | Subtle validation differences |

**Audit artifact**: Produce a `schema-audit-v5-v7.json` with per-schema diff results, checked into `grimoires/loa/a2a/` as a sprint gate artifact.

**Acceptance criteria:**
- [ ] `packages/loa-hounfour/` directory does not exist
- [ ] No path aliases, workspace refs, or deep imports reference the deleted local package
- [ ] All imports from `@0xhoneyjar/loa-hounfour` resolve to v7.0.0 in `node_modules/`
- [ ] `tsc --noEmit` passes with zero errors
- [ ] Schema audit documents every wire-format schema diff (v5→v7) with "no new required fields" confirmation
- [ ] Existing 187+ tests still pass

### FR-2: Canonical Branded Type Adoption

Replace local type equivalents with canonical branded types from loa-hounfour v5.5.0+:

| Local Pattern | Canonical Type | Files Affected |
|--------------|----------------|----------------|
| `string` for micro-USD amounts | `MicroUSD` (branded string) | `src/hounfour/billing-finalize-client.ts`, `cost-arithmetic.ts`, `budget.ts` |
| `number` for basis points | `BasisPoints` (branded number) | `src/hounfour/budget.ts`, pricing config |
| `string` for account IDs | `AccountId` (branded string) | JWT auth, billing client |
| Local `PoolId` union literal | Canonical `PoolId` from vocabulary | Already imported — verify canonical |

**Wire format stability contract:**

For each branded type used at any boundary (JWT claims, HTTP bodies, WS messages, stream events):

| Branded Type | Wire Type | Canonical Format | Conversion Points |
|-------------|-----------|-----------------|-------------------|
| `MicroUSD` | `string` | `^[0-9]+$` (unsigned) or `^-?[0-9]+$` (signed, v4.0.0+) | Parse: `string → MicroUSD` at request boundary. Serialize: `MicroUSD → string` at response boundary. Internal: BigInt arithmetic. |
| `BasisPoints` | `number` | Integer, 0–10000 | Parse: `number → BasisPoints` at config load. Internal only (not on wire). |
| `AccountId` | `string` | `^[a-zA-Z0-9_-]+$` | Parse: `string → AccountId` at JWT validation. Serialize: `AccountId → string` at billing finalize. |
| `PoolId` | `string` | Union literal from vocabulary | Already canonical — verify no vocabulary changes between v5 and v7. See drift contingency below. |

**PoolId vocabulary drift contingency:**
The `PoolId` union literal is the most heavily used type (31+ occurrences across 5 source files). If the vocabulary changed between v5 and v7:
1. **Detection**: Schema audit (FR-1) must diff PoolId vocabulary members between v5 and v7
2. **If unchanged**: No action needed — verify with vocabulary snapshot test
3. **If members added**: Backward-compatible — existing code handles known members, new members fall through to default handling
4. **If members removed or renamed**: Breaking — pin v5 vocabulary as an alias set, add backward-compatible parsing that maps old names to new, and flag for arrakis coordination

**Golden wire fixtures (Sprint 1 pre-bump, Sprint 2 post-migration gate):**
- Add JSON snapshot tests for: billing request body, billing response body, JWT claims payload, stream event envelope
- These fixtures must remain byte-for-byte stable across the branded type migration
- Any fixture change requires explicit justification and arrakis compatibility review

**Fixture determinism requirements:**

| Element | Rule | Rationale |
|---------|------|-----------|
| JWT signing key | Fixed ES256 test keypair committed to test fixtures | Deterministic signatures |
| Timestamps (`iat`, `exp`) | Fixed epoch values (e.g., `1700000000`) | Reproducible across runs |
| Nonce/JTI | Fixed test values (`test-jti-001`) | Deterministic token body |
| JSON key order | Canonical key ordering (alphabetical or schema-defined) | Byte-for-byte comparison |
| Whitespace | Compact JSON (`JSON.stringify` with no indent) | No formatting drift |
| `req_hash` | Computed from fixed request body, verified end-to-end | Catches hash algorithm changes |

**Normalization boundaries**: Byte-for-byte match required for JSON body payloads. JWT header/signature segments may vary only if signing key changes (which is gated). The fixture harness must replay signing and verification end-to-end, not just compare pre-signed tokens.

**MicroUSD canonical normalization rules:**

| Edge Case | Canonical Behavior | Example |
|-----------|-------------------|---------|
| Leading zeros | Strip — `"007"` → `"7"` | Normalizer rejects or strips |
| Negative values | Allowed (signed, v4.0.0+) — `"-100"` is valid | Pattern: `^-?[1-9][0-9]*$\|^0$` |
| Plus sign | Reject — `"+100"` is invalid | Parse boundary rejects |
| Empty string | Reject — `""` is invalid | Validator rejects at boundary |
| Zero representation | Canonical `"0"`, not `"-0"` or `"00"` | Normalizer maps `-0` → `0` |
| Overflow | No upper bound in protocol (BigInt) | Application-level budget limits apply |

Fixtures must include edge-case vectors for each rule above. Both validator (parse boundary) and serializer (response boundary) must enforce the same normalization.

**Acceptance criteria:**
- [ ] No local type aliases that shadow canonical protocol types
- [ ] Type narrowing/validation uses canonical validators where available
- [ ] All branded type conversions are explicit (no silent coercion)
- [ ] Golden wire fixtures pass: billing request/response, JWT claims, stream events remain byte-for-byte stable
- [ ] MicroUSD signed/unsigned pattern documented and consistent with arrakis expectations

### FR-3: Conservation Evaluator Integration

Wire the canonical conservation evaluator for billing invariants:

| Billing Invariant | Evaluator Builtin | Current Enforcement |
|-------------------|-------------------|---------------------|
| Budget conservation (spent ≤ limit) | `bigint_lte` | Ad-hoc check in `budget.ts` |
| Cost non-negative | `bigint_gte` (vs 0) | Ad-hoc check in `cost-arithmetic.ts` |
| Reserve ≤ allocation | `bigint_lte` | Ad-hoc check in `billing-finalize-client.ts` |
| Micro-USD string format | `string_matches_pattern` | TypeBox schema validation |

**Approach**: Import `EVALUATOR_BUILTIN_SPECS` and individual builtins from `@0xhoneyjar/loa-hounfour`. Create a `BillingConservationGuard` that wraps existing checks with evaluator-backed validation.

**Evaluator lifecycle (performance contract):**
1. **Startup**: Load and compile constraint registry once at process boot (`BillingConservationGuard.init()`)
2. **Cache**: Compiled constraint ASTs stored in memory — no per-request parsing
3. **Execute**: Only billing-relevant builtins invoked per request (4 builtins, not full 31-builtin suite)
4. **Benchmark**: CI microbenchmark harness on representative payloads; build fails if p95 > 1ms per invariant

**Fail-closed invariant classification:**

| Invariant | Classification | On Failure |
|-----------|---------------|------------|
| Budget conservation (spent ≤ limit) | **HARD-FAIL** | Reject request, return 402 |
| Cost non-negative | **HARD-FAIL** | Reject request, log alert |
| Reserve ≤ allocation | **HARD-FAIL** | Reject finalize, return 409 |
| Micro-USD string format | **HARD-FAIL** | Reject at validation boundary |

All billing/ledger invariants are **fail-closed**. There is no fail-open mode for economic safety controls. If the evaluator itself fails to load at startup, the process must refuse to serve billing requests (circuit-open state).

**Startup failure recovery model:**

| Failure Mode | Behavior | Recovery |
|-------------|----------|----------|
| Constraint registry compilation fails | Process starts but billing endpoints return 503 (circuit-open) | Retry compilation with exponential backoff (3 attempts, 1s/2s/4s) |
| Compilation succeeds after retry | Circuit closes, billing endpoints become available | Health check transitions to READY |
| All retries exhausted | Process remains up, non-billing endpoints available, billing returns 503 | Alert fires, requires deploy fix or manual restart |
| Runtime constraint evaluation throws | Individual request fails with HARD-FAIL | Log, alert, but do not circuit-open (isolated failure) |

**Health endpoint integration**: `/health` returns `{ "billing": "ready" | "degraded" | "unavailable", "evaluator_compiled": true | false }`. Kubernetes readiness probe gates on `billing: "ready"` for billing-serving pods. Non-billing pods can serve without evaluator.

**CI preflight gate**: Sprint 2 CI must include a step that compiles the evaluator constraint registry in the same Node version and container base image as production. This catches environment-sensitive compilation failures before deploy.

**Emergency evaluator bypass** (break-glass only):
- Environment variable `EVALUATOR_BYPASS=true` disables evaluator and falls back to existing ad-hoc checks
- **NOT** a feature flag — requires deploy with explicit env override
- When active: all billing requests logged with `{ "evaluator_bypassed": true }` for post-incident audit
- Requires incident ticket reference in deploy notes
- Ad-hoc checks (the pre-migration billing guards) must be preserved as fallback code paths, not deleted during evaluator integration

**Acceptance criteria:**
- [ ] Billing invariants enforced via canonical evaluator builtins
- [ ] All billing invariants are fail-closed (no fail-open fallback)
- [ ] Evaluator failures produce structured error with invariant ID
- [ ] Evaluator compiled once at startup, cached — zero per-request compilation
- [ ] Existing billing tests pass with evaluator wired in
- [ ] CI microbenchmark: p95 evaluator overhead < 1ms per invariant on representative payloads

### FR-4: Protocol Handshake Update

Update `src/hounfour/protocol-handshake.ts` to handle v7.0.0:

- Update `CONTRACT_VERSION` to `'7.0.0'`
- **DO NOT** set `MIN_SUPPORTED_VERSION` to `'6.0.0'` — arrakis is at v4.6.0 and would be rejected. Set to `'4.0.0'` (or keep current value) until arrakis upgrades.
- Verify `validateCompatibility()` from v7.0.0 package works with existing handshake flow
- Handle the `trust_scopes` field in any protocol metadata exchange

**Explicit interoperability contract:**

| Field | Value | Who Validates | On Mismatch |
|-------|-------|---------------|-------------|
| `contract_version` (advertised by loa-finn) | `'7.0.0'` | Peer consumer (arrakis) | arrakis currently ignores — no rejection expected |
| `min_supported_version` (enforced by loa-finn) | `'4.0.0'` | loa-finn on inbound | Reject with `CONTRACT_VERSION_MISMATCH` (400) |
| arrakis contract version | `'4.6.0'` (vendored) | loa-finn via `validateCompatibility()` | Accept — within loa-finn's `min_supported` range |

**Version negotiation behavior:**
- loa-finn advertises v7.0.0 but accepts peers ≥ v4.0.0
- When arrakis upgrades to v7.0.0, `min_supported` can be raised to v6.0.0
- Feature detection: `trust_scopes` presence indicates v6.0.0+ peer; absence indicates v4.x/v5.x peer
- **Interop test required**: loa-finn(v7) handshake against arrakis(v4.6.0) fixture must not reject

**Handshake verification approach (two-tier):**
1. **Synthetic fixture** (Sprint 1, required): Simulated arrakis v4.6.0 handshake request constructed from arrakis source code analysis. Document the exact arrakis code path and commit SHA that constructs/validates the handshake. Link to arrakis source in audit artifact.
2. **Captured traffic replay** (Sprint 1, best-effort): If staging environment is available, capture a real arrakis→loa-finn handshake at current v5.0.0, then replay against v7.0.0 and diff. If staging unavailable, document as a risk and require manual verification before production deploy.

**Arrakis behavioral evidence**: The synthetic fixture must reference the specific arrakis code (file + line + commit) that handles `contract_version`. If arrakis has no validation logic for this field, cite the absence as evidence. Do not assert "arrakis ignores X" without a code reference.

**Acceptance criteria:**
- [ ] Protocol handshake advertises v7.0.0
- [ ] `MIN_SUPPORTED_VERSION` set to `'4.0.0'` — arrakis at v4.6.0 is within range
- [ ] Interop fixture test: simulate arrakis v4.6.0 handshake, verify acceptance
- [ ] Arrakis handshake behavior documented with source code reference (file:line:commit)
- [ ] Captured traffic replay attempted; if unavailable, risk documented with manual verification gate
- [ ] Feature detection for `trust_scopes` (present = v6.0.0+ peer, absent = v4.x/v5.x)
- [ ] Health check includes protocol version in response

### FR-5: Oracle Knowledge Corpus Update

Update Oracle knowledge sources to reflect v7.0.0 reality:

| Knowledge Source | Update Needed |
|-----------------|---------------|
| `code-reality-hounfour.md` | Complete rewrite — v5.x → v7.0.0 (87+ schemas, 31 builtins, constraint system) |
| `architecture.md` | Update protocol layer description |
| `capabilities.md` | Add conservation evaluator, branded types, liveness properties |

**Acceptance criteria:**
- [ ] Oracle gold-set questions about the protocol return v7.0.0-accurate answers
- [ ] No knowledge source references v5.x-specific concepts without noting migration
- [ ] Gold-set passes at 100% (20/20 baseline from cycle-025)

---

## 5. Technical & Non-Functional Requirements

### NFR-1: Zero Wire Format Changes

The JWT claims schema, stream event schemas, and invoke request/response schemas must remain wire-compatible. Arrakis at v4.6.0 must continue to interoperate with loa-finn at v7.0.0.

**Verification (independent of pre-existing test failures):**

The pre-existing `s2s-jwt.test.ts` failures mean we cannot rely solely on current tests as the wire-compat canary. Verification requires:

1. **New deterministic wire fixtures** (Sprint 1): Golden JSON snapshots for signed JWT vectors (ES256 + req_hash), representative billing request/response payloads, and stream event envelopes. These fixtures are created BEFORE the version bump and must pass AFTER.
2. **Interop handshake fixture** (Sprint 1): Simulated arrakis v4.6.0 request → loa-finn v7.0.0 response cycle, asserting no rejection.
3. **Existing passing tests** remain passing (187 baseline).
4. **Pre-existing JWT test failure**: Either fix `s2s-jwt.test.ts` as part of Sprint 1 (preferred — it's a safety gate for this migration) or document why the failure is unrelated to wire format and create an independent JWT wire fixture that covers the same surface.

### NFR-2: Performance Budget

Conservation evaluator integration must not add measurable latency:
- Evaluator call overhead: < 1ms per invariant check
- Total billing pipeline overhead: < 5ms per request (current: ~2ms)

### NFR-3: Import Path Cleanliness

After migration, there must be exactly ONE source for protocol types:
- `@0xhoneyjar/loa-hounfour` (root barrel) for most imports
- `@0xhoneyjar/loa-hounfour/composition` for v7.0.0 composition types (if needed)
- Zero imports from `packages/loa-hounfour/` (deleted)
- Zero local type redefinitions that shadow canonical types

### NFR-4: Test Baseline

- Pre-migration: 200 tests, 187 passing, 13 pre-existing failures
- Post-migration: ≥ 187 passing, zero new failures
- Pre-existing failures in `reconciliation-e2e.test.ts`, `s2s-jwt.test.ts`, `usage-handler.test.ts` are separate concerns

### NFR-5: Observability for Fail-Closed Components

The conservation evaluator is fail-closed for all billing invariants (FR-3). This requires observability to ensure failures are diagnosable and don't silently block billing:

| Signal | Metric | Alert Threshold | Dashboard |
|--------|--------|----------------|-----------|
| Evaluator compilation | `evaluator.compile.duration_ms` | > 500ms or failure | Startup health |
| Invariant check latency | `evaluator.check.p95_ms` per invariant ID | > 1ms (NFR-2 budget) | Billing pipeline |
| HARD-FAIL rate | `evaluator.hard_fail.count` by invariant ID | > 0 for new invariant failures | Billing alerts |
| Circuit-open state | `evaluator.circuit.state` | Any transition to OPEN | PagerDuty |
| Constraint registry size | `evaluator.registry.constraint_count` | Drift from expected count | Deployment |

**Structured logging**: Every HARD-FAIL must emit a structured log with `{invariant_id, input_summary, expected, actual, timestamp}`. No PII in billing logs.

**SLO**: Evaluator availability ≥ 99.9% (measured as % of requests where evaluator is compilated and responsive). Circuit-open state counts against this SLO.

---

## 6. Scope & Prioritization

### In Scope (This Cycle)

| Priority | Item | Effort |
|----------|------|--------|
| **P0** | FR-1: Version bump + local package removal | ~0.5 sprint |
| **P0** | FR-4: Protocol handshake update | ~0.5 sprint |
| **P1** | FR-2: Canonical branded type adoption | ~1 sprint |
| **P1** | FR-3: Conservation evaluator integration | ~1 sprint |
| **P2** | FR-5: Oracle knowledge corpus update | ~0.5 sprint |

**Total estimated: 3–4 sprints**

### Explicitly Out of Scope

| Item | Why | Where It Lives |
|------|-----|----------------|
| npm publish of loa-hounfour | Different repo | loa-hounfour repo |
| Arrakis upgrade to v7.0.0 | Different repo | arrakis repo, Phase 3 |
| Cross-system E2E on v7.0.0 | Blocked on arrakis | Phase 4, future cycle |
| Adoption of v7.0.0 composition schemas (sagas, governance, etc.) | Feature work, not convergence | Future cycle |
| Adoption of `trust_scopes` in JWT flow | arrakis doesn't send it yet | Future cycle (after arrakis v7.0.0) |
| Fixing pre-existing test failures (13 tests) | Separate concern | Bug triage |

---

## 7. Risks & Dependencies

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **v7.0.0 package has undocumented breaking changes** | Low | High | Schema audit gate in Sprint 1: diff every imported symbol v5→v7, verify no new required wire-format fields. `tsc --noEmit` as first compile check. |
| **Local package removal breaks hidden imports** | Medium | Medium | Comprehensive search: workspace refs, tsconfig paths, `file:` protocol, deep imports, compiled JS strings. CI check that `require.resolve` points to `node_modules/`. |
| **Conservation evaluator performance** | Low | Medium | Evaluator compiled once at startup, cached. CI microbenchmark harness on representative payloads — build fails if p95 > 1ms. All billing invariants are **fail-closed** (no fail-open). |
| **Oracle knowledge regression** | Low | Low | Gold-set 20/20 must pass before merge |
| **Wire format incompatibility with arrakis** | Low | High | Independent golden wire fixtures (JWT, billing, stream events) created BEFORE bump, verified AFTER. Interop handshake fixture for arrakis v4.6.0. Pre-existing `s2s-jwt.test.ts` failure to be fixed or independently covered in Sprint 1. |

### Dependencies

| Dependency | Status | Blocking? |
|-----------|--------|-----------|
| loa-hounfour v7.0.0 tag | Published (2026-02-17) | No — ready |
| loa-hounfour MIGRATION.md | Exists | No — ready |
| arrakis upgrade | Not started | **Not blocking** — wire format unchanged |
| npm publish | Not done | **Not blocking** — using git tag pin |

### Dependency Graph

```
loa-hounfour v7.0.0 tag ──► FR-1: Version bump
                               │
                               ├──► FR-4: Protocol handshake
                               │
                               ├──► FR-2: Branded types (after bump compiles)
                               │
                               ├──► FR-3: Conservation evaluator (after types adopted)
                               │
                               └──► FR-5: Oracle KB (after code changes finalized)
```

---

## 8. Affected Files (Estimated)

### Source Files (Modify)

| File | Change Type | FR |
|------|-----------|-----|
| `package.json` | Bump dependency, remove workspace ref | FR-1 |
| `tsconfig.json` | Remove packages/ path mapping (if any) | FR-1 |
| `src/hounfour/protocol-handshake.ts` | Version + compatibility | FR-4 |
| `src/hounfour/tier-bridge.ts` | Canonical PoolId, branded types | FR-2 |
| `src/hounfour/pool-enforcement.ts` | Canonical PoolId, branded types | FR-2 |
| `src/hounfour/pool-registry.ts` | Canonical PoolId | FR-2 |
| `src/hounfour/jwt-auth.ts` | Canonical types | FR-2 |
| `src/hounfour/nft-routing-config.ts` | Canonical PoolId | FR-2 |
| `src/hounfour/billing-finalize-client.ts` | MicroUSD branded type, evaluator | FR-2, FR-3 |
| `src/hounfour/cost-arithmetic.ts` | MicroUSD branded type, evaluator | FR-2, FR-3 |
| `src/hounfour/budget.ts` | BasisPoints branded type, evaluator | FR-2, FR-3 |
| `src/config.ts` | Protocol version in config | FR-4 |

### Source Files (Delete)

| File | Reason | FR |
|------|--------|-----|
| `packages/loa-hounfour/` (entire directory) | Replaced by external package | FR-1 |

### Test Files (Modify)

| File | Change Type | FR |
|------|-----------|-----|
| `tests/finn/pool-enforcement.test.ts` | Update imports | FR-1, FR-2 |
| `tests/finn/budget-accounting.test.ts` | Branded type assertions | FR-2, FR-3 |
| `tests/finn/jwt-roundtrip.test.ts` | Verify wire compatibility | FR-4 |
| `tests/finn/pool-registry.test.ts` | Update imports | FR-1 |

### Knowledge Files (Rewrite)

| File | Change Type | FR |
|------|-----------|-----|
| `grimoires/oracle/code-reality-hounfour.md` | Complete rewrite for v7.0.0 | FR-5 |
| `grimoires/oracle/sources.json` | Update checksum | FR-5 |

---

## 9. Implementation Strategy

### Sprint Sequencing

```
Sprint 1: Foundation — Bump + Cleanup + Safety Gates
├── Create golden wire fixtures BEFORE bump (JWT, billing, stream events)
├── Delete packages/loa-hounfour/ (comprehensive search for hidden refs)
├── Bump dep to v7.0.0 tag
├── Schema audit: diff every imported symbol v5→v7, confirm no new required wire fields
├── Fix compile errors (tsc --noEmit)
├── Fix or independently cover s2s-jwt.test.ts wire-compat surface
├── Update protocol handshake (v7.0.0 advertised, MIN_SUPPORTED=4.0.0)
├── Add interop handshake fixture (arrakis v4.6.0 simulation)
├── Verify golden wire fixtures still pass AFTER bump
├── Run full test suite — verify ≥187 passing
└── Independently shippable checkpoint

Sprint 2: Type Adoption — Branded Types + Evaluator
├── Replace local MicroUSD/BasisPoints/AccountId with canonical
├── Add golden wire snapshot tests (billing req/res, JWT, streams)
├── Verify wire fixtures byte-for-byte stable after type migration
├── Wire conservation evaluator (compile once at startup, cache)
├── All billing invariants fail-closed — no fail-open mode
├── Add evaluator-backed invariant tests
├── CI microbenchmark: p95 evaluator overhead < 1ms
└── Independently shippable checkpoint

Sprint 3: Knowledge + Hardening
├── Rewrite Oracle knowledge sources for v7.0.0
├── Update gold-set test vectors
├── Verify 20/20 gold-set pass rate
├── Protocol version drift detection in CI
└── Final integration pass
```

### Rollback Strategy

Each sprint is independently shippable. If any sprint introduces regressions:
1. Revert the sprint's commits
2. Prior sprint's state is valid and tested
3. Git tag pin can be reverted to old commit SHA trivially

**Rollback runbook (per sprint):**

| Trigger | Signal | Owner | Action | RTO |
|---------|--------|-------|--------|-----|
| Wire-compat fixture failure post-deploy | Golden fixture test fails in staging | On-call engineer | Revert PR, re-pin to previous commit SHA | < 15 min |
| Billing invariant violation in production | Evaluator HARD-FAIL alert rate > 0 for new failure modes | On-call engineer | Circuit-open billing endpoints, revert evaluator wiring | < 10 min |
| arrakis handshake rejection | `CONTRACT_VERSION_MISMATCH` errors from arrakis | On-call engineer | Revert `CONTRACT_VERSION` to previous value | < 10 min |
| Test regression > 2 failures beyond baseline | CI red, new failures not in pre-existing 13 | Sprint author | Block merge, fix or revert | Before merge |

**Verification after rollback**: Golden wire fixtures pass, test count ≥ 187, arrakis handshake fixture passes, evaluator health check returns OK.

### Deployment Strategy

**Canary deployment** for each sprint merge:
1. Deploy to staging with full test suite + golden wire fixtures
2. Shadow traffic: replay 10 min of production billing requests against staging, compare responses byte-for-byte
3. Canary: route 5% of production traffic for 30 min, monitor evaluator latency + error rate
4. Full rollout only after canary shows zero new errors and p95 latency within budget
5. Rollback hook: automated revert if error rate exceeds 0.1% during canary window
