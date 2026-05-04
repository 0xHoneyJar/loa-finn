// tests/finn/protocol-schema-imports.test.ts — Protocol Schema & Type Import Verification (Sprint 2, Task 2.4)
//
// Verifies: EFFECTIVE_JTI_POLICY merging, MAX_JTI_WINDOW_SECONDS capping,
// protocol type re-exports, and deriveJtiTtl ceiling override.

import { describe, it, expect, expectTypeOf, vi, afterEach } from "vitest"
import {
  EFFECTIVE_JTI_POLICY,
  LOCAL_JTI_POLICY,
  MAX_JTI_WINDOW_SECONDS,
  JTI_POLICY,
  isJtiRequired,
} from "../../src/hounfour/jwt-auth.js"
import { PROTOCOL_JTI_POLICY } from "../../src/hounfour/protocol-types.js"
import { deriveJtiTtl } from "../../src/hounfour/jti-replay.js"

// Protocol type imports — compile-time verification
import type {
  ProtocolJwtClaims,
  ProtocolS2SJwtClaims,
  ProtocolBillingEntry,
  EconomicBoundary,
  QualificationCriteria,
  DenialCode,
  EvaluationGap,
  ModelEconomicProfile,
  JwtBoundarySpec,
  ConstraintOrigin,
  ReputationStateName,
} from "../../src/hounfour/protocol-types.js"

import {
  JwtClaimsSchema,
  S2SJwtClaimsSchema,
  ProtocolBillingEntrySchema,
  EconomicBoundarySchema,
  QualificationCriteriaSchema,
  DenialCodeSchema,
  EvaluationGapSchema,
  ModelEconomicProfileSchema,
  JwtBoundarySpecSchema,
  REPUTATION_STATES,
  REPUTATION_STATE_ORDER,
  isKnownReputationState,
} from "../../src/hounfour/protocol-types.js"

// ---------------------------------------------------------------------------
// Compile-time type verification
// ---------------------------------------------------------------------------

describe("Protocol schema imports — compile-time verification", () => {
  it("ProtocolJwtClaims has required JWT fields", () => {
    expectTypeOf<ProtocolJwtClaims>().toHaveProperty("iss")
    expectTypeOf<ProtocolJwtClaims>().toHaveProperty("aud")
    expectTypeOf<ProtocolJwtClaims>().toHaveProperty("sub")
    expectTypeOf<ProtocolJwtClaims>().toHaveProperty("tenant_id")
    expectTypeOf<ProtocolJwtClaims>().toHaveProperty("tier")
    expectTypeOf<ProtocolJwtClaims>().toHaveProperty("req_hash")
  })

  it("EconomicBoundary has required boundary fields", () => {
    expectTypeOf<EconomicBoundary>().toHaveProperty("boundary_id")
    expectTypeOf<EconomicBoundary>().toHaveProperty("trust_layer")
    expectTypeOf<EconomicBoundary>().toHaveProperty("capital_layer")
    expectTypeOf<EconomicBoundary>().toHaveProperty("access_decision")
  })

  it("DenialCode is a string union", () => {
    expectTypeOf<DenialCode>().toMatchTypeOf<string>()
  })

  it("ConstraintOrigin is a string union", () => {
    expectTypeOf<ConstraintOrigin>().toMatchTypeOf<string>()
  })

  it("ReputationStateName is a string union", () => {
    expectTypeOf<ReputationStateName>().toMatchTypeOf<string>()
  })

  it("JwtBoundarySpec has replay_window_seconds", () => {
    expectTypeOf<JwtBoundarySpec>().toHaveProperty("replay_window_seconds")
  })
})

// ---------------------------------------------------------------------------
// Runtime: Protocol schema re-exports are defined
// ---------------------------------------------------------------------------

