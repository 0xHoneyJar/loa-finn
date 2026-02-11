// tests/finn/jwt-integration.test.ts — Sprint A Integration Tests (T-A.10)
// E2E test suite covering JWT → routing → budget → abort → usage report flow.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { createHash } from "node:crypto"
import { Hono } from "hono"
import { exportPKCS8 } from "jose"
import { startMockArrakis } from "../fixtures/mock-arrakis-server.js"
import type { MockArrakisServer } from "../fixtures/mock-arrakis-server.js"
import { jwtAuthMiddleware, reqHashMiddleware, resetJWKSCache } from "../../src/hounfour/jwt-auth.js"
import { PoolRegistry, DEFAULT_POOLS } from "../../src/hounfour/pool-registry.js"
import { calculateCostMicro, calculateTotalCostMicro, RemainderAccumulator } from "../../src/hounfour/pricing.js"
import { InMemoryJtiReplayGuard } from "../../src/hounfour/jti-replay.js"
import { IdempotencyCache } from "../../src/hounfour/idempotency.js"
import { S2SJwtSigner } from "../../src/hounfour/s2s-jwt.js"
import { UsageReporter } from "../../src/hounfour/usage-reporter.js"
import { authMiddleware } from "../../src/gateway/auth.js"
import type { FinnConfig } from "../../src/config.js"

let arrakis: MockArrakisServer

function mockConfig(): FinnConfig {
  return {
    auth: {
      bearerToken: "test-bearer-token",
      corsOrigins: ["*"],
      rateLimiting: { windowMs: 60000, maxRequestsPerWindow: 100 },
    },
    jwt: {
      enabled: true,
      issuer: "arrakis",
      audience: "loa-finn",
      jwksUrl: arrakis.jwksUrl,
      clockSkewSeconds: 30,
      maxTokenLifetimeSeconds: 3600,
    },
  } as FinnConfig
}

function sha256(data: string): string {
  return createHash("sha256").update(Buffer.from(data, "utf-8")).digest("hex")
}

