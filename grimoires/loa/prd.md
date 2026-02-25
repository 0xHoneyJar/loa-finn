# PRD: Hounfour v8.2.0 Upgrade — Commons Protocol + ModelPerformance

> **Version**: 1.1.0
> **Date**: 2026-02-25
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-033
> **Predecessor**: cycle-032 "Protocol Convergence v7.9.2" (sprints 126-131, all completed)
> **Protocol Package**: [@0xhoneyjar/loa-hounfour v8.2.0](https://github.com/0xHoneyJar/loa-hounfour/releases/tag/v8.2.0) (released 2026-02-25)
> **Migration Guide**: [MIGRATION.md — v7.11.0 → v8.2.0](https://github.com/0xHoneyJar/loa-hounfour/blob/main/MIGRATION.md#v7110--v820-breaking)

---

## 0. Framing — Why This Matters Now

loa-finn currently pins `@0xhoneyjar/loa-hounfour` at commit `ff8c16b` (v7.9.2). That version was adopted in cycle-032 with full protocol convergence — 202 conformance vectors, strict `parseMicroUsd()`, 6-dimensional trust, and economic boundary evaluation.

v8.2.0 was released today (2026-02-25) and crosses a **major version boundary** with three breaking changes and significant additive features:

### Breaking Changes

| Version | Change | loa-finn Impact |
|---------|--------|-----------------|
| **v8.0.0** | New `commons` module — 21 governance substrate schemas (`GovernedResource<T>`, `ConservationLaw`, `AuditTrail`, `StateMachine`, `DynamicContract`, `GovernanceError`) | New import path `@0xhoneyjar/loa-hounfour/commons`. **No existing code breaks** — commons is additive. Major version bump is for the new module's surface area commitment. |
| **v8.1.0** | `GovernanceMutation.actor_id` now **required** (was optional) | **No current usage in loa-finn.** GovernanceMutation is not constructed anywhere in src/. Forward-compat only — any future adoption must include `actor_id`. |
| **v8.2.0** | `ModelPerformanceEvent` — 4th `ReputationEvent` discriminated union variant | **No current ReputationEvent routing in loa-finn.** The reputation system uses `TIER_TRUST_MAP` with static states, not event-driven routing. However, this closes the Dixie → scoring → routing → Finn autopoietic feedback loop described in the Dixie contract. |

### Additive Features

| Feature | Version | Purpose | Adoption Priority |
|---------|---------|---------|-------------------|
| `QualityObservation` schema | v8.2.0 | Structured quality evaluation: score [0,1], dimensions, latency, evaluator | SHOULD — aligns with `quality-gate-scorer.ts` |
| `'unspecified'` TaskType literal | v8.2.0 | Reserved fallback when task metadata unavailable | SHOULD — NFT routing needs fallback handling |
| Governance Enforcement SDK | v8.2.0 | `evaluateGovernanceMutation()`, conservation law factories, checkpoint utilities | MAY — future governance substrate |
| 17 new conformance vectors (219 total) | v8.2.0 | Property-based discrimination tests, integration tests | MUST — conformance-vectors.test.ts auto-discovers |
| ADR-006 through ADR-009 | v8.2.0 | Hash chain, commons pattern, enforcement SDK, dynamic contract decisions | Informational |

### Why Now

1. **Dixie integration dependency** — loa-dixie needs to emit `ModelPerformanceEvent` per the Dixie contract. Finn must be on v8.2.0 to share the schema vocabulary.
2. **Conformance vector drift** — Every day on v7.9.2 means new upstream vectors are untested. The conformance test suite auto-discovers from the manifest, but schema structural changes (new required fields on existing schemas) could silently break validation.
3. **Governance substrate foundation** — The `commons` module provides the building blocks for governed resources (credits, reputation, freshness). Finn's billing ledger, quality governance, and reputation bootstrap (cycle-031) are natural adoption candidates.
4. **Low migration cost** — None of the three breaking changes cause compile-time errors in existing loa-finn code. However, the upgrade requires runtime/interop behavioral changes: protocol handshake version gating, TaskType routing updates, and QualityObservation output contract adoption. These are scoped and testable.

---

## 1. Problem Statement

loa-finn is pinned to `@0xhoneyjar/loa-hounfour` v7.9.2. The upstream protocol has evolved to v8.2.0 with a new governance substrate (`commons` module), required `actor_id` on governance mutations, and a 4th reputation event variant (`ModelPerformanceEvent`). While none of these changes cause compile-time breaks in existing loa-finn code, the upgrade requires runtime behavioral changes (handshake version gating, TaskType routing, quality output contracts). Remaining on v7.9.2 creates:

- **Schema vocabulary drift** between finn and dixie (dixie needs v8.2.0 for `ModelPerformanceEvent`)
- **Untested conformance vectors** (17 new vectors in v8.2.0)
- **Blocked governance adoption** (commons module only available in v8.0.0+)
- **Interop risk** during staged deployments if handshake compatibility window is not defined

> Sources: [MIGRATION.md](https://github.com/0xHoneyJar/loa-hounfour/blob/main/MIGRATION.md), [v8.2.0 release notes](https://github.com/0xHoneyJar/loa-hounfour/releases/tag/v8.2.0), dixie-contract.md

---

## 2. Goals & Success Metrics

### Primary Goals

| # | Goal | Metric |
|---|------|--------|
| G1 | Bump to v8.2.0 with zero regression | All existing tests pass, conformance vectors validate |
| G2 | Runtime-safe forward-compat for v8.x changes | `normalizeReputationEvent()` handles all 4 variants; `GovernanceMutation` documented with `actor_id` requirement |
| G3 | Adopt additive features with testable contracts | `scoreQualityGate()` output validated against `QualityObservationSchema`; `'unspecified'` TaskType routes to default pool via `mapTaskTypeToRoutingKey()` |
| G4 | Conformance vector coverage at v8.2.0 level | All manifest vectors pass, count ≥ 202 baseline |

### Non-Goals

| # | Non-Goal | Rationale |
|---|----------|-----------|
| NG1 | Full commons module adoption (governed credits, state machines) | Requires architectural design beyond version bump scope |
| NG2 | Dynamic contract negotiation | v8.0.0 feature, no current consumer need |
| NG3 | Governance enforcement SDK integration | `evaluateGovernanceMutation()` needs governance workflow design first |
| NG4 | Dixie-side ModelPerformanceEvent emission | Dixie's responsibility, tracked separately |

---

## 3. Scope

### In Scope

1. **Dependency bump**: `@0xhoneyjar/loa-hounfour` v7.9.2 → v8.2.0
2. **Protocol handshake update**: Update `CONTRACT_VERSION` expectation to `"8.2.0"`. Define compatibility window: finn MUST accept `8.x` (any 8.x minor) and MAY accept `7.9.2` during a rollout grace period (configurable, default 7 days). After grace period, `FINN_MIN_SUPPORTED` moves to `"8.0.0"`. This ensures staged deployments where dixie or arrakis may still be on 7.9.2 do not hard-break interop.
3. **Conformance vector validation**: 219 vectors (17 new), any new required categories
4. **Protocol-types.ts hub update**: Re-export new schemas/types from `commons` and `governance` subpackages
5. **ReputationEvent normalizer**: Add a minimal `normalizeReputationEvent()` function that pattern-matches all 4 variants including `model_performance`. For `model_performance`, log and emit a metric (no routing action yet — routing is a future cycle concern). Unit test with a `model_performance` fixture asserting the event is recognized and metered, not dropped.
6. **Forward-compat: GovernanceMutation actor_id**: Document requirement in protocol-types.ts JSDoc. No code changes needed (type not currently constructed).
7. **QualityObservation adoption**: Refactor `quality-gate-scorer.ts` to return `QualityObservation`-shaped output from `scoreQualityGate()`. Validate output against `QualityObservationSchema` at the call site using the hounfour validator. Unit test asserting `scoreQualityGate()` output passes schema validation. This is the internal quality scoring function — its output becomes the canonical payload for Dixie consumption.
8. **TaskType 'unspecified' handling**: Replace local `NFTTaskType` union with protocol `TaskType` and add an explicit mapping layer in `nft-routing-config.ts`: `mapTaskTypeToRoutingKey(taskType: TaskType): NFTRoutingKey`. `'unspecified'` maps to `'default'`. Unit test passing `'unspecified'` through `resolvePool()` and asserting default pool selection.

### Out of Scope

- Commons module governed resource adoption (future cycle)
- Dynamic contract negotiation
- Governance enforcement SDK wiring
- State machine configuration
- Dixie-side changes

---

## 4. Technical Context

### 4.1 Current Integration Surface (25 files)

The centralized re-export hub at `src/hounfour/protocol-types.ts` (143 lines, 43 named exports) is the single import point. All protocol types flow through this file. The upgrade affects this hub and its downstream consumers.

**Integration categories:**

| Category | Files | Key Imports |
|----------|-------|-------------|
| Core protocol bridge | `protocol-types.ts`, `wire-boundary.ts`, `protocol-handshake.ts` | 43 re-exports, branded types, version validation |
| Economic evaluation | `economic-boundary.ts`, `pool-enforcement.ts`, `tier-bridge.ts` | `evaluateEconomicBoundary()`, `TIER_TRUST_MAP`, pool claims |
| Billing/finance | `billing/types.ts`, `billing/ledger.ts`, `billing/pricing.ts`, `billing/state-machine.ts` | `BrandedMicroUSD` |
| Credits | `credits/conversion.ts`, `credits/purchase.ts` | `BrandedMicroUSD` |
| NFT routing | `nft-routing-config.ts` | `PoolId`, `Tier`, `TaskType` |
| JWT/auth | `jwt-auth.ts`, `s2s-jwt.ts`, `jti-replay.ts` | JWT schemas |
| Quality | `quality-gate-scorer.ts` | Quality scoring (adoption target for `QualityObservation`) |

### 4.2 Breaking Change Impact Analysis

#### GovernanceMutation.actor_id (v8.1.0)

**Current usage**: NONE. Grep for `GovernanceMutation` across `src/` returns zero hits. This type exists in the protocol but is not yet constructed by loa-finn.

**Action**: No code changes needed. Document requirement in protocol-types.ts JSDoc for future adoption.

#### ModelPerformanceEvent (v8.2.0)

**Current usage**: NONE. `ReputationEvent` is not routed or switched on in loa-finn. The reputation system uses `TIER_TRUST_MAP` (static mapping) and `ReputationProvider` interface (boost lookup), not event-driven processing.

**Action**: (1) Re-export the new type and schema from protocol-types.ts. (2) Add a `normalizeReputationEvent()` function that exhaustively pattern-matches all 4 variants with a `never` default. The `model_performance` variant is recognized, logged with a metric (`reputation_event_received{type="model_performance"}`), and returned — no routing action. This provides runtime safety against silent event drops and establishes the integration point for future Dixie-driven reputation routing.

#### commons module (v8.0.0)

**Current usage**: NONE. New import path `@0xhoneyjar/loa-hounfour/commons`.

**Action**: No immediate adoption. Re-export key schemas from protocol-types.ts for discoverability. The `GovernedCredits` schema is a natural fit for billing ledger governance in a future cycle.

### 4.3 Additive Feature Analysis

#### QualityObservation (v8.2.0)

**Natural fit**: `src/hounfour/quality-gate-scorer.ts` currently uses ad-hoc quality scoring. `QualityObservation` provides a canonical schema: `score: [0,1]`, optional `dimensions`, `latency`, `evaluator`. Adopting this aligns Finn's quality gate output with the protocol's expectation for Dixie consumption.

**Integration point**: `scoreQualityGate()` is the function that produces quality results. Its return type will be refactored to conform to `QualityObservation`. The output is validated at the call site using hounfour's schema validator (TypeBox `Value.Check(QualityObservationSchema, output)`). This output is an internal event consumed by the quality governance pipeline (cycle-031) and will become the payload Dixie reads for `ModelPerformanceEvent` emission.

#### TaskType 'unspecified' (v8.2.0)

**Natural fit**: `src/hounfour/nft-routing-config.ts` defines a local `NFTTaskType = "chat" | "analysis" | "architecture" | "code" | "default"`. The protocol `TaskType` now includes `'unspecified'` as a reserved fallback.

**Strategy**: Replace the local `NFTTaskType` union with protocol `TaskType` as the input type. Add an explicit mapping function `mapTaskTypeToRoutingKey(taskType: TaskType): NFTRoutingKey` where `NFTRoutingKey` remains the internal union (`"chat" | "analysis" | "architecture" | "code" | "default"`). The mapping sends `'unspecified'` → `'default'` and unknown values → `'default'` with a warning log. This creates a single source of truth (protocol `TaskType`) with a well-defined narrowing boundary.

### 4.4 Conformance Vectors

Current: 202 vectors validated in `tests/finn/conformance-vectors.test.ts` (auto-discovered from manifest).
Target: v8.2.0 manifest vectors (expected ~219 but not hardcoded). The test suite reads `schemas/index.json` from the installed package and auto-discovers all schemas. Assertions verify: (1) discovered count ≥ 202 baseline (no regression), (2) discovered count matches manifest entry count (no orphans or missing schemas), (3) all schemas parse and validate structurally. The actual count is logged for observability but not used as a gate value, avoiding brittleness when upstream adds vectors in patch releases.

---

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Schema structural changes break existing validation | Low | High | Conformance vectors test all schemas; CI catches structural drift |
| New required fields on existing schemas | Low | High | MIGRATION.md documents only `actor_id` on `GovernanceMutation` (unused) |
| `commons` import path breaks bundler | Low | Medium | Verify `exports` map in package.json supports `@0xhoneyjar/loa-hounfour/commons` |
| Version handshake rejects v8.2.0 or breaks 7.9.2 peers during rollout | Medium | High | Define compatibility window: accept 8.x primary + 7.9.2 grace period. Test both directions. `FINN_MIN_SUPPORTED` stays at `"7.9.2"` during grace, moves to `"8.0.0"` after. |
| Post-install build script incompatibility | Low | High | v8.2.0 has clean dist — verify no postinstall workaround is needed |

---

## 6. Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| AC1 | `@0xhoneyjar/loa-hounfour` resolves to v8.2.0 tag | `pnpm ls @0xhoneyjar/loa-hounfour` shows 8.2.0 |
| AC2 | All existing tests pass with zero regression | `pnpm test` exits 0 |
| AC3 | Conformance vectors pass against installed manifest | `conformance-vectors.test.ts` passes; discovered count ≥ 202 baseline AND matches manifest `index.json` entry count (no orphans, no missing). Actual count logged but not hardcoded. |
| AC4 | Protocol handshake succeeds with `CONTRACT_VERSION` "8.2.0" and backward-compat with 7.9.2 | `interop-handshake.test.ts` passes with both `"8.2.0"` (primary) and `"7.9.2"` (grace period). Test for `"6.0.0"` rejects. |
| AC5 | `protocol-types.ts` re-exports new v8.2.0 types | Import test: `ModelPerformanceEvent`, `QualityObservation`, `GovernanceError` resolve without errors |
| AC6 | `scoreQualityGate()` returns `QualityObservation`-conformant output | Unit test: call `scoreQualityGate()`, validate return value against `QualityObservationSchema` via `Value.Check()`, assert pass |
| AC7 | `'unspecified'` TaskType routes to default pool | Unit test: call `resolvePool(tier, 'unspecified')` through the actual routing entrypoint, assert default pool selected |
| AC8 | `normalizeReputationEvent()` handles all 4 variants | Unit test: feed `model_performance` fixture, assert recognized and metered (not dropped). Exhaustive `never` check on unknown variants. |
| AC9 | No postinstall patch script required | `scripts/patch-hounfour-dist.sh` not invoked (or removed if exists) |

---

## 7. Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| loa-hounfour v8.2.0 release | Released | 2026-02-25, tag available |
| cycle-032 completion | Archived | All 6 sprints completed, no blocking items |
| Dixie contract (consumer) | External | Dixie adopts v8.2.0 independently |

---

## 8. Appendix: Migration Checklist (from MIGRATION.md)

Per the [loa-finn consumer migration path](https://github.com/0xHoneyJar/loa-hounfour/blob/main/MIGRATION.md#loa-finn):

1. ✅ Update `@0xhoneyjar/loa-hounfour` to `^8.2.0`
2. ✅ Add `actor_id` to all `GovernanceMutation` payloads (no current usage — forward-compat only)
3. ✅ Handle `model_performance` variant in `ReputationEvent` routing (no current routing — forward-compat only)
4. ✅ Optionally import governance enforcement utilities from `./commons`
