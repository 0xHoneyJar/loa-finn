// tests/finn/native-enforcement-correctness.test.ts — Native Enforcement Correctness Gate (Task 3.2)
// Proves that enforcePoolClaims (expression path) and evaluateWithGeometry (dual-path router)
// produce identical PoolEnforcementResult for diverse inputs. 1000+ inputs for property coverage.

import { describe, it, expect } from "vitest"
import {
  enforcePoolClaims,
  evaluateWithGeometry,
  validateNativeEnforcementAvailable,
  type PoolEnforcementResult,
  type PoolEnforcementConfig,
} from "../../src/hounfour/pool-enforcement.js"
import type { JWTClaims } from "../../src/hounfour/jwt-auth.js"

// --- Helpers ---

const REQ_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

/** Generate diverse JWTClaims inputs for property testing */
function generateClaimsInputs(count: number): JWTClaims[] {
  const tiers = ["free", "pro", "enterprise"] as const
  const poolIds = [
    undefined, // no pool_id
    "",         // empty string
    "fast-code",
    "reviewer",
    "architect",
    "reasoning",
    "cheap",
    "invalid-pool-xyz",
    null,
  ]
  const allowedPoolVariants: (string[] | undefined)[] = [
    undefined,
    [],
    ["cheap"],
    ["cheap", "fast-code"],
    ["cheap", "fast-code", "reviewer"],
    ["cheap", "fast-code", "reviewer", "reasoning", "architect"],
    ["invalid-pool-abc"],
    ["fast-code", "invalid-pool-abc"],
    ["reasoning", "architect"],
  ]

  const inputs: JWTClaims[] = []
  for (let i = 0; i < count; i++) {
    const tier = tiers[i % tiers.length]
    const poolId = poolIds[i % poolIds.length]
    const allowedPools = allowedPoolVariants[i % allowedPoolVariants.length]

    inputs.push({
      tenant_id: `tenant-${i}`,
      tier,
      ...(poolId !== undefined ? { pool_id: poolId as string } : {}),
      ...(allowedPools !== undefined ? { allowed_pools: allowedPools } : {}),
      iss: "loa-finn-test",
      aud: "loa-finn",
      sub: `tenant-${i}`,
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: `jti-${i}`,
    } as JWTClaims)
  }
  return inputs
}

/** Deep structural comparison of PoolEnforcementResult */
function resultsMatch(a: PoolEnforcementResult, b: PoolEnforcementResult): boolean {
  if (a.ok !== b.ok) return false

  if (!a.ok && !b.ok) {
    return (
      a.error === b.error &&
      a.code === b.code &&
      JSON.stringify(a.details) === JSON.stringify(b.details)
    )
  }

  if (a.ok && b.ok) {
    // Compare resolvedPools (order matters — both paths use getAccessiblePools)
    if (JSON.stringify([...a.resolvedPools]) !== JSON.stringify([...b.resolvedPools])) return false
    if (a.requestedPool !== b.requestedPool) return false
    if (JSON.stringify(a.mismatch) !== JSON.stringify(b.mismatch)) return false
    return true
  }

  return false
}

// --- Tests ---