describe("Sprint A Integration (T-A.10)", () => {
  beforeAll(async () => {
    arrakis = await startMockArrakis()
  })

  afterAll(() => {
    arrakis.close()
  })

  beforeEach(() => {
    resetJWKSCache()
  })

  // --- E2E JWT Roundtrip: sign → validate → extract → route ---

  describe("JWT roundtrip → pool routing", () => {
    function createApp(): Hono {
      const config = mockConfig()
      const app = new Hono()

      app.use("/api/v1/*", jwtAuthMiddleware(config))
      app.use("/api/v1/*", reqHashMiddleware())

      // Bearer auth on /api/* excluding /api/v1/*
      app.use("/api/*", async (c, next) => {
        if (c.req.path.startsWith("/api/v1/")) return next()
        return authMiddleware(config)(c, next)
      })

      app.post("/api/v1/chat", (c) => {
        const tenant = c.get("tenant")
        const registry = new PoolRegistry(DEFAULT_POOLS)
        const authorized = registry.authorize("fast-code", tenant.claims.tier)
        const pool = authorized ? registry.resolve("fast-code") : null
        return c.json({
          tenant_id: tenant.claims.tenant_id,
          tier: tenant.claims.tier,
          pool: pool?.id ?? null,
          model: pool?.model ?? null,
        })
      })

      app.get("/api/status", (c) => {
        return c.json({ source: "bearer" })
      })

      return app
    }

    it("full flow: sign JWT → validate → extract claims → resolve pool", async () => {
      const app = createApp()
      const body = JSON.stringify({ text: "hello integration" })
      const bodyHash = sha256(body)

      const token = await arrakis.signJWT({
        iss: "arrakis",
        aud: "loa-finn",
        sub: "user:discord:456",
        tenant_id: "community:thj",
        tier: "pro",
        req_hash: `sha256:${bodyHash}`,
      })

      const res = await app.request("/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.tenant_id).toBe("community:thj")
      expect(json.tier).toBe("pro")
      expect(json.pool).toBe("fast-code")
      expect(json.model).toBeTruthy()
    })

    it("req_hash: hash body → embed in JWT → verify on receive", async () => {
      const app = createApp()
      const body = JSON.stringify({ text: "hashed body" })
      const bodyHash = sha256(body)

      const token = await arrakis.signJWT({
        iss: "arrakis",
        aud: "loa-finn",
        sub: "user:discord:789",
        tenant_id: "community:thj",
        tier: "pro",
        req_hash: `sha256:${bodyHash}`,
      })

      const res = await app.request("/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      })
      expect(res.status).toBe(200)
    })

    it("req_hash: wrong hash → 400 mismatch", async () => {
      const app = createApp()
      const body = JSON.stringify({ text: "tampered" })

      const token = await arrakis.signJWT({
        iss: "arrakis",
        aud: "loa-finn",
        sub: "user:discord:789",
        tenant_id: "community:thj",
        tier: "pro",
        req_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      })

      const res = await app.request("/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe("req_hash_mismatch")
    })

    it("req_hash: empty body verifies correctly", async () => {
      const app = createApp()
      const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

      const token = await arrakis.signJWT({
        iss: "arrakis",
        aud: "loa-finn",
        sub: "user:discord:789",
        tenant_id: "community:thj",
        tier: "pro",
        req_hash: `sha256:${emptyHash}`,
      })

      const res = await app.request("/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "",
      })
      expect(res.status).toBe(200)
    })

    it("route separation: JWT on /api/v1/* works", async () => {
      const app = createApp()
      const body = JSON.stringify({ text: "v1" })
      const token = await arrakis.signJWT({
        iss: "arrakis",
        aud: "loa-finn",
        sub: "user:discord:1",
        tenant_id: "community:thj",
        tier: "pro",
        req_hash: `sha256:${sha256(body)}`,
      })

      const res = await app.request("/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      })
      expect(res.status).toBe(200)
    })

    it("route separation: bearer on /api/* works", async () => {
      const app = createApp()
      const res = await app.request("/api/status", {
        headers: { Authorization: "Bearer test-bearer-token" },
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.source).toBe("bearer")
    })

    it("route separation: mixing JWT on /api/* → 401", async () => {
      const app = createApp()
      const token = await arrakis.signJWT({
        iss: "arrakis",
        aud: "loa-finn",
        sub: "user:discord:1",
        tenant_id: "community:thj",
        tier: "pro",
        req_hash: "sha256:abc",
      })

      const res = await app.request("/api/status", {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(401)
    })

    it("route separation: bearer on /api/v1/* → 401", async () => {
      const app = createApp()
      const res = await app.request("/api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-bearer-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
      expect(res.status).toBe(401)
    })
  })

  // --- Tier → Pool Authorization ---

  describe("tier → pool authorization", () => {
    const registry = new PoolRegistry(DEFAULT_POOLS)

    it("free → cheap only", () => {
      expect(registry.authorize("cheap", "free")).toBe(true)
      expect(registry.authorize("fast-code", "free")).toBe(false)
      expect(registry.authorize("reviewer", "free")).toBe(false)
      expect(registry.authorize("reasoning", "free")).toBe(false)
      expect(registry.authorize("architect", "free")).toBe(false)
    })

    it("pro → cheap, fast-code, reviewer", () => {
      expect(registry.authorize("cheap", "pro")).toBe(true)
      expect(registry.authorize("fast-code", "pro")).toBe(true)
      expect(registry.authorize("reviewer", "pro")).toBe(true)
      expect(registry.authorize("reasoning", "pro")).toBe(false)
      expect(registry.authorize("architect", "pro")).toBe(false)
    })

    it("enterprise → all pools", () => {
      expect(registry.authorize("cheap", "enterprise")).toBe(true)
      expect(registry.authorize("fast-code", "enterprise")).toBe(true)
      expect(registry.authorize("reviewer", "enterprise")).toBe(true)
      expect(registry.authorize("reasoning", "enterprise")).toBe(true)
      expect(registry.authorize("architect", "enterprise")).toBe(true)
    })

    it("unknown pool → false", () => {
      expect(registry.authorize("nonexistent", "enterprise")).toBe(false)
    })
  })

  // --- Budget: Deterministic + Randomized ---

  describe("budget deterministic + randomized", () => {
    it("BigInt oracle: calculateCostMicro matches BigInt reference", () => {
      const testCases = [
        { tokens: 1000, price: 3000 },
        { tokens: 500, price: 15000 },
        { tokens: 1, price: 1 },
        { tokens: 999999, price: 999999 },
        { tokens: 0, price: 5000 },
      ]

      for (const { tokens, price } of testCases) {
        const result = calculateCostMicro(tokens, price)
        const bigIntCost = Number((BigInt(tokens) * BigInt(price)) / BigInt(1_000_000))
        const bigIntRemainder = Number((BigInt(tokens) * BigInt(price)) % BigInt(1_000_000))
        expect(result.cost_micro).toBe(bigIntCost)
        expect(result.remainder_micro).toBe(bigIntRemainder)
      }
    })

    it("randomized 10k requests: drift ≤ max(1 micro, 0.1% of total)", () => {
      const accumulator = new RemainderAccumulator()
      let totalCostJs = 0

      // BigInt reference with its own remainder carry for apples-to-apples comparison
      let totalCostBigInt = 0n
      let bigIntRemainder = 0n

      for (let i = 0; i < 10_000; i++) {
        const tokens = Math.floor(Math.random() * 10000)
        const price = Math.floor(Math.random() * 100000)

        // JS path with RemainderAccumulator
        const result = calculateCostMicro(tokens, price)
        totalCostJs += result.cost_micro + accumulator.carry("test", result.remainder_micro)

        // BigInt path with equivalent remainder carry
        const product = BigInt(tokens) * BigInt(price)
        totalCostBigInt += product / BigInt(1_000_000)
        bigIntRemainder += product % BigInt(1_000_000)
        totalCostBigInt += bigIntRemainder / BigInt(1_000_000)
        bigIntRemainder = bigIntRemainder % BigInt(1_000_000)
      }

      const drift = Math.abs(totalCostJs - Number(totalCostBigInt))
      const threshold = Math.max(1, Number(totalCostBigInt) * 0.001)
      expect(drift).toBeLessThanOrEqual(threshold)
    })
  })

  // --- LRU Eviction ---

  describe("LRU eviction", () => {
    it("insert 10001 → size = 10000", async () => {
      const cache = new IdempotencyCache(120_000, 10_000)
      for (let i = 0; i < 10_001; i++) {
        await cache.set(`trace-${i}`, "tool", {}, { output: `result-${i}`, is_error: false })
      }
      expect(cache.size).toBe(10_000)
      // First entry should be evicted
      const first = await cache.get("trace-0", "tool", {})
      expect(first).toBeNull()
      // Last entry should exist
      const last = await cache.get("trace-10000", "tool", {})
      expect(last).toBeTruthy()
      cache.destroy()
    })
  })

  // --- JTI Replay Protection ---

  describe("JTI replay protection", () => {
    it("first jti → allowed, duplicate jti → rejected", async () => {
      const guard = new InMemoryJtiReplayGuard()
      expect(await guard.checkAndStore("jti-integration-1", 60)).toBe(false)
      expect(await guard.checkAndStore("jti-integration-1", 60)).toBe(true)
      guard.dispose()
    })
  })

  // --- Usage Report Pipeline ---

  describe("usage report pipeline", () => {
    let s2sSigner: S2SJwtSigner

    beforeAll(async () => {
      s2sSigner = new S2SJwtSigner({
        privateKeyPem: arrakis.privateKeyPem,
        kid: "finn-test-v1",
        issuer: "loa-finn",
        audience: "arrakis",
      })
      await s2sSigner.init()
    })

    it("delivers usage report with S2S JWT auth + JWS payload", async () => {
      const reporter = new UsageReporter(s2sSigner, null, {
        arrakisBaseUrl: `http://localhost:${arrakis.port}`,
      })

      const result = await reporter.report({
        report_id: "int-report-1",
        tenant_id: "community:thj",
        original_jti: "user-jti-abc",
        pool_id: "fast-code",
        model: "qwen3-coder-next",
        input_tokens: 1000,
        output_tokens: 500,
        cost_micro: 150,
        timestamp: new Date().toISOString(),
      })

      expect(result.delivered).toBe(true)
      expect(arrakis.state.usageReports.has("int-report-1")).toBe(true)

      reporter.destroy()
    })

    it("idempotency: duplicate report_id → 200 (no error)", async () => {
      const reporter = new UsageReporter(s2sSigner, null, {
        arrakisBaseUrl: `http://localhost:${arrakis.port}`,
      })

      const report = {
        report_id: "int-dup-1",
        tenant_id: "community:thj",
        pool_id: "fast-code",
        model: "qwen3-coder-next",
        input_tokens: 1000,
        output_tokens: 500,
        cost_micro: 150,
        timestamp: new Date().toISOString(),
      }

      const r1 = await reporter.report(report)
      const r2 = await reporter.report(report)
      expect(r1.delivered).toBe(true)
      expect(r2.delivered).toBe(true) // Duplicate → 200, still "delivered"

      reporter.destroy()
    })

    it("dead-letter + replay: arrakis down → queue → arrakis up → replay delivers", async () => {
      // Make arrakis fail
      arrakis.state.usageFailsRemaining = 999

      // Create mock Redis
      const store = new Map<string, Map<string, number>>()
      const mockRedis = {
        isConnected: () => true,
        key: (_c: string, ..._p: string[]) => `finn:hounfour:${_c}:${_p.join(":")}`,
        getClient: () => ({
          zadd: async (key: string, score: number, member: string) => {
            if (!store.has(key)) store.set(key, new Map())
            store.get(key)!.set(member, score)
            return 1
          },
          zpopmin: async (key: string, count = 1) => {
            const zset = store.get(key)
            if (!zset || zset.size === 0) return []
            const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1])
            const result: string[] = []
            for (let i = 0; i < Math.min(count, sorted.length); i++) {
              result.push(sorted[i][0], String(sorted[i][1]))
              zset.delete(sorted[i][0])
            }
            return result
          },
          zcard: async (key: string) => store.get(key)?.size ?? 0,
        }),
      } as any

      const reporter = new UsageReporter(s2sSigner, mockRedis, {
        arrakisBaseUrl: `http://localhost:${arrakis.port}`,
        maxRetries: 0,
        baseDelayMs: 10,
      })

      // Report while arrakis is down
      const r1 = await reporter.report({
        report_id: "dl-report-1",
        tenant_id: "community:thj",
        pool_id: "fast-code",
        model: "qwen3-coder-next",
        input_tokens: 500,
        output_tokens: 200,
        cost_micro: 75,
        timestamp: new Date().toISOString(),
      })
      expect(r1.delivered).toBe(false)
      expect(r1.deadLettered).toBe(true)

      // Verify queued
      const dlSize = await reporter.deadLetterSize()
      expect(dlSize).toBe(1)

      // Make arrakis healthy again
      arrakis.state.usageFailsRemaining = 0

      // Replay
      const replay = await reporter.replayBatch()
      expect(replay.replayed).toBe(1)
      expect(replay.failed).toBe(0)
      expect(arrakis.state.usageReports.has("dl-report-1")).toBe(true)

      reporter.destroy()
    })
  })
})
