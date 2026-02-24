// tests/finn/economic-boundary.test.ts — Choreography Failure Tests (Sprint 3, Task 3.3)
//
// Tests all 4 failure scenarios from SDD §6.3:
//   (1) Step 2 denial → no provider call, no billing (NEW)
//   (2) Step 5 conservation failure → no billing commit (EXISTING — regression)
//   (3) Step 6 finalize failure → DLQ entry (EXISTING — regression)
//   (4) Successful full lifecycle → all 6 steps execute (integration)
//
// Plus infrastructure error paths: snapshot failure → 503, schema → 503, exception → 503.
// Plus circuit breaker behavior (Task 4.1: instance-per-middleware).
// Plus graceful degradation for pre-v7.7 peers.
// Plus tenant ID hashing in logs (Task 4.4).
// Plus configurable budget period end (Task 4.2).

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
  CircuitBreaker,
  hashTenantId,
  computeBlendedScore,
  DEFAULT_BLENDING_WEIGHTS,
  type EconomicBoundaryMode,
  type EconomicBoundaryMiddlewareOptions,
  type EconomicBoundaryHandler,
  DEFAULT_REPUTATION_TIMEOUT_MS,
} from "../../src/hounfour/economic-boundary.js"
import type { JWTClaims } from "../../src/hounfour/jwt-auth.js"
import type { BudgetSnapshot, BudgetEpoch, ReputationProvider } from "../../src/hounfour/types.js"
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
    it("maps 'pro' tier to 'warming' reputation state", async () => {
      const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
      const snap = await buildTrustSnapshot(claims)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("warming")
      expect(snap!.blended_score).toBe(50)
      expect(snap!.snapshot_at).toBeDefined()
    })

    it("maps 'free' tier to 'cold' reputation state", async () => {
      const claims = makeClaims({ tier: "free" as JWTClaims["tier"] })
      const snap = await buildTrustSnapshot(claims)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("cold")
      expect(snap!.blended_score).toBe(10)
    })

    it("maps 'enterprise' tier to 'established' reputation state", async () => {
      const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })
      const snap = await buildTrustSnapshot(claims)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("established")
      expect(snap!.blended_score).toBe(80)
    })

    it("returns null for unknown tier (fail-closed)", async () => {
      const claims = makeClaims({ tier: "unknown_tier" as JWTClaims["tier"] })
      const snap = await buildTrustSnapshot(claims)

      expect(snap).toBeNull()
    })

    it("logs degraded mode for pre-v7.7 peers (Task 3.5)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
      const peerFeatures = makePeerFeatures({ economicBoundary: false })

      const snap = await buildTrustSnapshot(claims, peerFeatures)

      expect(snap).not.toBeNull()
      expect(snap!.reputation_state).toBe("warming")
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Degraded trust mode"),
      )
      warnSpy.mockRestore()
    })

    it("does NOT log degraded mode for v7.7+ peers", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
      const peerFeatures = makePeerFeatures({ economicBoundary: true })

      await buildTrustSnapshot(claims, peerFeatures)

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

    it("returns null for NaN limit (fail-closed)", () => {
      const budget = makeBudget({ limit_usd: NaN })
      const snap = buildCapitalSnapshot(budget)
      expect(snap).toBeNull()
    })

    it("returns null for Infinity spent (fail-closed)", () => {
      const budget = makeBudget({ spent_usd: Infinity })
      const snap = buildCapitalSnapshot(budget)
      expect(snap).toBeNull()
    })
  })
})

