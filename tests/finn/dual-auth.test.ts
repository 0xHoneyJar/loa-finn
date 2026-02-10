// tests/finn/dual-auth.test.ts — Route-Based Dual Auth tests (T-A.2)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { Hono } from "hono"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { serve } from "@hono/node-server"
import { jwtAuthMiddleware, resetJWKSCache } from "../../src/hounfour/jwt-auth.js"
import { authMiddleware } from "../../src/gateway/auth.js"
import { InMemoryJtiReplayGuard } from "../../src/hounfour/jti-replay.js"
import type { FinnConfig } from "../../src/config.js"

let jwksServer: ReturnType<typeof serve>
let jwksPort: number
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>

async function startJWKSServer(): Promise<void> {
  keyPair = await generateKeyPair("ES256")
  const app = new Hono()
  app.get("/.well-known/jwks.json", async (c) => {
    const jwk = await exportJWK(keyPair.publicKey)
    jwk.kid = "key-1"
    jwk.alg = "ES256"
    jwk.use = "sig"
    return c.json({ keys: [jwk] })
  })
  return new Promise((resolve) => {
    jwksServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      jwksPort = info.port
      resolve()
    })
  })
}

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
      jwksUrl: `http://localhost:${jwksPort}/.well-known/jwks.json`,
      clockSkewSeconds: 30,
      maxTokenLifetimeSeconds: 3600,
    },
  } as FinnConfig
}

async function signJWT(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "key-1" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keyPair.privateKey)
}

function validClaims(): Record<string, unknown> {
  return {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "user:discord:123",
    tenant_id: "community:thj",
    tier: "pro",
    req_hash: "sha256:abc123",
  }
}

describe("Route-Based Dual Auth (T-A.2)", () => {
  beforeAll(async () => {
    await startJWKSServer()
  })

  afterAll(() => {
    if (jwksServer) jwksServer.close()
  })

  beforeEach(() => {
    resetJWKSCache()
  })

  function createDualAuthApp(): Hono {
    const config = mockConfig()
    const app = new Hono()

    // JWT auth for /api/v1/* (arrakis-originated)
    app.use("/api/v1/*", jwtAuthMiddleware(config))

    // Bearer auth for /api/* EXCLUDING /api/v1/* (direct access)
    app.use("/api/*", async (c, next) => {
      // Skip bearer auth for /api/v1/* paths (already handled by JWT middleware)
      if (c.req.path.startsWith("/api/v1/")) return next()
      return authMiddleware(config)(c, next)
    })

    // V1 route
    app.get("/api/v1/test", (c) => {
      const tenant = c.get("tenant")
      return c.json({ source: "jwt", tenant_id: tenant?.claims?.tenant_id })
    })

    // Legacy route
    app.get("/api/test", (c) => {
      return c.json({ source: "bearer" })
    })

    return app
  }

  it("JWT on /api/v1/* works", async () => {
    const app = createDualAuthApp()
    const token = await signJWT(validClaims())
    const res = await app.request("/api/v1/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe("jwt")
    expect(body.tenant_id).toBe("community:thj")
  })

  it("bearer on /api/* works", async () => {
    const app = createDualAuthApp()
    const res = await app.request("/api/test", {
      headers: { Authorization: "Bearer test-bearer-token" },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe("bearer")
  })

  it("opaque bearer on /api/v1/* → 401 (no fallback)", async () => {
    const app = createDualAuthApp()
    const res = await app.request("/api/v1/test", {
      headers: { Authorization: "Bearer test-bearer-token" },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe("JWT_STRUCTURAL_INVALID")
  })

  it("JWT on /api/* → 401 (bearer rejects JWT tokens)", async () => {
    const app = createDualAuthApp()
    const token = await signJWT(validClaims())
    const res = await app.request("/api/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    // Bearer auth does timing-safe compare with the JWT string, which won't match
    expect(res.status).toBe(401)
  })

  it("no auth on /api/v1/* → 401", async () => {
    const app = createDualAuthApp()
    const res = await app.request("/api/v1/test")
    expect(res.status).toBe(401)
  })

  it("no auth on /api/* → 401", async () => {
    const app = createDualAuthApp()
    const res = await app.request("/api/test")
    expect(res.status).toBe(401)
  })
})

describe("JTI Replay Protection (T-A.2)", () => {
  it("allows first use of jti", async () => {
    const guard = new InMemoryJtiReplayGuard()
    const isReplay = await guard.checkAndStore("jti-1", 60)
    expect(isReplay).toBe(false)
    guard.destroy()
  })

  it("rejects duplicate jti", async () => {
    const guard = new InMemoryJtiReplayGuard()
    await guard.checkAndStore("jti-1", 60)
    const isReplay = await guard.checkAndStore("jti-1", 60)
    expect(isReplay).toBe(true)
    guard.destroy()
  })

  it("allows different jtis", async () => {
    const guard = new InMemoryJtiReplayGuard()
    expect(await guard.checkAndStore("jti-1", 60)).toBe(false)
    expect(await guard.checkAndStore("jti-2", 60)).toBe(false)
    expect(guard.size).toBe(2)
    guard.destroy()
  })

  it("expires jti after TTL", async () => {
    const guard = new InMemoryJtiReplayGuard()
    await guard.checkAndStore("jti-1", 0.05) // 50ms TTL
    expect(await guard.checkAndStore("jti-1", 0.05)).toBe(true)

    await new Promise(r => setTimeout(r, 80))
    expect(await guard.checkAndStore("jti-1", 60)).toBe(false) // expired, allowed again
    guard.destroy()
  })

  it("destroy clears all entries", async () => {
    const guard = new InMemoryJtiReplayGuard()
    await guard.checkAndStore("jti-1", 60)
    await guard.checkAndStore("jti-2", 60)
    expect(guard.size).toBe(2)
    guard.destroy()
    expect(guard.size).toBe(0)
  })
})
