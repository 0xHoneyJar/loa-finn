APPROVED - LETS FUCKING GO

# Sprint 122: Personality-Aware Model Routing — Security Audit

**Auditor**: Paranoid Cypherpunk Auditor
**Date**: 2026-02-21
**Sprint**: GID 122 | Local sprint-2 | Cycle cycle-030
**Verdict**: APPROVED — Tier safety invariant holds under adversarial analysis. No privilege escalation paths found.

---

## Executive Summary

I read every line of every file listed in the audit scope. I traced the tier enforcement path from JWT ingress through pool selection to model invocation. I hunted for privilege escalation, injection, information disclosure, and broken access control. The implementation is sound. The tier safety invariant holds with genuine defense-in-depth — not theater.

---

## Tier Safety Invariant — VERIFIED (Full Path Trace)

This is the single most critical security property in this sprint. A free-tier user must NEVER access architect/reasoning/reviewer/fast-code pools. I traced the complete enforcement chain:

### 1. JWT Boundary (Pre-existing, Verified)

**File**: `src/hounfour/jwt-auth.ts:280-292`

```typescript
const VALID_TIERS = new Set(["free", "pro", "enterprise"])
// ...
if (typeof payload.tier !== "string" || !VALID_TIERS.has(payload.tier)) {
    throw new Error(`Invalid tier: ${payload.tier}`)
}
```

Tier claim is validated at JWT parse time. Unknown tiers are rejected. This prevents `TIER_POOL_ACCESS[tier]` from returning `undefined` and causing a runtime crash in `allowedPoolsForTier()`.

### 2. allowedPoolsForTier() — Single Source of Truth

**File**: `src/nft/routing-affinity.ts:34-36`

```typescript
export function allowedPoolsForTier(tier: Tier): PoolId[] {
  return [...TIER_POOL_ACCESS[tier]]
}
```

- Delegates to canonical `TIER_POOL_ACCESS` from `@0xhoneyjar/loa-hounfour`
- Returns a defensive copy (spread into new array) — callers cannot mutate the canonical mapping
- Verified in test: `routing-affinity.test.ts:315-321` explicitly pushes to the returned array and verifies the original is unaffected

### 3. selectAffinityRankedPools() — Dual Enforcement

**File**: `src/hounfour/pool-enforcement.ts:358-379`

```typescript
const allowed = allowedPoolsForTier(tier)
const eligible = allowed.filter(p => tenantContext.resolvedPools.includes(p))
```

- **First gate**: `allowedPoolsForTier(tier)` — canonical tier constraint
- **Second gate**: Intersection with `resolvedPools` from JWT enforcement (set at auth time by `enforcePoolClaims`)
- Empty intersection returns empty array — caller MUST fail
- This is genuine defense-in-depth: even if one gate were bypassed, the other holds

### 4. Router Integration — Fail-Closed

**File**: `src/hounfour/router.ts:357-404`

The personality-aware path:

```typescript
const ranked = selectAffinityRankedPools(tenantContext, personalityContext.routing_affinity)

if (ranked.length === 0) {
  throw new HounfourError("POOL_ACCESS_DENIED", ...)
}
```

- Empty ranked list throws `POOL_ACCESS_DENIED` — not a silent fallback
- Does NOT call `resolveWithFallback` (which follows cross-pool fallback chains that can escape tier boundaries: architect -> reasoning -> reviewer -> fast-code -> cheap)
- Uses `poolRegistry.resolve()` (single pool lookup) + direct health check per candidate
- Unhealthy pools: `PROVIDER_UNAVAILABLE` error. NEVER escalates to a different tier's pool.

### 5. Negative Test Verification

**File**: `tests/nft/routing-affinity.test.ts:340-398`

Critical negative tests verified:

- Free tier + max affinity for all premium pools -> gets ONLY `cheap` (line 379-391)
- Pro tier + architect/reasoning at 0.99 affinity -> NEVER gets architect or reasoning (line 363-377)
- Empty resolvedPools -> empty result (line 393-398)
- JWT resolvedPools intersection enforced separately from tier (line 400-412)

**VERDICT**: The tier safety invariant is enforced at 3 independent layers (JWT claim validation, tier pool mapping, JWT resolvedPools intersection). All layers must be simultaneously compromised for escalation. No single-point bypass exists.

---

## OWASP Top 10 Checklist

### [PASS] Broken Access Control

- Personality routing affinity scores influence pool ORDERING but never pool MEMBERSHIP
- Pool membership is solely determined by `allowedPoolsForTier()` intersected with JWT `resolvedPools`
- Maximum affinity score (0.99) for an unauthorized pool is irrelevant — the pool is filtered out before sorting
- No IDOR: personality context is derived server-side from token ID, not user-supplied

### [PASS] Injection

- No user-controlled input reaches pool selection unsanitized
- `token_id` in agent-chat.ts is validated as a string (line 59) and passed to `personalityProvider.get()` — a lookup function, not a query constructor
- `archetype` comes from the server-side personality provider, NOT from the request body
- `body.message` is passed to `generateResponse` as a user message (appropriate — it IS user content)
- Dial values come from the dAMP fingerprint which is server-derived, not user-supplied

