// tests/contract/arrakis-budget.test.ts — Arrakis Budget Contract Tests (Task 2.8)
//
// Validates arrakis budget & BYOK endpoints against loa-hounfour schema.
// Runs against the mock server by default. Set ARRAKIS_URL env var to run
// against real arrakis in CI/nightly.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { ArrakisMockServer, createTestMockServer } from "../mocks/arrakis-mock-server.js"

// --- Test setup ---

const ARRAKIS_URL = process.env.ARRAKIS_URL
const useMock = !ARRAKIS_URL

let mockServer: ArrakisMockServer | null = null
let baseUrl: string

// Minimal JWT for testing (not cryptographically signed — mock doesn't verify)
function makeTestJwt(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "s2s-key-1" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    iss: "loa-finn",
    aud: "arrakis",
    sub: "loa-finn-s2s",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })).toString("base64url")
  const signature = Buffer.from("mock-signature").toString("base64url")
  return `${header}.${payload}.${signature}`
}

function authHeaders(claims?: Record<string, unknown>): Record<string, string> {
  return { Authorization: `Bearer ${makeTestJwt(claims)}` }
}

beforeAll(async () => {
  if (useMock) {
    mockServer = createTestMockServer()
    const port = await mockServer.start()
    baseUrl = `http://localhost:${port}`
  } else {
    baseUrl = ARRAKIS_URL!
  }
})

afterAll(async () => {
  if (mockServer) {
    await mockServer.stop()
  }
})

// --- Budget endpoint contract ---

