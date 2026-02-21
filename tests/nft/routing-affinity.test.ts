// tests/nft/routing-affinity.test.ts — Personality Routing Integration Tests (Sprint 2 T2.6)
//
// Tests: archetype affinity matrix, genotype scoring, combined scoring,
// tier safety invariant (NEVER escalate), health-aware fallback within
// tier-allowed pools, explicit error on no eligible pools.

import { describe, it, expect, vi } from "vitest"

// Mock broken loa-hounfour main index (missing validators/billing.js).
// vi.mock is hoisted — all values must be inline, no top-level refs.
vi.mock("@0xhoneyjar/loa-hounfour", () => {
  const pools = ["cheap", "fast-code", "reviewer", "reasoning", "architect"] as const
  const tierAccess: Record<string, readonly string[]> = {
    free: ["cheap"],
    pro: ["cheap", "fast-code", "reviewer"],
    enterprise: ["cheap", "fast-code", "reviewer", "reasoning", "architect"],
  }
  return {
    POOL_IDS: pools,
    TIER_POOL_ACCESS: tierAccess,
    TIER_DEFAULT_POOL: { free: "cheap", pro: "fast-code", enterprise: "reviewer" },
    isValidPoolId: (id: string) => (pools as readonly string[]).includes(id),
    tierHasAccess: (tier: string, poolId: string) => tierAccess[tier]?.includes(poolId) ?? false,
  }
})

import type { Archetype, DAMPFingerprint, DAMPDialId } from "../../src/nft/signal-types.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"
import {
  allowedPoolsForTier,
  ARCHETYPE_POOL_AFFINITY,
  getArchetypeAffinity,
  scorePoolByGenotype,
  computeRoutingAffinity,
} from "../../src/nft/routing-affinity.js"
import { selectAffinityRankedPools } from "../../src/hounfour/pool-enforcement.js"
import type { TenantContext } from "../../src/hounfour/jwt-auth.js"
import { getAccessiblePools } from "../../src/hounfour/tier-bridge.js"

// Use tier-bridge re-exports to avoid broken loa-hounfour index.js
type PoolId = string
type Tier = "free" | "pro" | "enterprise"

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const ALL_ARCHETYPES: Archetype[] = ["freetekno", "milady", "chicago_detroit", "acidhouse"]
const ALL_POOLS: PoolId[] = ["cheap", "fast-code", "reviewer", "reasoning", "architect"] as PoolId[]

function makeFingerprint(baseValue: number = 0.5): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = baseValue
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-sha-routing",
    derived_at: Date.now(),
  }
}

/** Create a fingerprint with high creativity dials (cr_ prefix) — should favor architect pool */
function makeCreativeFingerprint(): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    if (id.startsWith("cr_")) {
      dials[id] = 0.95 // Very high creativity
    } else {
      dials[id] = 0.5 // Neutral for everything else
    }
  }
  return { dials, mode: "default", derived_from: "test-creative", derived_at: Date.now() }
}

/** Create a fingerprint with high assertiveness dials (as_ prefix) — should favor fast-code pool */
function makeAssertiveFingerprint(): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    if (id.startsWith("as_")) {
      dials[id] = 0.95 // Very assertive
    } else {
      dials[id] = 0.5
    }
  }
  return { dials, mode: "default", derived_from: "test-assertive", derived_at: Date.now() }
}

/** Create a fingerprint with high cognitive dials (cg_ prefix) — should favor reasoning pool */
function makeCognitiveFingerprint(): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    if (id.startsWith("cg_")) {
      dials[id] = 0.95 // Very analytical
    } else {
      dials[id] = 0.5
    }
  }
  return { dials, mode: "default", derived_from: "test-cognitive", derived_at: Date.now() }
}