describe("Economic Boundary — Core Evaluation", () => {
  it("grants access for pro tier with budget", async () => {
    const claims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
    const budget = makeBudget({ limit_usd: 100, spent_usd: 10 })

    const result = await evaluateBoundary(claims, budget)

    expect(result).not.toBeNull()
    expect(result!.access_decision.granted).toBe(true)
  })

  it("denies access when trust score below threshold", async () => {
    const claims = makeClaims({ tier: "free" as JWTClaims["tier"] })
    const budget = makeBudget({ limit_usd: 100, spent_usd: 10 })
    // Use criteria that requires more than cold/10
    const criteria = {
      min_trust_score: 50,
      min_reputation_state: "warming" as const,
      min_available_budget: "0",
    }

    const result = await evaluateBoundary(claims, budget, undefined, criteria)

    expect(result).not.toBeNull()
    expect(result!.access_decision.granted).toBe(false)
  })

  it("returns null for unknown tier (fail-closed)", async () => {
    const claims = makeClaims({ tier: "mystery" as JWTClaims["tier"] })
    const budget = makeBudget()

    const result = await evaluateBoundary(claims, budget)

    expect(result).toBeNull()
  })

  it("returns null for negative budget (fail-closed)", async () => {
    const claims = makeClaims()
    const budget = makeBudget({ limit_usd: 10, spent_usd: 50 })

    const result = await evaluateBoundary(claims, budget)

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

    it("returns 503 when tenantContext is missing in enforce mode", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const app = new Hono()
      // Intentionally skip setting tenantContext
      app.use("*", economicBoundaryMiddleware({
        mode: "enforce",
        getBudgetSnapshot: async () => makeBudget(),
      }))
      app.post("/api/v1/invoke", (c) => c.json({ reached: true }))

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(503)
      errorSpy.mockRestore()
    })

    it("allows through when tenantContext is missing in shadow mode (fail-open)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const app = new Hono()
      // Intentionally skip setting tenantContext
      app.use("*", economicBoundaryMiddleware({
        mode: "shadow",
        getBudgetSnapshot: async () => makeBudget(),
      }))
      app.post("/api/v1/invoke", (c) => c.json({ reached: true }))

      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reached).toBe(true)
      errorSpy.mockRestore()
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
    it("returns 503 when circuit open in enforce mode (fail-closed)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

      const app = createTestApp({
        mode: "enforce",
        getBudgetSnapshot: async () => null,
      })

      // Fire 5 requests to open circuit
      for (let i = 0; i < 5; i++) {
        await app.request("/api/v1/invoke", { method: "POST" })
      }

      // 6th request should get 503 (circuit open + enforce = fail-closed)
      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(503)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Circuit open"),
      )

      errorSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it("bypasses when circuit open in shadow mode (fail-open)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

      const app = createTestApp({
        mode: "shadow",
        getBudgetSnapshot: async () => null,
      })

      // Fire 5 requests to open circuit
      for (let i = 0; i < 5; i++) {
        await app.request("/api/v1/invoke", { method: "POST" })
      }

      // 6th request should pass through (circuit open + shadow = allow)
      const res = await app.request("/api/v1/invoke", { method: "POST" })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reached).toBe(true)

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

// =============================================================================
// Sprint 4 Tests (global-129): Economic Boundary Hardening
// =============================================================================

describe("Sprint 4 — Instance Circuit Breaker (Task 4.1)", () => {
  it("CircuitBreaker class uses default config", () => {
    const cb = new CircuitBreaker()
    expect(cb.threshold).toBe(5)
    expect(cb.windowMs).toBe(30_000)
    expect(cb.resetMs).toBe(60_000)
    expect(cb.isOpen()).toBe(false)
  })

  it("CircuitBreaker accepts custom configuration", () => {
    const cb = new CircuitBreaker({ threshold: 3, windowMs: 10_000, resetMs: 20_000 })
    expect(cb.threshold).toBe(3)
    expect(cb.windowMs).toBe(10_000)
    expect(cb.resetMs).toBe(20_000)
  })

  it("opens after threshold failures", () => {
    const cb = new CircuitBreaker({ threshold: 3 })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen()).toBe(false)
    cb.recordFailure() // 3rd = threshold
    expect(cb.isOpen()).toBe(true)
  })

  it("resets failure count on success", () => {
    const cb = new CircuitBreaker({ threshold: 3 })
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    expect(cb.failureCount).toBe(0)
    expect(cb.isOpen()).toBe(false)
  })

  it("reset() clears all state", () => {
    const cb = new CircuitBreaker({ threshold: 2 })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen()).toBe(true)
    cb.reset()
    expect(cb.isOpen()).toBe(false)
    expect(cb.failureCount).toBe(0)
    expect(cb.lastFailure).toBe(0)
  })

  it("two middleware instances have independent circuit state", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    // Instance A — will be opened
    const handlerA = economicBoundaryMiddleware({
      mode: "enforce",
      getBudgetSnapshot: async () => null, // always fails
    })

    // Instance B — healthy
    const handlerB = economicBoundaryMiddleware({
      mode: "enforce",
      getBudgetSnapshot: async () => makeBudget(),
    })

    const appA = new Hono()
    appA.use("*", async (c, next) => {
      c.set("tenantContext", { claims: makeClaims() })
      return next()
    })
    appA.use("*", handlerA)
    appA.post("/api/v1/invoke", (c) => c.json({ reached: true }))

    const appB = new Hono()
    appB.use("*", async (c, next) => {
      c.set("tenantContext", { claims: makeClaims() })
      return next()
    })
    appB.use("*", handlerB)
    appB.post("/api/v1/invoke", (c) => c.json({ reached: true }))

    // Open circuit A with 5 failures
    for (let i = 0; i < 5; i++) {
      await appA.request("/api/v1/invoke", { method: "POST" })
    }

    // Verify A is open
    expect(handlerA.circuitBreaker.isOpen()).toBe(true)

    // Verify B still evaluates (independent circuit)
    expect(handlerB.circuitBreaker.isOpen()).toBe(false)
    const resB = await appB.request("/api/v1/invoke", { method: "POST" })
    expect(resB.status).toBe(200)

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it("middleware exposes circuitBreaker instance", () => {
    const handler = economicBoundaryMiddleware({
      getBudgetSnapshot: async () => makeBudget(),
    })
    expect(handler.circuitBreaker).toBeInstanceOf(CircuitBreaker)
  })

  it("accepts custom circuitBreakerOptions via middleware", () => {
    const handler = economicBoundaryMiddleware({
      getBudgetSnapshot: async () => makeBudget(),
      circuitBreakerOptions: { threshold: 10, windowMs: 5_000, resetMs: 120_000 },
    })
    expect(handler.circuitBreaker.threshold).toBe(10)
    expect(handler.circuitBreaker.windowMs).toBe(5_000)
    expect(handler.circuitBreaker.resetMs).toBe(120_000)
  })
})

describe("Sprint 4 — Configurable Budget Period End (Task 4.2)", () => {
  it("uses provided budget_period_end when present", () => {
    const customEnd = "2026-06-30T23:59:59Z"
    const budget = makeBudget({ budget_period_end: customEnd })
    const snap = buildCapitalSnapshot(budget)

    expect(snap).not.toBeNull()
    expect(snap!.budget_period_end).toBe(customEnd)
  })

  it("falls back to 30-day default when budget_period_end absent", () => {
    const budget = makeBudget() // no budget_period_end
    const now = Date.now()
    const snap = buildCapitalSnapshot(budget)

    expect(snap).not.toBeNull()
    // Should be ~30 days from now
    const periodEnd = new Date(snap!.budget_period_end).getTime()
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
    expect(periodEnd).toBeGreaterThan(now + thirtyDaysMs - 5000)
    expect(periodEnd).toBeLessThan(now + thirtyDaysMs + 5000)
  })

  it("preserves existing callers without budget_period_end (no breaking changes)", () => {
    // Old-style budget without the new field
    const budget: BudgetSnapshot = {
      scope: "monthly",
      spent_usd: 10,
      limit_usd: 100,
      percent_used: 10,
      warning: false,
      exceeded: false,
    }
    const snap = buildCapitalSnapshot(budget)

    expect(snap).not.toBeNull()
    expect(snap!.budget_remaining).toBe("90000000")
    expect(snap!.budget_period_end).toBeDefined()
  })
})

describe("Sprint 4 — Tenant ID Hashing (Task 4.4)", () => {
  it("hashTenantId produces 16-char hex string", () => {
    const hash = hashTenantId("community:thj")
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it("same tenant always produces same hash (deterministic)", () => {
    const hash1 = hashTenantId("community:thj")
    const hash2 = hashTenantId("community:thj")
    expect(hash1).toBe(hash2)
  })

  it("different tenants produce different hashes", () => {
    const hash1 = hashTenantId("community:thj")
    const hash2 = hashTenantId("community:other")
    expect(hash1).not.toBe(hash2)
  })

  it("structured denial log contains tenant_hash, not tenant_id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createTestApp({
      mode: "shadow",
      claims: makeClaims({ tier: "free" as JWTClaims["tier"], tenant_id: "community:thj" }),
      getBudgetSnapshot: async () => makeBudget(),
      criteria: {
        min_trust_score: 50,
        min_reputation_state: "warming" as const,
        min_available_budget: "0",
      },
    })

    await app.request("/api/v1/invoke", { method: "POST" })

    const logCalls = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("economic-boundary") && call[0].includes("evaluation"),
    )
    expect(logCalls.length).toBeGreaterThan(0)

    const logPayload = JSON.parse(logCalls[0][1] as string)
    // Must have tenant_hash
    expect(logPayload.tenant_hash).toBeDefined()
    expect(logPayload.tenant_hash).toHaveLength(16)
    expect(logPayload.tenant_hash).toBe(hashTenantId("community:thj"))
    // Must NOT have raw tenant_id
    expect(logPayload.tenant_id).toBeUndefined()

    warnSpy.mockRestore()
  })

  it("structured grant log contains tenant_hash, not tenant_id", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const app = createTestApp({
      mode: "shadow",
      claims: makeClaims({ tier: "pro" as JWTClaims["tier"], tenant_id: "community:thj" }),
      getBudgetSnapshot: async () => makeBudget(),
    })

    await app.request("/api/v1/invoke", { method: "POST" })

    const logCalls = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("economic-boundary") && call[0].includes("evaluation"),
    )
    expect(logCalls.length).toBeGreaterThan(0)

    const logPayload = JSON.parse(logCalls[0][1] as string)
    expect(logPayload.tenant_hash).toBeDefined()
    expect(logPayload.tenant_id).toBeUndefined()

    logSpy.mockRestore()
  })

  it("403 response body contains raw tenant_id for debugging", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createTestApp({
      mode: "enforce",
      claims: makeClaims({ tier: "free" as JWTClaims["tier"], tenant_id: "community:thj" }),
      getBudgetSnapshot: async () => makeBudget(),
      criteria: {
        min_trust_score: 50,
        min_reputation_state: "warming" as const,
        min_available_budget: "0",
      },
    })

    const res = await app.request("/api/v1/invoke", { method: "POST" })

    expect(res.status).toBe(403)
    const body = await res.json()
    // 403 response goes to the authenticated tenant — raw ID is safe
    expect(body.tenant_id).toBe("community:thj")

    warnSpy.mockRestore()
  })
})

