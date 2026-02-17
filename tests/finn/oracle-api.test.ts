// tests/finn/oracle-api.test.ts — Oracle handler tests (Sprint 3 Task 3.7)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createOracleHandler, oracleCorsMiddleware } from "../../src/gateway/routes/oracle.js"
import type { HounfourRouter } from "../../src/hounfour/router.js"
import type { CompletionResult } from "../../src/hounfour/types.js"
import type { FinnConfig } from "../../src/config.js"
import type { OracleRateLimiter } from "../../src/gateway/oracle-rate-limit.js"
import type { OracleTenantContext } from "../../src/gateway/oracle-auth.js"
import { HounfourError } from "../../src/hounfour/errors.js"

// --- Helpers ---

function createMockResult(overrides?: Partial<CompletionResult>): CompletionResult {
  return {
    content: "The Oracle answers your question.",
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 500, completion_tokens: 200, reasoning_tokens: 0 },
    metadata: {
      model: "claude-opus-4-6",
      latency_ms: 1500,
      trace_id: "trace-oracle-001",
      cost_micro: "300000", // 30 cents in micro-USD
      knowledge: {
        sources_used: ["glossary", "ecosystem-architecture"],
        tokens_used: 5000,
        budget: 15000,
        mode: "full",
        tags_matched: ["core", "technical"],
        classification: ["technical"],
      },
    },
    ...overrides,
  }
}

function createMockRouter(overrides?: Partial<HounfourRouter>): HounfourRouter {
  return {
    invokeForTenant: vi.fn().mockResolvedValue(createMockResult()),
    ...overrides,
  } as unknown as HounfourRouter
}

function createMockRateLimiter(): OracleRateLimiter {
  return {
    check: vi.fn().mockResolvedValue({ allowed: true, reason: null, limit: 5, remaining: 4 }),
    reserveCost: vi.fn().mockResolvedValue({
      allowed: true,
      reservationId: "res-001",
      release: vi.fn().mockResolvedValue(undefined),
    }),
    isHealthy: vi.fn().mockResolvedValue(true),
    getDailyUsage: vi.fn().mockResolvedValue({ globalCount: 10, costCents: 500 }),
  } as unknown as OracleRateLimiter
}

function createMockConfig(): FinnConfig {
  return {
    oracle: {
      enabled: true,
      sourcesConfigPath: "grimoires/oracle/sources.json",
      minContextWindow: 30000,
      dailyCap: 200,
      costCeilingCents: 2000,
      maxConcurrent: 3,
      publicDailyLimit: 5,
      authenticatedDailyLimit: 50,
      estimatedCostCents: 50,
      trustXff: true,
      corsOrigins: ["https://oracle.arrakis.community"],
      dixieRef: "abc123",
    },
  } as unknown as FinnConfig
}