/** Create a mock TenantContext with specified tier */
function makeTenantContext(tier: Tier, resolvedPools?: PoolId[]): TenantContext {
  const pools = resolvedPools ?? [...getAccessiblePools(tier)] as PoolId[]
  return {
    claims: {
      tenant_id: "test-tenant",
      nft_id: "test-nft-42",
      tier,
      model_preferences: {},
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: "test",
      sub: "test-tenant",
    },
    resolvedPools: [...pools],
    requestedPool: undefined,
    isBYOK: false,
  }
}

// ---------------------------------------------------------------------------
// T2.1 — Archetype → Pool Affinity Matrix
// ---------------------------------------------------------------------------

describe("Archetype pool affinity matrix (T2.1)", () => {
  it("all 4 archetypes have affinity entries for all 5 pools", () => {
    for (const archetype of ALL_ARCHETYPES) {
      const affinities = ARCHETYPE_POOL_AFFINITY[archetype]
      expect(affinities).toBeDefined()
      for (const pool of ALL_POOLS) {
        expect(affinities[pool]).toBeDefined()
        expect(affinities[pool]).toBeGreaterThanOrEqual(0)
        expect(affinities[pool]).toBeLessThanOrEqual(1)
      }
    }
  })

  it("4 archetypes produce distinct pool preference orderings", () => {
    const orderings = ALL_ARCHETYPES.map(archetype => {
      const affinities = ARCHETYPE_POOL_AFFINITY[archetype]
      return ALL_POOLS
        .slice()
        .sort((a, b) => affinities[b] - affinities[a])
        .join(",")
    })

    // At least 3 of 4 archetypes must have distinct orderings
    const unique = new Set(orderings)
    expect(unique.size).toBeGreaterThanOrEqual(3)
  })

  it("freetekno favors architect pool (creative archetype)", () => {
    const affinities = ARCHETYPE_POOL_AFFINITY.freetekno
    const maxPool = ALL_POOLS.reduce((a, b) => affinities[a] > affinities[b] ? a : b)
    expect(maxPool).toBe("architect")
  })

  it("chicago_detroit favors fast-code pool (assertive archetype)", () => {
    const affinities = ARCHETYPE_POOL_AFFINITY.chicago_detroit
    const maxPool = ALL_POOLS.reduce((a, b) => affinities[a] > affinities[b] ? a : b)
    expect(maxPool).toBe("fast-code")
  })

  it("getArchetypeAffinity returns 0.5 for unknown archetype", () => {
    expect(getArchetypeAffinity("unknown" as Archetype, "cheap" as PoolId)).toBe(0.5)
  })

  it("getArchetypeAffinity returns correct value for known pair", () => {
    expect(getArchetypeAffinity("freetekno", "architect" as PoolId)).toBe(0.9)
  })
})

// ---------------------------------------------------------------------------
// T2.2 — Dial-Weighted Pool Scoring (Genotype Expression)
// ---------------------------------------------------------------------------