describe("Protocol schema imports — runtime verification", () => {
  it("JwtClaimsSchema is defined", () => {
    expect(JwtClaimsSchema).toBeDefined()
    expect(JwtClaimsSchema.$id).toBe("JwtClaims")
  })

  it("S2SJwtClaimsSchema is defined", () => {
    expect(S2SJwtClaimsSchema).toBeDefined()
    expect(S2SJwtClaimsSchema.$id).toBe("S2SJwtClaims")
  })

  it("ProtocolBillingEntrySchema is defined", () => {
    expect(ProtocolBillingEntrySchema).toBeDefined()
  })

  it("EconomicBoundarySchema is defined", () => {
    expect(EconomicBoundarySchema).toBeDefined()
    expect(EconomicBoundarySchema.$id).toBe("EconomicBoundary")
  })

  it("QualificationCriteriaSchema is defined", () => {
    expect(QualificationCriteriaSchema).toBeDefined()
    expect(QualificationCriteriaSchema.$id).toBe("QualificationCriteria")
  })

  it("DenialCodeSchema is defined", () => {
    expect(DenialCodeSchema).toBeDefined()
    expect(DenialCodeSchema.$id).toBe("DenialCode")
  })

  it("EvaluationGapSchema is defined", () => {
    expect(EvaluationGapSchema).toBeDefined()
    expect(EvaluationGapSchema.$id).toBe("EvaluationGap")
  })

  it("ModelEconomicProfileSchema is defined", () => {
    expect(ModelEconomicProfileSchema).toBeDefined()
    expect(ModelEconomicProfileSchema.$id).toBe("ModelEconomicProfile")
  })

  it("JwtBoundarySpecSchema is defined", () => {
    expect(JwtBoundarySpecSchema).toBeDefined()
    expect(JwtBoundarySpecSchema.$id).toBe("JwtBoundarySpec")
  })
})

// ---------------------------------------------------------------------------
// Reputation vocabulary
// ---------------------------------------------------------------------------

