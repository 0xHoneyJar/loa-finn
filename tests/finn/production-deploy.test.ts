// tests/finn/production-deploy.test.ts — Sprint 7 Tasks 7.3, 7.5, 7.6, 7.7 Test Suite

import { describe, it, expect, vi, beforeEach } from "vitest"
import { metrics, metricsRoutes } from "../../src/gateway/metrics-endpoint.js"
import { JWKSService, jwksRoutes } from "../../src/gateway/jwks.js"
import { WALWriterLock } from "../../src/billing/wal-writer-lock.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient & { evalResults: unknown[] } {
  const store = new Map<string, string>()
  const evalResults: unknown[] = []

  return {
    evalResults,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    incrby: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    eval: vi.fn(async () => evalResults.shift() ?? null),
    hgetall: vi.fn(async () => null),
  } as unknown as RedisCommandClient & { evalResults: unknown[] }
}

// ---------------------------------------------------------------------------
// 1. Prometheus Metrics Endpoint
// ---------------------------------------------------------------------------

describe("Prometheus metrics endpoint", () => {
  it("serves Prometheus exposition format", async () => {
    const app = metricsRoutes()
    const resp = await app.request("/")
    expect(resp.status).toBe(200)
    expect(resp.headers.get("content-type")).toContain("text/plain")

    const body = await resp.text()
    expect(body).toContain("# HELP")
    expect(body).toContain("# TYPE")
    expect(body).toContain("loa_finn_http_requests_total")
  })

  it("increments counter and reflects in output", async () => {
    metrics.incrementCounter("loa_finn_http_requests_total", { method: "GET", status: "200" })
    metrics.incrementCounter("loa_finn_http_requests_total", { method: "GET", status: "200" })

    const app = metricsRoutes()
    const resp = await app.request("/")
    const body = await resp.text()
    expect(body).toContain('loa_finn_http_requests_total{method="GET",status="200"} 2')
  })

  it("sets gauge value", async () => {
    metrics.setGauge("loa_finn_ws_connections_active", {}, 5)

    const app = metricsRoutes()
    const resp = await app.request("/")
    const body = await resp.text()
    expect(body).toContain("loa_finn_ws_connections_active 5")
  })

  it("includes conservation guard metrics", async () => {
    const app = metricsRoutes()
    const resp = await app.request("/")
    const body = await resp.text()
    expect(body).toContain("loa_finn_conservation_guard_checks_total")
    expect(body).toContain("loa_finn_conservation_guard_state")
  })

  it("includes billing and x402 metrics", async () => {
    const app = metricsRoutes()
    const resp = await app.request("/")
    const body = await resp.text()
    expect(body).toContain("loa_finn_billing_events_total")
    expect(body).toContain("loa_finn_x402_quotes_total")
  })
})

// ---------------------------------------------------------------------------
// 2. JWKS Endpoint
// ---------------------------------------------------------------------------