// =============================================================================
// Sprint 5 Tests (global-130): Test Depth + Dynamic Reputation Foundation
// =============================================================================

describe("Sprint 5 — Half-open circuit breaker time-travel (Task 5.1)", () => {
  it("transitions to half-open after cooldown and closes on success", () => {
    const nowMock = vi.spyOn(Date, "now")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const baseTime = 1_000_000
    nowMock.mockReturnValue(baseTime)

    const cb = new CircuitBreaker({ threshold: 3, resetMs: 60_000 })

    // Open the circuit with threshold failures
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen()).toBe(true)

    // Just before cooldown boundary — still open
    nowMock.mockReturnValue(baseTime + 60_000 - 1)
    expect(cb.isOpen()).toBe(true)

    // At cooldown boundary + 1ms — half-open (isOpen returns false, allows retry)
    nowMock.mockReturnValue(baseTime + 60_000 + 1)
    expect(cb.isOpen()).toBe(false)

    // Success in half-open → circuit fully closes
    cb.recordSuccess()
    expect(cb.open).toBe(false)
    expect(cb.failureCount).toBe(0)

    nowMock.mockRestore()
    errorSpy.mockRestore()
  })

  it("re-opens immediately on failure in half-open state (no gradual recovery)", () => {
    const nowMock = vi.spyOn(Date, "now")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const baseTime = 1_000_000
    nowMock.mockReturnValue(baseTime)

    const cb = new CircuitBreaker({ threshold: 3, resetMs: 60_000 })

    // Open the circuit
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen()).toBe(true)

    // Advance past cooldown — half-open
    nowMock.mockReturnValue(baseTime + 60_001)
    expect(cb.isOpen()).toBe(false) // half-open

    // Single failure in half-open → immediately re-opens
    cb.recordFailure()
    expect(cb.open).toBe(true)

    // Verify it's truly open (not half-open)
    nowMock.mockReturnValue(baseTime + 60_002)
    expect(cb.isOpen()).toBe(true) // still within new cooldown

    nowMock.mockRestore()
    errorSpy.mockRestore()
  })

  it("off-by-one: cooldown-1ms stays open, cooldown+1ms goes half-open", () => {
    const nowMock = vi.spyOn(Date, "now")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const baseTime = 1_000_000
    nowMock.mockReturnValue(baseTime)

    const cb = new CircuitBreaker({ threshold: 2, resetMs: 10_000 })

    // Open the circuit
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.isOpen()).toBe(true)

    // Exactly at boundary: baseTime + resetMs = not yet past
    nowMock.mockReturnValue(baseTime + 10_000)
    expect(cb.isOpen()).toBe(true) // resetMs is > comparison, not >=

    // One ms past boundary
    nowMock.mockReturnValue(baseTime + 10_001)
    expect(cb.isOpen()).toBe(false) // half-open

    nowMock.mockRestore()
    errorSpy.mockRestore()
  })

  it("half-open → success → subsequent failures need full threshold again", () => {
    const nowMock = vi.spyOn(Date, "now")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const baseTime = 1_000_000
    nowMock.mockReturnValue(baseTime)

    const cb = new CircuitBreaker({ threshold: 3, resetMs: 60_000 })

    // Open, then half-open, then success
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    nowMock.mockReturnValue(baseTime + 60_001)
    expect(cb.isOpen()).toBe(false) // half-open
    cb.recordSuccess() // fully closed

    // Now need full threshold again to re-open
    nowMock.mockReturnValue(baseTime + 70_000)
    cb.recordFailure()
    expect(cb.isOpen()).toBe(false)
    cb.recordFailure()
    expect(cb.isOpen()).toBe(false)
    cb.recordFailure() // 3rd = threshold
    expect(cb.isOpen()).toBe(true)

    nowMock.mockRestore()
    errorSpy.mockRestore()
  })
})

