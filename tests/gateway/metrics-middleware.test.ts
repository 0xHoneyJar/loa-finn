// tests/gateway/metrics-middleware.test.ts — Metrics Middleware Tests (Sprint 6 T6.3, T6.4)

import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { metricsMiddleware } from "../../src/gateway/metrics-middleware.js"
import { metrics } from "../../src/gateway/metrics-endpoint.js"

// ---------------------------------------------------------------------------
// Helper: create test app with metrics middleware
// ---------------------------------------------------------------------------

function createTestApp(): Hono {
  const app = new Hono()
  app.use("*", metricsMiddleware())
  app.get("/health", (c) => c.json({ status: "ok" }))
  app.post("/api/v1/invoke", (c) => c.json({ response: "hello" }))
  app.get("/api/v1/keys/:key_id/balance", (c) => c.json({ balance: 100 }))
  app.get("/agent/:tokenId", (c) => c.json({ agent: c.req.param("tokenId") }))
  app.get("/error", (c) => c.json({ error: "not found" }, 404))
  app.get("/server-error", (c) => c.json({ error: "internal" }, 500))
  return app
}

// ---------------------------------------------------------------------------
// T6.3 + T6.4: Request metrics middleware
// ---------------------------------------------------------------------------

describe("T6.3 + T6.4: metricsMiddleware", () => {
  it("records request counter on successful GET", async () => {
    const app = createTestApp()
    const res = await app.request("/health")
    expect(res.status).toBe(200)

    const output = metrics.serialize()
    expect(output).toContain("finn_http_requests_total")
  })

  it("records request counter on POST", async () => {
    const app = createTestApp()
    const res = await app.request("/api/v1/invoke", { method: "POST" })
    expect(res.status).toBe(200)

    const output = metrics.serialize()
    expect(output).toContain("finn_http_requests_total")
  })

  it("records error counter on 4xx", async () => {
    const app = createTestApp()
    const res = await app.request("/error")
    expect(res.status).toBe(404)

    const output = metrics.serialize()
    expect(output).toContain("finn_http_errors_total")
  })

  it("records error counter on 5xx", async () => {
    const app = createTestApp()
    const res = await app.request("/server-error")
    expect(res.status).toBe(500)

    const output = metrics.serialize()
    expect(output).toContain("finn_http_errors_total")
  })

  it("records request duration histogram", async () => {
    const app = createTestApp()
    await app.request("/health")

    const output = metrics.serialize()
    expect(output).toContain("finn_request_duration_seconds_bucket")
    expect(output).toContain("finn_request_duration_seconds_sum")
    expect(output).toContain("finn_request_duration_seconds_count")
  })

  it("normalizes parameterized routes to prevent cardinality explosion", async () => {
    const app = createTestApp()
    await app.request("/api/v1/keys/key-abc123/balance")
    await app.request("/agent/42")

    const output = metrics.serialize()
    // Should use normalized route, not the actual tokenId/keyId
    expect(output).toContain('route="/api/v1/keys/:key_id/balance"')
    expect(output).toContain('route="/agent/:tokenId"')
    // Should NOT contain actual parameter values
    expect(output).not.toContain('route="/api/v1/keys/key-abc123/balance"')
    expect(output).not.toContain('route="/agent/42"')
  })
})
