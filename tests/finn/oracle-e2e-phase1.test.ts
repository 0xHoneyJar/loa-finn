// tests/finn/oracle-e2e-phase1.test.ts — E2E Integration Tests (Sprint 5 Task 5.6)
// Full-stack integration tests verifying the Oracle middleware chain using the E2E harness.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  setupE2E,
  createDefaultResult,
  requestWithIp,
  requestWithApiKey,
  preflightRequest,
} from "./e2e-harness.js"
import type { E2EContext } from "./e2e-harness.js"
import { HounfourError } from "../../src/hounfour/errors.js"

const BASE_URL = "http://localhost:3000"
const ORACLE_URL = `${BASE_URL}/api/v1/oracle`

describe("Oracle E2E Phase 1 Integration", () => {
  let ctx: E2EContext

  beforeEach(() => {
    ctx = setupE2E()
  })

  afterEach(() => {
    ctx.teardown()
  })

  // --- Test: Valid Oracle Query ---

  it("POST /api/v1/oracle with valid question returns OracleResponse shape", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How does the invoke API work?" }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    // OracleResponse shape validation
    expect(body).toHaveProperty("answer")
    expect(typeof body.answer).toBe("string")
    expect(body).toHaveProperty("sources")
    expect(Array.isArray(body.sources)).toBe(true)
    expect(body).toHaveProperty("metadata")
    expect(body.metadata).toHaveProperty("knowledge_mode")
    expect(body.metadata).toHaveProperty("total_knowledge_tokens")
    expect(body.metadata).toHaveProperty("knowledge_budget")
    expect(body.metadata).toHaveProperty("retrieval_ms")
    expect(body.metadata).toHaveProperty("model")
    expect(body.metadata).toHaveProperty("session_id")

    // API version header
    expect(res.headers.get("X-Oracle-API-Version")).toBe("2026-02-17")
  })

  it("includes source attribution in response", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What is the ecosystem architecture?" }),
    })

    const res = await ctx.app.fetch(req)
    const body = await res.json()

    expect(body.sources.length).toBeGreaterThan(0)
    for (const source of body.sources) {
      expect(source).toHaveProperty("id")
      expect(source).toHaveProperty("tags")
    }
  })

  // --- Test: Request Validation ---

  it("rejects missing question with 400", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.code).toBe("INVALID_REQUEST")
  })

  it("rejects question exceeding 10000 chars with 400", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "x".repeat(10_001) }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.code).toBe("INVALID_REQUEST")
  })

  // --- Test: Rate Limiting ---

  it("enforces public tier rate limit after configured requests", async () => {
    // Make 5 requests (public limit)
    for (let i = 0; i < 5; i++) {
      const req = requestWithIp(ORACLE_URL, "5.6.7.8", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: `Question ${i + 1}` }),
      })
      const res = await ctx.app.fetch(req)
      expect(res.status).toBe(200)
    }

    // 6th request should be rate limited
    const req = requestWithIp(ORACLE_URL, "5.6.7.8", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "One too many" }),
    })
    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(429)
  })

  // --- Test: Cost Ceiling ---

  it("returns 503 when cost ceiling exceeded", async () => {
    // Override rateLimiter.reserveCost to deny
    vi.mocked(ctx.rateLimiter.reserveCost).mockResolvedValueOnce({
      allowed: false,
      reservationId: "res-denied",
      release: vi.fn(),
    } as any)

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Expensive question" }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(503)

    const body = await res.json()
    expect(body.code).toBe("COST_CEILING_EXCEEDED")
  })

  // --- Test: CORS ---

  it("CORS preflight from allowed origin returns correct headers", async () => {
    const req = preflightRequest(ORACLE_URL, "https://oracle.arrakis.community")
    const res = await ctx.app.fetch(req)

    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://oracle.arrakis.community")
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization")
  })

  it("CORS preflight from disallowed origin has no CORS headers", async () => {
    const req = preflightRequest(ORACLE_URL, "https://evil.example.com")
    const res = await ctx.app.fetch(req)

    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  // --- Test: Error Mapping ---

  it("maps ORACLE_MODEL_UNAVAILABLE to 422", async () => {
    vi.mocked(ctx.mockRouter.invokeForTenant).mockRejectedValueOnce(
      new HounfourError("ORACLE_MODEL_UNAVAILABLE", "Context window too small"),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Small context query" }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(422)

    const body = await res.json()
    expect(body.code).toBe("ORACLE_MODEL_UNAVAILABLE")
  })

  it("maps BUDGET_EXCEEDED to 402", async () => {
    vi.mocked(ctx.mockRouter.invokeForTenant).mockRejectedValueOnce(
      new HounfourError("BUDGET_EXCEEDED", "Token budget exceeded"),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Budget test" }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(402)
  })

  // --- Test: Health Endpoint ---

  it("health endpoint reports oracle status", async () => {
    const res = await ctx.app.fetch(new Request(`${BASE_URL}/health`))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.status).toBe("healthy")
    expect(body.checks.oracle).toBeDefined()
    expect(body.checks.oracle.status).toBe("ok")
    expect(body.checks.oracle.rate_limiter_healthy).toBe(true)
  })

  // --- Test: Content-Type Enforcement ---

  it("always returns application/json content type", async () => {
    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Test content type" }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.headers.get("Content-Type")).toContain("application/json")
  })

  // --- Test: Cost Reconciliation ---

  it("releases reservation with actual cost on success", async () => {
    const mockRelease = vi.fn()
    vi.mocked(ctx.rateLimiter.reserveCost).mockResolvedValueOnce({
      allowed: true,
      reservationId: "res-reconcile",
      release: mockRelease,
    } as any)

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Cost reconciliation test" }),
    })

    await ctx.app.fetch(req)
    expect(mockRelease).toHaveBeenCalledWith(expect.any(Number))
  })

  it("releases reservation with 0 on error (full refund)", async () => {
    const mockRelease = vi.fn()
    vi.mocked(ctx.rateLimiter.reserveCost).mockResolvedValueOnce({
      allowed: true,
      reservationId: "res-refund",
      release: mockRelease,
    } as any)
    vi.mocked(ctx.mockRouter.invokeForTenant).mockRejectedValueOnce(
      new HounfourError("ORACLE_KNOWLEDGE_UNAVAILABLE", "Knowledge sources missing"),
    )

    const req = requestWithIp(ORACLE_URL, "1.2.3.4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Failing query" }),
    })

    await ctx.app.fetch(req)
    expect(mockRelease).toHaveBeenCalledWith(0)
  })
})