### [PASS] Security Misconfiguration

- Default affinity weight 0.5 for unknown archetypes/pools (neutral, not privileged)
- Missing fingerprint -> null PersonalityContext -> standard (non-personality) routing path
- Failed personality context resolution -> non-fatal catch, falls back to standard path (agent-chat.ts:80-83)
- No environment-specific configuration in the new code

---

## Secrets Check

### [PASS] No Hardcoded Credentials

Searched all 6 source files. No API keys, tokens, secrets, or credentials.

### [PASS] No Secrets in Logs

- `agent-chat.ts:82`: Logs only `token_id` on context resolution failure — no fingerprint data, no JWT claims
- `agent-chat.ts:92-95`: Error log includes `token_id` and error message — no internal state
- `router.ts:383-388`: Error includes tier and attempted pool list (operational, not sensitive)
- No fingerprint hashes, dial values, or JWT claims in any log statement

---

## Auth/Authz

### [PASS] Tier Enforcement at Every Pool Selection Point

- **Personality-aware path**: `selectAffinityRankedPools()` enforces tier (routing-affinity.ts + pool-enforcement.ts)
- **Standard path**: `selectAuthorizedPool()` checks `resolvedPools` membership (pool-enforcement.ts:333)
- **JWT boundary**: `enforcePoolClaims()` derives `resolvedPools` from tier at auth time (pool-enforcement.ts:84)

### [PASS] JWT Claims Validated Before Pool Access

- `hounfourAuth()` middleware runs BEFORE any route handler
- Tier claim validated against `VALID_TIERS` set (jwt-auth.ts:290)
- Pool enforcement result checked before context is set (pool-enforcement.ts:238-241)

### [PASS] No Privilege Escalation Through Personality Routing

Traced the full path: personality routing produces affinity SCORES. Scores affect ORDERING within a tier-constrained set. The constraint (tier membership) is applied BEFORE ordering. A free-tier personality with maximum architect affinity still gets only `cheap`.

---

## Input Validation

### [PASS] Archetype Values Validated

- `archetype` parameter in `getArchetypeAffinity()` returns 0.5 (neutral) for unknown values (routing-affinity.ts:87)
- `archetype` in `computeRoutingAffinity()` uses `getArchetypeAffinity()` with the same safe default
- Type system constrains to `"freetekno" | "milady" | "chicago_detroit" | "acidhouse"` at compile time
- At runtime: unknown archetype produces neutral scores — NO privileged behavior

### [PASS] Dial Values Bounded [0-1]

- `DAMPFingerprint.dials` is typed as `Record<DAMPDialId, number>` (signal-types.ts:237)
- `scorePoolByGenotype()` computation: `poolWeight * dial.value * (dial.distinctiveness / totalDistinctiveness)` (routing-affinity.ts:181)
- Even with dial values outside [0,1], the final score is clamped: `Math.max(0, Math.min(1, weightedScore))` (routing-affinity.ts:185)
- Test coverage verifies [0, 1] range for extreme fingerprints (all 0.0, all 1.0) at routing-affinity.test.ts:219-234

### [PASS] Fingerprint Data Validated Before Scoring

- Null fingerprint -> null PersonalityContext -> standard routing (personality-context.ts:144)
- Empty dials object -> `ranked` array is empty -> `totalDistinctiveness === 0` -> returns 0.5 (neutral)
- No unbounded iteration: top-5 slice (routing-affinity.ts:166)

---

## Error Handling

### [PASS] No Sensitive Info in Error Responses

- `POOL_ACCESS_DENIED` error includes tier but NOT the full pool topology (router.ts:365-368)
- `PROVIDER_UNAVAILABLE` includes tier and attempted pools (operational) but not JWT claims or fingerprint data
- Agent-chat route returns generic "Agent temporarily unavailable" (503) on any generation error — no internal details leak (agent-chat.ts:98)
- PersonalityContext resolution failure: "personality context resolution failed" with only token_id

### [PASS] Failed Personality Resolution Doesn't Leak State

- agent-chat.ts:80-83: catch block logs warning with only `token_id`, continues with null context
- No stack trace in the catch block
- No internal error details forwarded to the response

### [PASS] Unhealthy Pool Handling Doesn't Disclose Topology

- Router throws `PROVIDER_UNAVAILABLE` with tier context (router.ts:383-388)
- The `attempted` field in error details lists pool IDs tried — these are operational information tied to the user's own tier, not a disclosure of other tiers' pools
- Error response is caught and returned as generic 503 by the gateway (agent-chat.ts:98)

---

## Code Quality

### [PASS] No Logic Bugs in Scoring Algorithm

- `scorePoolByGenotype()` (routing-affinity.ts:150-186):
  - Distinctiveness = `|value - 0.5|` — correct
  - Top-5 selection via sort + slice — correct, bounded
  - Total distinctiveness zero check prevents division by zero — correct
  - Weighted score formula is mathematically sound
  - Final clamp to [0, 1] — correct

