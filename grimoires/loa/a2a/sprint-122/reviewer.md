# Sprint 122: Personality-Aware Model Routing — Implementation Report

**Global ID**: 122 | **Local**: sprint-2 | **Cycle**: cycle-030
**Status**: All 6 tasks implemented with 33 new tests + 26 existing tests passing

---

## Task Summary

| ID | Task | Status | Files |
|----|------|--------|-------|
| T2.1 | Archetype-Pool Affinity Matrix | Done | `src/nft/routing-affinity.ts` |
| T2.2 | Dial-Weighted Pool Scoring | Done | `src/nft/routing-affinity.ts` |
| T2.3 | Combined Scoring + PersonalityContext Integration | Done | `src/nft/routing-affinity.ts`, `src/nft/personality-context.ts` |
| T2.4 | Tier-Safe Pool Selection + Router Integration | Done | `src/hounfour/pool-enforcement.ts`, `src/hounfour/router.ts` |
| T2.5 | Agent Chat Endpoint Wiring | Done | `src/gateway/routes/agent-chat.ts` |
| T2.6 | Test Suite | Done | `tests/nft/routing-affinity.test.ts` |

---

## Implementation Details

### T2.1: Archetype-Pool Affinity Matrix

**File**: `src/nft/routing-affinity.ts:50-89`

Static `ARCHETYPE_POOL_AFFINITY` matrix maps 4 archetypes to 5 pools with affinity scores [0-1]:
- **freetekno**: creative, experimental -> favors architect (0.9) + reasoning (0.7)
- **milady**: aesthetic, social -> favors cheap (0.7) + architect (0.8)
- **chicago_detroit**: assertive, energetic -> favors fast-code (0.8) + reasoning (0.7)
- **acidhouse**: experimental, divergent -> favors architect (0.8) + reviewer (0.7)

`getArchetypeAffinity()` returns 0.5 (neutral) for unknown archetypes/pools.

### T2.2: Dial-Weighted Pool Scoring

**File**: `src/nft/routing-affinity.ts:102-186`

`DIAL_POOL_WEIGHTS` maps 12 dAMP category prefixes (sw_, cs_, as_, cg_, ep_, cr_, cv_, mo_, et_, sc_, ag_, id_) to per-pool affinity boosts.

`scorePoolByGenotype()` algorithm:
1. Compute distinctiveness for each dial: `|value - 0.5|`
2. Take top 5 most distinctive dials
3. Weight each dial's pool affinity by its distinctiveness ratio
4. Return composite score [0-1], clamped

A flat fingerprint (all 0.5) produces 0.5 across all pools.

### T2.3: Combined Scoring

**File**: `src/nft/routing-affinity.ts:205-227`

`computeRoutingAffinity()` blends archetype (60%) + genotype (40%) scores:
- With fingerprint: `archetype * 0.6 + genotype * 0.4`
- Without fingerprint: pure archetype affinity
- Returns `Record<PoolId, number>` keyed by all 5 pools

**Decoupling decision**: `PersonalityContext.routing_affinity` is typed as `Record<string, number>` (not `Record<PoolId, number>`) to avoid transitive dependency on loa-hounfour from personality-context.ts. Callers compute routing_affinity via `computeRoutingAffinity()` and pass it to `buildPersonalityContext()`.

### T2.4: Tier-Safe Pool Selection + Router Integration

**File**: `src/hounfour/pool-enforcement.ts` — added `selectAffinityRankedPools()`

Takes TenantContext + routing_affinity, returns PoolId[] sorted by affinity descending, constrained to `allowedPoolsForTier(tier) INTERSECT resolvedPools`. Deterministic tie-breaking by pool ID ascending.

**File**: `src/hounfour/router.ts` — modified `invokeForTenant()`

Added `personalityContext?: PersonalityContext | null` parameter. Two paths:
1. **Personality-aware**: iterates pools by affinity order, uses `poolRegistry.resolve()` + direct health check (NOT `resolveWithFallback` which crosses tier boundaries via pool fallback chains)
2. **Standard**: existing `selectAuthorizedPool` + `resolveWithFallback` path

