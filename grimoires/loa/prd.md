# PRD: Hounfour v7.11.0 Protocol Convergence

**Cycle**: 034 (Protocol Convergence)
**Status**: Draft
**Author**: Claude Opus 4.6 + Jani (strategic direction)
**Date**: 2026-02-24
**References**: [#66 Launch Readiness](https://github.com/0xHoneyJar/loa-finn/issues/66) · [loa-hounfour v7.11.0](https://github.com/0xHoneyJar/loa-hounfour) · [#31 Hounfour RFC](https://github.com/0xHoneyJar/loa-finn/issues/31)
**GPT-5.2 Review**: Iteration 1 — 7 blocking issues addressed

---

## 1. Problem Statement

**finn speaks hounfour v7.9.2. The protocol has moved to v7.11.0.**

Three releases (v7.10.0, v7.10.1, v7.11.0) have shipped upstream since finn pinned its dependency at commit `ff8c16b`. These releases are **additive by intent** (no deliberate breaking changes), but any dependency upgrade can surface type changes, stricter validation, or changed defaults that require adaptation. The upgrade must be validated through compile-check, compatibility matrix testing, and per-feature enablement flags before any new behavior activates. The capabilities delivered:

1. **Task-Dimensional Reputation** — Reputation scores are currently a single blended number per tenant (`blended_score` in `TIER_TRUST_MAP`). v7.11.0 introduces per-task-type cohorts (`TaskTypeCohort`, `ReputationEvent`, `ScoringPathLog`), meaning a tenant can be "established" for conversation but "cold" for code generation. finn's economic boundary and pool routing currently cannot express this.

2. **Native Enforcement Interface** — finn's `pool-enforcement.ts` and `economic-boundary.ts` use expression-based evaluation (`evaluateEconomicBoundary()`, `evaluateAccessPolicy()`). v7.11.0 adds `evaluation_geometry: 'native'` — a local evaluator optimization that calls enforcement functions directly instead of parsing expressions. This is a **local configuration choice** (not a peer-negotiated capability) — the wire protocol is unchanged; only the internal evaluation path differs.

3. **Tamper-Evident Hash Chain** — finn's `AuditTrail` (`src/safety/audit-trail.ts`) already maintains a hash chain, but v7.11.0 provides a protocol-level chain (SHA-256 + RFC 8785 canonical JSON). Aligning these creates cross-system auditability between finn and arrakis.

4. **Open Enum TaskType** — finn currently hardcodes task routing in `nft-routing-config.ts` with string literals. v7.11.0 introduces `namespace:type` extensible task types, enabling `finn:conversation`, `finn:summarize`, `finn:memory_inject` as first-class protocol citizens.

5. **Protocol Handshake Gap** — `protocol-handshake.ts` detects features up to v7.9.1 (`denialCodes`). None of the v7.10.0+ features are discoverable. The current handshake relies solely on semver thresholds, but arrakis spans v4.6.0–v7.x and older peers may not report semver reliably or may backport features. A dual-strategy approach (explicit peer-advertised capabilities with semver fallback) is needed.

> Sources: loa-hounfour CHANGELOG, issue #66 Command Center, codebase analysis of `src/hounfour/`

---

## 2. Vision

**"The protocol speaks for itself."**

After this cycle, finn doesn't just _use_ hounfour — it _converges_ with it. Task-dimensional reputation means an NFT agent's conversation skill and code generation skill have independent reputations. The hash chain means every enforcement decision is cryptographically auditable across finn and arrakis. Open task types mean finn can register its own capabilities (conversation, memory, summarization) as protocol-native operations. The handshake knows about all of it.

This is the last structural gap between finn's runtime and the protocol's design intent. After this, capability expansion is configuration, not code.

---

## 3. What Already Exists

| Component | File(s) | Status | Gap |
|-----------|---------|--------|-----|
| **Protocol Handshake** | `protocol-handshake.ts` | Built (v7.9.1) | Missing v7.10.0+ feature thresholds; semver-only detection |
| **Economic Boundary** | `economic-boundary.ts` | Built | Flat tier→reputation mapping, no task-dimensional cohorts |
| **Pool Enforcement** | `pool-enforcement.ts` | Built | Expression-only, no native geometry |
| **Tier Bridge** | `tier-bridge.ts` | Built | Static tier→pool mapping |
| **NFT Routing Config** | `nft-routing-config.ts` | Built | Hardcoded string task types |
| **Audit Trail** | `safety/audit-trail.ts` | Built | Independent hash chain, not protocol-aligned |
| **Protocol Types** | `protocol-types.ts` | Built | Re-exports from v7.9.2 — missing new types |
| **Wire Boundary** | `wire-boundary.ts` | Built | Branded type parsers — needs new branded types |
| **Types** | `types.ts` | Built | Re-exports from v7.9.2 |
| **Package.json** | `package.json:32` | `@0xhoneyjar/loa-hounfour#ff8c16b` | Pinned to v7.9.2 commit |

> Sources: `src/hounfour/protocol-handshake.ts`, `src/hounfour/economic-boundary.ts`, `package.json`

---

## 4. Goals & Success Metrics

| ID | Goal | Metric | Target |
|----|------|--------|--------|
| G-1 | **Upgrade dependency** | `@0xhoneyjar/loa-hounfour` resolves to v7.11.0 exact commit | package.json pin updated, `npm test` passes, upstream CHANGELOG diff reviewed |
| G-2 | **Feature detection complete** | Protocol handshake detects all v7.11.0 features | `PeerFeatures` includes 4 new fields; capability + semver dual detection |
| G-3 | **Task-dimensional reputation** | Economic boundary evaluates per-task-type cohorts | Unit tests cover multi-cohort scenarios with TaskType propagation |
| G-4 | **Native enforcement path** | Pool enforcement supports `evaluation_geometry: 'native'` | CI microbenchmark: native >= 3x faster than expression in same harness |
| G-5 | **Hash chain alignment** | Audit trail uses protocol hash chain format | Chain validates with shared test vectors; versioned envelope format |
| G-6 | **Open task types** | NFT routing uses `namespace:type` pattern | `finn:conversation`, `finn:summarize`, `finn:memory_inject` registered |
| G-7 | **Zero regression** | All existing tests pass under compatibility matrix | 779+ tests green against v7.9.2 behavior and v7.11.0 behavior |
| G-8 | **Upstream TODO resolved** | `economic-boundary.ts` TODO for `denial_codes` type removed | No local type extensions for upstream gaps |

---

## 5. User Stories

### US-1: Protocol Handshake Detects v7.11.0 Features (Dual-Strategy)

```
As the loa-finn boot sequence,
I want to detect task-dimensional reputation, hash chain,
and open task types from the remote arrakis health response,
using both explicit peer-advertised capabilities and semver fallback,
so that I can enable or degrade features correctly even when
the peer's version is absent, unparsable, or backported.

Acceptance Criteria:
- PeerFeatures includes: taskDimensionalReputation (v7.10.0+),
  hashChain (v7.10.1+), openTaskTypes (v7.11.0+)
- Primary detection: peer-advertised "capabilities" array/bitset
  in health response (when present)
- Fallback detection: FEATURE_THRESHOLDS semver comparison
  (when capabilities field is absent)
- Unknown state: when neither source is available, feature defaults
  to false (conservative)
- Backward compatibility: features remain false for v7.9.x peers
- Tests cover: v4.6.0, v7.9.x, v7.11.0, absent version,
  unparsable version, and backported-feature scenarios
- Log line shows detection method (capability/semver/unknown) per feature
```

### US-2: Task-Dimensional Reputation in Economic Boundary

```
As the economic boundary evaluator,
I want to use per-task-type reputation cohorts instead of a single
blended score,
so that a tenant with high conversation reputation but low code
generation reputation gets appropriate access for each task type.

Acceptance Criteria:
- TIER_TRUST_MAP replaced or augmented with task-type cohort mapping
- evaluateEconomicBoundary receives task type context
- TaskType is sourced from wire-boundary.ts parsing of inbound request
- TaskType is stored in WAL/audit record payloads
- TaskType propagates through enforcement → reputation event emission
- Fallback: if peer doesn't support task-dimensional reputation,
  use blended score (current behavior)
- Shadow mode logs cohort-vs-blended divergence for observability
```

### US-3: Native Enforcement Geometry (Local Evaluator)

```
As the pool enforcement middleware,
I want to use native function-call enforcement as a local optimization,
so that enforcement evaluation is faster without changing the wire protocol.

Acceptance Criteria:
- evaluateAccessPolicy supports evaluation_geometry: 'native'
- Native path calls local enforcement function directly
  (no expression parsing)
- Expression path remains default for backward compatibility
- This is a LOCAL config choice — not gated on peer capabilities
- Config: ENFORCEMENT_GEOMETRY=expression|native (default: expression)
- Wire protocol request/response format is identical for both paths
- Compatibility tests: v7.9.x peer interaction is byte-for-byte
  compatible regardless of local geometry choice
- CI microbenchmark: native path >= 3x faster than expression path
  in same harness (same input rules, logging off, Node 22, single-thread)
```

### US-4: Protocol-Aligned Hash Chain (Versioned Envelope)

```
As the audit trail,
I want to produce hash chain entries in a versioned envelope format
using the protocol's canonical serialization (SHA-256 + RFC 8785),
so that chain entries can be verified cross-system by arrakis.

Acceptance Criteria:
- Each entry hashes: prev_hash || canonical_json({version, algo,
  format, timestamp, action, payload_hash})
  where canonical_json uses RFC 8785 serialization
- Entry includes explicit "format" field: "protocol_v1" or "legacy"
- Verifiers select format per entry using the "format" field
- SHA-256 used for protocol_v1 (matching protocol spec)
- Migration: bridge entry computed with both legacy_prev_hash and
  protocol_prev_hash, marking the transition point
- Dual-write period: both legacy and protocol hashes computed for
  a configurable number of entries (default: 1000) after migration
- Shared test vectors: finn and arrakis validate identical chains
  from the same input data
- Replay test: existing chain replays correctly through the
  bridge entry and into protocol_v1 entries
```

### US-5: Open Enum Task Types for finn

```
As the NFT routing config,
I want to register finn-specific task types using the namespace:type pattern,
so that conversation, summarization, and memory injection are protocol-native
operations with their own reputation cohorts.

Acceptance Criteria:
- TaskType is a first-class field on the request context produced by
  wire-boundary.ts parsing
- Validation: namespace:type format, allowed charset [a-z0-9_-],
  max 64 chars, lowercase normalized
- finn-native types: "finn:conversation", "finn:summarize",
  "finn:memory_inject"
- nft-routing-config.ts routes by TaskType instead of string literals
- TaskType stored in WAL/audit record payloads, passed through all
  enforcement and reputation interfaces
- Unknown task types: DENY with denial code "unknown_task_type"
  unless explicitly allowlisted per tenant in config
- Configurable fallback: UNKNOWN_TASK_TYPE_POLICY=deny|safe_default
  (deny = reject with denial code; safe_default = route to
  rate-limited pool with strict budget)
- Legacy callers without TaskType: deterministic fallback mapping
  based on endpoint (e.g., /chat → finn:conversation)
- Tests cover: valid types, invalid format, unknown type denial,
  allowlisted unknown type, legacy caller fallback
```

### US-6: Dependency Upgrade with Zero Regression

```
As the CI pipeline,
I want the hounfour dependency upgraded from v7.9.2 to v7.11.0,
so that all new types and functions are available at compile time.

Acceptance Criteria:
- package.json points to exact v7.11.0 commit hash (not just tag)
- Upstream CHANGELOG diff (v7.9.2→v7.11.0) reviewed and documented
  in grimoires/loa/NOTES.md
- TypeScript compiles cleanly (no new errors)
- All 779+ existing tests pass
- Compatibility matrix test suite validates against:
  - v7.9.2 runtime behavior (existing tests)
  - v7.11.0 compile-time types (new imports resolve)
- Local type extensions (EvaluationResultWithDenials) removed
  if upstream now exports denial_codes
- Each new capability gated behind individual feature flag:
  - TASK_DIMENSIONAL_REPUTATION_ENABLED (default: false)
  - NATIVE_ENFORCEMENT_ENABLED (default: false)
  - PROTOCOL_HASH_CHAIN_ENABLED (default: false)
  - OPEN_TASK_TYPES_ENABLED (default: false)
- No runtime behavior change without explicit feature enablement
```

---

## 6. Functional Requirements

### FR-1: Dependency Upgrade (with Compatibility Validation)

- Update `@0xhoneyjar/loa-hounfour` from commit `ff8c16b` (v7.9.2) to exact v7.11.0 commit hash
- Review upstream CHANGELOG diff and document type/default changes in NOTES.md
- Remove local type patches (`EvaluationResultWithDenials` in `economic-boundary.ts`) if upstream types now include `denial_codes`
- Verify all existing imports from `@0xhoneyjar/loa-hounfour` still resolve
- Re-export any new branded types through `types.ts` and `wire-boundary.ts`
- Run compatibility matrix: compile against v7.11.0 types, test against v7.9.2 behavior expectations
- Gate each new capability behind individual feature flag (all default to `false`)

### FR-2: Protocol Handshake Extension (Dual-Strategy Detection)

- Add 3 new fields to `PeerFeatures` (capabilities negotiated with peer):
  - `taskDimensionalReputation: boolean` (v7.10.0+)
  - `hashChain: boolean` (v7.10.1+)
  - `openTaskTypes: boolean` (v7.11.0+)
- **Note**: `nativeEnforcement` is NOT a peer feature — it is a local evaluator choice (see FR-4)
- Implement dual-strategy detection:
  1. **Primary**: Parse `capabilities` array from health response if present (explicit peer advertisement)
  2. **Fallback**: Use `FEATURE_THRESHOLDS` semver comparison if `capabilities` absent
  3. **Unknown**: If neither source available, default to `false` (conservative)
- Add corresponding entries to `FEATURE_THRESHOLDS` for semver fallback
- Maintain existing fields unchanged
- Log detection method per feature: `method=capability|semver|unknown`
- Tests: v4.6.0, v7.9.x, v7.11.0, absent version, unparsable version, backported features

### FR-3: Task-Dimensional Reputation Integration

- Import `TaskTypeCohort`, `ReputationEvent`, `ScoringPathLog` from upstream
- Extend `ReputationProvider` interface (in `types.ts`) to support cohort-based queries
- Modify economic boundary to accept `taskType` parameter (required when feature enabled)
- **TaskType data flow**: `wire-boundary.ts` parse → request context → enforcement → reputation event → WAL/audit
- When `peerFeatures.taskDimensionalReputation` is true AND feature flag enabled, query cohort-specific scores
- When false or disabled, fall back to current `TIER_TRUST_MAP` blended scores
- Add shadow-mode metric: `hounfour_reputation_cohort_vs_blended_delta`

### FR-4: Native Enforcement Path (Local Configuration)

- Add `ENFORCEMENT_GEOMETRY` env var (values: `expression`, `native`; default: `expression`)
- Implement native enforcement function matching protocol's evaluation interface
- **This is a local evaluator optimization** — not gated on peer capabilities or health response
- The wire protocol request/response format is identical regardless of geometry
- Expression path remains default; native is opt-in via config
- Compatibility requirement: v7.9.x peer interaction must produce identical enforcement results regardless of local geometry choice
- CI microbenchmark: same input rules, logging disabled, Node 22, single-threaded. Target: native >= 3x faster than expression

### FR-5: Hash Chain Alignment (Versioned Envelope)

- Define versioned hash chain envelope format:
  ```
  entry_hash = SHA-256(prev_hash || canonical_json({
    version: 1,
    algo: "sha256",
    format: "protocol_v1",
    timestamp: <ISO-8601>,
    action: <string>,
    payload_hash: SHA-256(canonical_json(payload))
  }))
  ```
  where `canonical_json` uses RFC 8785 serialization
- Each `AuditRecord` includes explicit `format` field (`"protocol_v1"` or `"legacy"`)
- Verifiers select hash computation method per entry based on `format` field
- Migration bridge entry:
  - Computed with `legacy_prev_hash` (last legacy entry's hash)
  - Contains both `legacy_prev_hash` and `protocol_prev_hash` (same value for bridge)
  - Marks the deterministic transition point
- Dual-write period: both legacy and protocol hashes computed for configurable period (default: 1000 entries)
- After dual-write: legacy computation drops, only `protocol_v1` continues
- Shared test vectors: document in `tests/safety/hash-chain-vectors.json` for cross-system validation
- Never rewrite existing chain entries

### FR-6: Open Task Types (with Conservative Unknown Handling)

- Import `TaskType` branded type from upstream (or define with `wire-boundary.ts` parser)
- Validation: `namespace:type` format, charset `[a-z0-9_-]`, max 64 chars, lowercase normalized
- `TaskType` is a first-class field on request context (`wire-boundary.ts` → all downstream)
- `TaskType` stored in WAL entry payloads and `AuditRecord` payloads
- `TaskType` propagated through: pool routing → enforcement → reputation event emission
- Define finn-native task types: `finn:conversation`, `finn:summarize`, `finn:memory_inject`
- Refactor `nft-routing-config.ts` to route by `TaskType` instead of string literals
- Register finn task types in protocol-handshake health response
- **Unknown task type handling** (configurable via `UNKNOWN_TASK_TYPE_POLICY`):
  - `deny` (default): reject with denial code `unknown_task_type`
  - `safe_default`: route to rate-limited pool with strict budget enforcement
- Per-tenant allowlist: config can allowlist specific unknown task types per tenant
- Legacy caller fallback: deterministic mapping from endpoint to TaskType (e.g., `/chat` → `finn:conversation`)

### FR-7: Goodhart Protection (ADR-004)

- Implement scoring path logging when `ScoringPathLog` is available
- Ensure reputation events include `TaskType` context for dimensional scoring
- No single metric can determine enforcement outcome alone

---

## 7. Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Native enforcement latency | >= 3x faster than expression in CI microbenchmark (same harness, Node 22, single-threaded, logging off) |
| NFR-2 | Backward compatibility | All v7.9.x and v4.6.0 peers continue working identically |
| NFR-3 | Hash chain validation | < 10ms per entry verification |
| NFR-4 | Zero downtime upgrade | Existing sessions unaffected; all features behind flags (default off) |
| NFR-5 | Type safety | No `any` casts on new upstream types; all branded types through wire-boundary |

---

## 8. Scope & Prioritization

### In Scope (This Cycle)

1. **P0**: Dependency upgrade to v7.11.0 with compatibility matrix (FR-1)
2. **P0**: Protocol handshake extension with dual-strategy detection (FR-2)
3. **P1**: Task-dimensional reputation integration with TaskType data flow (FR-3)
4. **P1**: Open task types registration with conservative unknown handling (FR-6)
5. **P1**: Native enforcement path as local config (FR-4)
6. **P2**: Hash chain alignment with versioned envelope and migration (FR-5)
7. **P2**: Goodhart protection wiring (FR-7)

### Out of Scope

- Arrakis v7.11.0 upgrade (separate workstream per issue #66)
- Freeside hounfour adoption (workstream #2 per issue #66)
- Dixie hounfour adoption (workstream #5 per issue #66)
- Governance explorer UI (workstream #7 per issue #66)
- Personality authoring pipeline (workstream #4 per issue #66)
- New model providers or pool configuration changes

---

## 9. Risks & Dependencies

| Risk | Severity | Mitigation |
|------|----------|------------|
| v7.11.0 has undocumented type changes | Medium | Pin to exact commit hash, review CHANGELOG diff, compile-check before behavior changes |
| Additive changes break pinned integration | Medium | Compatibility matrix tests validate v7.9.2 behavior preserved under v7.11.0 types |
| Shadow mode masks issues in production | Low | Structured logging with alerts on divergence > threshold |
| Hash chain migration corrupts existing trail | High | Versioned envelope with bridge entry; dual-write period; never rewrite history; shared test vectors |
| Expression → native enforcement edge cases | Medium | Wire protocol unchanged; CI tests confirm identical results for both geometry paths |
| Unknown task types exploit cheap routing | High | Conservative default: deny unknown task types; per-tenant allowlist required |
| Capability detection disagrees with semver | Medium | Explicit priority: capability field > semver > unknown (conservative) |

### Dependencies

- `@0xhoneyjar/loa-hounfour` v7.11.0 must be published/tagged with stable commit
- Issue #66 workstream #1 (merge protocol-convergence-v7) should be complete first
- No dependency on arrakis upgrade — finn upgrades first per issue #66 command center

---

## 10. Technical Constraints

- **Existing file count**: 57 TypeScript files in `src/hounfour/` — changes must be surgical
- **Branded types**: All protocol values use branded types (`MicroUSD`, `PoolId`, `AccountId`) — new types (including `TaskType`) must follow the same pattern through `wire-boundary.ts`
- **Three enforcement modes**: `bypass`, `shadow`, `enforce` — new features must respect all three
- **Dev/prod divergence**: Handshake skips in dev, fails-fast in prod — new features follow same pattern
- **No FinnConfig schema enforcement for pools**: Existing tech debt (pools config not validated in schema) — don't add to this debt
- **Feature flags**: All new capabilities default to `false` — no behavior change on upgrade alone
- **TaskType as first-class field**: Must propagate end-to-end: wire-boundary parse → request context → enforcement → reputation → WAL → audit

---

## 11. Upgrade Plan

### Phase A: Compile-Time Upgrade (Sprint 1)

1. Pin `@0xhoneyjar/loa-hounfour` to exact v7.11.0 commit hash
2. Review upstream CHANGELOG diff (v7.9.2 → v7.11.0), document in NOTES.md
3. Fix any compile errors from type changes
4. Remove local type patches if upstream now exports them
5. Verify all 779+ tests pass with zero behavior change
6. Add feature flag env vars (all default `false`)

### Phase B: Protocol Extension (Sprint 2)

1. Extend handshake with dual-strategy detection
2. Wire TaskType through request context and all downstream interfaces
3. Implement open task types with deny-by-default for unknowns
4. Implement task-dimensional reputation with shadow mode

### Phase C: Internal Optimizations (Sprint 3)

1. Native enforcement geometry (local config, no wire change)
2. Hash chain versioned envelope with migration bridge
3. Goodhart protection scoring path logging
4. CI microbenchmarks and shared test vectors