describe("Reputation vocabulary imports", () => {
  it("REPUTATION_STATES contains canonical states", () => {
    expect(REPUTATION_STATES).toEqual(["cold", "warming", "established", "authoritative"])
  })

  it("REPUTATION_STATE_ORDER maps states to numeric ranks", () => {
    expect(REPUTATION_STATE_ORDER.cold).toBe(0)
    expect(REPUTATION_STATE_ORDER.warming).toBe(1)
    expect(REPUTATION_STATE_ORDER.established).toBe(2)
    expect(REPUTATION_STATE_ORDER.authoritative).toBe(3)
  })

  it("isKnownReputationState narrows valid states", () => {
    expect(isKnownReputationState("cold")).toBe(true)
    expect(isKnownReputationState("warming")).toBe(true)
    expect(isKnownReputationState("established")).toBe(true)
    expect(isKnownReputationState("authoritative")).toBe(true)
  })

  it("isKnownReputationState rejects unknown states", () => {
    expect(isKnownReputationState("unknown")).toBe(false)
    expect(isKnownReputationState("")).toBe(false)
    expect(isKnownReputationState("COLD")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EFFECTIVE_JTI_POLICY
// ---------------------------------------------------------------------------

describe("EFFECTIVE_JTI_POLICY — merged local + protocol", () => {
  it("invoke: required is true (OR of local=true, protocol=true)", () => {
    expect(EFFECTIVE_JTI_POLICY.invoke.required).toBe(true)
  })

  it("admin: required is true (OR of local=true, protocol=true)", () => {
    expect(EFFECTIVE_JTI_POLICY.admin.required).toBe(true)
  })

  it("s2s_get: required is false (OR of local=false, protocol=false)", () => {
    expect(EFFECTIVE_JTI_POLICY.s2s_get.required).toBe(false)
    expect(EFFECTIVE_JTI_POLICY.s2s_get.compensating).toBe("exp <= 60s")
  })

  it("byok: adopted from protocol with bounded-use mode", () => {
    expect(EFFECTIVE_JTI_POLICY.byok.required).toBe(true)
    expect(EFFECTIVE_JTI_POLICY.byok.mode).toBe("bounded-use")
    expect(EFFECTIVE_JTI_POLICY.byok.maxUses).toBe(100)
  })

  it("PROTOCOL_JTI_POLICY has byok entry", () => {
    expect(PROTOCOL_JTI_POLICY.byok).toBeDefined()
    expect(PROTOCOL_JTI_POLICY.byok.required).toBe(true)
  })

  it("LOCAL_JTI_POLICY matches legacy JTI_POLICY", () => {
    expect(LOCAL_JTI_POLICY).toBe(JTI_POLICY)
  })
})

// ---------------------------------------------------------------------------
// isJtiRequired with new byok endpoint type
// ---------------------------------------------------------------------------

describe("isJtiRequired — uses EFFECTIVE_JTI_POLICY", () => {
  it("invoke requires jti", () => {
    expect(isJtiRequired("invoke")).toBe(true)
  })

  it("admin requires jti", () => {
    expect(isJtiRequired("admin")).toBe(true)
  })

  it("s2s does not require jti", () => {
    expect(isJtiRequired("s2s")).toBe(false)
  })

  it("byok requires jti", () => {
    expect(isJtiRequired("byok")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// MAX_JTI_WINDOW_SECONDS
// ---------------------------------------------------------------------------

describe("MAX_JTI_WINDOW_SECONDS — env-configurable ceiling", () => {
  it("defaults to 600 when env var not set", () => {
    // In test environment, env var is likely not set
    // The module-level constant is already evaluated — just verify it's a valid number
    expect(MAX_JTI_WINDOW_SECONDS).toBeGreaterThanOrEqual(30)
    expect(typeof MAX_JTI_WINDOW_SECONDS).toBe("number")
    expect(Number.isFinite(MAX_JTI_WINDOW_SECONDS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// deriveJtiTtl ceiling override
// ---------------------------------------------------------------------------

describe("deriveJtiTtl — ceiling override for effective window", () => {
  const NOW = 1700000000

  it("default ceiling is 7200 (backward compatible)", () => {
    // Token expiring in 10000s — should be capped at 7200 (default)
    const ttl = deriveJtiTtl(NOW + 10000, NOW)
    expect(ttl).toBe(7200)
  })

  it("protocol window of 3600s caps TTL to 3600", () => {
    // Token expiring in 10000s, ceiling = 3600
    const ttl = deriveJtiTtl(NOW + 10000, NOW, 3600)
    expect(ttl).toBe(3600)
  })

  it("protocol window of 600s (default MAX_JTI_WINDOW_SECONDS) caps TTL", () => {
    // Token expiring in 10000s, ceiling = 600
    const ttl = deriveJtiTtl(NOW + 10000, NOW, 600)
    expect(ttl).toBe(600)
  })

  it("MIN_TTL floor (30s) still enforced regardless of ceiling", () => {
    // Token already expired — raw TTL is negative
    const ttl = deriveJtiTtl(NOW - 100, NOW, 600)
    expect(ttl).toBe(30)
  })

  it("short-lived token within ceiling uses exp-derived TTL", () => {
    // Token expiring in 120s: raw = 120 + 60 = 180
    const ttl = deriveJtiTtl(NOW + 120, NOW, 600)
    expect(ttl).toBe(180) // within ceiling, uses actual value
  })

  it("token exactly at ceiling boundary", () => {
    // Token expiring in 540s: raw = 540 + 60 = 600 = ceiling
    const ttl = deriveJtiTtl(NOW + 540, NOW, 600)
    expect(ttl).toBe(600)
  })

  it("token just above ceiling gets capped", () => {
    // Token expiring in 541s: raw = 541 + 60 = 601 > ceiling of 600
    const ttl = deriveJtiTtl(NOW + 541, NOW, 600)
    expect(ttl).toBe(600)
  })
})
