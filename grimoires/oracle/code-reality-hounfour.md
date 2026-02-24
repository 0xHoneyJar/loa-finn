---
generated_date: "2026-02-24"
source_repo: 0xHoneyJar/loa-hounfour
provenance: cycle-032-sprint-128-task-3.6
tags: ["technical"]
---

# Code Reality: loa-hounfour

Technical knowledge source documenting the `@0xhoneyjar/loa-hounfour` protocol
package as observed from loa-finn's imports and usage. This is a protocol
library -- it defines interfaces, canonical vocabularies, and validation
functions. Implementations live in loa-finn and arrakis.

**Dependency reference**: `loa-finn/package.json` pins the package at a
specific commit SHA (v7.9.2 tag):

```json
"@0xhoneyjar/loa-hounfour": "github:0xHoneyJar/loa-hounfour#ff8c16b899b5bbebb9bf1a5e3f9e791342b49bea"
```

**Contract version**: `7.9.2` (CONTRACT_VERSION constant from the package).

---

## 1. Module Map

The package exports from multiple subpaths:

| Subpath | Purpose |
|---------|---------|
| `@0xhoneyjar/loa-hounfour` | Main: pool vocab, tier model, versioning, reputation, access policy, economic boundary evaluation |
| `@0xhoneyjar/loa-hounfour/economy` | Economy: MicroUSDC types, pricing, billing schemas, JWT schemas, NFT IDs, economic boundary schemas |
| `@0xhoneyjar/loa-hounfour/constraints` | Constraints: ConstraintOrigin type |

---

## 2. Known Exports (from loa-finn import analysis)

### 2.1 Main Package (`@0xhoneyjar/loa-hounfour`)

#### Types

| Export | Description |
|--------|-------------|
| `PoolId` | Branded string type for canonical pool identifiers |
| `Tier` | String literal union: `"free" \| "pro" \| "enterprise"` |
| `TaskType` | String type for task classification |
| `ReputationStateName` | `"cold" \| "warming" \| "established" \| "authoritative"` |
| `AccessPolicyContext` | Input context for access policy evaluation |
| `AccessPolicyResult` | Result of access policy evaluation |

#### Constants

| Export | Description |
|--------|-------------|
| `POOL_IDS` | Canonical set of valid pool IDs |
| `TIER_POOL_ACCESS` | Map: Tier to readonly PoolId[] |
| `TIER_DEFAULT_POOL` | Map: Tier to default PoolId |
| `CONTRACT_VERSION` | Protocol version string (`"7.9.2"`) |
| `REPUTATION_STATES` | Array of valid reputation state names |
| `REPUTATION_STATE_ORDER` | Map: state name → numeric order (cold=0, warming=1, established=2, authoritative=3) |

#### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `isValidPoolId` | `(id: string) => boolean` | Validate pool ID against canonical vocabulary |
| `tierHasAccess` | `(tier: Tier, poolId: string) => boolean` | Check tier can access pool |
| `validateCompatibility` | `(remoteVersion: string) => CompatResult` | Semver compatibility check |
| `isKnownReputationState` | `(s: string) => s is ReputationStateName` | Type guard for reputation states |
| `evaluateEconomicBoundary` | `(trust, capital, criteria, evaluatedAt) => EvaluationResult` | Core economic boundary evaluation |
| `evaluateFromBoundary` | `(boundary, criteria, evaluatedAt) => EvaluationResult` | Evaluate from pre-constructed boundary object |
| `evaluateAccessPolicy` | `(context: AccessPolicyContext) => AccessPolicyResult` | Access policy evaluation |

### 2.2 Economy Subpackage (`@0xhoneyjar/loa-hounfour/economy`)

#### Types