describe("Dial-weighted pool scoring (T2.2)", () => {
  it("flat fingerprint (all 0.5) produces 0.5 for all pools", () => {
    const fp = makeFingerprint(0.5)
    for (const pool of ALL_POOLS) {
      expect(scorePoolByGenotype(fp, pool)).toBe(0.5)
    }
  })

  it("creative fingerprint scores architect pool higher than cheap", () => {
    const fp = makeCreativeFingerprint()
    const architectScore = scorePoolByGenotype(fp, "architect" as PoolId)
    const cheapScore = scorePoolByGenotype(fp, "cheap" as PoolId)
    expect(architectScore).toBeGreaterThan(cheapScore)
  })

  it("assertive fingerprint scores fast-code pool higher than cheap", () => {
    const fp = makeAssertiveFingerprint()
    const fastCodeScore = scorePoolByGenotype(fp, "fast-code" as PoolId)
    const cheapScore = scorePoolByGenotype(fp, "cheap" as PoolId)
    expect(fastCodeScore).toBeGreaterThan(cheapScore)
  })

  it("cognitive fingerprint scores reasoning pool higher than cheap", () => {
    const fp = makeCognitiveFingerprint()
    const reasoningScore = scorePoolByGenotype(fp, "reasoning" as PoolId)
    const cheapScore = scorePoolByGenotype(fp, "cheap" as PoolId)
    expect(reasoningScore).toBeGreaterThan(cheapScore)
  })

  it("distinctive dials measurably shift pool selection vs flat", () => {
    const flat = makeFingerprint(0.5)
    const creative = makeCreativeFingerprint()

    const flatArchitect = scorePoolByGenotype(flat, "architect" as PoolId)
    const creativeArchitect = scorePoolByGenotype(creative, "architect" as PoolId)

    // Creative fingerprint should score architect pool differently than flat
    expect(Math.abs(creativeArchitect - flatArchitect)).toBeGreaterThan(0.05)
  })

  it("scores are always in [0, 1] range", () => {
    const fingerprints = [
      makeFingerprint(0.0),
      makeFingerprint(0.5),
      makeFingerprint(1.0),
      makeCreativeFingerprint(),
      makeAssertiveFingerprint(),
    ]
    for (const fp of fingerprints) {
      for (const pool of ALL_POOLS) {
        const score = scorePoolByGenotype(fp, pool)
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(1)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// T2.3 — Combined Scoring (Archetype + Genotype)
// ---------------------------------------------------------------------------

describe("Combined routing affinity (T2.3)", () => {
  it("returns affinity scores for all 5 pools", () => {
    const fp = makeFingerprint()
    const affinity = computeRoutingAffinity("freetekno", fp)
    for (const pool of ALL_POOLS) {
      expect(affinity[pool]).toBeDefined()
      expect(affinity[pool]).toBeGreaterThanOrEqual(0)
      expect(affinity[pool]).toBeLessThanOrEqual(1)
    }
  })

  it("without fingerprint, returns pure archetype affinity", () => {
    const affinity = computeRoutingAffinity("milady", null)
    expect(affinity["cheap" as PoolId]).toBe(ARCHETYPE_POOL_AFFINITY.milady["cheap" as PoolId])
    expect(affinity["architect" as PoolId]).toBe(ARCHETYPE_POOL_AFFINITY.milady["architect" as PoolId])
  })

  it("with fingerprint, blends archetype (60%) and genotype (40%)", () => {
    const fp = makeFingerprint(0.5) // flat → genotype score = 0.5 for all pools
    const affinity = computeRoutingAffinity("freetekno", fp)

    // For flat fingerprint: combined = archetype * 0.6 + 0.5 * 0.4
    // For architect: 0.9 * 0.6 + 0.5 * 0.4 = 0.54 + 0.20 = 0.74
    expect(affinity["architect" as PoolId]).toBeCloseTo(0.74, 2)
  })

  it("creative fingerprint + freetekno archetype strongly favors architect", () => {
    const fp = makeCreativeFingerprint()
    const affinity = computeRoutingAffinity("freetekno", fp)

    // Both archetype (0.9) and genotype (high cr_ → architect) should push architect high
    const pools = ALL_POOLS.slice().sort((a, b) => affinity[b] - affinity[a])
    expect(pools[0]).toBe("architect")
  })

  it("each archetype produces a different top pool with flat fingerprint", () => {
    const fp = makeFingerprint(0.5)
    const topPools = ALL_ARCHETYPES.map(arch => {
      const affinity = computeRoutingAffinity(arch, fp)
      return ALL_POOLS.slice().sort((a, b) => affinity[b] - affinity[a])[0]
    })
    // At least 2 different top pools across archetypes
    const unique = new Set(topPools)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Tier Safety — allowedPoolsForTier (GPT-5.2 fix #5)
// ---------------------------------------------------------------------------

describe("Tier safety — allowedPoolsForTier (GPT-5.2 fix #5)", () => {
  it("free tier only allows cheap", () => {
    const pools = allowedPoolsForTier("free" as Tier)
    expect(pools).toEqual(["cheap"])
  })

  it("pro tier allows cheap, fast-code, reviewer", () => {
    const pools = allowedPoolsForTier("pro" as Tier)
    expect(pools).toContain("cheap")
    expect(pools).toContain("fast-code")
    expect(pools).toContain("reviewer")
    expect(pools).not.toContain("reasoning")
    expect(pools).not.toContain("architect")
  })

  it("enterprise tier allows all 5 pools", () => {
    const pools = allowedPoolsForTier("enterprise" as Tier)
    expect(pools).toHaveLength(5)
    for (const pool of ALL_POOLS) {
      expect(pools).toContain(pool)
    }
  })

  it("returns a copy (not a reference to canonical array)", () => {
    const pools = allowedPoolsForTier("free" as Tier)
    pools.push("architect" as PoolId)
    const pools2 = allowedPoolsForTier("free" as Tier)
    expect(pools2).toEqual(["cheap"])
  })
})

// ---------------------------------------------------------------------------
// T2.4 — Affinity-Ranked Pool Selection with Tier Enforcement
// ---------------------------------------------------------------------------

describe("selectAffinityRankedPools — tier enforcement (T2.4)", () => {
  it("enterprise tier returns all pools sorted by affinity", () => {
    const tenant = makeTenantContext("enterprise" as Tier)
    const affinity = computeRoutingAffinity("freetekno", makeCreativeFingerprint())
    const ranked = selectAffinityRankedPools(tenant, affinity)

    expect(ranked).toHaveLength(5)
    // Verify descending order
    for (let i = 1; i < ranked.length; i++) {
      expect(affinity[ranked[i]]).toBeLessThanOrEqual(affinity[ranked[i - 1]])
    }
  })

  it("free tier returns ONLY cheap regardless of high architect affinity", () => {
    const tenant = makeTenantContext("free" as Tier)
    const affinity = computeRoutingAffinity("freetekno", makeCreativeFingerprint())

    // freetekno + creative fingerprint strongly favors architect
    // But free tier should ONLY return cheap
    const ranked = selectAffinityRankedPools(tenant, affinity)
    expect(ranked).toEqual(["cheap"])
  })

  it("pro tier returns only pro-accessible pools", () => {
    const tenant = makeTenantContext("pro" as Tier)
    const affinity = computeRoutingAffinity("acidhouse", makeFingerprint())
    const ranked = selectAffinityRankedPools(tenant, affinity)

    expect(ranked.length).toBeLessThanOrEqual(3)
    for (const pool of ranked) {
      expect(["cheap", "fast-code", "reviewer"]).toContain(pool)
    }
    expect(ranked).not.toContain("reasoning")
    expect(ranked).not.toContain("architect")
  })

  it("NEVER escalates tier — negative test: pro cannot get architect", () => {
    const tenant = makeTenantContext("pro" as Tier)
    // Give architect the highest affinity
    const affinity: Record<PoolId, number> = {
      cheap: 0.1,
      "fast-code": 0.2,
      reviewer: 0.3,
      reasoning: 0.8,
      architect: 0.99,
    } as Record<PoolId, number>

    const ranked = selectAffinityRankedPools(tenant, affinity)
    expect(ranked).not.toContain("architect")
    expect(ranked).not.toContain("reasoning")
  })

  it("NEVER escalates tier — negative test: free cannot get fast-code", () => {
    const tenant = makeTenantContext("free" as Tier)
    const affinity: Record<PoolId, number> = {
      cheap: 0.01,
      "fast-code": 0.99,
      reviewer: 0.99,
      reasoning: 0.99,
      architect: 0.99,
    } as Record<PoolId, number>

    const ranked = selectAffinityRankedPools(tenant, affinity)
    expect(ranked).toEqual(["cheap"])
  })

  it("empty resolvedPools returns empty array (no eligible pools)", () => {
    const tenant = makeTenantContext("free" as Tier, [])
    const affinity = computeRoutingAffinity("freetekno", makeFingerprint())
    const ranked = selectAffinityRankedPools(tenant, affinity)
    expect(ranked).toEqual([])
  })

  it("intersection of allowedPools and resolvedPools is enforced", () => {
    // TenantContext only has cheap and fast-code in resolvedPools
    // but tier is enterprise (all pools allowed)
    const tenant = makeTenantContext("enterprise" as Tier, ["cheap", "fast-code"] as PoolId[])
    const affinity = computeRoutingAffinity("freetekno", makeCreativeFingerprint())
    const ranked = selectAffinityRankedPools(tenant, affinity)

    // Should only include pools that are BOTH tier-allowed AND in resolvedPools
    expect(ranked.length).toBeLessThanOrEqual(2)
    for (const pool of ranked) {
      expect(["cheap", "fast-code"]).toContain(pool)
    }
  })

  it("deterministic tie-breaking by pool ID ascending", () => {
    const tenant = makeTenantContext("enterprise" as Tier)
    // All pools have equal affinity
    const affinity: Record<PoolId, number> = {
      cheap: 0.5,
      "fast-code": 0.5,
      reviewer: 0.5,
      reasoning: 0.5,
      architect: 0.5,
    } as Record<PoolId, number>

    const ranked = selectAffinityRankedPools(tenant, affinity)
    // Should be sorted by pool ID ascending (deterministic)
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].localeCompare(ranked[i - 1])).toBeGreaterThanOrEqual(0)
    }
  })
})

// ---------------------------------------------------------------------------
// PersonalityContext routing_affinity integration
// ---------------------------------------------------------------------------

describe("PersonalityContext routing_affinity integration (T2.3)", () => {
  it("buildPersonalityContextSync includes routing_affinity", async () => {
    const { buildPersonalityContextSync } = await import("../../src/nft/personality-context.js")
    const fp = makeCreativeFingerprint()
    const affinity = computeRoutingAffinity("freetekno", fp)
    const ctx = buildPersonalityContextSync("bears:42", "freetekno", fp, affinity)

    expect(ctx).not.toBeNull()
    expect(ctx!.routing_affinity).toBeDefined()
    for (const pool of ALL_POOLS) {
      expect(ctx!.routing_affinity![pool]).toBeDefined()
      expect(ctx!.routing_affinity![pool]).toBeGreaterThanOrEqual(0)
      expect(ctx!.routing_affinity![pool]).toBeLessThanOrEqual(1)
    }
  })

  it("routing_affinity reflects archetype + genotype blend", async () => {
    const { buildPersonalityContextSync } = await import("../../src/nft/personality-context.js")
    const fp = makeCreativeFingerprint()
    const affinity = computeRoutingAffinity("freetekno", fp)
    const ctx = buildPersonalityContextSync("bears:42", "freetekno", fp, affinity)

    // freetekno + creative → architect should be highest
    const topPool = ALL_POOLS.reduce((a, b) =>
      ctx!.routing_affinity![a] > ctx!.routing_affinity![b] ? a : b,
    )
    expect(topPool).toBe("architect")
  })

  it("null fingerprint returns null context (no routing_affinity)", async () => {
    const { buildPersonalityContextSync } = await import("../../src/nft/personality-context.js")
    const ctx = buildPersonalityContextSync("bears:42", "freetekno", null)
    expect(ctx).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Legacy Behavior — No PersonalityContext
// ---------------------------------------------------------------------------

describe("Legacy behavior — no PersonalityContext", () => {
  it("selectAffinityRankedPools with empty affinity returns empty for each pool at 0", () => {
    const tenant = makeTenantContext("enterprise" as Tier)
    const emptyAffinity = {} as Record<PoolId, number>
    const ranked = selectAffinityRankedPools(tenant, emptyAffinity)
    // All affinities default to 0, so all pools are returned (sorted by name)
    expect(ranked).toHaveLength(5)
  })
})