describe("JWKS endpoint", () => {
  it("returns JWK set from provider", async () => {
    const mockKeys = [{
      kty: "RSA",
      kid: "key-1",
      use: "sig",
      alg: "RS256",
      n: "test-modulus",
      e: "AQAB",
    }]

    const service = new JWKSService({
      getPublicKeys: async () => mockKeys,
    })

    const app = jwksRoutes(service)
    const resp = await app.request("/")
    expect(resp.status).toBe(200)

    const body = await resp.json()
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0].kid).toBe("key-1")
    expect(body.keys[0].alg).toBe("RS256")
  })

  it("caches JWKS response", async () => {
    let callCount = 0
    const service = new JWKSService({
      getPublicKeys: async () => {
        callCount++
        return [{ kty: "RSA", kid: "key-1", use: "sig", alg: "RS256" }]
      },
      cacheTtlMs: 60_000,
    })

    await service.getJWKS()
    await service.getJWKS()
    await service.getJWKS()

    expect(callCount).toBe(1) // Only called once, rest from cache
  })

  it("cache invalidation forces refresh", async () => {
    let callCount = 0
    const service = new JWKSService({
      getPublicKeys: async () => {
        callCount++
        return [{ kty: "RSA", kid: `key-${callCount}`, use: "sig", alg: "RS256" }]
      },
    })

    const first = await service.getJWKS()
    expect(first.keys[0].kid).toBe("key-1")

    service.invalidateCache()
    const second = await service.getJWKS()
    expect(second.keys[0].kid).toBe("key-2")
    expect(callCount).toBe(2)
  })

  it("sets cache-control header", async () => {
    const service = new JWKSService({
      getPublicKeys: async () => [],
    })

    const app = jwksRoutes(service)
    const resp = await app.request("/")
    expect(resp.headers.get("cache-control")).toContain("max-age=300")
  })

  it("handles provider error gracefully", async () => {
    const service = new JWKSService({
      getPublicKeys: async () => { throw new Error("KMS unavailable") },
    })

    const app = jwksRoutes(service)
    const resp = await app.request("/")
    expect(resp.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// 3. WAL Writer Lock
// ---------------------------------------------------------------------------

describe("WALWriterLock", () => {
  it("acquires lock with fencing token", async () => {
    const redis = createMockRedis()
    redis.evalResults.push([1, 1]) // acquired, fencing token 1

    const lock = new WALWriterLock({
      redis,
      instanceId: "task-001",
    })

    const result = await lock.acquire()
    expect(result.acquired).toBe(true)
    expect(result.fencingToken).toBe(1)
    expect(lock.isHolder).toBe(true)

    // Clean up keepalive
    await lock.release()
  })

  it("rejects second writer", async () => {
    const redis = createMockRedis()
    redis.evalResults.push([0, "task-001"]) // not acquired, held by task-001

    const lock = new WALWriterLock({
      redis,
      instanceId: "task-002",
    })

    const result = await lock.acquire()
    expect(result.acquired).toBe(false)
    expect(result.fencingToken).toBeNull()
    expect(result.currentHolder).toBe("task-001")
    expect(lock.isHolder).toBe(false)
  })

  it("releases lock on graceful shutdown", async () => {
    const redis = createMockRedis()
    redis.evalResults.push([1, 1]) // acquire success

    const lock = new WALWriterLock({
      redis,
      instanceId: "task-001",
    })

    await lock.acquire()
    expect(lock.isHolder).toBe(true)

    redis.evalResults.push(1) // release success
    await lock.release()
    expect(lock.isHolder).toBe(false)
    expect(lock.fencingToken).toBeNull()
  })

  it("validates fencing token", async () => {
    const redis = createMockRedis()
    redis.evalResults.push([1, 42]) // acquired with token 42

    const lock = new WALWriterLock({
      redis,
      instanceId: "task-001",
    })

    await lock.acquire()
    expect(await lock.validateFencingToken(42)).toBe(true)
    expect(await lock.validateFencingToken(41)).toBe(false) // stale token

    await lock.release()
  })

  it("calls onLockLost when lock is stolen", async () => {
    const redis = createMockRedis()
    redis.evalResults.push([1, 1]) // acquire success

    let lostCalled = false
    const lock = new WALWriterLock({
      redis,
      instanceId: "task-001",
      onLockLost: () => { lostCalled = true },
    })

    await lock.acquire()
    expect(lock.isHolder).toBe(true)

    // Simulate keepalive finding lock lost
    redis.evalResults.push(0) // keepalive finds lock gone

    // Wait for keepalive interval
    await new Promise((r) => setTimeout(r, 11_000))

    expect(lock.isHolder).toBe(false)
    expect(lostCalled).toBe(true)
  }, 15_000) // 15s timeout for keepalive test
})

// ---------------------------------------------------------------------------
// 4. Module Exports
// ---------------------------------------------------------------------------

describe("Sprint 7 module exports", () => {
  it("metrics-endpoint exports", async () => {
    const mod = await import("../../src/gateway/metrics-endpoint.js")
    expect(mod.metrics).toBeDefined()
    expect(mod.metricsRoutes).toBeDefined()
  })

  it("jwks exports", async () => {
    const mod = await import("../../src/gateway/jwks.js")
    expect(mod.JWKSService).toBeDefined()
    expect(mod.jwksRoutes).toBeDefined()
  })

  it("wal-writer-lock exports", async () => {
    const mod = await import("../../src/billing/wal-writer-lock.js")
    expect(mod.WALWriterLock).toBeDefined()
  })
})