### [PASS] No Floating-Point Edge Cases

- `totalDistinctiveness === 0` check (routing-affinity.ts:170): This is safe because `Math.abs(0.5 - 0.5) === 0` is exact in IEEE-754
- `Math.max(0, Math.min(1, ...))` clamp (routing-affinity.ts:185): Handles any floating-point drift
- Affinity blend: `archetype * 0.6 + genotype * 0.4` (routing-affinity.ts:219) — potential for tiny float imprecision but clamped downstream and not security-relevant (affects ordering, not authorization)

### [PASS] No Unbounded Iterations or Memory Allocations

- Pool iteration: bounded by `eligible.length` which is at most 5 (5 canonical pools)
- Dial iteration: bounded by 96 dials (DAMP_DIAL_IDS.length), top-5 selection
- Sort operations: on arrays of at most 96 or 5 elements
- No recursive calls, no unbounded loops

---

## NON-BLOCKING Observations (Informational Only)

### LOW-1: Standard Path's resolveWithFallback Can Cross Tier Boundaries (Pre-Existing)

**File**: `src/hounfour/router.ts:394-403` (standard path, NOT the new personality-aware path)
**Severity**: LOW (pre-existing, not introduced by Sprint 122)

The standard (non-personality) path calls `resolveWithFallback()` which follows pool fallback chains (architect -> reasoning -> reviewer -> fast-code -> cheap). This could theoretically resolve to a pool outside the user's tier if `selectAuthorizedPool` returns a pool whose fallback chain crosses tier boundaries. However:

1. `selectAuthorizedPool` checks the resolved pool against `resolvedPools` (defense-in-depth)
2. `resolvePool` defaults to `TIER_DEFAULT_POOL[tier]` which is always tier-appropriate
3. NFT model_preferences could reference a cross-tier pool, but `resolvePool` silently skips invalid preferences

This is a pre-existing architectural concern, not introduced or worsened by Sprint 122. The personality-aware path explicitly avoids it by NOT using `resolveWithFallback`. Noted for future hardening.

### LOW-2: routing_affinity Not Included in Serialization Round-Trip

**File**: `src/nft/personality-context.ts:191-204`

`serializePersonalityContext()` omits `routing_affinity`, and `deserializePersonalityContext()` does not restore it. This is defensible because routing_affinity is computed fresh at the call site. But if this context is ever serialized and consumed by another service, the routing data would be lost. The engineer feedback already noted this. Not a security issue.

### LOW-3: Response Includes Top 3 Dominant Dimensions

**File**: `src/gateway/routes/agent-chat.ts:111`

The response exposes `dominant_dimensions` (top 3 dial IDs) to the client. This is personality metadata (e.g., "cr_divergent_thinking"), not PII or secrets. However, if dial IDs are considered proprietary intellectual property of the dAMP system, this could be an information disclosure concern. Assessed as LOW — dial IDs are part of the public-facing personality system.

---

## Audit Trail

### Files Audited (Read in Full)

| # | File | Lines | Security-Relevant |
|---|------|-------|-------------------|
| 1 | `src/nft/routing-affinity.ts` | 228 | Core routing logic, tier enforcement |
| 2 | `src/nft/personality-context.ts` | 249 | Factory, serialization, type safety |
| 3 | `src/hounfour/pool-enforcement.ts` | 380 | selectAffinityRankedPools, auth middleware |
| 4 | `src/hounfour/router.ts` | 1053 | invokeForTenant personality branch |
| 5 | `src/gateway/routes/agent-chat.ts` | 128 | PersonalityContext wiring, response |
| 6 | `tests/nft/routing-affinity.test.ts` | 486 | 33 test cases including negative tests |
| 7 | `src/hounfour/tier-bridge.ts` | 125 | TIER_POOL_ACCESS delegation |
| 8 | `src/nft/signal-types.ts` | 309 | Type definitions, DAMPDialId union |
| 9 | `src/hounfour/pool-registry.ts` | 234 | resolveWithFallback fallback chains |
| 10 | `src/hounfour/wire-boundary.ts` | 412 | parsePoolId validation |
| 11 | `src/hounfour/jwt-auth.ts` (partial) | 50 | VALID_TIERS, validateClaims |

### Supporting Documentation Reviewed

| # | File | Purpose |
|---|------|---------|
| 12 | `grimoires/loa/a2a/sprint-122/reviewer.md` | Implementation report |
| 13 | `grimoires/loa/a2a/sprint-122/engineer-feedback.md` | Senior lead approval |

---

## Verdict

**APPROVED**. The tier safety invariant holds under adversarial analysis. No privilege escalation paths exist in the personality-aware routing implementation. The defense-in-depth pattern (3 independent enforcement layers) is genuine, not theater. Test coverage includes the correct negative tests. No secrets exposure, no injection vectors, no broken access control.

The code is clean. Ship it.
