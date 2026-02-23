# PRD: Protocol Convergence v7.9.2 — Full Adoption

> **Version**: 1.1.0
> **Date**: 2026-02-23
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-032
> **Origin**: [Launch Readiness RFC — Issue #66](https://github.com/0xHoneyJar/loa-finn/issues/66) Sprint A: Protocol Adoption
> **Predecessor**: cycle-030 "Forward Architecture" (sprints 121-123, 562 tests), cycle-026 "Protocol Convergence v7.0.0" (sprint 65)
> **Protocol Package**: [@0xhoneyjar/loa-hounfour v7.9.2](https://github.com/0xHoneyJar/loa-hounfour/releases/tag/v7.9.2) (released 2026-02-23)

---

## 0. Framing — Why This Matters Now

loa-finn currently pins `@0xhoneyjar/loa-hounfour` at commit `d091a3c0` (v7.0.0). That version was published with a **stale dist build** requiring a postinstall patch script (`scripts/patch-hounfour-dist.sh`) that clones the repo, checks out the commit, and rebuilds from source on every `pnpm install`.

v7.9.2 was released today (2026-02-23) with:
- **Clean dist** — Loa development framework ejected, protocol-only distribution
- **Additive-only changes** — all new features are opt-in imports (but see §4.2 for dist/export-map verification requirements)
- **111 new conformance vectors** (91 → 202) — doubled cross-language validation coverage
- **11 new evaluator builtins** (31 → 42) — conservation, bigint, temporal governance
- **Decision engine** — `evaluateEconomicBoundary()` for trust × capital access decisions
- **Strict BigInt parser** — `parseMicroUsd()` with discriminated union return
- **6-dimensional trust** — `CapabilityScopedTrust` replacing flat trust_level
- **Constraint provenance** — `ConstraintOrigin` on all 72 constraint files

The gap between v7.0.0 and v7.9.2 represents 9 minor versions of additive protocol evolution. Every feature loa-finn's billing, trust, reputation, and governance systems need is now available as a shared contract. Continuing to maintain local implementations of protocol-level concerns creates drift risk and doubles the maintenance surface.

Issue #66 identifies "Arrakis adopts loa-hounfour" as a P0 Sprint A deliverable. This cycle completes the **loa-finn side** of that convergence — ensuring finn is a model consumer that arrakis can reference.

---

## 1. Problem Statement

### 1.1 Stale Dependency

The v7.0.0 pin requires a postinstall patch that:
- Clones the full repo on every `pnpm install` (slow CI, flaky in air-gapped environments)
- Hardcodes a commit SHA (`d091a3c0`) that must match the pin (fragile coupling)
- Exits silently if the package isn't installed (hides failures)

> Source: `scripts/patch-hounfour-dist.sh:1-52`, `package.json:29,32`

### 1.2 Protocol Drift

Local implementations diverge from protocol contracts:

| Local Implementation | Protocol Counterpart (v7.9.2) | Relationship |
|---------------------|-------------------------------|-------------|
| `wire-boundary.ts:parseMicroUSD()` — throws, allows negatives | `parseMicroUsd()` — discriminated union, non-negative only | **Complementary**: protocol for strict boundaries, local for internal accounting |
| `billing-conservation-guard.ts` — post-invocation invariant checks | `evaluateEconomicBoundary()` — pre-invocation trust×capital decision | **Complementary**: different lifecycle phases (see §4.5 choreography) |
| No trust scoping | `CapabilityScopedTrust` — 6-dimensional | Missing capability granularity |
| No constraint provenance | `ConstraintOrigin` — genesis/enacted/migrated | No constraint audit trail |
| 91 conformance vectors | 202 conformance vectors | 111 untested protocol paths |

> Source: `src/hounfour/wire-boundary.ts:55-95`, `src/hounfour/billing-conservation-guard.ts:55-67`

### 1.3 Missing Protocol Features

v7.1.0–v7.9.2 introduced features loa-finn already needs but implements locally:

- **Reputation event sourcing** (v7.3.0): `reconstructAggregateFromEvents()`, `verifyAggregateConsistency()` — loa-finn has `EventStore` (cycle-030) but no protocol-level aggregate verification
- **Access policy evaluation** (v7.1.0): `evaluateAccessPolicy()` — loa-finn has ad-hoc tier checks in `pool-enforcement.ts`
- **Constraint namespace validation** (v7.8.0): `detectReservedNameCollisions()` — no equivalent in loa-finn
- **Model economic profiles** (v7.7.0): `ModelEconomicProfileSchema` — loa-finn uses untyped provider config

---

## 2. Goals & Success Metrics

### 2.1 Primary Goals

| # | Goal | Measurable Outcome |
|---|------|--------------------|
| G1 | **Bump to v7.9.2** | `package.json` pins `ff8c16b8` (v7.9.2 tag SHA) |
| G2 | **Remove postinstall patch** | `scripts/patch-hounfour-dist.sh` deleted, `postinstall` hook removed |
| G3 | **Adopt protocol decision engine** | `evaluateEconomicBoundary()` integrated at access control boundary |
| G4 | **Adopt protocol BigInt parser** | `parseMicroUsd()` used at strict non-negative boundaries |
| G5 | **Adopt protocol type system** | Branded types, schemas, and vocabulary from v7.1.0–v7.9.2 imported where applicable |
| G6 | **Run all 202 conformance vectors** | Test suite validates against full v7.9.2 vector set |
| G7 | **Update protocol handshake** | `CONTRACT_VERSION` reflects v7.9.2, feature detection updated |

### 2.2 Success Criteria

- **Zero regressions**: All existing tests pass (currently ~1,105+)
- **Full vector coverage**: 202/202 conformance vectors pass
- **No local duplication**: Every protocol-level function that has a v7.9.2 equivalent either delegates to the protocol version or documents why it doesn't
- **Clean install**: `pnpm install` completes without postinstall patching
- **Type safety**: No `as unknown as` casts at protocol boundaries

### 2.3 Non-Goals

- Arrakis-side adoption (tracked in [arrakis#54](https://github.com/0xHoneyJar/arrakis/issues/54))
- New feature development beyond adoption
- Breaking changes to loa-finn's public API surface
- Constraint authoring (v7.8.0 grammar) — adopt types only, defer authoring tools

---

## 3. Scope & Requirements

### 3.1 Bump & Clean (G1, G2)

**FR-1**: Update `package.json` dependency from `d091a3c0` to `ff8c16b899b5bbebb9bf1a5e3f9e791342b49bea` (v7.9.2 tag).

**FR-2**: Delete `scripts/patch-hounfour-dist.sh` and remove `"postinstall"` from `package.json` scripts.

**FR-3**: Run `pnpm install` and verify clean resolution without patching.

**FR-3a** (Resolution Audit Gate): Before any adoption work, enumerate ALL current import specifiers used across loa-finn (including deep JSON paths like `vectors/jwt/conformance.json` and sub-module paths like `@0xhoneyjar/loa-hounfour/economy`). Verify each resolves under v7.9.2's `exports` map. If any deep path is not exported, switch to an exported loader API or vendor vectors into test fixtures. This gate MUST pass before Sprint 1 tasks beyond the bump itself can proceed.

Verification steps:
1. `pnpm install && pnpm typecheck` — compile-time import resolution
2. `node -e "require.resolve('@0xhoneyjar/loa-hounfour')"` — runtime resolution
3. Grep all `from '@0xhoneyjar/loa-hounfour` import paths, attempt dynamic import of each
4. Verify `vectors/` directory structure is preserved in v7.9.2 dist

### 3.2 Decision Engine Adoption (G3)

**FR-4**: Integrate `evaluateEconomicBoundary()` at the access control layer (invoke handler, oracle handler) as a pre-flight check alongside existing pool enforcement.

**Design considerations**:
- `evaluateEconomicBoundary()` evaluates trust × capital to produce an access decision with structured denial reasons and gap analysis
- This **complements** (does not replace) `BillingConservationGuard` — they operate at different points in the request lifecycle (see §4.5 Enforcement Choreography)
- The function is total (never throws), deterministic (caller-provided `evaluatedAt`), and fail-closed
- Requires `TrustLayerSnapshot` and `CapitalLayerSnapshot` — wire these from existing tier/budget state

**FR-5**: Integrate `evaluateFromBoundary()` convenience overload where `EconomicBoundary` objects are available (prevents confused deputy with caller-provided criteria).

**FR-5a**: Reference `ECONOMIC_CHOREOGRAPHY` and `TRANSFER_INVARIANTS` from protocol vocabulary to document the enforcement ordering. Require tests that simulate each failure point in the choreography (boundary denies → no provider call; boundary allows but guard fails → no billing commit).

### 3.3 BigInt Parser Adoption (G4)

**FR-6**: Adopt `parseMicroUsd()` from protocol at **strict non-negative boundaries** (HTTP ingress, JWT claim parsing, billing finalize wire).

**Design constraint**: loa-finn's local `parseMicroUSD()` allows **negatives** (deficit tracking) and performs **normalization** (leading zero stripping, "-0" → "0"). The protocol `parseMicroUsd()` is non-negative only with discriminated union return. These serve different purposes:

| Boundary | Parser | Reason |
|----------|--------|--------|
| HTTP ingress (JWT claims, request bodies) | **Protocol** `parseMicroUsd()` | Wire values are always non-negative |
| Billing finalize wire | **Protocol** `parseMicroUsd()` | Costs are always non-negative |
| Internal accounting (budget tracking, deficit) | **Local** `parseMicroUSD()` | Needs negative support |
| Persistence read (WAL, R2) | **Local** `parseMicroUSDLenient()` | Needs normalization + negative |

**FR-7**: Add protocol `parseMicroUsd` as an import in `wire-boundary.ts` and create a delegating wrapper. The wrapper imports `MicroUSD` from the same module that produces `result.amount` to avoid brand-symbol mismatch:
```typescript
import { parseMicroUsd, type MicroUSD as ProtocolMicroUSD } from '@0xhoneyjar/loa-hounfour';
// Re-export the protocol type as the canonical MicroUSD
export type { ProtocolMicroUSD as StrictMicroUSD };

// At strict non-negative boundaries, delegate to protocol parser
export function parseStrictMicroUSD(raw: string): ProtocolMicroUSD {
  const result = parseMicroUsd(raw);
  if (!result.valid) throw new WireBoundaryError("micro_usd", raw, result.reason);
  return result.amount;  // No cast — same type provenance
}
```

**FR-7a** (Negative Value Boundary Invariant): Define and enforce a hard invariant:
- **Negative MicroUSD values** (deficit tracking) are ONLY permitted in internal accounting contexts: `budget.ts`, `ledger.ts`, `ledger-v2.ts`, `billing/state-machine.ts`
- **Negative values MUST NEVER cross** strict non-negative boundaries: JWT claims, HTTP request/response bodies, billing finalize wire, cost ledger JSONL entries
- If a deficit must be communicated externally, use a separate signed field (e.g., `balance_delta`) with its own schema
- **Required tests**: Round-trip WAL → internal → outbound wire to verify no negative leaks. Property test: any value entering `parseStrictMicroUSD` that is negative produces a `WireBoundaryError`

### 3.4 Type System Adoption (G5)

**FR-8**: Import and use the following v7.1.0–v7.9.2 types where applicable:

| Type/Schema | Version | Use In |
|-------------|---------|--------|
| `JwtClaimsSchema` | v7.0.0 | `jwt-auth.ts` — validate JWT claims at parse boundary |
| `BillingEntrySchema` | v7.0.0 | `billing/types.ts` — validate billing entries |
| `EconomicBoundarySchema` | v7.7.0 | New access control layer |
| `QualificationCriteria` | v7.9.0 | Economic boundary evaluation |
| `DenialCode` | v7.9.1 | Structured denial reasons in access decisions |
| `EvaluationGap` | v7.9.1 | Gap analysis in denied access decisions |
| `ModelEconomicProfileSchema` | v7.7.0 | Provider config typing |
| `MicroUSDC` (branded) | v7.1.0 | Replace local `MicroUSDC` in `wire-boundary.ts` |
| `ConstraintOrigin` | v7.9.0 | Constraint provenance tracking |
| `ReputationStateName` | v7.9.0 | Type-safe reputation state references |

**FR-9**: Replace local `MicroUSDC` branded type in `wire-boundary.ts:236-265` with import from `@0xhoneyjar/loa-hounfour/economy` (`MicroUSDC`, `microUSDC`, `readMicroUSDC`).

**FR-9a** (Branded Type Migration Plan): Systematic migration to ensure exactly ONE source of truth per brand:

| Branded Type | Current Source | Target Source (v7.9.2) | Migration |
|-------------|---------------|----------------------|-----------|
| `MicroUSD` | Protocol (`BrandedMicroUSD as MicroUSD`) | Protocol (same) | No change — already canonical |
| `BasisPoints` | Protocol | Protocol (same) | No change |
| `AccountId` | Protocol | Protocol (same) | No change |
| `PoolId` | Protocol | Protocol (same) | No change |
| `MicroUSDC` | **Local** (`wire-boundary.ts:236`) | **Protocol** (`economy/branded-types.ts`) | **Migrate** — replace local brand symbol with protocol import |
| `CreditUnit` | Local (`wire-boundary.ts:186`) | Local (no protocol equivalent) | Keep local — finn-specific denomination |

Migration steps:
1. Inventory all branded money types and their constructors/readers across codebase
2. Replace local `MicroUSDC` declaration with protocol import; use `readMicroUSDC()` as adapter where old constructors were used
3. Provide temporary adapter: `wire-boundary.ts` re-exports protocol `MicroUSDC` for backward-compatible import paths
4. After Sprint 2: forbid parallel local brand symbols for any type that has a protocol equivalent (enforced via ESLint rule or grep in CI)

**FR-10**: Import `JTI_POLICY` from protocol (`@0xhoneyjar/loa-hounfour/economy`) and validate consistency with local JTI policy constants in `jwt-auth.ts`.

### 3.5 Vocabulary & Utilities Adoption (G5)

**FR-11**: Import and use the following vocabulary/utility exports:

| Export | Version | Replaces/Complements |
|--------|---------|---------------------|
| `computeCostMicro()` / `computeCostMicroSafe()` | v5.1.0 | Validate against local `calculateCostMicro` in `pricing.ts` |
| `verifyPricingConservation()` | v5.1.0 | Protocol-level pricing invariant |
| `validateBillingEntry()` | v5.1.0 | Protocol-level billing entry validation |
| `isValidNftId()` / `parseNftId()` | v5.1.0 | NFT ID validation in routing config |
| `isKnownReputationState()` | v7.9.1 | Type guard for reputation state references |
| `REPUTATION_STATES` / `REPUTATION_STATE_ORDER` | v7.9.0 | Canonical reputation vocabulary |
| `ECONOMIC_CHOREOGRAPHY` | v7.7.0 | Document billing flow ordering |
| `TRANSFER_CHOREOGRAPHY` / `TRANSFER_INVARIANTS` | v7.0.0 | Transfer flow validation |

**FR-12**: Import `evaluateAccessPolicy()` (v7.1.0) and evaluate for use in `pool-enforcement.ts` alongside existing tier checks.

### 3.6 Conformance Vectors (G6)

**FR-13**: Update conformance vector test infrastructure to load all 202 vectors from the v7.9.2 package. Vector loading MUST be self-verifying:
1. Discover vectors by enumerating the `vectors/` directory in the installed package (glob `vectors/**/*.json`)
2. Assert total vector count equals 202 (hard-coded expected count from release notes)
3. Assert category coverage includes at minimum: `jwt`, plus any new categories (billing, economic-boundary, constraint)
4. If v7.9.2 exports a manifest file (`vectors/manifest.json` or similar), use it as the authoritative source; otherwise vendor a pinned manifest in `tests/fixtures/` for this release

**FR-14**: Current JWT conformance test (`tests/finn/jwt-auth.test.ts:31`) loads vectors from `node_modules/@0xhoneyjar/loa-hounfour/vectors/jwt/conformance.json`. Verify this path is valid in v7.9.2 (part of FR-3a resolution audit). If the path changed, update accordingly.

**FR-15**: Add conformance vector tests for every new vector category introduced in v7.1.0–v7.9.2. Each category gets its own test file following the pattern `tests/finn/conformance-{category}.test.ts`. A test that loads zero vectors from a category MUST fail (prevents silent empty-directory pass).

### 3.7 Protocol Handshake Update (G7)

**FR-16**: After bumping, `CONTRACT_VERSION` will be `7.9.2`. Verify `protocol-handshake.ts` compatibility logic works correctly:
- `FINN_MIN_SUPPORTED` remains `4.0.0` (arrakis transition still in progress)
- Feature detection MUST derive from `CONTRACT_VERSION` semver comparison against each feature's introduction version — NOT from hardcoded boolean assumptions
- Add feature detection for v7.9.0+ features: `economicBoundary`, `constraintOrigin`

**FR-17**: Update `PeerFeatures` interface to include new feature flags. Each flag is derived from the remote peer's advertised `contract_version` by comparing against the feature's introduction version:
```typescript
interface PeerFeatures {
  trustScopes: boolean;              // introduced v6.0.0
  capabilityScopedTrust: boolean;    // introduced v7.6.0
  economicBoundary: boolean;         // introduced v7.9.0
  constraintOrigin: boolean;         // introduced v7.9.0
}

// Derive from remote version, not hardcoded
function detectPeerFeatures(remoteVersion: string): PeerFeatures {
  const remote = parseSemver(remoteVersion);
  const gte = (major: number, minor: number) =>
    remote.major > major || (remote.major === major && remote.minor >= minor);
  return {
    trustScopes: gte(6, 0),
    capabilityScopedTrust: gte(7, 6),
    economicBoundary: gte(7, 9),
    constraintOrigin: gte(7, 9),
  };
}
```

**FR-17a** (Handshake Behavioral Compatibility): Version compatibility is necessary but not sufficient for behavioral compatibility. Define which side enforces which check for each feature:

| Feature | Finn Enforces | Arrakis Enforces | Graceful Degradation |
|---------|--------------|-----------------|---------------------|
| `trustScopes` | Economic boundary uses 6D trust if peer supports | Sends trust scopes in JWT if available | Falls back to flat trust_level |
| `economicBoundary` | Runs evaluation if peer advertises | N/A (finn-side only) | Skips evaluation, logs warning |
| `constraintOrigin` | Validates provenance if peer supports | Includes origin in constraint payloads | Accepts constraints without origin |

Require integration tests with simulated peers advertising v4.6.0, v6.0.0, v7.0.0, and v7.9.2 to verify graceful degradation at each feature boundary.

### 3.8 Documentation & Reality Update

**FR-18**: Update `grimoires/oracle/code-reality-hounfour.md` to reflect v7.9.2 exports, new modules, and updated import map.

---

## 4. Architecture Constraints

### 4.1 No Breaking Changes to loa-finn API

All changes are internal. The HTTP API surface (`/api/v1/*`, `/ws/*`, `/health`) remains identical. Callers see no difference.

### 4.2 Additive Adoption Only (With Verification)

v7.9.2 is additive-only per release notes. However, the "clean dist" (Loa framework ejected) release is exactly where module/export paths, ESM/CJS conditions, or file layout can change without API-level breaking changes. The upgrade path includes mandatory verification gates:

1. Bump pin → **FR-3a resolution audit** (verify all import specifiers resolve) → verify existing tests pass
2. Remove patch → verify clean install (no postinstall, no manual rebuild)
3. Adopt new features → add new imports and integration points
4. Run vectors → verify protocol compliance (self-verifying count assertion)

### 4.3 Local Implementations Preserved Where Needed

The local `parseMicroUSD()` (negative-capable, normalizing) is **not replaced** — it serves a different purpose than the protocol's strict non-negative `parseMicroUsd()`. Similarly, `BillingConservationGuard` remains — the protocol decision engine is complementary, not a replacement.

### 4.4 Branded Type Compatibility

loa-finn imports `BrandedMicroUSD as MicroUSD` from the protocol. v7.9.2 maintains the same branded type definition. The `MicroUSDC` type in `wire-boundary.ts` uses a local brand symbol — this MUST be migrated to the protocol version per FR-9a to ensure cross-system type compatibility and prevent brand-symbol mismatch at compile time.

### 4.5 Enforcement Choreography

The economic boundary evaluator and conservation guard operate at different points in the request lifecycle. The authoritative fail-closed enforcement ordering is:

```
Request Arrives
  │
  ├─ 1. JWT Auth (pool-enforcement.ts)
  │     └─ Tier/pool validation, JTI replay check
  │
  ├─ 2. Economic Boundary Evaluation (NEW — evaluateEconomicBoundary)
  │     └─ Trust × Capital pre-flight. If DENIED → 403 + structured denial_codes
  │     └─ No provider call. No billing entry. Request terminates.
  │
  ├─ 3. Budget Reserve (budget.ts)
  │     └─ Atomic reserve against daily budget
  │
  ├─ 4. Provider Call (cheval-invoker.ts / native-adapter.ts)
  │     └─ Model invocation with tool-call orchestration
  │
  ├─ 5. Conservation Guard (billing-conservation-guard.ts)
  │     └─ Post-invocation invariant checks (cost ≥ 0, spent ≤ limit)
  │     └─ If FAIL → no billing commit, compensating entry written, 500 returned
  │
  └─ 6. Billing Finalize (billing-finalize-client.ts)
        └─ Commit actual cost to arrakis. DLQ on transient failure.
```

**Failure semantics**:
- Step 2 denies → no provider call, no billing, client gets structured denial with gap analysis
- Step 5 fails → provider call happened but billing is NOT committed, compensating WAL entry
- Step 6 fails transiently → DLQ with replay (existing dead-letter infrastructure)

**Invariant**: A billing commit (step 6) MUST NOT occur unless conservation guard (step 5) passes. Tests MUST simulate each failure point.

---

## 5. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | v7.9.2 dist has unexpected module/export-map changes (ejected framework may alter file layout) | Medium | High | FR-3a resolution audit gate: enumerate all import specifiers, verify resolution before proceeding. Abort Sprint 1 if any path breaks. |
| R2 | Conformance vector directory structure changed or vector count doesn't match 202 | Low | Medium | FR-13 self-verifying loader: assert count == 202, assert category coverage, fail loudly on mismatch |
| R3 | `evaluateEconomicBoundary()` integration adds latency to request path | Medium | Low | Function is pure computation (<1ms); benchmark before/after |
| R4 | Local `MicroUSDC` brand symbol mismatch with protocol brand causes widespread compile errors or pressure to add unsafe casts | Medium | High | FR-9a migration plan: inventory all branded types, migrate systematically with adapter functions via `readMicroUSDC()`, forbid parallel local brands after Sprint 2 |
| R5 | Handshake version compatibility ≠ behavioral compatibility — feature flags gate security decisions | Medium | Medium | FR-17a behavioral compatibility matrix: define per-feature enforcement responsibility, graceful degradation, integration tests with simulated peers at v4.6.0/v6.0.0/v7.0.0/v7.9.2 |
| R6 | Negative MicroUSD values leak from internal accounting to strict non-negative wire boundaries | Low | High | FR-7a negative invariant: explicit boundary rules, round-trip WAL→internal→wire tests, property tests for parseStrictMicroUSD |

---

## 6. Out of Scope

- **Arrakis protocol adoption** — tracked separately in arrakis#54
- **Constraint authoring tools** — adopt types only; grammar/tokenizer/type-checker are protocol internals
- **Reputation credential system** — `computeCredentialPrior()` available but needs persistence design
- **Schema graph visualization** — `buildSchemaGraph()` available but no UI exists
- **Event subscription system** — `EventSubscriptionSchema` available but needs runtime design
- **Saga orchestration** — `BridgeTransferSagaSchema` available but cross-system; needs arrakis coordination

---

## 7. Sprint Estimation

| Sprint | Focus | Estimated Tasks |
|--------|-------|-----------------|
| Sprint 1 | **Bump + Clean + Vectors** — Pin v7.9.2, remove patch, verify all tests, run 202 vectors | ~6 tasks |
| Sprint 2 | **Type System + Vocabulary Adoption** — Import schemas, replace local MicroUSDC, adopt utilities, update handshake | ~7 tasks |
| Sprint 3 | **Decision Engine + Access Control** — Integrate `evaluateEconomicBoundary()`, wire trust/capital snapshots, adopt access policy | ~6 tasks |

**Total**: ~19 tasks across 3 sprints. No new infrastructure — pure adoption and integration.

---

## 8. References

| Document | Location |
|----------|----------|
| Issue #66 — Launch Readiness RFC | [GitHub](https://github.com/0xHoneyJar/loa-finn/issues/66) |
| loa-hounfour v7.9.2 Release | [GitHub](https://github.com/0xHoneyJar/loa-hounfour/releases/tag/v7.9.2) |
| Hounfour Code Reality | `grimoires/oracle/code-reality-hounfour.md` |
| Protocol Handshake (SDD §3.2) | `src/hounfour/protocol-handshake.ts` |
| Wire Boundary (SDD §4.1) | `src/hounfour/wire-boundary.ts` |
| Conservation Guard (SDD §4.2, §7.2) | `src/hounfour/billing-conservation-guard.ts` |
| Current package pin | `package.json:32` — `d091a3c0` (v7.0.0) |
| Target tag SHA | `ff8c16b899b5bbebb9bf1a5e3f9e791342b49bea` (v7.9.2) |