**Tier Safety Invariant**: `allowedPoolsForTier()` (delegating to `TIER_POOL_ACCESS`) is the single source of truth. Called in `selectAffinityRankedPools()` which constrains both primary selection AND fallback. If all allowed pools are unhealthy, request fails with explicit error — NEVER escalates to unauthorized pool.

### T2.5: Agent Chat Endpoint Wiring

**File**: `src/gateway/routes/agent-chat.ts`

- Extended `AgentChatDeps` with optional `resolvePersonalityContext` method
- Extended `generateResponse` signature to accept optional `PersonalityContext`
- Wired context resolution in handler (non-fatal try/catch, logs warning on failure)
- Response includes routing metadata: `routing_version`, top 3 `dominant_dimensions`
- Legacy v1 personalities (null fingerprint) fall back to standard pool selection

### T2.6: Test Suite

**File**: `tests/nft/routing-affinity.test.ts` — 33 tests

| Test Group | Count | What |
|------------|-------|------|
| Archetype affinity matrix (T2.1) | 7 | All 4 archetypes produce distinct orderings, unknown archetype returns 0.5 |
| Genotype scoring (T2.2) | 7 | Creative fingerprint favors architect, flat fingerprint = neutral, distinctiveness weighting |
| Combined scoring (T2.3) | 5 | Blend weights, archetype-only fallback, weight customization |
| Tier safety invariant (T2.4) | 4 | Free tier gets only cheap, enterprise gets all 5, NEVER escalates |
| Affinity-ranked selection (T2.4) | 4 | Correct ordering, intersection enforcement, deterministic tie-breaking |
| PersonalityContext integration | 3 | buildPersonalityContextSync includes routing_affinity, reflects blend, null fingerprint returns null |
| Legacy behavior | 3 | selectAuthorizedPool still works, no routing_affinity = standard path, empty affinity = empty result |

**Mock strategy**: `vi.mock("@0xhoneyjar/loa-hounfour", ...)` with inline pool data (POOL_IDS, TIER_POOL_ACCESS, TIER_DEFAULT_POOL) to avoid broken loa-hounfour index.js (pre-existing issue: dist/index.js references missing validators/billing.js).

---

## Test Results

```
tests/nft/routing-affinity.test.ts    33 passed (33)
tests/nft/personality-context.test.ts  26 passed (26)
tests/nft/ + tests/hounfour/ + tests/gateway/  528 passed (528) across 25 files
```

No regressions in any affected module.

---

## Architecture Notes

### Why personality affinity order replaces pool fallback chains

Pool-level fallback chains in `PoolDefinition.fallback` (e.g., architect->reasoning->reviewer->fast-code->cheap) cross tier boundaries. A free-tier user selecting architect would walk the chain all the way to cheap, but intermediate pools (reasoning, reviewer, fast-code) are not authorized.

The personality-aware path avoids this by treating the affinity-ranked list as the fallback order. Each pool in the list is already verified as tier-authorized, so iterating through them is safe.

### Why PersonalityContext uses Record<string, number> instead of Record<PoolId, number>

`personality-context.ts` is a core module imported by many test files. Adding a transitive dependency on `@0xhoneyjar/loa-hounfour` (via `routing-affinity.ts` -> `tier-bridge.ts` -> loa-hounfour) would break all existing tests that don't mock loa-hounfour. Using `Record<string, number>` keeps the module decoupled. The actual `PoolId` typing is enforced at the call site where `computeRoutingAffinity()` returns `Record<PoolId, number>`.

---

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/nft/routing-affinity.ts` | Created | 228 |
| `src/nft/personality-context.ts` | Modified | Factory functions accept optional routingAffinity param |
| `src/hounfour/pool-enforcement.ts` | Modified | Added selectAffinityRankedPools() |
| `src/hounfour/router.ts` | Modified | Personality-aware branch in invokeForTenant() |
| `src/gateway/routes/agent-chat.ts` | Modified | PersonalityContext wiring |
| `tests/nft/routing-affinity.test.ts` | Created | 33 tests |
