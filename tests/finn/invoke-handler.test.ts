// tests/finn/invoke-handler.test.ts — Invoke endpoint handler tests (cycle-024 T6)

import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { createInvokeHandler } from "../../src/gateway/routes/invoke.js"
import type { HounfourRouter } from "../../src/hounfour/router.js"
import type { TenantContext } from "../../src/hounfour/jwt-auth.js"
import type { CompletionResult } from "../../src/hounfour/types.js"
import { HounfourError } from "../../src/hounfour/errors.js"

// --- Test Helpers ---

function createMockResult(overrides?: Partial<CompletionResult>): CompletionResult {
  return {
    content: "Hello from the model",
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
    metadata: {
      model: "gpt-4o",
      latency_ms: 200,
      trace_id: "trace-001",
      cost_micro: "1500",
    },
    ...overrides,
  }
}

function createMockRouter(overrides?: Partial<HounfourRouter>): HounfourRouter {
  return {
    invokeForTenant: async () => createMockResult(),
    ...overrides,
  } as unknown as HounfourRouter
}

function createMockTenant(overrides?: Partial<TenantContext>): TenantContext {
  return {
    claims: {
      iss: "arrakis",
      aud: "loa-finn",
      sub: "tenant-abc",
      tenant_id: "tenant-abc",
      tier: "premium" as const,
      req_hash: "hash",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    resolvedPools: ["default"],
    isNFTRouted: false,
    isBYOK: false,
    ...overrides,
  } as TenantContext
}

function createTestApp(router?: HounfourRouter, tenant?: TenantContext | null) {
  const app = new Hono()
  const mockTenant = tenant === null ? undefined : (tenant ?? createMockTenant())

  // Simulate hounfourAuth middleware setting tenant context
  app.use("*", async (c, next) => {
    if (mockTenant) {
      c.set("tenant", mockTenant)
    }
    return next()
  })

  app.post("/api/v1/invoke", createInvokeHandler(router ?? createMockRouter()))
  return app
}

// --- Tests ---

describe("createInvokeHandler", () => {
  // 1. Successful invocation
  it("returns 200 with response on success", async () => {
    const app = createTestApp()
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.response).toBe("Hello from the model")
    expect(body.model).toBe("gpt-4o")
    expect(body.usage.prompt_tokens).toBe(100)
    expect(body.usage.completion_tokens).toBe(50)
    expect(body.usage.total_tokens).toBe(150)
    expect(body.cost_micro).toBe("1500")
    expect(body.trace_id).toBe("trace-001")
  })

  // 2. Missing tenant context → 401
  it("returns 401 when tenant context is missing", async () => {
    const app = createTestApp(undefined, null)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe("TENANT_CONTEXT_MISSING")
  })

  // 3. Missing prompt → 400
  it("returns 400 when prompt is missing", async () => {
    const app = createTestApp()
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("INVALID_REQUEST")
    expect(body.error).toContain("prompt")
  })

  // 4. Empty prompt → 400
  it("returns 400 when prompt is empty string", async () => {
    const app = createTestApp()
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "   " }),
    })
    expect(res.status).toBe(400)
  })

  // 5. Missing agent → 400
  it("returns 400 when agent is missing", async () => {
    const app = createTestApp()
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("agent")
  })

  // 6. Invalid JSON body → 400
  it("returns 400 on invalid JSON body", async () => {
    const app = createTestApp()
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("INVALID_REQUEST")
  })

  // 7. BUDGET_EXCEEDED → 402
  it("maps BUDGET_EXCEEDED to 402", async () => {
    const router = createMockRouter({
      invokeForTenant: async () => {
        throw new HounfourError("BUDGET_EXCEEDED", "Budget limit reached", {})
      },
    })
    const app = createTestApp(router)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.code).toBe("BUDGET_EXCEEDED")
  })

  // 8. BINDING_INVALID → 400
  it("maps BINDING_INVALID to 400", async () => {
    const router = createMockRouter({
      invokeForTenant: async () => {
        throw new HounfourError("BINDING_INVALID", "No binding for agent", {})
      },
    })
    const app = createTestApp(router)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "unknown-agent", prompt: "Hello" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("BINDING_INVALID")
  })

  // 9. BUDGET_CIRCUIT_OPEN → 503
  it("maps BUDGET_CIRCUIT_OPEN to 503", async () => {
    const router = createMockRouter({
      invokeForTenant: async () => {
        throw new HounfourError("BUDGET_CIRCUIT_OPEN", "Circuit open", {})
      },
    })
    const app = createTestApp(router)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    expect(res.status).toBe(503)
  })

  // 10. RATE_LIMITED → 429
  it("maps RATE_LIMITED to 429", async () => {
    const router = createMockRouter({
      invokeForTenant: async () => {
        throw new HounfourError("RATE_LIMITED", "Too many requests", {})
      },
    })
    const app = createTestApp(router)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    expect(res.status).toBe(429)
  })

  // 11. PROVIDER_UNAVAILABLE → 502
  it("maps PROVIDER_UNAVAILABLE to 502", async () => {
    const router = createMockRouter({
      invokeForTenant: async () => {
        throw new HounfourError("PROVIDER_UNAVAILABLE", "No providers available", {})
      },
    })
    const app = createTestApp(router)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    expect(res.status).toBe(502)
  })

  // 12. Unexpected error → 500
  it("returns 500 on unexpected non-Hounfour error", async () => {
    const router = createMockRouter({
      invokeForTenant: async () => {
        throw new Error("unexpected failure")
      },
    })
    const app = createTestApp(router)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe("INTERNAL_ERROR")
  })

  // 13. cost_micro defaults to "0" when not set
  it("defaults cost_micro to '0' when not in metadata", async () => {
    const router = createMockRouter({
      invokeForTenant: async () => createMockResult({
        metadata: { model: "gpt-4o", latency_ms: 200, trace_id: "trace-002" },
      }),
    })
    const app = createTestApp(router)
    const res = await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "reviewer", prompt: "Hello" }),
    })
    const body = await res.json()
    expect(body.cost_micro).toBe("0")
  })

  // 14. Passes correct arguments to invokeForTenant
  it("passes agent, prompt, tenant, and source to invokeForTenant", async () => {
    let capturedArgs: unknown[] = []
    const router = createMockRouter({
      invokeForTenant: async (...args: unknown[]) => {
        capturedArgs = args
        return createMockResult()
      },
    })
    const tenant = createMockTenant()
    const app = createTestApp(router, tenant)
    await app.request("/api/v1/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "my-agent", prompt: "test prompt" }),
    })
    expect(capturedArgs[0]).toBe("my-agent")
    expect(capturedArgs[1]).toBe("test prompt")
    expect(capturedArgs[2]).toBe(tenant)
    expect(capturedArgs[3]).toBe("invoke")
  })
})
