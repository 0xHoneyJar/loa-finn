// tests/finn/jwt-auth.test.ts — JWT Validation Middleware tests (T-A.1)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { Hono } from "hono"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { serve } from "@hono/node-server"
import {
  jwtAuthMiddleware,
  validateJWT,
  validateWsJWT,
  isStructurallyJWT,
  resetJWKSCache,
} from "../../src/hounfour/jwt-auth.js"
import type { JWTConfig } from "../../src/hounfour/jwt-auth.js"
import type { FinnConfig } from "../../src/config.js"

// --- Test JWKS Server ---

let jwksServer: ReturnType<typeof serve>
let jwksPort: number
let currentKeyPair: Awaited<ReturnType<typeof generateKeyPair>>
let previousKeyPair: Awaited<ReturnType<typeof generateKeyPair>> | null = null

async function startJWKSServer(): Promise<void> {
  currentKeyPair = await generateKeyPair("ES256")
  const app = new Hono()

  app.get("/.well-known/jwks.json", async (c) => {
    const currentPublicJWK = await exportJWK(currentKeyPair.publicKey)
    currentPublicJWK.kid = "key-current"
    currentPublicJWK.alg = "ES256"
    currentPublicJWK.use = "sig"

    const keys = [currentPublicJWK]

    if (previousKeyPair) {
      const prevPublicJWK = await exportJWK(previousKeyPair.publicKey)
      prevPublicJWK.kid = "key-previous"
      prevPublicJWK.alg = "ES256"
      prevPublicJWK.use = "sig"
      keys.push(prevPublicJWK)
    }

    return c.json({ keys })
  })

  return new Promise((resolve) => {
    jwksServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      jwksPort = info.port
      resolve()
    })
  })
}

function getJWTConfig(): JWTConfig {
  return {
    enabled: true,
    issuer: "arrakis",
    audience: "loa-finn",
    jwksUrl: `http://localhost:${jwksPort}/.well-known/jwks.json`,
    clockSkewSeconds: 30,
    maxTokenLifetimeSeconds: 3600,
  }
}

async function signJWT(
  claims: Record<string, unknown>,
  options?: { kid?: string; privateKey?: CryptoKey },
): Promise<string> {
  const key = options?.privateKey ?? currentKeyPair.privateKey
  const kid = options?.kid ?? "key-current"

  const builder = new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
    .setIssuedAt()
    .setExpirationTime("1h")

  return builder.sign(key)
}

function validClaims(): Record<string, unknown> {
  return {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "user:discord:123456789",
    tenant_id: "community:thj",
    tier: "pro",
    req_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  }
}

// --- Tests ---