| Export | Description |
|--------|-------------|
| `MicroUSDC` | Branded type for micro-USD amounts (string integer) |
| `BrandedMicroUSD` | Branded arithmetic micro-USD type |
| `BasisPoints` | Branded basis points type |
| `AccountId` | Branded account identifier type |
| `JwtClaims` (as `ProtocolJwtClaims`) | Protocol JWT claims schema type |
| `S2SJwtClaims` (as `ProtocolS2SJwtClaims`) | Service-to-service JWT claims |
| `BillingEntry` (as `ProtocolBillingEntry`) | Billing entry wire type |
| `EconomicBoundary` | Combined trust + capital boundary object |
| `QualificationCriteria` | Threshold criteria for boundary evaluation |
| `DenialCode` | Denial code enum for boundary denials |
| `EvaluationGap` | Gap between evaluation and criteria |
| `ModelEconomicProfile` | Model-level economic configuration |
| `JwtBoundarySpec` | JWT boundary specification (replay_window_seconds) |
| `NftId` / `ParsedNftId` | NFT identifier types |
| `PricingInput` (as `ProtocolPricingInput`) | Pricing computation input |
| `UsageInput` (as `ProtocolUsageInput`) | Usage computation input |
| `ConservationResult` | Pricing conservation verification result |
| `TransferChoreography` / `TransferInvariant` | Transfer choreography vocabulary |
| `EconomicChoreography` | Economic choreography vocabulary |
| `TrustLayerSnapshot` | Trust layer state for boundary evaluation |
| `CapitalLayerSnapshot` | Capital layer state for boundary evaluation |
| `AccessDecision` | Boundary access decision (granted + denial_reason) |
| `TrustEvaluation` | Trust evaluation sub-result |
| `CapitalEvaluation` | Capital evaluation sub-result |
| `EconomicBoundaryEvaluationResult` | Full boundary evaluation result |

#### Schemas (Zod)

| Export | Description |
|--------|-------------|
| `JwtClaimsSchema` | Zod schema for JWT claims |
| `S2SJwtClaimsSchema` | Zod schema for S2S JWT claims |
| `BillingEntrySchema` (as `ProtocolBillingEntrySchema`) | Billing entry schema |
| `EconomicBoundarySchema` | Economic boundary schema |
| `QualificationCriteriaSchema` | Qualification criteria schema |
| `DenialCodeSchema` | Denial code schema |
| `EvaluationGapSchema` | Evaluation gap schema |
| `ModelEconomicProfileSchema` | Model economic profile schema |
| `JwtBoundarySpecSchema` | JWT boundary spec schema |
| `TrustLayerSnapshotSchema` | Trust layer snapshot schema |
| `CapitalLayerSnapshotSchema` | Capital layer snapshot schema |
| `AccessDecisionSchema` | Access decision schema |
| `TrustEvaluationSchema` | Trust evaluation schema |
| `CapitalEvaluationSchema` | Capital evaluation schema |
| `EconomicBoundaryEvaluationResultSchema` | Full evaluation result schema |

#### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `microUSDC` | `(value: number) => MicroUSDC` | Create branded MicroUSDC value |
| `readMicroUSDC` | `(value: MicroUSDC) => number` | Read branded MicroUSDC as number |
| `serializeMicroUSDC` (as `protocolSerializeMicroUSDC`) | `(value: MicroUSDC) => string` | Serialize to wire string |
| `deserializeMicroUSDC` | `(value: string) => MicroUSDC` | Deserialize from wire string |
| `microUSDToUSDC` | `(micro: number) => number` | Convert micro-USD to USDC |
| `microUSDCToUSD` | `(micro: MicroUSDC) => number` | Convert MicroUSDC to USD |
| `computeCostMicro` (as `protocolComputeCostMicro`) | `(input: PricingInput) => MicroUSDC` | Compute cost in micro-USD |
| `computeCostMicroSafe` (as `protocolComputeCostMicroSafe`) | `(input: PricingInput) => MicroUSDC \| null` | Safe cost computation (null on error) |
| `verifyPricingConservation` | `(input, output) => ConservationResult` | Verify pricing conservation invariant |
| `validateBillingEntry` (as `protocolValidateBillingEntry`) | `(entry) => boolean` | Validate billing entry |
| `validateBillingRecipients` (as `protocolValidateBillingRecipients`) | `(recipients) => boolean` | Validate recipients |
| `validateCreditNote` (as `protocolValidateCreditNote`) | `(note) => boolean` | Validate credit note |
| `allocateRecipients` (as `protocolAllocateRecipients`) | `(amount, recipients) => Allocation[]` | Allocate billing across recipients |
| `isValidNftId` | `(id: string) => boolean` | Validate NFT ID format |
| `parseNftId` | `(id: string) => ParsedNftId` | Parse NFT ID into components |
| `formatNftId` | `(parsed: ParsedNftId) => string` | Format ParsedNftId back to string |
| `checksumAddress` | `(address: string) => string` | EIP-55 checksum address |

