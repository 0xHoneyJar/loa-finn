// tests/finn/personality-v2-routes.test.ts — V2 Route Handler Tests (Sprint 4 Task 4.5)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { PersonalityService, registerPersonalityV2Routes } from "../../src/nft/personality.js"
import type { PersonalityServiceDeps, PersonalityV2Deps } from "../../src/nft/personality.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis (minimal key-value)
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient & { _store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    _store: store,
    async get(key: string) { return store.get(key) ?? null },
    async set(key: string, value: string) { store.set(key, value); return "OK" },
    async del(...keys: string[]) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n++
      return n
    },
    async incrby() { return 0 },
    async incrbyfloat() { return "0" },
    async expire() { return 1 },
    async exists() { return 0 },
    async ping() { return "PONG" },
    async eval() { return null },
    async hgetall() { return {} },
    async hincrby() { return 0 },
    async zadd() { return 1 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
  }
}

// ---------------------------------------------------------------------------
// Mock beauvoir-template
// ---------------------------------------------------------------------------

vi.mock("../../src/nft/beauvoir-template.js", () => ({
  generateBeauvoirMd: (name: string) => `# ${name}\n\nGenerated BEAUVOIR.md`,
  DEFAULT_BEAUVOIR_MD: "# Default\n",
}))

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

function createTestApp(): {
  app: Hono
  redis: ReturnType<typeof createMockRedis>
  service: PersonalityService
} {
  const redis = createMockRedis()
  const deps: PersonalityServiceDeps = {
    redis,
    walAppend: () => "wal-id",
  }
  const service = new PersonalityService(deps)

  const v2Deps: PersonalityV2Deps = {
    service,
    // No synthesizer provided — tests the guard behavior
  }

  const app = new Hono()
  registerPersonalityV2Routes(app, v2Deps)

  return { app, redis, service }
}

// ---------------------------------------------------------------------------
// Tests: 503 Pre-auth Guard
// ---------------------------------------------------------------------------

describe("V2 Routes — 503 Pre-auth Guard", () => {
  it("POST /personality/v2 returns 503 SERVICE_UNAVAILABLE", async () => {
    const { app } = createTestApp()

    const res = await app.request("/testcol/1/personality/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "TestAgent",
        voice: "analytical",
        expertise_domains: [],
        signals: { archetype: "freetekno" },
      }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("SERVICE_UNAVAILABLE")
    expect(body.error).toContain("governance not configured")
  })

  it("PUT /personality/v2 returns 503 SERVICE_UNAVAILABLE", async () => {
    const { app } = createTestApp()

    const res = await app.request("/testcol/1/personality/v2", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "UpdatedAgent",
      }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("SERVICE_UNAVAILABLE")
    expect(body.error).toContain("governance not configured")
  })

  it("POST /personality/synthesize returns 503 SERVICE_UNAVAILABLE", async () => {
    const { app } = createTestApp()

    const res = await app.request("/testcol/1/personality/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("SERVICE_UNAVAILABLE")
    expect(body.error).toContain("governance not configured")
  })
})

// ---------------------------------------------------------------------------
// Tests: Route Registration
// ---------------------------------------------------------------------------

describe("V2 Routes — Route Registration", () => {
  it("registerPersonalityV2Routes adds 3 routes", async () => {
    const { app } = createTestApp()

    // All three endpoints should respond (even if 503 guarded)
    const createRes = await app.request("/col/1/personality/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(createRes.status).toBe(503)

    const updateRes = await app.request("/col/1/personality/v2", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(updateRes.status).toBe(503)

    const synthRes = await app.request("/col/1/personality/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(synthRes.status).toBe(503)
  })

  it("unregistered routes return 404", async () => {
    const { app } = createTestApp()

    const res = await app.request("/col/1/personality/v3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: Guard blocks all write methods consistently
// ---------------------------------------------------------------------------

describe("V2 Routes — Guard Consistency", () => {
  it("all V2 write endpoints return identical 503 shape", async () => {
    const { app } = createTestApp()

    const endpoints = [
      { path: "/col/1/personality/v2", method: "POST" as const },
      { path: "/col/1/personality/v2", method: "PUT" as const },
      { path: "/col/1/personality/synthesize", method: "POST" as const },
    ]

    for (const endpoint of endpoints) {
      const res = await app.request(endpoint.path, {
        method: endpoint.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      })

      expect(res.status).toBe(503)
      const body = await res.json() as Record<string, unknown>
      expect(body).toHaveProperty("error")
      expect(body).toHaveProperty("code")
      expect(body.code).toBe("SERVICE_UNAVAILABLE")
    }
  })
})
