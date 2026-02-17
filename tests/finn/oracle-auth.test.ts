// tests/finn/oracle-auth.test.ts — Oracle auth middleware tests (Sprint 3 Task 3.7)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { oracleAuthMiddleware, extractClientIp, isValidIp } from "../../src/gateway/oracle-auth.js"
import type { OracleTenantContext } from "../../src/gateway/oracle-auth.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

function createMockRedis(overrides?: Partial<RedisCommandClient>): RedisCommandClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(1),
    incrbyfloat: vi.fn().mockResolvedValue("1"),
    expire: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    ping: vi.fn().mockResolvedValue("PONG"),
    eval: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue({}),
    hincrby: vi.fn().mockResolvedValue(1),
    zadd: vi.fn().mockResolvedValue(1),
    zpopmin: vi.fn().mockResolvedValue([]),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn().mockResolvedValue("OK"),
    ...overrides,
  }
}

function createTestApp(redis: RedisCommandClient, trustXff = true) {
  const app = new Hono()
  app.use("*", oracleAuthMiddleware(redis, { trustXff }))
  app.post("/", (c) => {
    const tenant = c.get("oracleTenant") as OracleTenantContext
    return c.json({
      tier: tenant.tier,
      identityType: tenant.identity.type,
    })
  })
  return app
}

describe("oracleAuthMiddleware", () => {
  let redis: RedisCommandClient

  beforeEach(() => {
    redis = createMockRedis()
  })

  it("should assign public tier when no Authorization header", async () => {
    const app = createTestApp(redis)
    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tier).toBe("public")
    expect(body.identityType).toBe("ip")
  })

  it("should assign authenticated tier for valid API key", async () => {
    redis = createMockRedis({
      hgetall: vi.fn().mockResolvedValue({
        status: "active",
        owner: "test-user",
        created_at: "2026-01-01T00:00:00Z",
        last_used_at: null,
      }),
    })
    const app = createTestApp(redis)

    const res = await app.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer dk_live_0123456789abcdef0123456789abcdef" },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tier).toBe("authenticated")
    expect(body.identityType).toBe("api_key")
  })

  it("should fall through to public tier for revoked key", async () => {
    redis = createMockRedis({
      hgetall: vi.fn().mockResolvedValue({
        status: "revoked",
        owner: "test-user",
      }),
    })
    const app = createTestApp(redis)

    const res = await app.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer dk_live_0123456789abcdef0123456789abcdef" },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tier).toBe("public")
  })

  it("should return 503 on Redis error with Authorization header (fail-closed)", async () => {
    redis = createMockRedis({
      hgetall: vi.fn().mockRejectedValue(new Error("Redis timeout")),
    })
    const app = createTestApp(redis)

    const res = await app.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer dk_live_0123456789abcdef0123456789abcdef" },
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe("AUTH_UNAVAILABLE")
  })

  it("should fall through to public for non-dk_ Bearer token", async () => {
    const app = createTestApp(redis)

    const res = await app.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer some-other-token" },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tier).toBe("public")
  })

  it("should accept dk_test_ prefix keys", async () => {
    redis = createMockRedis({
      hgetall: vi.fn().mockResolvedValue({ status: "active", owner: "tester" }),
    })
    const app = createTestApp(redis)

    const res = await app.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer dk_test_0123456789abcdef0123456789abcdef" },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tier).toBe("authenticated")
  })

  it("should produce a valid TenantContext from asTenant()", async () => {
    redis = createMockRedis({
      hgetall: vi.fn().mockResolvedValue({ status: "active", owner: "test" }),
    })
    const app = new Hono()
    app.use("*", oracleAuthMiddleware(redis, { trustXff: true }))
    app.post("/", (c) => {
      const tenant = c.get("oracleTenant") as OracleTenantContext
      const tc = tenant.asTenant()
      return c.json({
        tenant_id: tc.claims.tenant_id,
        tier: tc.claims.tier,
        resolvedPools: tc.resolvedPools,
        isNFTRouted: tc.isNFTRouted,
        isBYOK: tc.isBYOK,
      })
    })

    const res = await app.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer dk_live_0123456789abcdef0123456789abcdef" },
    })
    const body = await res.json()
    expect(body.tenant_id).toMatch(/^oracle:dk:/)
    expect(body.tier).toBe("free")
    expect(body.resolvedPools).toEqual(["cheap"])
    expect(body.isNFTRouted).toBe(false)
    expect(body.isBYOK).toBe(false)
  })
})

describe("isValidIp", () => {
  it("should accept valid IPv4", () => {
    expect(isValidIp("192.168.1.1")).toBe(true)
    expect(isValidIp("10.0.0.1")).toBe(true)
    expect(isValidIp("255.255.255.255")).toBe(true)
  })

  it("should accept valid IPv6", () => {
    expect(isValidIp("::1")).toBe(true)
    expect(isValidIp("2001:db8::1")).toBe(true)
    expect(isValidIp("fe80::1")).toBe(true)
  })

  it("should reject invalid values", () => {
    expect(isValidIp("not-an-ip")).toBe(false)
    expect(isValidIp("")).toBe(false)
    expect(isValidIp("1234")).toBe(false)
  })
})