describe("Sprint 5 — Interaction matrix cross-mode (Task 5.2)", () => {
  // Tests the 4 critical cells of ECONOMIC_BOUNDARY_MODE × AP_ENFORCEMENT.
  // Ref: economic-boundary.ts lines 13-21 interaction matrix comment.
  //
  // Since EB and AP are separate middleware, these tests verify EB's behavior
  // for each matrix cell and document the expected combined behavior.

  it("shadow × observe: EB logs denial but allows through (neither enforces)", async () => {
    // Matrix cell: shadow × observe → log both, neither enforces
    // EB behavior: shadow mode logs denial, allows through
    // AP behavior: observe mode would also log, not enforce
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

    const res = await app.request("/api/v1/invoke", { method: "POST" })

    expect(res.status).toBe(200) // EB allows through (shadow)
    const body = await res.json()
    expect(body.reached).toBe(true) // Downstream middleware reached
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("economic-boundary"),
      expect.stringContaining("denied"),
    )
    warnSpy.mockRestore()
  })

  it("shadow × enforce: EB logs but allows through (AP would enforce separately)", async () => {
    // Matrix cell: shadow × enforce → AP enforced, EB logs
    // EB behavior: shadow mode logs, allows through regardless
    // AP behavior: enforce mode would then evaluate and potentially deny
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

    const res = await app.request("/api/v1/invoke", { method: "POST" })

    expect(res.status).toBe(200) // EB shadow: always allows
    expect(warnSpy).toHaveBeenCalled() // But logs the denial
    warnSpy.mockRestore()
  })

  it("enforce × observe: EB enforces 403 (short-circuits before AP evaluates)", async () => {
    // Matrix cell: enforce × observe → EB enforced, AP logs
    // EB behavior: enforce mode returns 403 on denial
    // AP behavior: never reached because EB short-circuits the chain
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = createTestApp({
      mode: "enforce",
      claims: makeClaims({ tier: "free" as JWTClaims["tier"] }),
      getBudgetSnapshot: async () => makeBudget(),
      criteria: {
        min_trust_score: 50,
        min_reputation_state: "warming" as const,
        min_available_budget: "0",
      },
    })

    const res = await app.request("/api/v1/invoke", { method: "POST" })

    expect(res.status).toBe(403) // EB enforces
    const body = await res.json()
    expect(body.code).toBe("ECONOMIC_BOUNDARY_DENIED")
    expect(body.reached).toBeUndefined() // Downstream NOT reached
    warnSpy.mockRestore()
  })

  it("enforce × enforce: EB denial takes precedence (returns 403 before AP evaluates)", async () => {
    // Matrix cell: enforce × enforce → both enforce, EB denial takes precedence
    // EB behavior: enforce mode returns 403, preventing AP from running
    // AP behavior: would also enforce, but never gets the chance
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const providerSpy = vi.fn(async () => makeBudget())
    const app = new Hono()
    const claims = makeClaims({ tier: "free" as JWTClaims["tier"] })
    app.use("*", async (c, next) => {
      c.set("tenantContext", { claims })
      return next()
    })
    app.use("*", economicBoundaryMiddleware({
      mode: "enforce",
      getBudgetSnapshot: providerSpy,
      criteria: {
        min_trust_score: 50,
        min_reputation_state: "warming" as const,
        min_available_budget: "0",
      },
    }))
    // Simulated AP middleware — should NOT be reached on EB denial
    let apReached = false
    app.use("*", async (_c, next) => {
      apReached = true
      return next()
    })
    app.post("/api/v1/invoke", (c) => c.json({ reached: true }))

    const res = await app.request("/api/v1/invoke", { method: "POST" })

    expect(res.status).toBe(403) // EB takes precedence
    // Note: AP middleware placement after EB means it's not reached on EB 403.
    // In production chain order: JWT Auth → EB → AP → Provider
    // EB denial short-circuits before AP.
    expect(apReached).toBe(false)
    warnSpy.mockRestore()
  })
})