describe("Native Enforcement Correctness Gate (Task 3.2)", () => {
  // §1: Determinism — same input always produces same output
  it("enforcePoolClaims is deterministic over 1000+ inputs", () => {
    const inputs = generateClaimsInputs(1050)
    for (const claims of inputs) {
      const result1 = enforcePoolClaims(claims)
      const result2 = enforcePoolClaims(claims)
      expect(resultsMatch(result1, result2)).toBe(true)
    }
  })

  // §2: Strict mode consistency — strict is never MORE permissive than normal
  it("enforcePoolClaims produces consistent results with strict mode", () => {
    const inputs = generateClaimsInputs(200)
    const config: PoolEnforcementConfig = { strictMode: true }
    for (const claims of inputs) {
      const normal = enforcePoolClaims(claims)
      const strict = enforcePoolClaims(claims, config)

      if (!strict.ok && normal.ok) {
        // Strict is stricter — this is expected only for superset mismatch
        // The normal result must have had a superset mismatch that strict escalated
        expect(normal.ok).toBe(true)
        if (normal.ok) {
          expect(normal.mismatch?.type).toBe("superset")
        }
      } else if (strict.ok && !normal.ok) {
        // Strict should NEVER be more permissive than normal
        throw new Error(
          `Strict mode more permissive than normal for tenant_id=${claims.tenant_id}: ` +
          `strict.ok=${strict.ok}, normal.ok=${normal.ok}`
        )
      }
    }
  })

  // §3: evaluateWithGeometry equivalence — default geometry is "expression"
  it("evaluateWithGeometry matches enforcePoolClaims in expression mode", () => {
    // When ENFORCEMENT_GEOMETRY=expression (default), evaluateWithGeometry delegates
    // directly to enforcePoolClaims. Results must be structurally identical.
    const inputs = generateClaimsInputs(500)
    for (const claims of inputs) {
      const expression = enforcePoolClaims(claims)
      const geometry = evaluateWithGeometry(claims)
      expect(resultsMatch(expression, geometry)).toBe(true)
    }
  })

  // §4: validateNativeEnforcementAvailable is a no-op when disabled
  it("validateNativeEnforcementAvailable does not throw when disabled", () => {
    // NATIVE_ENFORCEMENT_ENABLED defaults to false
    expect(() => validateNativeEnforcementAvailable()).not.toThrow()
  })

  // §5: Edge cases — individual scenarios

  it("handles unknown tier — throws TypeError (tier not in TIER_POOL_ACCESS)", () => {
    // Unknown tier causes getAccessiblePools() to return undefined,
    // which triggers a TypeError when enforcePoolClaims accesses .length.
    // This documents the current behavior: unknown tiers are not expected
    // at this layer (JWT validation rejects them earlier).
    const claims = {
      tenant_id: "t1",
      tier: "unknown_tier" as JWTClaims["tier"],
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    expect(() => enforcePoolClaims(claims)).toThrow(TypeError)
  })

  it("handles null pool_id", () => {
    const claims = {
      tenant_id: "t1",
      tier: "pro" as const,
      pool_id: null as unknown as string,
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    // null pool_id is treated as "no pool requested" (line 106: != null check)
    expect(result.ok).toBe(true)
  })

  it("handles empty string pool_id", () => {
    const claims = {
      tenant_id: "t1",
      tier: "pro" as const,
      pool_id: "",
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    // empty string pool_id is treated as "no pool requested" (line 106: !== "" check)
    expect(result.ok).toBe(true)
  })

  it("invalid pool_id returns UNKNOWN_POOL", () => {
    const claims = {
      tenant_id: "t1",
      tier: "pro" as const,
      pool_id: "not-a-real-pool",
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN_POOL")
    }
  })

  it("valid pool_id outside tier returns POOL_ACCESS_DENIED", () => {
    // "free" tier only has access to "cheap" — "architect" should be denied
    const claims = {
      tenant_id: "t1",
      tier: "free" as const,
      pool_id: "architect",
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("POOL_ACCESS_DENIED")
    }
  })

  it("detects superset allowed_pools mismatch", () => {
    // "free" tier only has ["cheap"], but allowed_pools claims ["cheap", "fast-code"]
    const claims = {
      tenant_id: "t1",
      tier: "free" as const,
      allowed_pools: ["cheap", "fast-code", "architect"],
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    // Superset entries exist ("fast-code", "architect" not in free's ["cheap"])
    // In non-strict mode, result is still ok=true but with mismatch
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mismatch).not.toBeNull()
      expect(result.mismatch!.type).toBe("superset")
    }
  })

  it("detects invalid_entry allowed_pools mismatch", () => {
    const claims = {
      tenant_id: "t1",
      tier: "pro" as const,
      allowed_pools: ["not-valid-pool-xyz"],
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mismatch).not.toBeNull()
      expect(result.mismatch!.type).toBe("invalid_entry")
    }
  })

  it("detects subset allowed_pools mismatch", () => {
    // "enterprise" has 5 pools, but allowed_pools only claims 2
    const claims = {
      tenant_id: "t1",
      tier: "enterprise" as const,
      allowed_pools: ["cheap", "fast-code"],
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mismatch).not.toBeNull()
      expect(result.mismatch!.type).toBe("subset")
      expect(result.mismatch!.count).toBe(3) // 5 enterprise pools - 2 claimed = 3
    }
  })

  // §6: Structural shape assertions

  it("results have consistent shape for ok=true", () => {
    const claims = {
      tenant_id: "t1",
      tier: "pro" as const,
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.isArray(result.resolvedPools)).toBe(true)
      expect(result.resolvedPools.length).toBeGreaterThan(0)
      // requestedPool is null when no pool_id in claims
      expect(result.requestedPool).toBeNull()
      // mismatch is null when no allowed_pools in claims
      expect(result.mismatch).toBeNull()
    }
  })

  it("results have consistent shape for ok=false", () => {
    // Use a valid tier with an invalid pool_id to trigger a clean ok=false result
    const claims = {
      tenant_id: "t1",
      tier: "pro" as const,
      pool_id: "nonexistent-pool",
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(typeof result.error).toBe("string")
      expect(result.error.length).toBeGreaterThan(0)
      expect(typeof result.code).toBe("string")
      expect(["POOL_ACCESS_DENIED", "UNKNOWN_POOL"]).toContain(result.code)
    }
  })

  it("requestedPool is populated when valid pool_id provided", () => {
    const claims = {
      tenant_id: "t1",
      tier: "pro" as const,
      pool_id: "fast-code",
      iss: "test",
      aud: "test",
      sub: "t1",
      req_hash: REQ_HASH,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: "j1",
    } as JWTClaims
    const result = enforcePoolClaims(claims)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.requestedPool).toBe("fast-code")
    }
  })

  // §7: Batch property tests (1000+ inputs)

  it("all 1050 inputs produce valid PoolEnforcementResult shape", () => {
    const inputs = generateClaimsInputs(1050)
    let okCount = 0
    let failCount = 0

    for (const claims of inputs) {
      const result = enforcePoolClaims(claims)
      if (result.ok) {
        okCount++
        expect(Array.isArray(result.resolvedPools)).toBe(true)
        expect(result.resolvedPools.length).toBeGreaterThan(0)
        expect(
          result.requestedPool === null || typeof result.requestedPool === "string",
        ).toBe(true)
        // mismatch is either null or has valid shape
        if (result.mismatch !== null) {
          expect(["subset", "superset", "invalid_entry"]).toContain(result.mismatch.type)
          expect(typeof result.mismatch.count).toBe("number")
          expect(result.mismatch.count).toBeGreaterThan(0)
        }
      } else {
        failCount++
        expect(typeof result.error).toBe("string")
        expect(result.error.length).toBeGreaterThan(0)
        expect(["POOL_ACCESS_DENIED", "UNKNOWN_POOL"]).toContain(result.code)
      }
    }

    // Sanity: we should get both ok and failure results from 1050 diverse inputs
    expect(okCount).toBeGreaterThan(0)
    expect(failCount).toBeGreaterThan(0)
  })

  // §8: evaluateWithGeometry strict mode equivalence
  it("evaluateWithGeometry matches enforcePoolClaims with strict config", () => {
    const inputs = generateClaimsInputs(200)
    const config: PoolEnforcementConfig = { strictMode: true }
    for (const claims of inputs) {
      const expression = enforcePoolClaims(claims, config)
      const geometry = evaluateWithGeometry(claims, config)
      expect(resultsMatch(expression, geometry)).toBe(true)
    }
  })

  // §9: Each tier produces correct pool count
  it("each tier resolves the expected number of pools", () => {
    const tierExpected = {
      free: 1,       // ["cheap"]
      pro: 3,        // ["cheap", "fast-code", "reviewer"]
      enterprise: 5, // all 5 pools
    } as const

    for (const [tier, expectedCount] of Object.entries(tierExpected)) {
      const claims = {
        tenant_id: `tier-test-${tier}`,
        tier: tier as JWTClaims["tier"],
        iss: "test",
        aud: "test",
        sub: `tier-test-${tier}`,
        req_hash: REQ_HASH,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        jti: `jti-tier-${tier}`,
      } as JWTClaims
      const result = enforcePoolClaims(claims)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.resolvedPools.length).toBe(expectedCount)
      }
    }
  })
})