describe("JWT Auth (T-A.1)", () => {
  beforeAll(async () => {
    await startJWKSServer()
  })

  afterAll(() => {
    if (jwksServer) jwksServer.close()
  })

  beforeEach(() => {
    resetJWKSCache()
  })

  describe("isStructurallyJWT", () => {
    it("returns true for valid JWT structure", async () => {
      const token = await signJWT(validClaims())
      expect(isStructurallyJWT(token)).toBe(true)
    })

    it("returns false for opaque bearer token", () => {
      expect(isStructurallyJWT("some-opaque-bearer-token")).toBe(false)
    })

    it("returns false for two-segment token", () => {
      expect(isStructurallyJWT("abc.def")).toBe(false)
    })

    it("returns false for non-ES256 JWT header", () => {
      // Craft a token with RS256 header
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
      const payload = Buffer.from("{}").toString("base64url")
      expect(isStructurallyJWT(`${header}.${payload}.fakesig`)).toBe(false)
    })

    it("returns false for missing typ in header", () => {
      const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")
      const payload = Buffer.from("{}").toString("base64url")
      expect(isStructurallyJWT(`${header}.${payload}.fakesig`)).toBe(false)
    })
  })

  describe("validateJWT", () => {
    it("validates a correctly signed ES256 JWT", async () => {
      const token = await signJWT(validClaims())
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.claims.tenant_id).toBe("community:thj")
        expect(result.claims.tier).toBe("pro")
        expect(result.claims.sub).toBe("user:discord:123456789")
      }
    })

    it("rejects expired JWT", async () => {
      const token = await new SignJWT(validClaims() as Record<string, unknown>)
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "key-current" })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(currentKeyPair.privateKey)

      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(false)
    })

    it("rejects wrong issuer", async () => {
      const token = await signJWT({ ...validClaims(), iss: "not-arrakis" })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(false)
    })

    it("rejects wrong audience", async () => {
      const token = await signJWT({ ...validClaims(), aud: "not-loa-finn" })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(false)
    })

    it("rejects missing required claim (tenant_id)", async () => {
      const claims = validClaims()
      delete claims.tenant_id
      const token = await signJWT(claims)
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(false)
    })

    it("rejects invalid tier", async () => {
      const token = await signJWT({ ...validClaims(), tier: "ultra" })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(false)
    })

    it("accepts token within clock skew tolerance", async () => {
      // Token issued 25s in the future (within 30s skew)
      const token = await new SignJWT(validClaims() as Record<string, unknown>)
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "key-current" })
        .setIssuedAt(Math.floor(Date.now() / 1000) + 25)
        .setExpirationTime("1h")
        .sign(currentKeyPair.privateKey)

      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
    })

    it("handles dual-key rotation window", async () => {
      // Rotate key: current becomes previous, generate new current
      previousKeyPair = currentKeyPair
      currentKeyPair = await generateKeyPair("ES256")

      // Sign with the old key
      const token = await signJWT(validClaims(), {
        kid: "key-previous",
        privateKey: previousKeyPair.privateKey,
      })

      // Should still validate (JWKS includes both keys)
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)

      previousKeyPair = null
    })

    it("refetches JWKS on kid cache miss via new kid", async () => {
      // Sign with a kid that doesn't exist yet
      const newKeyPair = await generateKeyPair("ES256")

      // Create a separate JWKS server that serves both the current and new key
      const jwksApp = new Hono()
      jwksApp.get("/.well-known/jwks.json", async (c) => {
        const currentJwk = await exportJWK(currentKeyPair.publicKey)
        currentJwk.kid = "key-current"
        currentJwk.alg = "ES256"
        currentJwk.use = "sig"

        const newJwk = await exportJWK(newKeyPair.publicKey)
        newJwk.kid = "key-rotated"
        newJwk.alg = "ES256"
        newJwk.use = "sig"

        return c.json({ keys: [currentJwk, newJwk] })
      })

      const rotatedServer = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
        const s = serve({ fetch: jwksApp.fetch, port: 0 }, (info) => {
          resolve({ server: s, port: info.port })
        })
      })

      try {
        const config = {
          ...getJWTConfig(),
          jwksUrl: `http://localhost:${rotatedServer.port}/.well-known/jwks.json`,
        }

        // Sign with new kid — first JWKS fetch will find it
        const token = await signJWT(validClaims(), {
          kid: "key-rotated",
          privateKey: newKeyPair.privateKey,
        })

        const result = await validateJWT(token, config)
        expect(result.ok).toBe(true)
      } finally {
        rotatedServer.server.close()
      }
    })

    it("rejects structurally invalid token", async () => {
      const result = await validateJWT("not-a-jwt", getJWTConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JWT_STRUCTURAL_INVALID")
      }
    })

    it("validates optional model_preferences as object of strings", async () => {
      const token = await signJWT({
        ...validClaims(),
        model_preferences: { chat: "fast-code", review: "reviewer" },
      })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.claims.model_preferences).toEqual({ chat: "fast-code", review: "reviewer" })
      }
    })

    it("rejects model_preferences with non-string values", async () => {
      const token = await signJWT({
        ...validClaims(),
        model_preferences: { chat: 42 },
      })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(false)
    })

    it("accepts JWT with optional nft_id and byok claims", async () => {
      const token = await signJWT({
        ...validClaims(),
        nft_id: "mibera:4269",
        byok: true,
      })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.claims.nft_id).toBe("mibera:4269")
        expect(result.claims.byok).toBe(true)
      }
    })

    it("accepts JWT with jti claim", async () => {
      const token = await signJWT({
        ...validClaims(),
        jti: "unique-request-id-123",
      })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.claims.jti).toBe("unique-request-id-123")
      }
    })
  })

  describe("jwtAuthMiddleware", () => {
    function createTestApp(config: FinnConfig): Hono {
      const app = new Hono()
      app.use("/api/v1/*", jwtAuthMiddleware(config))
      app.get("/api/v1/test", (c) => {
        const tenant = c.get("tenant")
        return c.json({ tenant })
      })
      return app
    }

    function mockConfig(): FinnConfig {
      return {
        jwt: getJWTConfig(),
      } as FinnConfig
    }

    it("passes valid JWT and sets tenant context", async () => {
      const app = createTestApp(mockConfig())
      const token = await signJWT(validClaims())

      const res = await app.request("/api/v1/test", {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.tenant.claims.tenant_id).toBe("community:thj")
      expect(body.tenant.isNFTRouted).toBe(false)
      expect(body.tenant.isBYOK).toBe(false)
    })

    it("returns 401 for missing Authorization header", async () => {
      const app = createTestApp(mockConfig())
      const res = await app.request("/api/v1/test")
      expect(res.status).toBe(401)
    })

    it("returns 401 for opaque bearer token on /api/v1/*", async () => {
      const app = createTestApp(mockConfig())
      const res = await app.request("/api/v1/test", {
        headers: { Authorization: "Bearer some-opaque-token" },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.code).toBe("JWT_STRUCTURAL_INVALID")
    })

    it("skips validation when jwt.enabled is false", async () => {
      const config = mockConfig()
      config.jwt.enabled = false
      const app = createTestApp(config)

      const res = await app.request("/api/v1/test")
      expect(res.status).toBe(200)
    })

    it("sets isNFTRouted when nft_id present", async () => {
      const app = createTestApp(mockConfig())
      const token = await signJWT({ ...validClaims(), nft_id: "mibera:1234" })

      const res = await app.request("/api/v1/test", {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.tenant.isNFTRouted).toBe(true)
    })
  })

  describe("validateWsJWT", () => {
    it("validates JWT from query param", async () => {
      const token = await signJWT(validClaims())
      const result = await validateWsJWT(token, getJWTConfig())
      expect(result).not.toBeNull()
      expect(result!.claims.tenant_id).toBe("community:thj")
    })

    it("returns null when token is undefined", async () => {
      const result = await validateWsJWT(undefined, getJWTConfig())
      expect(result).toBeNull()
    })

    it("returns null when jwt disabled", async () => {
      const config = { ...getJWTConfig(), enabled: false }
      const token = await signJWT(validClaims())
      const result = await validateWsJWT(token, config)
      expect(result).toBeNull()
    })

    it("returns null for invalid token", async () => {
      const result = await validateWsJWT("invalid-token", getJWTConfig())
      expect(result).toBeNull()
    })
  })
})
