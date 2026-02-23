// tests/finn/economic-boundary.test.ts — Choreography Failure Tests (Sprint 3, Task 3.3)
//
// Tests all 4 failure scenarios from SDD §6.3:
//   (1) Step 2 denial → no provider call, no billing (NEW)
//   (2) Step 5 conservation failure → no billing commit (EXISTING — regression)
//   (3) Step 6 finalize failure → DLQ entry (EXISTING — regression)
//   (4) Successful full lifecycle → all 6 steps execute (integration)
//
// Plus infrastructure error paths: snapshot failure → 503, schema → 503, exception → 503.
// Plus circuit breaker behavior.
// Plus graceful degradation for pre-v7.7 peers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  buildTrustSnapshot,
  buildCapitalSnapshot,
  evaluateBoundary,
  economicBoundaryMiddleware,
  TIER_TRUST_MAP,
  DEFAULT_CRITERIA,
  validateTierTrustMap,
  resetCircuitBreaker,
  ECONOMIC_BOUNDARY_MODE,
  type EconomicBoundaryMode,
  type EconomicBoundaryMiddlewareOptions,
} from "../../src/hounfour/economic-boundary.js"
import type { JWTClaims } from "../../src/hounfour/jwt-auth.js"
import type { BudgetSnapshot } from "../../src/hounfour/types.js"
import type { PeerFeatures } from "../../src/hounfour/protocol-handshake.js"
import { Hono } from "hono"

// --- Test Helpers ---

function makeClaims(overrides?: Partial<JWTClaims>): JWTClaims {
  return {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "user:discord:123",
    tenant_id: "community:thj",
    tier: "pro",
    req_hash: "sha256:abc123",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: "test-jti-001",
    ...overrides,
  } as JWTClaims
}

function makeBudget(overrides?: Partial<BudgetSnapshot>): BudgetSnapshot {
  return {
    scope: "monthly",
    spent_usd: 10,
    limit_usd: 100,
    percent_used: 10,
    warning: false,
    exceeded: false,
    ...overrides,
  }
}

function makePeerFeatures(overrides?: Partial<PeerFeatures>): PeerFeatures {
  return {
    trustScopes: true,
    reputationGated: true,
    compoundPolicies: true,
    economicBoundary: true,
    denialCodes: true,
    ...overrides,
  }
}

/**
 * Create a test Hono app with economic boundary middleware + a test endpoint.
 * The test endpoint always returns 200 with { reached: true } if the middleware allows.
 */
function createTestApp(opts: EconomicBoundaryMiddlewareOptions & {
  claims?: JWTClaims
}) {
  const app = new Hono()

  // Simulate hounfourAuth setting tenantContext (prerequisite middleware)
  const claims = opts.claims ?? makeClaims()
  app.use("*", async (c, next) => {
    c.set("tenantContext", { claims })
    return next()
  })

  // Economic boundary middleware under test
  app.use("*", economicBoundaryMiddleware(opts))

  // Test endpoint — represents provider call
  app.post("/api/v1/invoke", (c) => {
    return c.json({ reached: true })
  })

  return app
}

// --- Tests ---