#### Constants

| Export | Description |
|--------|-------------|
| `JTI_POLICY` (as `PROTOCOL_JTI_POLICY`) | Protocol-defined JTI replay policy per endpoint type |
| `TRANSFER_CHOREOGRAPHY` | Transfer choreography step vocabulary |
| `TRANSFER_INVARIANTS` | Transfer invariant definitions |
| `ECONOMIC_CHOREOGRAPHY` | Economic choreography (6-step enforcement chain) |

### 2.3 Constraints Subpackage (`@0xhoneyjar/loa-hounfour/constraints`)

| Export | Description |
|--------|-------------|
| `ConstraintOrigin` | Type for constraint origin tracking |

---

## 3. Economic Boundary Evaluation

The core economic boundary evaluation is the pre-invocation gate (SDD §6.3, step 2).

### 3.1 Input Types

```typescript
interface TrustLayerSnapshot {
  reputation_state: ReputationStateName  // "cold" | "warming" | "established" | "authoritative"
  blended_score: number                  // 0-100
  snapshot_at: string                    // ISO-8601
}

interface CapitalLayerSnapshot {
  budget_remaining: string               // MicroUSD string integer
  billing_tier: string                   // Billing scope
  budget_period_end: string              // ISO-8601
}

interface QualificationCriteria {
  min_trust_score: number
  min_reputation_state: ReputationStateName
  min_available_budget: string           // MicroUSD string integer
}
```

### 3.2 Result Type

```typescript
interface EconomicBoundaryEvaluationResult {
  access_decision: {
    granted: boolean
    denial_reason?: string
  }
  trust_evaluation: {
    passed: boolean
    score: number
    state: ReputationStateName
  }
  capital_evaluation: {
    passed: boolean
    remaining: string
  }
  denial_codes?: DenialCode[]           // e.g. "TRUST_SCORE_BELOW_THRESHOLD"
  evaluated_at: string
}
```

### 3.3 Denial Codes

Known denial codes: `TRUST_SCORE_BELOW_THRESHOLD`, `TRUST_STATE_BELOW_THRESHOLD`,
`BUDGET_BELOW_THRESHOLD`.

### 3.4 loa-finn Adapter

`src/hounfour/economic-boundary.ts` bridges JWT claims to protocol evaluation:

- **TIER_TRUST_MAP**: Maps tier to `{reputation_state, blended_score}`:
  - `free` → `{cold, 10}`
  - `pro` → `{warming, 50}`
  - `enterprise` → `{established, 80}`
  - `authoritative` → `{authoritative, 95}` — (Sprint 5, Task 5.3) the tier that money cannot buy. Reached only via behavioral evidence through `ReputationProvider`, not subscription level.