const mockTenant: OracleTenantContext = {
  tier: "public",
  identity: { type: "ip", ip: "1.2.3.4" },
  asTenant: () => ({
    claims: {
      iss: "oracle",
      aud: "loa-finn",
      sub: "oracle:ip:1.2.3.4",
      tenant_id: "oracle:ip:1.2.3.4",
      tier: "free" as const,
      req_hash: "",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    resolvedPools: ["cheap"] as any,
    isNFTRouted: false,
    isBYOK: false,
  }) as any,
}

function createTestApp(
  router?: HounfourRouter,
  rateLimiter?: OracleRateLimiter,
  config?: FinnConfig,
  tenant?: OracleTenantContext | null,
) {
  const app = new Hono()
  const activeTenant = tenant === null ? undefined : (tenant ?? mockTenant)

  // Simulate oracle auth middleware
  app.use("*", async (c, next) => {
    if (activeTenant) {
      c.set("oracleTenant", activeTenant)
      c.set("oracleIdentity", activeTenant.identity)
    }
    return next()
  })

  app.post(
    "/",
    createOracleHandler(
      router ?? createMockRouter(),
      rateLimiter ?? createMockRateLimiter(),
      config ?? createMockConfig(),
    ),
  )
  return app
}

describe("createOracleHandler", () => {
  it("should return valid OracleResponse shape", async () => {
    const app = createTestApp()
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What is Hounfour?" }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("X-Oracle-API-Version")).toBe("2026-02-17")

    const body = await res.json()
    expect(body.answer).toBeTruthy()
    expect(body.sources).toBeInstanceOf(Array)
    expect(body.sources.length).toBeGreaterThan(0)
    expect(body.sources[0]).toHaveProperty("id")
    expect(body.sources[0]).toHaveProperty("tags")
    expect(body.metadata.knowledge_mode).toBe("full")
    expect(body.metadata.model).toBe("claude-opus-4-6")
    expect(body.metadata.session_id).toBeNull()
  })

  it("should return 400 for missing question", async () => {
    const app = createTestApp()
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("INVALID_REQUEST")
  })

  it("should return 400 for empty question", async () => {
    const app = createTestApp()
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "   " }),
    })
    expect(res.status).toBe(400)
  })

  it("should return 400 for question exceeding 10000 chars", async () => {
    const app = createTestApp()
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "a".repeat(10001) }),
    })
    expect(res.status).toBe(400)
  })

  it("should return 400 for context exceeding 5000 chars", async () => {
    const app = createTestApp()
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What?", context: "a".repeat(5001) }),
    })
    expect(res.status).toBe(400)
  })

  it("should return 400 for invalid JSON body", async () => {
    const app = createTestApp()
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(res.status).toBe(400)
  })

  it("should return 401 when no tenant set", async () => {
    const app = createTestApp(undefined, undefined, undefined, null)
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Hello" }),
    })
    expect(res.status).toBe(401)
  })

  it("should return 503 when cost ceiling exceeded", async () => {
    const rateLimiter = createMockRateLimiter()
    ;(rateLimiter.reserveCost as any).mockResolvedValue({
      allowed: false,
      reservationId: "res-denied",
      release: vi.fn(),
    })
    const app = createTestApp(undefined, rateLimiter)

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Hello" }),
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe("COST_CEILING_EXCEEDED")
  })

  it("should map BUDGET_EXCEEDED to 402", async () => {
    const router = createMockRouter({
      invokeForTenant: vi.fn().mockRejectedValue(
        new HounfourError("BUDGET_EXCEEDED", "Budget exceeded"),
      ),
    })
    const app = createTestApp(router)

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Hello" }),
    })
    expect(res.status).toBe(402)
  })

  it("should map ORACLE_MODEL_UNAVAILABLE to 422", async () => {
    const router = createMockRouter({
      invokeForTenant: vi.fn().mockRejectedValue(
        new HounfourError("ORACLE_MODEL_UNAVAILABLE", "No model"),
      ),
    })
    const app = createTestApp(router)

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Hello" }),
    })
    expect(res.status).toBe(422)
  })

  it("should map CONTEXT_OVERFLOW to 413", async () => {
    const router = createMockRouter({
      invokeForTenant: vi.fn().mockRejectedValue(
        new HounfourError("CONTEXT_OVERFLOW", "Too large"),
      ),
    })
    const app = createTestApp(router)

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Hello" }),
    })
    expect(res.status).toBe(413)
  })

  it("should release(0) on error for full refund", async () => {
    const releaseFn = vi.fn().mockResolvedValue(undefined)
    const rateLimiter = createMockRateLimiter()
    ;(rateLimiter.reserveCost as any).mockResolvedValue({
      allowed: true,
      reservationId: "res-err",
      release: releaseFn,
    })
    const router = createMockRouter({
      invokeForTenant: vi.fn().mockRejectedValue(new Error("boom")),
    })
    const app = createTestApp(router, rateLimiter)

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Hello" }),
    })

    expect(releaseFn).toHaveBeenCalledWith(0)
  })

  it("should include optional context in prompt", async () => {
    const router = createMockRouter()
    const app = createTestApp(router)

    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What is X?", context: "X is a feature" }),
    })

    expect(router.invokeForTenant).toHaveBeenCalledWith(
      "oracle",
      "What is X?\n\nAdditional context: X is a feature",
      expect.anything(),
      "invoke",
    )
  })
})

describe("oracleCorsMiddleware", () => {
  it("should set CORS headers for allowed origin", async () => {
    const app = new Hono()
    app.use("*", oracleCorsMiddleware(["https://oracle.arrakis.community"]))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", {
      method: "POST",
      headers: { Origin: "https://oracle.arrakis.community" },
    })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://oracle.arrakis.community")
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS")
  })

  it("should not set CORS headers for disallowed origin", async () => {
    const app = new Hono()
    app.use("*", oracleCorsMiddleware(["https://oracle.arrakis.community"]))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", {
      method: "POST",
      headers: { Origin: "https://evil.com" },
    })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("should return 204 for OPTIONS preflight", async () => {
    const app = new Hono()
    app.use("*", oracleCorsMiddleware(["https://oracle.arrakis.community"]))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", {
      method: "OPTIONS",
      headers: { Origin: "https://oracle.arrakis.community" },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://oracle.arrakis.community")
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400")
  })
})