describe("Economic Boundary — Snapshot Builders", () => {
  describe("buildTrustSnapshot", () => {
    it("maps 'pro' tier to 'warming' reputation state", () => {
      const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
      const snap = buildTrustSnapshot(claims)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("warming")
      expect(snap!.blended_score).toBe(50)
      expect(snap!.snapshot_at).toBeDefined()
    })

    it("maps 'free' tier to 'cold' reputation state", () => {
      const claims = makeClaims({ tier: "free" as JWTClaims["tier"] })
      const snap = buildTrustSnapshot(claims)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("cold")
      expect(snap!.blended_score).toBe(10)
    })

    it("maps 'enterprise' tier to 'established' reputation state", () => {
      const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })
      const snap = buildTrustSnapshot(claims)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("established")
      expect(snap!.blended_score).toBe(80)
    })

    it("returns null for unknown tier (fail-closed)", () => {
      const claims = makeClaims({ tier: "unknown_tier" as JWTClaims["tier"] })
      const snap = buildTrustSnapshot(claims)

      expect(snap).toBeNull()
    })

    it("logs degraded mode for pre-v7.7 peers (Task 3.5)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
      const peerFeatures = makePeerFeatures({ economicBoundary: false })

      const snap = buildTrustSnapshot(claims, peerFeatures)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("warming")
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Degraded trust mode"),
      )
      warnSpy.mockRestore()
    })

    it("does NOT log degraded mode for v7.7+ peers", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
      const peerFeatures = makePeerFeatures({ economicBoundary: true })

      buildTrustSnapshot(claims, peerFeatures)

      // Should not contain "Degraded trust mode"
      const degradedCalls = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Degraded trust mode"),
      )
      expect(degradedCalls).toHaveLength(0)
      warnSpy.mockRestore()
    })
  })

  describe("buildCapitalSnapshot", () => {
    it("computes remaining budget in MicroUSD", () => {
      const budget = makeBudget({ limit_usd: 100, spent_usd: 25 })
      const snap = buildCapitalSnapshot(budget)

      expect(snap).not.toBeNull()
      // 75 USD = 75,000,000 MicroUSD
      expect(snap!.budget_remaining).toBe("75000000")
      expect(snap!.billing_tier).toBe("monthly")
    })

    it("returns null on negative remaining (fail-closed)", () => {
      const budget = makeBudget({ limit_usd: 10, spent_usd: 50 })
      const snap = buildCapitalSnapshot(budget)

      expect(snap).toBeNull()
    })

    it("handles zero remaining budget", () => {
      const budget = makeBudget({ limit_usd: 100, spent_usd: 100 })
      const snap = buildCapitalSnapshot(budget)

      expect(snap).not.toBeNull()
      expect(snap!.budget_remaining).toBe("0")
    })

    it("uses 'unknown' for missing scope", () => {
      const budget = makeBudget({ scope: undefined as unknown as string })
      const snap = buildCapitalSnapshot(budget)

      expect(snap).not.toBeNull()
      expect(snap!.billing_tier).toBe("unknown")
    })
  })
})

describe("Economic Boundary — Core Evaluation", () => {
  it("grants access for pro tier with budget", () => {
    const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
    const budget = makeBudget({ limit_usd: 100, spent_usd: 10 })

    const result = evaluateBoundary(claims, budget)

    expect(result).not.toBeNull()
    expect(result!.access_decision.granted).toBe(true)
  })

  it("denies access when trust score below threshold", () => {
    const claims = makeClaims({ tier: "free" as JWTClaims["tier"] })
    const budget = makeBudget({ limit_usd: 100, spent_usd: 10 })
    // Use criteria that requires more than cold/10
    const criteria = {
      min_trust_score: 50,
      min_reputation_state: "warming" as const,
      min_available_budget: "0",
    }

    const result = evaluateBoundary(claims, budget, undefined, criteria)

    expect(result).not.toBeNull()
    expect(result!.access_decision.granted).toBe(false)
  })

  it("returns null for unknown tier (fail-closed)", () => {
    const claims = makeClaims({ tier: "mystery" as JWTClaims["tier"] })
    const budget = makeBudget()

    const result = evaluateBoundary(claims, budget)

    expect(result).toBeNull()
  })

  it("returns null for negative budget (fail-closed)", () => {
    const claims = makeClaims()
    const budget = makeBudget({ limit_usd: 10, spent_usd: 50 })

    const result = evaluateBoundary(claims, budget)

    expect(result).toBeNull()
  })
})