describe("GET /api/v1/budget/:tenant_id", () => {
  it("returns budget with string micro-USD values", async () => {
    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()

    // Schema validation: all micro-USD fields must be string integers
    expect(typeof body.committed_micro).toBe("string")
    expect(typeof body.reserved_micro).toBe("string")
    expect(typeof body.limit_micro).toBe("string")
    expect(/^[0-9]+$/.test(body.committed_micro)).toBe(true)
    expect(/^[0-9]+$/.test(body.reserved_micro)).toBe(true)
    expect(/^[0-9]+$/.test(body.limit_micro)).toBe(true)

    // Window fields must be ISO 8601 timestamps
    expect(typeof body.window_start).toBe("string")
    expect(typeof body.window_end).toBe("string")
    expect(() => new Date(body.window_start)).not.toThrow()
    expect(() => new Date(body.window_end)).not.toThrow()
  })

  it("returns 404 for unknown tenant", async () => {
    const res = await fetch(`${baseUrl}/api/v1/budget/nonexistent-tenant`, {
      headers: authHeaders(),
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("tenant_not_found")
  })

  it("returns 401 without auth header", async () => {
    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`)

    expect(res.status).toBe(401)
  })

  it("returns 401 with malformed token", async () => {
    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: { Authorization: "Bearer not-a-jwt" },
    })

    expect(res.status).toBe(401)
  })

  it("returns 403 with wrong audience", async () => {
    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders({ aud: "wrong-audience" }),
    })

    expect(res.status).toBe(403)
  })

  it("returns 403 with disallowed issuer", async () => {
    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders({ iss: "evil-service" }),
    })

    expect(res.status).toBe(403)
  })

  it("budget values are within reasonable ranges", async () => {
    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders(),
    })

    const body = await res.json()
    const committed = parseInt(body.committed_micro, 10)
    const reserved = parseInt(body.reserved_micro, 10)
    const limit = parseInt(body.limit_micro, 10)

    // Committed + reserved should not exceed limit (in normal state)
    expect(committed + reserved).toBeLessThanOrEqual(limit)
    // All values non-negative
    expect(committed).toBeGreaterThanOrEqual(0)
    expect(reserved).toBeGreaterThanOrEqual(0)
    expect(limit).toBeGreaterThan(0)
  })
})

// --- BYOK session contract ---

describe("POST /api/v1/byok/session", () => {
  it("creates a BYOK session and returns session_id + proxy_url", async () => {
    const res = await fetch(`${baseUrl}/api/v1/byok/session`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenant_id: "tenant-abc",
        provider: "openai",
        model: "gpt-4o",
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()

    expect(typeof body.session_id).toBe("string")
    expect(body.session_id.length).toBeGreaterThan(0)
    expect(typeof body.expires_at).toBe("string")
    expect(typeof body.proxy_url).toBe("string")
    expect(body.proxy_url).toContain("/api/v1/byok/proxy")
  })
})

describe("POST /api/v1/byok/proxy", () => {
  it("proxies request for valid session", async () => {
    // Create session first
    const createRes = await fetch(`${baseUrl}/api/v1/byok/session`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: "t", provider: "openai", model: "gpt-4o" }),
    })
    const session = await createRes.json()

    // Proxy request
    const res = await fetch(`${baseUrl}/api/v1/byok/proxy`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: session.session_id }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("proxied")
    expect(body.session_id).toBe(session.session_id)
  })

  it("returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/api/v1/byok/proxy`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "nonexistent" }),
    })

    expect(res.status).toBe(404)
  })

  it("returns 400 for missing session_id", async () => {
    const res = await fetch(`${baseUrl}/api/v1/byok/proxy`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})

// --- Failure mode tests (mock only) ---

describe("scripted failure modes", { skip: !useMock }, () => {
  it("simulates 500 error", async () => {
    mockServer!.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "error_500",
    })

    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders(),
    })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("internal_error")

    mockServer!.clearFailureModes()
  })

  it("simulates timeout", async () => {
    mockServer!.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "timeout",
      delayMs: 100, // Short for tests
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 200)

    try {
      const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
        headers: authHeaders(),
        signal: controller.signal,
      })
      // If we got a response before abort, check it's the timeout response
      expect(res.status).toBe(504)
    } catch (err: any) {
      // AbortError is also acceptable (client-side timeout)
      expect(err.name).toBe("AbortError")
    } finally {
      clearTimeout(timeout)
      mockServer!.clearFailureModes()
    }
  })

  it("simulates stale data (old window_end)", async () => {
    mockServer!.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "stale_data",
    })

    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()

    // window_end should be in the past (stale)
    const windowEnd = new Date(body.window_end)
    expect(windowEnd.getTime()).toBeLessThan(Date.now())

    mockServer!.clearFailureModes()
  })

  it("simulates drift (mismatched committed_micro)", async () => {
    mockServer!.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "drift",
      driftMicro: "999999",
    })

    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.committed_micro).toBe("999999")

    mockServer!.clearFailureModes()
  })

  it("simulates rate limiting", async () => {
    mockServer!.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "rate_limit",
    })

    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, {
      headers: authHeaders(),
    })

    expect(res.status).toBe(429)

    mockServer!.clearFailureModes()
  })

  it("failure mode triggers after N requests", async () => {
    mockServer!.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "error_500",
      triggerAfter: 2, // First 2 succeed, then fails
    })

    // First 2 should succeed
    const res1 = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, { headers: authHeaders() })
    const res2 = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, { headers: authHeaders() })
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    // 3rd should fail
    const res3 = await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, { headers: authHeaders() })
    expect(res3.status).toBe(500)

    mockServer!.clearFailureModes()
  })

  it("request log tracks all requests", async () => {
    mockServer!.clearRequestLog()

    await fetch(`${baseUrl}/api/v1/budget/tenant-abc`, { headers: authHeaders() })
    await fetch(`${baseUrl}/api/v1/budget/tenant-xyz`, { headers: authHeaders() })

    expect(mockServer!.requestLog).toHaveLength(2)
    expect(mockServer!.requestLog[0].path).toBe("/api/v1/budget/tenant-abc")
    expect(mockServer!.requestLog[1].path).toBe("/api/v1/budget/tenant-xyz")
    expect(mockServer!.requestLog[0].headers["authorization"]).toBeDefined()
  })

  it("setTenantBudget dynamically updates state", async () => {
    mockServer!.setTenantBudget("tenant-dynamic", {
      committed_micro: "42000",
      reserved_micro: "0",
      limit_micro: "1000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })

    const res = await fetch(`${baseUrl}/api/v1/budget/tenant-dynamic`, {
      headers: authHeaders(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.committed_micro).toBe("42000")
  })
})

// --- Health endpoint ---

describe("GET /health", () => {
  it("returns health status without auth", async () => {
    const res = await fetch(`${baseUrl}/health`)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
  })
})