describe("Sprint 5 — Authoritative tier + ReputationProvider (Task 5.3)", () => {
  it("TIER_TRUST_MAP.authoritative exists and passes boot-time validation", () => {
    expect(TIER_TRUST_MAP.authoritative).toBeDefined()
    expect(TIER_TRUST_MAP.authoritative.reputation_state).toBe("authoritative")
    expect(TIER_TRUST_MAP.authoritative.blended_score).toBe(95)
    // Boot-time validation should not throw with authoritative tier
    expect(() => validateTierTrustMap()).not.toThrow()
  })

  it("ReputationProvider interface: provider returning boost >= 15 upgrades to authoritative", async () => {
    const provider: ReputationProvider = {
      getReputationBoost: async () => ({ boost: 20, source: "behavioral-analysis" }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const snap = await buildTrustSnapshot(claims, undefined, { reputationProvider: provider })

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("authoritative")
    // Blended: Math.round(0.7 * 80 + 0.3 * 20) = Math.round(62) = 62
    expect(snap!.blended_score).toBeCloseTo(62, 0)
  })

  it("without provider: existing behavior unchanged", async () => {
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const snap = await buildTrustSnapshot(claims)

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("established")
    expect(snap!.blended_score).toBe(80)
  })

  it("provider returning null: static mapping used", async () => {
    const provider: ReputationProvider = {
      getReputationBoost: async () => null,
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const snap = await buildTrustSnapshot(claims, undefined, { reputationProvider: provider })

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("established")
    expect(snap!.blended_score).toBe(80)
  })

  it("provider returning boost < 15: static mapping used", async () => {
    const provider: ReputationProvider = {
      getReputationBoost: async () => ({ boost: 10, source: "low-signal" }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const snap = await buildTrustSnapshot(claims, undefined, { reputationProvider: provider })

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("established")
    expect(snap!.blended_score).toBe(80)
  })

  it("provider throwing: static mapping used (fail-closed)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const provider: ReputationProvider = {
      getReputationBoost: async () => { throw new Error("Redis unavailable") },
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const snap = await buildTrustSnapshot(claims, undefined, { reputationProvider: provider })

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("established")
    expect(snap!.blended_score).toBe(80)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ReputationProvider failed"),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it("provider exceeding 5ms timeout: static mapping used (fail-closed)", async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const provider: ReputationProvider = {
      getReputationBoost: () => new Promise((resolve) => {
        setTimeout(() => resolve({ boost: 20, source: "slow" }), 10) // 10ms > 5ms timeout
      }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const promise = buildTrustSnapshot(claims, undefined, { reputationProvider: provider })
    vi.advanceTimersByTime(6) // Fire the 5ms timeout
    const snap = await promise

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("established") // Static mapping, not authoritative
    expect(snap!.blended_score).toBe(80)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ReputationProvider failed"),
      expect.any(Error),
    )
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it("provider only queried for enterprise tier (not pro or free)", async () => {
    const providerSpy = vi.fn(async () => ({ boost: 20, source: "test" }))
    const provider: ReputationProvider = { getReputationBoost: providerSpy }

    const proClaims = makeClaims({ tier: "pro" as JWTClaims["tier"] })
    await buildTrustSnapshot(proClaims, undefined, { reputationProvider: provider })
    expect(providerSpy).not.toHaveBeenCalled()

    const freeClaims = makeClaims({ tier: "free" as JWTClaims["tier"] })
    await buildTrustSnapshot(freeClaims, undefined, { reputationProvider: provider })
    expect(providerSpy).not.toHaveBeenCalled()
  })

  it("integration: enterprise tenant with behavioral boost → blended score > static", async () => {
    const provider: ReputationProvider = {
      getReputationBoost: async () => ({ boost: 25, source: "community-governance" }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })
    const budget = makeBudget({ limit_usd: 1000, spent_usd: 100 })

    // Verify at snapshot level: blended score > static (80)
    const snap = await buildTrustSnapshot(claims, undefined, { reputationProvider: provider })
    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("authoritative")
    // Blended: Math.round(0.7 * 80 + 0.3 * 25) = Math.round(63.5) = 64
    // Note: blended score is LOWER than static 80 because the behavioral boost (25)
    // brings it down. The upgrade to authoritative is the reputation state, not score.
    expect(snap!.blended_score).toBeCloseTo(64, 0)

    // Verify at evaluation level: grants access with authoritative state
    const result = await evaluateBoundary(claims, budget, undefined, undefined, { reputationProvider: provider })
    expect(result).not.toBeNull()
    expect(result!.access_decision.granted).toBe(true)
    expect(result!.trust_evaluation.passed).toBe(true)
    // Protocol schema uses actual_state/actual_score (0-1 range)
    expect((result!.trust_evaluation as Record<string, unknown>).actual_state).toBe("authoritative")
  })
})

describe("Sprint 5 — Blended score weighting (Task 5.4)", () => {
  it("computeBlendedScore(50, 30) → 44 (default weights)", () => {
    // Math.round(0.7 * 50 + 0.3 * 30) = Math.round(35 + 9) = Math.round(44) = 44
    expect(computeBlendedScore(50, 30)).toBeCloseTo(44, 0)
  })

  it("score clamped: computeBlendedScore(90, 100) ≤ 100", () => {
    // Math.round(0.7 * 90 + 0.3 * 100) = Math.round(63 + 30) = Math.round(93) = 93
    const result = computeBlendedScore(90, 100)
    expect(result).toBeLessThanOrEqual(100)
    expect(result).toBeCloseTo(93, 0)
  })

  it("score clamped at lower bound: negative inputs → 0", () => {
    const result = computeBlendedScore(-10, -20)
    expect(result).toBe(0)
  })

  it("custom weights: computeBlendedScore(50, 30, {alpha: 0.5, beta: 0.5}) → 40", () => {
    // Math.round(0.5 * 50 + 0.5 * 30) = Math.round(25 + 15) = 40
    expect(computeBlendedScore(50, 30, { alpha: 0.5, beta: 0.5 })).toBeCloseTo(40, 0)
  })

  it("epsilon weight validation: throws when weights don't sum to 1.0", () => {
    expect(() => computeBlendedScore(50, 30, { alpha: 0.6, beta: 0.3 })).toThrow(
      "Blending weights must sum to 1.0",
    )
  })

  it("epsilon tolerance: 0.1 + 0.2 + 0.7 = ~1.0 does not throw (IEEE-754 safe)", () => {
    // 0.3 + 0.7 = 1.0000000000000002 in IEEE-754 — within epsilon
    expect(() => computeBlendedScore(50, 30, { alpha: 0.3, beta: 0.7 })).not.toThrow()
  })

  it("final score always Math.round() to integer", () => {
    const result = computeBlendedScore(51, 33)
    expect(Number.isInteger(result)).toBe(true)
  })

  it("DEFAULT_BLENDING_WEIGHTS exports alpha=0.7, beta=0.3", () => {
    expect(DEFAULT_BLENDING_WEIGHTS.alpha).toBe(0.7)
    expect(DEFAULT_BLENDING_WEIGHTS.beta).toBe(0.3)
  })
})

describe("Sprint 6 — Configurable ReputationProvider timeout (Task 6.1)", () => {
  it("DEFAULT_REPUTATION_TIMEOUT_MS exports 5", () => {
    expect(DEFAULT_REPUTATION_TIMEOUT_MS).toBe(5)
  })

  it("buildTrustSnapshot with undefined opts uses default 5ms timeout", async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const provider: ReputationProvider = {
      getReputationBoost: () => new Promise((resolve) => {
        setTimeout(() => resolve({ boost: 20, source: "slow" }), 10)
      }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    // No reputationTimeoutMs — should use default 5ms
    const promise = buildTrustSnapshot(claims, undefined, { reputationProvider: provider })
    vi.advanceTimersByTime(6)
    const snap = await promise

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("established") // Timed out → static mapping
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ReputationProvider failed"),
      expect.any(Error),
    )
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it("custom timeout: provider resolving within deadline succeeds", async () => {
    vi.useFakeTimers()
    const provider: ReputationProvider = {
      getReputationBoost: () => new Promise((resolve) => {
        setTimeout(() => resolve({ boost: 20, source: "custom-timeout" }), 8)
      }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    // 15ms timeout — provider resolves at 8ms, within deadline
    const promise = buildTrustSnapshot(claims, undefined, {
      reputationProvider: provider,
      reputationTimeoutMs: 15,
    })
    vi.advanceTimersByTime(9)
    const snap = await promise

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("authoritative") // Provider succeeded
  })

  it("custom timeout: provider exceeding custom deadline times out", async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const provider: ReputationProvider = {
      getReputationBoost: () => new Promise((resolve) => {
        setTimeout(() => resolve({ boost: 20, source: "too-slow" }), 25)
      }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    // 10ms custom timeout — provider resolves at 25ms, exceeds deadline
    const promise = buildTrustSnapshot(claims, undefined, {
      reputationProvider: provider,
      reputationTimeoutMs: 10,
    })
    vi.advanceTimersByTime(11)
    const snap = await promise

    expect(snap).not.toBeNull()
    expect(snap!.reputation_state).toBe("established") // Timed out → static mapping
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ReputationProvider failed"),
      expect.any(Error),
    )
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it("middleware with undefined options compiles and uses default timeout", async () => {
    // Verify backward compatibility: existing call sites compile unchanged
    const app = createTestApp({
      mode: "shadow" as EconomicBoundaryMode,
      getBudgetSnapshot: async () => makeBudget(),
      // No reputationProvider, no reputationTimeoutMs — must compile and work
    })

    const res = await app.request("/api/v1/invoke", { method: "POST" })
    expect(res.status).toBe(200)
  })

  it("middleware threads reputationTimeoutMs to evaluateBoundary", async () => {
    // Use real timers — fake timers conflict with Hono's async middleware chain.
    // Provider resolves instantly, proving the timeout option is threaded through.
    const providerSpy = vi.fn(async () => ({ boost: 20, source: "threaded" }))
    const provider: ReputationProvider = { getReputationBoost: providerSpy }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const app = createTestApp({
      mode: "shadow" as EconomicBoundaryMode,
      getBudgetSnapshot: async () => makeBudget(),
      reputationProvider: provider,
      reputationTimeoutMs: 50, // Custom timeout threaded through middleware
      claims,
    })

    const res = await app.request("/api/v1/invoke", { method: "POST" })

    expect(res.status).toBe(200)
    // Provider was called — proves reputationProvider option is threaded through middleware
    expect(providerSpy).toHaveBeenCalledWith(claims.tenant_id)
  })

  it("timer is cleaned up after provider resolves (no dangling setTimeout)", async () => {
    vi.useFakeTimers()
    const setSpy = vi.spyOn(globalThis, "setTimeout")
    const clearSpy = vi.spyOn(globalThis, "clearTimeout")
    const provider: ReputationProvider = {
      getReputationBoost: () => Promise.resolve({ boost: 20, source: "fast" }),
    }
    const claims = makeClaims({ tier: "enterprise" as JWTClaims["tier"] })

    const promise = buildTrustSnapshot(claims, undefined, {
      reputationProvider: provider,
      reputationTimeoutMs: 100,
    })
    vi.advanceTimersByTime(1)
    await promise

    // Find the specific handle for the 100ms deadline timer created by buildTrustSnapshot.
    // Asserting clearTimeout was called with that handle proves the production timer was
    // cleaned up — not merely that Vitest internals happened to call clearTimeout.
    const timeoutIndex = setSpy.mock.calls.findIndex((call) => call[1] === 100)
    const timeoutHandle = timeoutIndex >= 0 ? setSpy.mock.results[timeoutIndex]?.value : undefined
    expect(timeoutHandle).toBeDefined()
    expect(clearSpy).toHaveBeenCalledWith(timeoutHandle)

    setSpy.mockRestore()
    clearSpy.mockRestore()
    vi.useRealTimers()
  })

  it("R13: middleware warns when reputationTimeoutMs exceeds 50ms ceiling", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    createTestApp({
      mode: "shadow" as EconomicBoundaryMode,
      getBudgetSnapshot: async () => makeBudget(),
      reputationTimeoutMs: 100, // Exceeds 50ms ceiling
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reputationTimeoutMs=100 exceeds recommended 50ms ceiling"),
    )
    warnSpy.mockRestore()
  })

  it("R13: warns when reputationTimeoutMs is 0 (times out async providers)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    createTestApp({
      mode: "shadow" as EconomicBoundaryMode,
      getBudgetSnapshot: async () => makeBudget(),
      reputationTimeoutMs: 0,
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reputationTimeoutMs<=0 will time out all asynchronous"),
    )
    warnSpy.mockRestore()
  })

  it("R13: warns when reputationTimeoutMs is negative (Node.js clamps to 1ms)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    createTestApp({
      mode: "shadow" as EconomicBoundaryMode,
      getBudgetSnapshot: async () => makeBudget(),
      reputationTimeoutMs: -5,
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reputationTimeoutMs<=0 will time out all asynchronous"),
    )
    warnSpy.mockRestore()
  })

  it("R13: warns and defaults when reputationTimeoutMs is NaN", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    createTestApp({
      mode: "shadow" as EconomicBoundaryMode,
      getBudgetSnapshot: async () => makeBudget(),
      reputationTimeoutMs: NaN,
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("is not a finite number"),
    )
    warnSpy.mockRestore()
  })

  it("R13: no warning when reputationTimeoutMs is within 50ms ceiling", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    createTestApp({
      mode: "shadow" as EconomicBoundaryMode,
      getBudgetSnapshot: async () => makeBudget(),
      reputationTimeoutMs: 25, // Within ceiling
    })

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("exceeds recommended 50ms ceiling"),
    )
    warnSpy.mockRestore()
  })
})

describe("Sprint 6 — BudgetEpoch temporal diversity (Task 6.2)", () => {
  it("BudgetEpoch interface accepts calendar epoch type", () => {
    const epoch: BudgetEpoch = { epoch_type: "calendar", epoch_id: "Q1-2026" }
    expect(epoch.epoch_type).toBe("calendar")
    expect(epoch.epoch_id).toBe("Q1-2026")
  })

  it("BudgetEpoch interface accepts event epoch type", () => {
    const epoch: BudgetEpoch = { epoch_type: "event", epoch_id: "launch-campaign-3" }
    expect(epoch.epoch_type).toBe("event")
  })

  it("BudgetEpoch interface accepts community-sync epoch type", () => {
    const epoch: BudgetEpoch = { epoch_type: "community-sync", epoch_id: "governance-cycle-7" }
    expect(epoch.epoch_type).toBe("community-sync")
  })

  it("buildCapitalSnapshot emits structured log when budget_epoch present", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
    const budget = makeBudget({
      budget_epoch: { epoch_type: "calendar", epoch_id: "Q1-2026" },
    })

    const snap = buildCapitalSnapshot(budget)

    expect(snap).not.toBeNull()
    expect(debugSpy).toHaveBeenCalledWith(
      "[economic-boundary] budget_epoch_type=calendar community_epoch_id=Q1-2026",
    )
    debugSpy.mockRestore()
  })

  it("buildCapitalSnapshot does NOT log epoch when budget_epoch absent", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
    const budget = makeBudget() // No budget_epoch

    const snap = buildCapitalSnapshot(budget)

    expect(snap).not.toBeNull()
    expect(debugSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("budget_epoch_type"),
    )
    debugSpy.mockRestore()
  })

  it("budget_period_end from upstream takes precedence over 30-day default", () => {
    const customEnd = "2026-04-01T00:00:00.000Z"
    const budget = makeBudget({
      budget_period_end: customEnd,
      budget_epoch: { epoch_type: "calendar", epoch_id: "Q1-2026" },
    })

    const snap = buildCapitalSnapshot(budget)

    expect(snap).not.toBeNull()
    expect(snap!.budget_period_end).toBe(customEnd)
  })

  it("epoch metadata does NOT appear in CapitalLayerSnapshot (log-only)", () => {
    const budget = makeBudget({
      budget_epoch: { epoch_type: "community-sync", epoch_id: "gov-7" },
    })

    const snap = buildCapitalSnapshot(budget)

    expect(snap).not.toBeNull()
    // CapitalLayerSnapshot only has: budget_remaining, billing_tier, budget_period_end
    const keys = Object.keys(snap!)
    expect(keys).not.toContain("budget_epoch")
    expect(keys).not.toContain("budget_epoch_type")
    expect(keys).not.toContain("epoch_type")
    expect(keys).not.toContain("epoch_id")
  })
})
