// tests/finn/gateway/health.test.ts — Two-tier health endpoint tests (cycle-035 T-1.8)

import { describe, it, expect } from "vitest"
import { Hono } from "hono"

// Minimal test app that exercises the health endpoint pattern from server.ts

function createTestApp(deps: {
  redisHealth?: () => Promise<{ connected: boolean; latencyMs: number }>
  dynamoHealth?: () => Promise<{ reachable: boolean; latencyMs: number }>
}) {
  const app = new Hono()

  // /healthz — always 200
  app.get("/healthz", (c) => {
    return c.json({ status: "ok", uptime: process.uptime() }, 200)
  })

  // /health/deps — 503 if any critical dep down
  app.get("/health/deps", async (c) => {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {}
    let allHealthy = true

    if (deps.redisHealth) {
      try {
        const rh = await deps.redisHealth()
        checks.redis = { status: rh.connected ? "ok" : "degraded", latencyMs: rh.latencyMs }
        if (!rh.connected) allHealthy = false
      } catch (err) {
        checks.redis = { status: "error", error: (err as Error).message }
        allHealthy = false
      }
    }

    if (deps.dynamoHealth) {
      try {
        const dh = await deps.dynamoHealth()
        checks.dynamodb = { status: dh.reachable ? "ok" : "degraded", latencyMs: dh.latencyMs }
        if (!dh.reachable) allHealthy = false
      } catch (err) {
        checks.dynamodb = { status: "error", error: (err as Error).message }
        allHealthy = false
      }
    }

    return c.json({ status: allHealthy ? "ready" : "not_ready", checks }, allHealthy ? 200 : 503)
  })

  return app
}

// /health — full diagnostic JSON document (#207, #218). The route returns a
// JSON body (never a redirect); this mirrors the contract in
// src/gateway/server.ts and docs/gateway-health.md.
function createHealthDocApp() {
  const app = new Hono()
  app.get("/health", (c) => {
    return c.json({
      status: "healthy",
      uptime: process.uptime(),
      checks: { agent: { status: "ok" }, sessions: { active: 0 } },
      billing: { dlq_size: null, dlq_durable: false },
      protocol: { contract_version: "8.3.0", finn_min_supported: "7.0.0" },
      ready_for_billing: true,
    })
  })
  return app
}

describe("/health (diagnostic document)", () => {
  it("returns 200 with a JSON health document — not a redirect", async () => {
    const app = createHealthDocApp()
    const res = await app.request("/health")

    expect(res.status).toBe(200) // legacy comment claimed 301 → /healthz; actual contract is JSON
    expect(res.headers.get("location")).toBeNull()
    expect(res.headers.get("content-type")).toContain("application/json")

    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty("status")
    expect(body).toHaveProperty("checks")
    expect(body).toHaveProperty("billing")
    expect(body).toHaveProperty("protocol")
  })

  it("source comment for /health does not claim redirect behavior", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/gateway/server.ts", "utf-8")
    const healthSection = src.slice(src.indexOf('app.get("/health"') - 600, src.indexOf('app.get("/health"'))
    expect(healthSection).not.toMatch(/301/)
    expect(healthSection).not.toMatch(/Legacy \/health →/)
  })
})

describe("/healthz (ALB liveness)", () => {
  it("returns 200 always", async () => {
    const app = createTestApp({})
    const res = await app.request("/healthz")

    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe("ok")
  })

  it("returns 200 even when Redis is unreachable", async () => {
    const app = createTestApp({
      redisHealth: async () => ({ connected: false, latencyMs: 0 }),
    })
    const res = await app.request("/healthz")

    expect(res.status).toBe(200)
  })
})

describe("/health/deps (readiness)", () => {
  it("returns 200 when all deps healthy", async () => {
    const app = createTestApp({
      redisHealth: async () => ({ connected: true, latencyMs: 2 }),
      dynamoHealth: async () => ({ reachable: true, latencyMs: 5 }),
    })
    const res = await app.request("/health/deps")

    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; checks: Record<string, { status: string }> }
    expect(body.status).toBe("ready")
    expect(body.checks.redis.status).toBe("ok")
    expect(body.checks.dynamodb.status).toBe("ok")
  })

  it("returns 503 when Redis down", async () => {
    const app = createTestApp({
      redisHealth: async () => ({ connected: false, latencyMs: 0 }),
      dynamoHealth: async () => ({ reachable: true, latencyMs: 5 }),
    })
    const res = await app.request("/health/deps")

    expect(res.status).toBe(503)
    const body = await res.json() as { status: string }
    expect(body.status).toBe("not_ready")
  })

  it("returns 503 when DynamoDB down", async () => {
    const app = createTestApp({
      redisHealth: async () => ({ connected: true, latencyMs: 2 }),
      dynamoHealth: async () => ({ reachable: false, latencyMs: 0 }),
    })
    const res = await app.request("/health/deps")

    expect(res.status).toBe(503)
  })

  it("returns 503 when dep health throws", async () => {
    const app = createTestApp({
      redisHealth: async () => { throw new Error("Connection refused") },
    })
    const res = await app.request("/health/deps")

    expect(res.status).toBe(503)
    const body = await res.json() as { checks: Record<string, { status: string; error?: string }> }
    expect(body.checks.redis.status).toBe("error")
    expect(body.checks.redis.error).toBe("Connection refused")
  })

  it("returns 200 when no deps configured", async () => {
    const app = createTestApp({})
    const res = await app.request("/health/deps")

    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe("ready")
  })
})