- **ECONOMIC_BOUNDARY_MODE** env var: `enforce` | `shadow` | `bypass` (default: `shadow`)
- **Circuit breaker** (Sprint 4, Task 4.1; Sprint 5, Task 5.1): `CircuitBreaker` class instantiated per-middleware (Hystrix bulkheading). Configurable `threshold`/`windowMs`/`resetMs`. Default: 5 failures/30s → open, 60s cooldown → half-open. Half-open behavior: `isOpen()` returns false after cooldown (allows one probe request). Success in half-open → circuit closes. Failure in half-open → circuit immediately re-opens (no gradual recovery). Mode-aware: enforce → 503 (fail-closed), shadow → allow through.
- **Budget period** (Sprint 4, Task 4.2): `BudgetSnapshot.budget_period_end?` (ISO 8601). When provided, used verbatim in capital snapshot. When absent, 30-day default.
- **Tenant ID hashing** (Sprint 4, Task 4.4): `hashTenantId()` — SHA-256 truncated to 16 hex chars. Used in structured logs for PII protection. Raw `tenant_id` preserved in 403 response bodies (goes to authenticated tenant).
- **denial_codes type gap** (Sprint 4, Task 4.3): Local `EvaluationResultWithDenials` extends protocol type. Upstream issue: [loa-hounfour#35](https://github.com/0xHoneyJar/loa-hounfour/issues/35).
- **Graceful degradation**: Pre-v7.7 peers use flat tier-based trust only
- **ReputationProvider** (Sprint 5, Task 5.3): Optional async interface `{ getReputationBoost(tenantId): Promise<{boost, source} | null> }` exported from `types.ts`. When provided to `buildTrustSnapshot()` and tenant tier is "enterprise", queried with 5ms `Promise.race` timeout. Boost >= 15 upgrades reputation to "authoritative" with blended score. Provider absent, returning null, throwing, or timing out → static mapping (fail-closed). Only queried for enterprise tier.
- **Blended score weighting** (Sprint 5, Task 5.4): `computeBlendedScore(tierBase, behavioralBoost, weights?)` computes `α × tierBase + β × behavioralBoost`. Default weights: `{alpha: 0.7, beta: 0.3}` (tier-dominant). Result: integer in `[0, 100]` via `Math.round()` + clamp. Epsilon weight validation: `Math.abs(α + β - 1) < 1e-9` handles IEEE-754 non-terminating decimals. Exported as `DEFAULT_BLENDING_WEIGHTS`.
- **Interaction matrix** (Sprint 5, Task 5.2): 9-cell matrix of `ECONOMIC_BOUNDARY_MODE × AP_ENFORCEMENT`. Key cells: shadow × observe → both log, neither enforces. shadow × enforce → AP enforces, EB logs. enforce × observe → EB enforces (403), AP never reached. enforce × enforce → EB denial takes precedence (short-circuits chain). EB is upstream of AP in the middleware chain.
- **Configurable timeout** (Sprint 6, Task 6.1): `reputationTimeoutMs` option added to `buildTrustSnapshot()`, `evaluateBoundary()`, and `EconomicBoundaryMiddlewareOptions`. Fully optional — existing call sites compile unchanged. Default: `DEFAULT_REPUTATION_TIMEOUT_MS = 5` (5ms). Exported constant preserves the performance contract.
- **BudgetEpoch** (Sprint 6, Task 6.2): `BudgetEpoch` interface in `types.ts` with `epoch_type: "calendar" | "event" | "community-sync"` and `epoch_id: string`. Added as optional `budget_epoch` field on `BudgetSnapshot`. Log-only metadata — does NOT mutate protocol `CapitalLayerSnapshot`. Structured log emitted via `console.info` when present.

### 3.5 ADR: Blended Score Governance — Radical Meritocracy

**Status**: Accepted (Sprint 6, Task 6.3)
**Context**: The blended score weighting system (`computeBlendedScore`) makes a value judgment: how much should subscription tier (capital) versus behavioral evidence (reputation) influence access decisions?

**Decision**: Default weights are `{alpha: 0.7, beta: 0.3}` — tier-dominant, meaning subscription level has 70% influence on the blended score. This is a deliberate choice: the system privileges paying customers while reserving 30% for behavioral merit. The "authoritative" tier exists as an escape valve — it can only be reached through behavioral evidence (ReputationProvider boost >= 15), never purchased directly.

**Consequences**:
- The weight ratio is a governance parameter, not an engineering constant. Changes to `alpha/beta` shift the system's values between plutocracy (alpha→1.0) and pure meritocracy (beta→1.0).
- Weight changes MUST be treated as governance decisions requiring stakeholder review, not routine parameter tuning.
- The epsilon validation (`|α + β - 1| < 1e-9`) ensures weights form a proper convex combination, preventing accidental score inflation.
- Future consideration: community-configurable weights per tenant (e.g., DAOs choosing their own merit/capital balance). This would require per-tenant weight storage and validation.
- The BudgetEpoch system (Task 6.2) extends this philosophy to temporal governance — communities can express their own budget rhythms without protocol changes.

**Architectural parallel**: Google's PageRank faced the same tension — link authority (capital, who links to you) versus content relevance (merit, what you say). Their `alpha` damping factor (0.85) similarly encoded a value judgment about how much structure versus content should matter.

---

## 4. Reputation State Model

Four-state reputation model with strict ordering:

| State | Order | Description |
|-------|-------|-------------|
| `cold` | 0 | New/unknown tenant |
| `warming` | 1 | Building trust |
| `established` | 2 | Trusted tenant |
| `authoritative` | 3 | Highest trust |

---

## 5. Protocol Versioning

`validateCompatibility()` performs semver-based compatibility checking.
`CONTRACT_VERSION` is `"7.9.2"`. loa-finn's `FINN_MIN_SUPPORTED` is `"4.0.0"`.

### 5.1 Feature Detection Thresholds

| Feature | Minimum Version | Description |
|---------|----------------|-------------|
| `trustScopes` | 6.0.0 | Trust scope arrays in health response |
| `reputationGated` | 7.3.0 | Reputation-gated access |
| `compoundPolicies` | 7.4.0 | Compound policy evaluation |
| `economicBoundary` | 7.7.0 | Economic boundary evaluation |
| `denialCodes` | 7.9.1 | Structured denial codes |

---

## 6. Economic Choreography (6-Step Enforcement Chain)

The `ECONOMIC_CHOREOGRAPHY` constant defines the enforcement chain position:

1. **JWT Auth** — Validate token, extract claims
2. **Economic Boundary** — Pre-invocation trust + capital gate (NEW in v7.9.2 adoption)
3. **Budget Reserve** — Reserve funds for the operation
4. **Provider Call** — Execute the model invocation
5. **Conservation Guard** — Verify billing invariants
6. **Billing Finalize** — Commit billing entry to arrakis

---

## 7. Import Map (loa-finn → protocol-types.ts)

loa-finn centralizes all protocol imports through `src/hounfour/protocol-types.ts`.
Consumer files import from this module, not directly from `@0xhoneyjar/loa-hounfour`.

| Consumer | Imports |
|----------|---------|
| `pool-enforcement.ts` | `evaluateAccessPolicy`, `AccessPolicyContext`, `AccessPolicyResult` |
| `jwt-auth.ts` | `PROTOCOL_JTI_POLICY` |
| `wire-boundary.ts` | `microUSDC`, `readMicroUSDC`, `protocolSerializeMicroUSDC`, `deserializeMicroUSDC`, MicroUSDC types |
| `economic-boundary.ts` | `evaluateEconomicBoundary`, trust/capital types, `QualificationCriteria`, `REPUTATION_STATES`, `DenialCode` |
| `protocol-handshake.ts` | `CONTRACT_VERSION` (direct from main package) |
| `billing-conservation-guard.ts` | `verifyPricingConservation`, `ConservationResult`, `TRANSFER_INVARIANTS` |

---

## 8. Package Role Summary

loa-hounfour is the shared protocol package between loa-finn and arrakis.
It provides:

- **Canonical vocabulary**: Pool IDs, tier names, task types, reputation states
- **Access control matrix**: Which tiers can use which pools
- **Validation functions**: Pool ID validation, tier access checks, protocol version compatibility
- **Schema definitions**: NFT routing policy, billing types, JWT claims, economic boundary
- **Economic evaluation**: Pre-invocation boundary evaluation with trust + capital layers
- **Pricing utilities**: MicroUSDC arithmetic, cost computation, conservation verification
- **Billing utilities**: Entry validation, recipient allocation, credit notes
- **NFT utilities**: ID validation, parsing, checksumming

It does NOT contain:
- Provider implementations (those live in loa-finn)
- HTTP clients or servers
- Business logic beyond validation and evaluation
- State management or persistence