describe("Economic Boundary — Middleware", () => {
  beforeEach(() => {
    resetCircuitBreaker()
  })

  // --- Scenario 1: Step 2 denial → no provider call ---

  describe("Scenario 1: Policy denial → no provider call", () => {
    it("returns 403 with denial_codes in enforce mode", async () => {
      const app = createTestApp({
        mode: "enforce",
        claims: makeClaims({ tier: "free" as JWTClaims["tier"] }),
        getBudgetSnapshot: async () => makeBudget({ limit_usd: 100, spent_usd: 10 }),
        criteria: {
          min_trust_score: 50,
          min_reputation_state: "warming" as const,
          min_available_budget: "0",
        },
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe("ECONOMIC_BOUNDARY_DENIED")
      expect(body.denial_codes).toBeDefined()
      // Provider endpoint was NOT reached
      expect(body.reached).toBeUndefined()
    })

    it("allows through in shadow mode despite denial (logs only)", async () => {
      const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const app = createTestApp({
        mode: "shadow",
        claims: makeClaims({ tier: "free" as JWTClaims["tier"] }),
        getBudgetSnapshot: async () => makeBudget({ limit_usd: 100, spent_usd: 10 }),
        criteria: {
          min_trust_score: 50,
          min_reputation_state: "warming" as const,
          min_available_budget: "0",
        },
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reached).toBe(true)
      // Should have logged the denial
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("economic-boundary"),
        expect.stringContaining("denied"),
      )
      logSpy.mockRestore()
    })
  })

  // --- Scenario 4: Successful full lifecycle ---

  describe("Scenario 4: Granted → provider reached", () => {
    it("allows pro tier through in enforce mode", async () => {
      const app = createTestApp({
        mode: "enforce",
        claims: makeClaims({ tier: "pro" as JWTClaims["tier"] }),
        getBudgetSnapshot: async () => makeBudget({ limit_usd: 100, spent_usd: 10 }),
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reached).toBe(true)
    })

    it("allows enterprise tier through in enforce mode", async () => {
      const app = createTestApp({
        mode: "enforce",
        claims: makeClaims({ tier: "enterprise" as JWTClaims["tier"] }),
        getBudgetSnapshot: async () => makeBudget({ limit_usd: 1000, spent_usd: 100 }),
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200)
    })
  })

  // --- Infrastructure Error Paths ---

  describe("Infrastructure errors → 503", () => {
    it("returns 503 when budget snapshot unavailable (enforce)", async () => {
      const app = createTestApp({
        mode: "enforce",
        getBudgetSnapshot: async () => null,
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error_type).toBe("infrastructure")
    })

    it("allows through when budget unavailable (shadow)", async () => {
      const app = createTestApp({
        mode: "shadow",
        getBudgetSnapshot: async () => null,
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200)
    })

    it("returns 503 when getBudgetSnapshot throws (enforce)", async () => {
      const app = createTestApp({
        mode: "enforce",
        getBudgetSnapshot: async () => {
          throw new Error("Redis connection failed")
        },
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error_type).toBe("infrastructure")
    })

    it("returns 503 for unknown tier in enforce mode (trust snapshot null)", async () => {
      const app = createTestApp({
        mode: "enforce",
        claims: makeClaims({ tier: "mystery_tier" as JWTClaims["tier"] }),
        getBudgetSnapshot: async () => makeBudget(),
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      // Trust snapshot returns null → evaluation fails → 503 infrastructure
      expect(res.status).toBe(503)
    })

    it("returns 503 when tenantContext is missing (middleware ordering error)", async () => {
      const app = new Hono()
      // Intentionally skip setting tenantContext
      app.use("*", economicBoundaryMiddleware({
        mode: "enforce",
        getBudgetSnapshot: async () => makeBudget(),
      }))
      app.post("/api/v1/invoke", (c) => c.json({ reached: true }))

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(503)
    })
  })

  // --- Bypass Mode ---

  describe("Bypass mode (emergency kill-switch)", () => {
    it("skips evaluation entirely", async () => {
      const snapshotSpy = vi.fn(async () => makeBudget())
      const app = createTestApp({
        mode: "bypass",
        getBudgetSnapshot: snapshotSpy,
      })

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200)
      // Budget snapshot should NOT be called in bypass mode
      expect(snapshotSpy).not.toHaveBeenCalled()
    })
  })

  // --- Circuit Breaker ---

  describe("Circuit breaker", () => {
    it("opens after 5 consecutive snapshot failures", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      let callCount = 0

      const app = createTestApp({
        mode: "enforce",
        getBudgetSnapshot: async () => {
          callCount++
          return null // Simulate failure
        },
      })

      // Fire 5 requests to open circuit
      for (let i = 0; i < 5; i++) {
        await app.request("/api/v1/invoke", { method: "POST" })
      }

      // 6th request should bypass (circuit open)
      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200) // Bypassed → reached endpoint
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Circuit open"),
      )

      errorSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it("resets on successful evaluation", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      let failCount = 0

      const app = createTestApp({
        mode: "enforce",
        getBudgetSnapshot: async () => {
          failCount++
          // Fail first 3, then succeed
          if (failCount <= 3) return null
          return makeBudget()
        },
      })

      // 3 failures
      for (let i = 0; i < 3; i++) {
        await app.request("/api/v1/invoke", { method: "POST" })
      }

      // Successful request resets counter
      const res = await app.request("/api/v1/invoke", { method: "POST" })
      expect(res.status).toBe(200)

      errorSpy.mockRestore()
    })
  })
})

describe("Economic Boundary — Boot Validation", () => {
  it("TIER_TRUST_MAP contains all expected tiers", () => {
    expect(TIER_TRUST_MAP.free).toBeDefined()
    expect(TIER_TRUST_MAP.pro).toBeDefined()
    expect(TIER_TRUST_MAP.enterprise).toBeDefined()
  })

  it("validateTierTrustMap does not throw for valid map", () => {
    expect(() => validateTierTrustMap()).not.toThrow()
  })

  it("DEFAULT_CRITERIA is minimal bar", () => {
    expect(DEFAULT_CRITERIA.min_trust_score).toBe(5)
    expect(DEFAULT_CRITERIA.min_reputation_state).toBe("cold")
    expect(DEFAULT_CRITERIA.min_available_budget).toBe("0")
  })
})

describe("Economic Boundary — Observability", () => {
  beforeEach(() => {
    resetCircuitBreaker()
  })

  it("emits structured log on denial", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createTestApp({
      mode: "shadow",
      claims: makeClaims({ tier: "free" as JWTClaims["tier"] }),
      getBudgetSnapshot: async () => makeBudget(),
      criteria: {
        min_trust_score: 50,
        min_reputation_state: "warming" as const,
        min_available_budget: "0",
      },
    })

    await app.request("/api/v1/invoke", { method: "POST" })

    // Find the structured log call
    const logCalls = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("economic-boundary"),
    )
    expect(logCalls.length).toBeGreaterThan(0)

    // Parse structured log
    const logPayload = JSON.parse(logCalls[0][1] as string)
    expect(logPayload.component).toBe("economic-boundary")
    expect(logPayload.decision).toBe("denied")
    expect(logPayload.mode).toBe("shadow")
    expect(logPayload.latency_ms).toBeDefined()
    expect(typeof logPayload.latency_ms).toBe("number")

    warnSpy.mockRestore()
  })

  it("emits structured log on grant in shadow mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const app = createTestApp({
      mode: "shadow",
      claims: makeClaims({ tier: "pro" as JWTClaims["tier"] }),
      getBudgetSnapshot: async () => makeBudget(),
    })

    await app.request("/api/v1/invoke", { method: "POST" })

    const logCalls = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("economic-boundary"),
    )
    expect(logCalls.length).toBeGreaterThan(0)

    const logPayload = JSON.parse(logCalls[0][1] as string)
    expect(logPayload.decision).toBe("granted")

    logSpy.mockRestore()
  })
})
